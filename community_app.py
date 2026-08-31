"""Customer-facing Vivo Johari community app backend (/api/community/*).

Public, self-authenticating endpoints for the standalone customer app at
/app/ (artifacts/vivo-community). Auth model mirrors /api/loyalty: the
api_pg middleware lets /api/community/* through WITHOUT a staff session and
every member-scoped handler here validates its own Bearer token (sha256 of
the token is stored in community_sessions) and fails closed with 401.

Auth flow (per product spec): phone -> SMS one-time code -> app.
SMS DEMO MODE: no SMS provider is connected yet. When no provider is
configured (_sms_configured() is False) the stored OTP is the fixed demo
code 123456 and responses carry {"demo": true} so the UI can say so.
To plug in a real provider later: implement _send_otp_sms() and make
_sms_configured() detect the provider secret — verify logic is unchanged
(a random code is generated first; demo mode merely overwrites it).

Data: products come from the live catalogue (all_products_clean +
product_images, stock from all_inventory); members are matched to real
customers in all_customers by phone (right-9-digit match) so the profile
shows real purchase-derived stats. PII: /me only ever returns the
logged-in member's OWN record.
"""

import base64
import collections
import hashlib
import logging
import os
import json
import re
import secrets
import smtplib
import threading
import time
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone

import psycopg2
import psycopg2.extras
from fastapi import Body, HTTPException, Request
from fastapi.responses import JSONResponse, Response

log = logging.getLogger("community_app")

# Set in register_community_routes() to the fully-loaded api_pg module.
A = None

DEMO_CODE = "123456"

# --- Membership terms versioning -------------------------------------------
# The SERVER owns the consent record of truth. The SPA bundle is deployed in
# lockstep with this file, so the Terms version members actually see is the
# server's current version. The client's claimed version is honoured only if
# it names a published version; anything else (missing, forged, unknown)
# records the current version instead — arbitrary strings can never be stored.
# Lockstep: artifacts/vivo-community/src/components/community/legalData.js
COMMUNITY_TERMS_VERSION = "0.9.7"
COMMUNITY_TERMS_PUBLISHED = {"0.9", "0.9.1", "0.9.2", "0.9.3", "0.9.4", "0.9.5", "0.9.6", "0.9.7"}
OTP_TTL_SEC = 10 * 60          # code valid 10 minutes
OTP_MAX_ATTEMPTS = 5
OTP_RESEND_GAP_SEC = 30
SIGNUP_TOKEN_TTL_SEC = 30 * 60
SESSION_TTL_SEC = 60 * 24 * 3600   # 60 days

WELCOME_BONUS_PTS = 200
KES_PER_POINT = 100            # matches the "1 pt per 100 KES" earn rule
# Vivo Johari gemstone ladder ("johari" is Swahili for jewel) — the Aug 2026
# rebrand of Bronze/Silver/Gold; lifetime-point thresholds are unchanged.
TIER_LADDER = [("Tsavorite", 0), ("Ruby", 500), ("Tanzanite", 1000)]

# ---------- Virtual Try-On ----------
# Weekly generation allowance per Johari tier (resets Monday, EAT). The cap
# is the cost control: every real generation is a billed Gemini image call.
# ── ADMIN NOTE: this dict is the ONE switch for the try-on business model ──
# Value = try-ons per week; None = unlimited; 0 = not included on that tier
# (members there see an upgrade nudge instead of a counter). The API serves
# this ladder live to the app (allowance endpoint → Rewards perk card, try-on
# counters, upsell copy), so changing the split — e.g. Tanzanite-exclusive:
# {"Tsavorite": 0, "Ruby": 0, "Tanzanite": None} — needs no other code change
# and no frontend rebuild.
TRYON_WEEK_LIMITS = {"Tsavorite": 2, "Ruby": 5, "Tanzanite": None}
TRYON_PHOTO_CAP = 12                 # stored photos per member
TRYON_MODEL = "gemini-2.5-flash-image"
TRYON_PENDING_STALE_SEC = 300        # pending older than this self-heals to failed
# Force demo composites even when the AI integration is configured (testing).
TRYON_FORCE_DEMO = os.environ.get("TRYON_DEMO_MODE", "").strip() == "1"
QUIZ_BONUS_PTS = 50            # one-time Style Quiz completion bonus (instant, no moderation)
SURVEY_BONUS_PTS = 30          # per-wave customer survey bonus (instant, once per wave)
ARTICLE_COMMENT_BONUS_PTS = 5  # first comment on a campaign article (once per article)
# Submit-time comment blocklist (basic profanity/spam net; reports + the
# author-delete path cover what slips through). Word-boundary matched,
# case-insensitive — keep entries lowercase.
_COMMENT_BLOCKLIST = re.compile(
    r"\b(fuck\w*|shit\w*|bitch\w*|cunt|nigg\w+|malaya|mavi|kuma\w*|"
    r"takataka|mjinga|pumbavu|whore|slut)\b|https?://|www\.",
    re.IGNORECASE)

# ---- Campaign articles ("Join the Conversation") ---------------------------
# Articles are DB rows (community_articles). The boot seed keeps the launch
# article in sync with these constants (title/body edits reach every
# environment on boot); future campaigns are new rows — no new templates.
ARTICLE_SLUG_LAUNCH = "the-new-old-money"
_ARTICLE_SEED = {
    "slug": ARTICLE_SLUG_LAUNCH,
    "article_type": "campaign",
    "title": "The New Old Money",
    "subheading": ("Timeless silhouettes, refined details and effortless "
                   "elegance, reimagined for the modern Vivo woman."),
    "cover_image": "/app/assets/brand/hero.jpg",
    "tag": "This season's conversation",
    "subject": None,
    "byline": None,
    "gallery": [],
    "body": [
        "Quiet luxury has been having a moment everywhere — but Nairobi has "
        "always known how to do it with warmth. This season we asked a "
        "simple question: what does old money elegance look like when it's "
        "designed here, for her?",
        "The answer is a collection built on restraint. Clean tailoring "
        "that skims rather than clings. Buttery neutrals — ivory, camel, "
        "deep chocolate — lifted by the occasional flash of Vivo orange. "
        "Fabrics you want to touch, cut generously enough to live in.",
        "Styling notes from the studio: pair the structured shirt dress "
        "with flat leather sandals and one bold gold piece, never three. "
        "A headscarf, tied soft, does more than any logo could. And the "
        "column skirt is worth sizing to your waist, not your hips — the "
        "line is the whole point.",
        "Our design team calls it 'inheritance dressing' — pieces that "
        "look like they've always been yours and always will be. Less "
        "trend, more heirloom.",
        "Now it's your turn. What does old money style mean to you — and "
        "how are you wearing it? Drop a comment below; the team reads "
        "every one, and your take might shape where we go next season.",
    ],
}

# Community Spotlights use the exact same article + comment model as campaign
# stories. These launch profiles belong to the rotating fictional launch
# jewels; they seed only once so a future staff-authored interview is never
# overwritten by application startup.
_SPOTLIGHT_ARTICLE_SEEDS = [
    {
        "slug": "nyambura-finding-her-shape",
        "article_type": "spotlight",
        "title": "Nyambura's style began with making room",
        "subheading": ("For Nyambura, finding clothes that fitted well was the "
                       "start. Finding women who made room for one another "
                       "changed everything."),
        "cover_image": "/app/assets/brand/home-teasers/community-960.webp",
        "tag": "Community spotlight",
        "subject": "Nyambura K.",
        "byline": "Words by Vivo Community",
        "gallery": [
            {
                "image": "/app/assets/brand/home-teasers/community-960.webp",
                "alt": "Vivo women sharing a bright studio moment together",
                "caption": "The kind of room Nyambura says every woman deserves.",
            },
            {
                "image": "/app/assets/brand/home-teasers/style-boards-960.webp",
                "alt": "A Vivo editorial look in warm tones",
                "caption": "One of the softer, structured looks that helped her see a new silhouette.",
            },
            {
                "image": "/app/assets/brand/home-teasers/curators-960.webp",
                "alt": "Vivo women in polished evening looks",
                "caption": "A reminder that a good look can feel like an introduction.",
            },
        ],
        "body": [
            "“Finding a community that celebrates African curves has completely changed how I shop. Vivo is more than fashion, it’s family.”",
            "Nyambura joined Vivo Community after a friend sent her a fitting-room photo and a message that read: try the dress you think is ‘not for you’. She had loved colour and a good occasion look for as long as she could remember, but shopping had often begun with a quiet calculation: what would hide, what would skim, what would ask the least of her body.",
            "Her first Vivo piece was a wrap dress she nearly left on the rail. In the fitting room, the waist sat where it was meant to, the sleeves gave her room to move, and the print did not apologise for taking up space. She wore it to a cousin’s birthday with flat sandals and gold hoops. By the end of the evening, three women had asked where she found it.",
            "That question started a habit. Nyambura began saving the fit notes she found in Community, then adding her own: size up here if you want a softer drape; belt this one at the natural waist; keep the earrings simple and let the print speak. The posts were practical, but the replies were what stayed with her — women celebrating one another before they had ever met.",
            "These days, she reaches first for pieces with shape: a defined waist, a generous sleeve, a skirt that moves when she does. The makeover was never about becoming someone else. It was learning that being seen clearly can be a comfort.",
            "Her advice to another woman standing outside a fitting room door is simple: take the piece in. Try the colour. Let the mirror tell a fuller story than the one you arrived with.",
        ],
    },
    {
        "slug": "halima-dressing-to-arrive",
        "article_type": "spotlight",
        "title": "Halima stopped dressing to disappear",
        "subheading": ("A fitting-room note, a bright print and a patient "
                       "community helped Halima trade hiding for arriving."),
        "cover_image": "/app/assets/brand/home-teasers/style-boards-960.webp",
        "tag": "Community spotlight",
        "subject": "Halima S.",
        "byline": "Words by Vivo Community",
        "gallery": [
            {
                "image": "/app/assets/brand/home-teasers/style-boards-960.webp",
                "alt": "A Vivo editorial look in warm tones",
                "caption": "The shape-led look that made Halima pause at the mirror.",
            },
            {
                "image": "/app/assets/brand/home-teasers/community-960.webp",
                "alt": "Vivo women sharing a bright studio moment together",
                "caption": "Community fit notes made a first try feel less daunting.",
            },
        ],
        "body": [
            "“I used to buy clothes to hide. These days I dress to arrive — and this community did that.”",
            "For a long time, Halima’s wardrobe was a collection of compromises: safe colours, forgiving shapes and pieces chosen for the smallest possible reaction. She had shopped Vivo before, but it was the Community’s unfiltered fit notes that persuaded her to revisit a dress she had dismissed from a thumbnail.",
            "She ordered the print in the size members kept recommending, then took her time with it at home. The first look was not a grand reveal — just the dress, a clean shoe and the decision to leave the jacket behind. But it felt different. The fabric moved with her instead of asking her to disappear behind it.",
            "Halima started posting the details she used to keep to herself: where the waist sits, how the sleeve feels after a full day, the size she would choose if she wanted a closer fit. Her honesty made other women braver with their own questions, and soon the comments turned into a small styling circle.",
            "Her most-worn formula now is a bold piece with one quiet companion: a printed dress with a simple bag, a bright top with a straight trouser, a soft jacket over a colour she would once have avoided. The point is not to be louder. It is to be present.",
        ],
    },
    {
        "slug": "asha-wearing-her-story-proudly",
        "article_type": "spotlight",
        "title": "Asha learned to wear every chapter proudly",
        "subheading": ("Asha's style story is built from shared notes, joyful "
                       "prints and the permission to change her mind."),
        "cover_image": "/app/assets/brand/home-teasers/curators-960.webp",
        "tag": "Community spotlight",
        "subject": "Asha K.",
        "byline": "Words by Vivo Community",
        "gallery": [
            {
                "image": "/app/assets/brand/home-teasers/curators-960.webp",
                "alt": "Vivo women in polished evening looks",
                "caption": "Asha now starts with the feeling she wants an outfit to hold.",
            },
            {
                "image": "/app/assets/brand/home-teasers/community-960.webp",
                "alt": "Vivo women sharing a bright studio moment together",
                "caption": "The best styling advice, she says, feels like a friend cheering.",
            },
        ],
        "body": [
            "“Every woman here taught me something about wearing my own story proudly.”",
            "Asha arrived in Vivo Community looking for outfit ideas before a friend’s wedding. She stayed because every saved look came with a conversation: someone explaining a hem, another member suggesting a colour, a third reminding her that an outfit only works if she can laugh and dance in it.",
            "The wedding look was a turning point. Asha paired a fluid skirt with a sharper top, chose a print she would once have called too much, and spent the evening receiving compliments that felt less about the clothes than the ease she carried in them. She still has the photo, but what she remembers most is not checking whether she looked right.",
            "Since then, she has built a wardrobe by feeling rather than rules. Some weeks it is soft tailoring and a low heel. Some weeks it is a saturated colour, large earrings and no need to explain either choice. The through-line is that every piece makes space for her life as it is now.",
            "Asha leaves the same note under new members’ posts whenever she can: begin with one thing you love. The rest of the look — and the rest of the story — can meet you there.",
        ],
    },
]

# ---- Customer survey ("Help us dress you better") --------------------------
# Waves are DB rows (community_survey_waves): each wave carries its own
# question schema, so a future wave can change content with NO frontend
# rebuild. The boot seed keeps wave 1 in sync with these constants so
# additive mid-wave edits (like appending an optional question) reach every
# environment on boot. Never rename/remove ids or options mid-wave — that
# orphans collected answers; breaking changes = a NEW wave row (close the
# old one).
# Home-card "Maybe later": first dismiss hides the card, it re-surfaces once
# after SURVEY_RESURFACE_DAYS, a second dismiss retires it for the wave
# (the Rewards mission and Profile entry points always remain).
SURVEY_RESURFACE_DAYS = 3
SURVEY_WAVE1_KEY = "2026-w1"
SURVEY_WAVE1_TITLE = "Help us dress you better"
SURVEY_WAVE1_QUESTIONS = [
    {"id": "tenure", "kind": "single",
     "title": "How long have you been shopping with Vivo?",
     "options": ["Under a year", "1–3 years", "3–5 years", "5+ years",
                 "This is my first time browsing"]},
    {"id": "channel", "kind": "single",
     "title": "Where do you usually shop with us?",
     "options": ["In store", "Online", "Both"],
     "followup": {"id": "store", "title": "Which store do you visit most?",
                  "when": ["In store", "Both"],
                  "options": ["Galleria", "The Junction", "Moi Avenue",
                              "Another Kenya store", "Uganda", "Rwanda"]}},
    {"id": "occasions", "kind": "multi",
     "title": "What do you mostly buy Vivo for?",
     "hint": "Pick all that apply.",
     "options": ["Work", "Everyday", "Events & celebrations",
                 "Church & Sunday best", "Gifts"]},
    {"id": "fit", "kind": "single",
     "title": "How do Vivo pieces usually fit you?",
     "options": ["Perfectly", "Usually right, sometimes off", "Hit or miss",
                 "I often have trouble with fit"]},
    {"id": "loves", "kind": "multi", "max": 2,
     "title": "What keeps you coming back?",
     "hint": "Pick up to two.",
     "options": ["Fit", "Quality", "Designs & prints", "Price", "Service",
                 "Made in Africa", "Size range"]},
    {"id": "improve", "kind": "multi", "max": 2,
     "title": "Where should we improve first?",
     "hint": "Pick up to two.",
     "options": ["Fit", "Quality", "Designs & prints", "Price", "Service",
                 "Stock availability", "Sizing consistency", "Delivery"]},
    {"id": "nps", "kind": "nps",
     "title": "How likely are you to recommend Vivo to a friend?",
     "low": "Not at all likely", "high": "Extremely likely"},
    {"id": "nps_why", "kind": "text", "optional": True,
     "title": "What's the main reason for your score?",
     "placeholder": "Tell us as much or as little as you like…"},
    {"id": "services", "kind": "multi",
     "title": "Which of these would you use?",
     "hint": "Pick any that catch your eye.",
     "options": ["Tailoring & alterations", "Personal styling",
                 "Personalised embroidery", "Members' events",
                 "Virtual try-on"]},
    {"id": "anything_else", "kind": "text", "optional": True,
     "title": "Anything else you'd like to share or ask us?",
     "hint": "Totally optional — and we read every single one.",
     "placeholder": "A thought, a wish, a question — the floor is yours…"},
]

# ---- Personalised embroidered tank reward ---------------------------------
# The first real, fulfillable redemption: Vivo's ribbed Chela tank finished
# with a member-supplied embroidered design, stitched in-house. Sits between
# the styling session (1,200) and members' event (2,000) rungs of the ladder.
# Tier is lifetime-based, so redeeming never demotes a member; spendable
# balance = lifetime earn − non-cancelled redemptions.
EMB_TANK_STYLE = "Vivo Chela Tank Top in Stretch Rib"
EMB_TANK_POINTS = 1600
ZETU_SHOOT_POINTS = 3000           # top of the ladder: photoshoot at Zetu Studios

# "Shining This Week" — editorial celebration content. Warm reasons, zero
# numbers, zero ranks; rotated weekly (jewel) and shuffled per visit
# (celebrated, client-side). Fictional launch voices, same as the feed seeds.
_CELEBRATION_JEWELS = [
    {"username": "nyambura.k", "tier": "Tanzanite", "show_tier": True,
     "article_slug": "nyambura-finding-her-shape",
     "quote": "Finding a community that celebrates African curves has "
              "completely changed how I shop. Vivo is more than fashion, "
              "it's family."},
    {"username": "halima.s", "tier": None, "show_tier": False,
     "article_slug": "halima-dressing-to-arrive",
     "quote": "I used to buy clothes to hide. These days I dress to "
              "arrive — and this community did that."},
    {"username": "asha.k", "tier": "Tanzanite", "show_tier": True,
     "article_slug": "asha-wearing-her-story-proudly",
     "quote": "Every woman here taught me something about wearing my own "
              "story proudly."},
]
_CELEBRATED = [
    {"username": "asha.k",
     "reason": "for welcoming every new member in the comments like an old friend"},
    {"username": "halima.s",
     "reason": "for fit notes so honest half of Nairobi shops on her word"},
    {"username": "makena_w",
     "reason": "for styling advice that always starts with 'you already look lovely'"},
    {"username": "njoki.g",
     "reason": "for turning every haul into a masterclass in mixing prints"},
    {"username": "wanjiku.m",
     "reason": "for cheering loudest on other women's wins, every single week"},
    {"username": "zawadi.n",
     "reason": "for asking the brave questions everyone else was quietly wondering"},
]
CHALLENGE_WINNER_BONUS_PTS = 200   # hybrid model: team picks from the shortlist
POST_PHOTO_PTS = 50                # community look with a photo, on publication
POST_VIDEO_PTS = 100               # community look with a video, on publication
EMB_TANK_MIN_SIZES = 3          # a colourway needs this many stocked sizes to be offered
EMB_TANK_MAX_DESIGN_BYTES = 3 * 1024 * 1024   # decoded upload cap
EMB_TANK_MONOGRAM_STYLES = [
    {"id": "serif", "label": "Classic Serif"},
    {"id": "block", "label": "Modern Block"},
    {"id": "script", "label": "Hand Script"},
]
EMB_TANK_PICKUP_STORES = [
    "The Junction Mall", "Galleria Mall", "Sarit Centre", "Yaya Centre",
    "Village Market", "Thika Road Mall", "The Oasis Mall", "Vivo Acacia",
]
_tank_cache = {}               # {"t": ts, "v": payload} — stock-ish, member-agnostic
_TANK_TTL = 300

# ---- Community events ------------------------------------------------------
# RSVP'able member gatherings. Events are code-seeded (marketing edits this
# list the same way they edit newsData.js on the client); RSVPs persist per
# member in community_event_rsvps. Head-counts are PUBLIC by product decision
# (Aug 2026 feedback): cards show "18 of 30 spots taken", so the API returns
# capacity/taken/spots_left. When full, RSVPs land on a waitlist; cancelling
# a confirmed spot promotes the earliest waitlisted member (email, best
# effort). seed_taken is the demo-layer baseline of signups (same idea as the
# mock feed posts) — real member RSVPs stack on top, so the DB may hold at
# most capacity − seed_taken confirmed rows per event. Times are EAT
# (+03:00) and the server pre-formats every display label so all devices
# show Nairobi time. Gated events stay VISIBLE to everyone; the gate only
# controls RSVP (tier gate and/or a held redemption reward unlocks it).
# image files live in the SPA at public/events/<image> (served /app/events/).
COMMUNITY_EVENTS = [
    {
        "id": "galleria-styling-evening",
        "kicker": "Styling Evening",
        "title": "An Evening of Styling at Galleria",
        "starts_at": "2026-08-28T17:30:00+03:00",
        "ends_at": "2026-08-28T19:30:00+03:00",
        "venue": "Vivo, Galleria Mall",
        "area": "Langata Road, Nairobi",
        "blurb": "Our stylists walk you through the new season — what to pair, how to layer, and the fits that flatter. Bring a friend; leave with a look.",
        "about": [
            "The store closes to everyone but you. For two hours our Galleria stylists have the floor — the new season on the rails, and honest, practical answers to the questions we hear every day: what goes with this, how do I layer for Nairobi evenings, which cut actually flatters me.",
            "Come as you are, bring a friend if you like. You'll leave with looks pulled for your shape and your life — photographed on the rail so you can find them again, no pressure to buy a thing.",
        ],
        "expect": [
            "A guided walk through the new season with our stylists",
            "One-on-one time to pull looks for your shape and plans",
            "Styling notes to take home — your looks, photographed",
            "Light refreshments while you browse",
        ],
        "host": {"name": "Achieng Wairimu", "role": "Head Stylist, Galleria"},
        "capacity": 30,
        "seed_taken": 18,
        "image": "galleria-styling-evening.jpg",
        "cover": {"tone": "charcoal", "mark": "Styled", "sub": "Galleria Mall · 28 Aug"},
        "news_id": "galleria-store",
    },
    {
        "id": "junction-perfect-fit",
        "kicker": "Fit Workshop",
        "title": "The Perfect Fit: A Tailoring Afternoon",
        "starts_at": "2026-09-12T14:00:00+03:00",
        "ends_at": "2026-09-12T16:30:00+03:00",
        "venue": "Vivo, The Junction Mall",
        "area": "Ngong Road, Nairobi",
        "blurb": "Meet the tailors behind our new in-store service. Live demos on hems, waists and straps — and how the smallest changes make a piece completely yours.",
        "about": [
            "A hem taken up two centimetres. A strap moved half an inch. The difference between a dress you like and a dress you live in is usually smaller than you think — and now there's a tailoring bench inside The Junction store to prove it.",
            "This afternoon is hands-on and small on purpose: live alterations on real pieces, a fitting queue if you bring something of your own, and the tailors talking through what they're doing and why.",
        ],
        "expect": [
            "Live demos — hems, waists, straps — on real garments",
            "Bring one piece of your own for the fitting queue",
            "Straight talk on what alterations cost and how long they take",
            "A small group, so everyone gets bench time",
        ],
        "host": {"name": "Mumbi Njeri", "role": "Lead Tailor, The Junction"},
        "capacity": 25,
        "seed_taken": 21,
        "image": "junction-perfect-fit.jpg",
        "cover": {"tone": "cream", "mark": "Made for you", "sub": "The Junction · 12 Sep"},
        "news_id": "junction-tailoring",
    },
    {
        "id": "myvivostory-photo-afternoon",
        "kicker": "Community Meet-up",
        "title": "#MyVivoStory Meet-up & Photo Afternoon",
        "starts_at": "2026-09-26T14:00:00+03:00",
        "ends_at": "2026-09-26T17:00:00+03:00",
        "venue": "Vivo, Moi Avenue",
        "area": "Nairobi CBD",
        "blurb": "Meet the community behind the hashtag. Portraits by our photographer in the refreshed store, stylists on hand, and stories worth sharing.",
        "about": [
            "The hashtag started with you — thousands of photos of real women wearing Vivo their own way. This afternoon we put faces to it: the refreshed Moi Avenue store, our photographer set up in the good light, and the community in one room.",
            "Have your portrait taken (it's yours to keep and to post, if you want to), get a quick styling touch-up before the lens, and meet the women whose looks you've been double-tapping all year.",
        ],
        "expect": [
            "A professional portrait — edited and sent to you",
            "Stylists on hand for pre-photo touch-ups",
            "Meet the community behind #MyVivoStory",
            "Featured stories may appear in Vivo News (with your say-so)",
        ],
        "host": {"name": "Zawadi Atieno", "role": "Community Lead"},
        "capacity": 40,
        "seed_taken": 12,
        "image": "myvivostory-photo-afternoon.jpg",
        "cover": {"tone": "orange", "mark": "#MyVivoStory", "sub": "Moi Avenue · 26 Sep"},
        "news_id": "moi-avenue-refresh",
    },
    {
        "id": "new-collection-first-look",
        "kicker": "Members' Evening",
        "title": "New Collection: The First Look",
        "starts_at": "2026-10-08T18:00:00+03:00",
        "ends_at": "2026-10-08T20:00:00+03:00",
        "venue": "Vivo, The Junction Mall",
        "area": "Ngong Road, Nairobi",
        "blurb": "The new collection on the rails a week before anyone else sees it — first pick, light bites, and the designers in the room.",
        "about": [
            "A full week before the collection goes on sale anywhere, it hangs on the rails for this room only. First pick of every piece and every size, and the people who designed it standing next to it — ask them anything.",
            "This is a small evening by design. Tanzanite members and invitation holders only, light bites and something to drink, and the kind of first-dibs shopping that never makes it to the shop floor.",
        ],
        "expect": [
            "The new collection, one week before anyone else",
            "First pick — every piece, every size, held for the room",
            "The designers in the room, happy to talk through it",
            "Light bites and drinks through the evening",
        ],
        "host": {"name": "Nyokabi Muthoni", "role": "Design Lead"},
        "capacity": 25,
        "seed_taken": 19,
        "image": "new-collection-first-look.jpg",
        "gate": {
            "label": "Members' evening",
            "tiers": ["Tanzanite"],
            "rewards": ["members_event"],
            "copy": "A first look for Tanzanite members and invitation holders — reach Tanzanite, or redeem the Members' Event Invitation, and you're on the list.",
        },
        "cover": {"tone": "charcoal", "mark": "First Look", "sub": "Members' evening · 8 Oct"},
    },
    {
        "id": "fifteen-years-celebration",
        "kicker": "Celebration",
        "title": "Fifteen Years of Vivo: The Big One",
        "starts_at": "2026-10-24T16:00:00+03:00",
        "ends_at": "2026-10-24T20:00:00+03:00",
        "venue": "Sarit Centre Expo Hall",
        "area": "Westlands, Nairobi",
        "blurb": "Fifteen years of dressing her boldly deserves a party. Music, a lookback at the collections that made us, and a toast to the women who wore them.",
        "about": [
            "Fifteen years ago Vivo opened one store with one idea: clothes made for her, here. This is the party for everyone who carried that idea — a live retrospective of the collections that made us, music, and a proper Nairobi toast.",
            "Expect a runway of archive pieces (some you'll remember, some you kept), the founders telling the stories behind them, and a room full of the women who wore the brand into what it is.",
        ],
        "expect": [
            "An archive runway — fifteen years of collections, live",
            "Music, food and a toast as the sun goes down",
            "The founding team telling the stories behind the pieces",
            "A keepsake for every guest on the way out",
        ],
        "host": None,
        "capacity": 60,
        "seed_taken": 60,
        "image": "fifteen-years-celebration.jpg",
        "cover": {"tone": "orange", "mark": "15", "sub": "years of Vivo · 24 Oct"},
        "news_id": "vivo-turns-15",
    },
]
# Guard against seed edits that would make the maths impossible: the DB may
# hold at most capacity − seed_taken confirmed rows per event.
for _ev in COMMUNITY_EVENTS:
    assert 0 <= int(_ev.get("seed_taken", 0)) <= int(_ev["capacity"]), _ev["id"]
del _ev

_tables_ready = False
_tables_lock = threading.Lock()

# Small in-process caches (products list is identical for every member).
# All caches are size-capped: keys can be influenced by public callers, so
# unbounded growth would be a memory-DoS vector.
_products_cache = {}           # key -> (ts, payload)
_PRODUCTS_TTL = 600
_me_cache = {}                 # member_id -> (ts, payload)
_ME_TTL = 300
_pdp_cache = {}                # sku -> (ts, payload)  product detail
_PDP_TTL = 600
# Merch badges ("Selling fast" / "Best seller") for cards + PDPs. One
# catalogue-wide map refreshed lazily; deliberately scarce (top handful
# each) and never numeric — exact stock counts must not reach customers.
_badges_cache = {"ts": 0.0, "map": {}, "refreshing": False}
_badges_lock = threading.Lock()
_BADGES_TTL = 600
_BADGES_RETRY = 60             # after a failed refresh, retry sooner

_IMG_CACHE = collections.OrderedDict()   # sku -> (ts, jpeg bytes | None=404)
_IMG_LOCK = threading.Lock()
_IMG_TTL = 3600
_IMG_CAP = 400                 # ~40KB/img -> <=~16MB
_IMG_MAX_BYTES = 300 * 1024    # never cache abnormally large blobs

# ---- public-endpoint abuse guards (in-process sliding windows) ----------
# These endpoints bypass the staff-auth middleware, so they need their own
# IP / phone / global budgets: without them anyone could mint unlimited OTP
# rows (and, once a real SMS provider is connected, pump SMS spend).
_RL_LOCK = threading.Lock()
_RL_HITS = {}                  # bucket key -> deque[hit unix ts]
_RL_MAX_KEYS = 20000           # hard memory valve


# ---------------------------------------------------------------- helpers

def _conn():
    return psycopg2.connect(os.environ["DATABASE_URL"], connect_timeout=5,
                            options="-c statement_timeout=15000")


def _compute_badges():
    """(style_name, color) -> 'selling_fast' | 'best_seller'.

    Soft merchandising instead of numeric scarcity: low-stock pieces that
    are actually moving read "Selling fast"; the biggest 30-day movers read
    "Best seller". Both lists are capped so badges stay meaningful, and a
    piece never carries more than one (selling-fast wins the overlap).
    Units follow the house canon: gross ordered quantity on sale/order rows.
    """
    sql = """
    WITH sk AS (
        -- Same universe as the shop cards: imaged, own-brand, active,
        -- priced. Badge slots are scarce; spend them only on pieces a
        -- customer can actually see in the grid.
        SELECT DISTINCT p.style_name, COALESCE(p.color_print,'') AS color, p.sku
        FROM all_products_clean p
        JOIN product_image_map m ON m.sku = p.sku
        JOIN product_images img ON img.tmpl_id = m.tmpl_id
             AND COALESCE(img.image_512,'') <> ''
        WHERE p.active IS TRUE AND p.price::float > 0
          AND p.style_name IS NOT NULL AND p.style_name <> ''
          AND COALESCE(p.brand,'') NOT ILIKE '%%third party%%'
    ),
    inv AS (
        SELECT i.sku, SUM(COALESCE(i.available,0)) AS soh
        FROM all_inventory i
        WHERE i.sku IN (SELECT sku FROM sk)
        GROUP BY i.sku
    ),
    stock AS (
        SELECT sk.style_name, sk.color, SUM(COALESCE(inv.soh,0)) AS soh
        FROM sk
        LEFT JOIN inv ON inv.sku = sk.sku
        GROUP BY 1, 2
    ),
    sales AS (
        SELECT sk.style_name, sk.color,
               SUM(CASE WHEN s.sale_kind IN ('sale','order')
                        THEN COALESCE(s.ordered_item_quantity,0) ELSE 0 END) AS units
        FROM all_sales s
        JOIN sk ON sk.sku = s.variant_sku
        WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY 1, 2
    )
    SELECT st.style_name, st.color, st.soh::int AS soh,
           COALESCE(sa.units,0)::int AS units
    FROM stock st
    LEFT JOIN sales sa ON sa.style_name = st.style_name AND sa.color = st.color
    WHERE st.soh > 0 AND COALESCE(sa.units,0) > 0
    """
    with _db() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql)
            rows = [dict(r) for r in cur.fetchall()]
    fast = [r for r in rows if 1 <= r["soh"] <= 5 and r["units"] >= 2]
    fast.sort(key=lambda r: (-r["units"], r["style_name"], r["color"]))
    fast = fast[:6]
    taken = {(r["style_name"], r["color"]) for r in fast}
    best = [r for r in rows
            if (r["style_name"], r["color"]) not in taken and r["units"] >= 5]
    best.sort(key=lambda r: (-r["units"], r["style_name"], r["color"]))
    best = best[:6]
    out = {k: "selling_fast" for k in taken}
    out.update({(r["style_name"], r["color"]): "best_seller" for r in best})
    return out


# ---- Shop filter canon -------------------------------------------------
# Colour facet buckets: customer-facing colour families matched by keyword
# against all_products_clean.color_print (which mixes colours and print
# names). A colourway may fall in several families; filters OR the selected
# families' keywords. Keep keywords lowercase substrings.
COMMUNITY_COLOR_BUCKETS = {
    "Black": ["black"],
    "White & Cream": ["white", "ivory", "cream", "ecru"],
    "Blue": ["blue", "navy", "teal", "denim", "cobalt", "indigo",
             "turquoise", "sky", "aqua", "petrol"],
    "Green": ["green", "olive", "sage", "emerald", "mint", "lime",
              "forest", "jade"],
    "Red": ["red", "maroon", "burgundy", "wine", "crimson", "scarlet",
            "cherry", "berry"],
    "Pink": ["pink", "blush", "rose", "fuchsia", "magenta", "coral"],
    "Orange": ["orange", "rust", "terracotta", "tangerine", "apricot",
               "peach"],
    "Yellow": ["yellow", "mustard", "gold", "ochre", "lemon"],
    "Purple": ["purple", "lilac", "lavender", "plum", "violet", "mauve",
               "aubergine", "grape"],
    "Brown": ["brown", "chocolate", "choco", "coffee", "mocha", "tan",
              "camel", "caramel", "toffee", "cognac"],
    "Neutrals": ["beige", "taupe", "nude", "sand", "stone", "natural",
                 "oat", "khaki", "cappuccino", "mushroom"],
    "Grey": ["grey", "gray", "charcoal", "silver", "slate"],
}

# Preset KES bands (id, low, high-exclusive, label). Multi-select ORs bands.
COMMUNITY_PRICE_BANDS = [
    ("u1000", 0, 1000, "Under KSh 1,000"),
    ("1k_3k", 1000, 3000, "KSh 1,000 \u2013 3,000"),
    ("3k_6k", 3000, 6000, "KSh 3,000 \u2013 6,000"),
    ("6k_up", 6000, None, "KSh 6,000+"),
]
_PRICE_BAND_MAP = {b[0]: (b[1], b[2]) for b in COMMUNITY_PRICE_BANDS}

COMMUNITY_SIZE_ORDER = ["XXS", "XS", "XS/S", "S", "S/M", "M", "M/L", "L",
                        "L/1X", "1X", "1X/2X", "2X", "2X/3X", "3X", "3X/4X",
                        "4X", "5X", "F"]

# Style-Quiz size_range -> concrete size labels (split sizes overlap ranges).
QUIZ_SIZE_RANGE_SIZES = {
    "xs_s": ["XXS", "XS", "XS/S", "S", "S/M"],
    "m_l": ["S/M", "M", "M/L", "L", "L/1X"],
    "xl_2x": ["L/1X", "1X", "1X/2X", "2X", "2X/3X"],
    "3x_up": ["2X/3X", "3X", "3X/4X", "4X", "5X"],
}

COMMUNITY_SHOP_SORTS = ("new", "price_asc", "price_desc", "best")


def _refresh_badges():
    """Recompute the badge map off the request path (background thread)."""
    try:
        mp = _compute_badges()
        with _badges_lock:
            _badges_cache["map"] = mp
            _badges_cache["ts"] = time.time()
    except Exception:
        log.exception("community badge computation failed")
        with _badges_lock:
            # Keep the previous map; retry sooner than a full TTL.
            _badges_cache["ts"] = time.time() - _BADGES_TTL + _BADGES_RETRY
    finally:
        with _badges_lock:
            _badges_cache["refreshing"] = False


def _badge_map():
    """Current badge map without ever blocking a customer request: a stale
    (or empty, at boot) map is served as-is while one background thread
    refreshes. Badges are decorative — they must never break the shop."""
    with _badges_lock:
        if (time.time() - _badges_cache["ts"] >= _BADGES_TTL
                and not _badges_cache["refreshing"]):
            _badges_cache["refreshing"] = True
            threading.Thread(target=_refresh_badges, daemon=True,
                             name="community-badges").start()
        return _badges_cache["map"]


def _stamp_badges(resp):
    """Overlay current badges on a products payload at response time (fresh
    copies — the cached payload stays unstamped) so a payload cached while
    the badge map was cold never pins badge-less cards for a full TTL."""
    badges = _badge_map()
    return {**resp, "items": [
        {**i, "badge": badges.get((i.get("style_name"), i.get("color")))}
        for i in resp.get("items", [])
    ]}


def _stamp_pdp_badge(resp):
    """Same, for the PDP payload (name == style_name)."""
    return {**resp,
            "badge": _badge_map().get((resp.get("name"), resp.get("color")))}


@contextmanager
def _db():
    """Bounded DB access. Borrow from the host API server's connection pool
    (A._acquire_conn waits briefly then 503s cleanly when saturated) so
    public traffic can never exhaust raw Postgres connections; fall back to
    a short-lived direct connection when running outside api_pg."""
    if A is not None and hasattr(A, "_acquire_conn"):
        pool, conn = A._acquire_conn()
        try:
            conn.autocommit = False    # pool conns may arrive autocommit=True
            yield conn
            try:
                conn.rollback()        # drop any uncommitted (read-only) tx
            except Exception:
                pass
        except HTTPException:
            # Application-level error (400/401/429…): connection is healthy.
            try:
                conn.rollback()
                pool.putconn(conn)
            except Exception:
                pool.putconn(conn, close=True)
            raise
        except Exception:
            # Unknown failure: never return a possibly-poisoned conn.
            pool.putconn(conn, close=True)
            raise
        else:
            pool.putconn(conn)
    else:
        conn = _conn()
        try:
            yield conn
        finally:
            conn.close()


def _cache_put(cache, key, value, cap=256):
    """Insert into a ts-keyed cache, evicting the oldest entries at cap."""
    if len(cache) >= cap:
        for k in sorted(cache, key=lambda k: cache[k][0])[: max(1, cap // 8)]:
            cache.pop(k, None)
    cache[key] = (time.time(), value)


def _rate_ok(key, limit, window_sec):
    now = time.time()
    with _RL_LOCK:
        if key not in _RL_HITS and len(_RL_HITS) >= _RL_MAX_KEYS:
            # Memory valve 1: sweep stale buckets before admitting a new key.
            cutoff = now - 3600
            for k in list(_RL_HITS):
                dq = _RL_HITS[k]
                while dq and dq[0] < cutoff:
                    dq.popleft()
                if not dq:
                    _RL_HITS.pop(k, None)
            # Memory valve 2: hard cap. If forged never-seen keys keep arriving
            # (e.g. spoofed client hints), evict the oldest-inserted buckets so
            # the table can NEVER grow beyond _RL_MAX_KEYS.
            if len(_RL_HITS) >= _RL_MAX_KEYS:
                for k in list(_RL_HITS)[: max(1, _RL_MAX_KEYS // 20)]:
                    _RL_HITS.pop(k, None)
        dq = _RL_HITS.setdefault(key, collections.deque())
        cut = now - window_sec
        while dq and dq[0] < cut:
            dq.popleft()
        if len(dq) >= limit:
            return False
        dq.append(now)
        return True


def _client_ip(request):
    # Behind the platform proxy the LAST X-Forwarded-For entry is the one the
    # trusted proxy appended (the real peer). Earlier entries are client-supplied
    # and trivially spoofable, so they must never feed rate-limit keys.
    xff = (request.headers.get("x-forwarded-for") or "")
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            return parts[-1][:64]
    return request.client.host if request.client else "unknown"


def _throttle(request, scope, rules, phone=None):
    """rules: [(dim, limit, window_sec)] with dim in 'ip'|'phone'|'global'.
    Raises 429 when any bucket is exhausted."""
    ip = _client_ip(request)
    for dim, limit, window in rules:
        # window in the key: same-dimension rules must NOT share a bucket
        # (they'd double-count every hit and halve the effective limit).
        if dim == "ip":
            key = f"{scope}:ip:{ip}:{window}"
        elif dim == "phone":
            if not phone:
                continue
            key = f"{scope}:ph:{phone}:{window}"
        else:
            key = f"{scope}:g:{window}"
        if not _rate_ok(key, limit, window):
            # PII minimisation: never log the raw key — the phone-dimension
            # key embeds the customer's phone number. Log scope/dim/window
            # plus a short hash of the key so distinct offenders remain
            # correlatable without exposing the identifier.
            key_h = hashlib.sha256(key.encode()).hexdigest()[:12]
            log.warning("community throttle hit: scope=%s dim=%s window=%s key_hash=%s",
                        scope, dim, window, key_h)
            raise HTTPException(status_code=429,
                                detail="Too many requests — please try again shortly")


def _ensure_tables():
    global _tables_ready
    if _tables_ready:
        return
    with _tables_lock:
        if _tables_ready:
            return
        ddl = """
        CREATE TABLE IF NOT EXISTS community_members (
            id SERIAL PRIMARY KEY,
            phone TEXT UNIQUE NOT NULL,
            full_name TEXT NOT NULL,
            email TEXT NOT NULL,
            dob DATE,
            consent_at TIMESTAMPTZ NOT NULL,
            customer_id TEXT,
            customer_store_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_login_at TIMESTAMPTZ
        );
        ALTER TABLE community_members ADD COLUMN IF NOT EXISTS username TEXT;
        ALTER TABLE community_members ADD COLUMN IF NOT EXISTS show_tier BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE community_members ADD COLUMN IF NOT EXISTS show_leaderboard BOOLEAN NOT NULL DEFAULT TRUE;
        ALTER TABLE community_members ADD COLUMN IF NOT EXISTS consent_terms_version TEXT;
        -- Referral codes are opaque public handles; the member id and contact
        -- details never travel in a share link. A referrer is captured once,
        -- when a genuinely new member completes signup.
        ALTER TABLE community_members ADD COLUMN IF NOT EXISTS referral_code TEXT;
        ALTER TABLE community_members ADD COLUMN IF NOT EXISTS referred_by_member_id INT
            REFERENCES community_members(id);
        CREATE UNIQUE INDEX IF NOT EXISTS community_members_username_uq
            ON community_members (LOWER(username)) WHERE username IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS community_members_referral_code_uq
            ON community_members (referral_code) WHERE referral_code IS NOT NULL;
        -- Backfill existing members with a placeholder handle (first name +
        -- member id, unique by construction) they can change in Profile.
        UPDATE community_members
           SET username = COALESCE(NULLIF(left(regexp_replace(lower(split_part(full_name, ' ', 1)), '[^a-z0-9]', '', 'g'), 12), ''), 'member') || '.' || id::text
         WHERE username IS NULL;
        CREATE TABLE IF NOT EXISTS community_otp (
            phone TEXT PRIMARY KEY,
            code TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            attempts INT NOT NULL DEFAULT 0,
            last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS community_sessions (
            token_hash TEXT PRIMARY KEY,
            member_id INT,
            phone TEXT NOT NULL,
            purpose TEXT NOT NULL DEFAULT 'member',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at TIMESTAMPTZ NOT NULL
        );
        -- Reward redemptions (currently the personalised embroidered tank).
        -- The row IS the points ledger: spendable = lifetime − SUM(points_cost)
        -- over non-cancelled rows. Uploaded designs live inline as BYTEA
        -- (capped at ~3MB, magic-byte checked) like other in-house imagery.
        CREATE TABLE IF NOT EXISTS community_redemptions (
            id SERIAL PRIMARY KEY,
            member_id INT NOT NULL REFERENCES community_members(id),
            reward_key TEXT NOT NULL,
            points_cost INT NOT NULL,
            sku TEXT, size TEXT, colour TEXT,
            embroidery_type TEXT,
            monogram_text TEXT, monogram_style TEXT,
            design_image BYTEA, design_mime TEXT,
            collection_method TEXT, pickup_store TEXT,
            status TEXT NOT NULL DEFAULT 'in_review',
            status_note TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- Independent point earns (Style Quiz bonus today, missions later).
        -- UNIQUE(member_id, kind) makes one-time bonuses idempotent at the
        -- schema level: a retake or a double-tap can never award twice.
        CREATE TABLE IF NOT EXISTS community_points_events (
            id SERIAL PRIMARY KEY,
            member_id INT NOT NULL REFERENCES community_members(id),
            kind TEXT NOT NULL,
            points INT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (member_id, kind)
        );
        -- At most one referrer can earn for a referred member. This is the
        -- durable guard around the referral ledger event, not a UI promise.
        CREATE TABLE IF NOT EXISTS community_referral_rewards (
            referred_member_id INT PRIMARY KEY REFERENCES community_members(id),
            referrer_member_id INT NOT NULL REFERENCES community_members(id),
            awarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (referred_member_id <> referrer_member_id)
        );
        -- Style Quiz answers + composed Style DNA, one row per member. The
        -- size_range / fit_lean answers are private (member-only, never on
        -- community surfaces); shared_at records the explicit opt-in share.
        CREATE TABLE IF NOT EXISTS community_style_quiz (
            member_id INT PRIMARY KEY REFERENCES community_members(id),
            answers JSONB NOT NULL DEFAULT '{}'::jsonb,
            dna JSONB,
            completed_at TIMESTAMPTZ,
            shared_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- "Styled for You" preferences — weekly personalised recommendations
        -- are strictly OPT-IN (opted_in flips only on an explicit member
        -- action; opted_in_at records the consent moment). use_activity is
        -- her permission to use purchase history for the picks.
        CREATE TABLE IF NOT EXISTS community_style_prefs (
            member_id INT PRIMARY KEY REFERENCES community_members(id),
            opted_in BOOLEAN NOT NULL DEFAULT FALSE,
            opted_in_at TIMESTAMPTZ,
            size TEXT NOT NULL DEFAULT '',
            fit TEXT NOT NULL DEFAULT '',
            colours JSONB NOT NULL DEFAULT '[]'::jsonb,
            print_preferences JSONB NOT NULL DEFAULT '[]'::jsonb,
            colour_shades JSONB NOT NULL DEFAULT '[]'::jsonb,
            fabrics JSONB NOT NULL DEFAULT '[]'::jsonb,
            categories JSONB NOT NULL DEFAULT '[]'::jsonb,
            interests JSONB NOT NULL DEFAULT '[]'::jsonb,
            avoid JSONB NOT NULL DEFAULT '[]'::jsonb,
            frequency TEXT NOT NULL DEFAULT 'weekly',
            notify_push BOOLEAN NOT NULL DEFAULT TRUE,
            notify_email BOOLEAN NOT NULL DEFAULT FALSE,
            -- purchase-history personalisation is a SEPARATE consent:
            -- off by default, only an explicit member action turns it on
            use_activity BOOLEAN NOT NULL DEFAULT FALSE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE community_style_prefs
            ADD COLUMN IF NOT EXISTS print_preferences JSONB NOT NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS colour_shades JSONB NOT NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS fabrics JSONB NOT NULL DEFAULT '[]'::jsonb;
        -- "About your Vivo journey" — customer-insight record collected on the
        -- Style Preferences page (merged from the old "Help us dress you
        -- better" survey). Kept SEPARATE from community_style_prefs: prefs
        -- drive the recommendation engine, this is a one-off insight profile.
        CREATE TABLE IF NOT EXISTS community_journey_profile (
            member_id INT PRIMARY KEY REFERENCES community_members(id),
            tenure TEXT NOT NULL DEFAULT '',
            discovery TEXT NOT NULL DEFAULT '',
            shop_frequency TEXT NOT NULL DEFAULT '',
            feedback TEXT NOT NULL DEFAULT '',
            completed_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS community_redemptions_member_idx
            ON community_redemptions (member_id, created_at DESC);
        -- Event RSVPs: one row per (event, member); cancelling flips status
        -- (history survives, re-RSVP is an UPDATE). Events themselves are
        -- code-seeded — see COMMUNITY_EVENTS.
        CREATE TABLE IF NOT EXISTS community_event_rsvps (
            id SERIAL PRIMARY KEY,
            event_id TEXT NOT NULL,
            member_id INT NOT NULL REFERENCES community_members(id),
            status TEXT NOT NULL DEFAULT 'confirmed',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            waitlisted_at TIMESTAMPTZ,
            UNIQUE (event_id, member_id)
        );
        -- waitlisted_at orders the waitlist queue (set when a member joins
        -- it; kept on promotion for audit). ALTER covers pre-waitlist DBs.
        ALTER TABLE community_event_rsvps
            ADD COLUMN IF NOT EXISTS waitlisted_at TIMESTAMPTZ;
        CREATE INDEX IF NOT EXISTS community_event_rsvps_event_idx
            ON community_event_rsvps (event_id) WHERE status = 'confirmed';
        -- One row per event, used only as a FOR UPDATE handle so concurrent
        -- RSVP confirms serialize per event. Row locks inside a single
        -- transaction survive the txn-mode pooler (advisory locks do not).
        CREATE TABLE IF NOT EXISTS community_event_locks (
            event_id TEXT PRIMARY KEY
        );
        -- Contact Us messages: member-submitted from the app's Contact form,
        -- reviewed by care staff in the CRM app (/api/crm/community-contact*).
        -- Photos inline as BYTEA (3MB cap, magic-byte checked) like designs.
        CREATE TABLE IF NOT EXISTS community_contact_messages (
            id SERIAL PRIMARY KEY,
            member_id INT NOT NULL REFERENCES community_members(id),
            subject TEXT NOT NULL,
            message TEXT NOT NULL,
            photo BYTEA, photo_mime TEXT,
            status TEXT NOT NULL DEFAULT 'new',
            staff_note TEXT,
            handled_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS community_contact_status_idx
            ON community_contact_messages (status, created_at DESC);
        -- Virtual Try-On: member photos (private, BYTEA like other in-house
        -- imagery) and generated looks. Photos cap at TRYON_PHOTO_CAP per
        -- member; looks count against a weekly per-tier allowance (failed
        -- attempts never count). Deleting a photo keeps finished looks
        -- (photo_id goes NULL); deleting the member cascades everything.
        CREATE TABLE IF NOT EXISTS community_tryon_photos (
            id SERIAL PRIMARY KEY,
            member_id INT NOT NULL REFERENCES community_members(id) ON DELETE CASCADE,
            image BYTEA NOT NULL,
            mime TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS community_tryon_photos_member_idx
            ON community_tryon_photos (member_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS community_tryon_looks (
            id SERIAL PRIMARY KEY,
            member_id INT NOT NULL REFERENCES community_members(id) ON DELETE CASCADE,
            photo_id INT REFERENCES community_tryon_photos(id) ON DELETE SET NULL,
            product_sku TEXT NOT NULL,
            product_name TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',
            error TEXT,
            result BYTEA,
            result_mime TEXT,
            demo BOOLEAN NOT NULL DEFAULT FALSE,
            is_shared BOOLEAN NOT NULL DEFAULT FALSE,
            shared_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS community_tryon_looks_member_idx
            ON community_tryon_looks (member_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS community_tryon_looks_shared_idx
            ON community_tryon_looks (shared_at DESC) WHERE is_shared;

        CREATE TABLE IF NOT EXISTS community_content_consents (
            id SERIAL PRIMARY KEY,
            member_id INT NOT NULL REFERENCES community_members(id) ON DELETE CASCADE,
            content_type TEXT NOT NULL,
            content_id INT NOT NULL,
            marketing_ok BOOLEAN NOT NULL DEFAULT FALSE,
            granted_at TIMESTAMPTZ,
            withdrawn_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            history JSONB NOT NULL DEFAULT '[]'::jsonb,
            UNIQUE (member_id, content_type, content_id)
        );
        CREATE TABLE IF NOT EXISTS community_data_requests (
            id SERIAL PRIMARY KEY,
            member_id INT NOT NULL REFERENCES community_members(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            note TEXT,
            status TEXT NOT NULL DEFAULT 'open',
            staff_note TEXT,
            handled_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE community_content_consents
            ADD COLUMN IF NOT EXISTS history JSONB NOT NULL DEFAULT '[]'::jsonb;
        CREATE UNIQUE INDEX IF NOT EXISTS community_data_requests_open_uniq
            ON community_data_requests (member_id, kind) WHERE status = 'open';
        CREATE INDEX IF NOT EXISTS community_data_requests_member_idx
            ON community_data_requests (member_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS community_contact_messages_member_idx
            ON community_contact_messages (member_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS community_survey_waves (
            id SERIAL PRIMARY KEY,
            wave_key TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            questions JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            closed_at TIMESTAMPTZ
        );
        CREATE TABLE IF NOT EXISTS community_survey_responses (
            id SERIAL PRIMARY KEY,
            wave_id INT NOT NULL REFERENCES community_survey_waves(id),
            member_id INT NOT NULL REFERENCES community_members(id) ON DELETE CASCADE,
            answers JSONB NOT NULL DEFAULT '{}'::jsonb,
            nps INT,
            tier_at TEXT,
            member_since TIMESTAMPTZ,
            duration_secs INT,
            completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (wave_id, member_id)
        );
        CREATE INDEX IF NOT EXISTS community_survey_responses_wave_idx
            ON community_survey_responses (wave_id, completed_at DESC);
        CREATE TABLE IF NOT EXISTS community_survey_dismissals (
            wave_id INT NOT NULL REFERENCES community_survey_waves(id),
            member_id INT NOT NULL REFERENCES community_members(id) ON DELETE CASCADE,
            count INT NOT NULL DEFAULT 1,
            last_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (wave_id, member_id)
        );
        -- Interactive feed: DB-backed posts (seeded from the launch content
        -- set), real per-member likes and comments, member reports feeding
        -- the staff review queue in the CRM app.
        CREATE TABLE IF NOT EXISTS community_feed_posts (
            id SERIAL PRIMARY KEY,
            mock_key TEXT UNIQUE,
            author_member_id INT REFERENCES community_members(id) ON DELETE SET NULL,
            author_username TEXT NOT NULL,
            author_initials TEXT NOT NULL DEFAULT 'V',
            author_tier TEXT,
            author_show_tier BOOLEAN NOT NULL DEFAULT FALSE,
            caption TEXT NOT NULL DEFAULT '',
            variant TEXT NOT NULL DEFAULT 'standard',
            visual TEXT NOT NULL DEFAULT 'light',
            tagged JSONB NOT NULL DEFAULT '[]'::jsonb,
            like_seed INT NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'approved',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS community_feed_posts_status_idx
            ON community_feed_posts (status, created_at DESC);
        CREATE TABLE IF NOT EXISTS community_post_likes (
            post_id INT NOT NULL REFERENCES community_feed_posts(id) ON DELETE CASCADE,
            member_id INT NOT NULL REFERENCES community_members(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (post_id, member_id)
        );
        CREATE TABLE IF NOT EXISTS community_post_comments (
            id SERIAL PRIMARY KEY,
            post_id INT NOT NULL REFERENCES community_feed_posts(id) ON DELETE CASCADE,
            member_id INT NOT NULL REFERENCES community_members(id) ON DELETE CASCADE,
            body TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'visible',
            removed_by TEXT,
            removed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS community_post_comments_post_idx
            ON community_post_comments (post_id, status, created_at);
        CREATE TABLE IF NOT EXISTS community_comment_likes (
            comment_id INT NOT NULL REFERENCES community_post_comments(id) ON DELETE CASCADE,
            member_id INT NOT NULL REFERENCES community_members(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (comment_id, member_id)
        );
        CREATE TABLE IF NOT EXISTS community_comment_reports (
            id SERIAL PRIMARY KEY,
            comment_id INT NOT NULL REFERENCES community_post_comments(id) ON DELETE CASCADE,
            reporter_member_id INT NOT NULL REFERENCES community_members(id) ON DELETE CASCADE,
            reason TEXT,
            status TEXT NOT NULL DEFAULT 'open',
            resolved_by TEXT,
            resolved_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (comment_id, reporter_member_id)
        );
        -- Campaign articles ("Join the Conversation" blog). Comments mirror
        -- the feed-comment tables one-for-one so the UI + moderation model
        -- stay familiar; reports get their own table (reviewable via CRM
        -- later, DB-review is the v1 contract).
        CREATE TABLE IF NOT EXISTS community_articles (
            id SERIAL PRIMARY KEY,
            slug TEXT NOT NULL UNIQUE,
            article_type TEXT NOT NULL DEFAULT 'campaign',
            title TEXT NOT NULL,
            subheading TEXT,
            cover_image TEXT,
            tag TEXT,
            subject TEXT,
            byline TEXT,
            gallery JSONB NOT NULL DEFAULT '[]'::jsonb,
            body JSONB NOT NULL DEFAULT '[]'::jsonb,
            published_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE community_articles
            ADD COLUMN IF NOT EXISTS article_type TEXT NOT NULL DEFAULT 'campaign',
            ADD COLUMN IF NOT EXISTS subject TEXT,
            ADD COLUMN IF NOT EXISTS byline TEXT,
            ADD COLUMN IF NOT EXISTS gallery JSONB NOT NULL DEFAULT '[]'::jsonb;
        CREATE TABLE IF NOT EXISTS community_article_comments (
            id SERIAL PRIMARY KEY,
            article_id INT NOT NULL REFERENCES community_articles(id) ON DELETE CASCADE,
            member_id INT NOT NULL REFERENCES community_members(id) ON DELETE CASCADE,
            body TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'visible',
            removed_by TEXT,
            removed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS community_article_comments_article_idx
            ON community_article_comments (article_id, status, created_at);
        CREATE TABLE IF NOT EXISTS community_article_comment_likes (
            comment_id INT NOT NULL REFERENCES community_article_comments(id) ON DELETE CASCADE,
            member_id INT NOT NULL REFERENCES community_members(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (comment_id, member_id)
        );
        CREATE TABLE IF NOT EXISTS community_article_comment_reports (
            id SERIAL PRIMARY KEY,
            comment_id INT NOT NULL REFERENCES community_article_comments(id) ON DELETE CASCADE,
            reporter_member_id INT NOT NULL REFERENCES community_members(id) ON DELETE CASCADE,
            reason TEXT,
            status TEXT NOT NULL DEFAULT 'open',
            resolved_by TEXT,
            resolved_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (comment_id, reporter_member_id)
        );
        -- Interactive challenges. Entries ARE community_feed_posts rows
        -- (challenge_id set) so likes, comments, reports and the CRM
        -- moderation queue reuse the feed machinery unchanged. Photos sit
        -- in a sidecar table to keep BYTEA out of feed row scans. The
        -- main feed excludes entry rows (challenge_id IS NULL filter).
        CREATE TABLE IF NOT EXISTS community_challenges (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            hashtag TEXT,
            description TEXT NOT NULL DEFAULT '',
            rules TEXT NOT NULL DEFAULT '',
            caption_prompt TEXT,
            points INT NOT NULL DEFAULT 50,
            prize TEXT,
            deadline TIMESTAMPTZ NOT NULL,
            voting_enabled BOOLEAN NOT NULL DEFAULT FALSE,
            is_flagship BOOLEAN NOT NULL DEFAULT FALSE,
            entry_seed INT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE community_feed_posts
            ADD COLUMN IF NOT EXISTS challenge_id TEXT
                REFERENCES community_challenges(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS entry_status TEXT,
            ADD COLUMN IF NOT EXISTS marketing_ok BOOLEAN,
            ADD COLUMN IF NOT EXISTS winner_position SMALLINT,
            ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS post_type TEXT NOT NULL DEFAULT 'look',
            ADD COLUMN IF NOT EXISTS fit_note JSONB,
            ADD COLUMN IF NOT EXISTS image_url TEXT,
            ADD COLUMN IF NOT EXISTS media_kind TEXT;
        ALTER TABLE community_challenges
            ADD COLUMN IF NOT EXISTS deciding TEXT NOT NULL
                DEFAULT 'community_shortlist';
        CREATE INDEX IF NOT EXISTS community_feed_posts_challenge_idx
            ON community_feed_posts (challenge_id, entry_status)
            WHERE challenge_id IS NOT NULL;
        -- one ACTIVE (pending or published) entry per member per challenge;
        -- a rejected entry frees the slot so she can try again
        CREATE UNIQUE INDEX IF NOT EXISTS community_one_active_entry_idx
            ON community_feed_posts (challenge_id, author_member_id)
            WHERE challenge_id IS NOT NULL AND author_member_id IS NOT NULL
              AND entry_status IN ('pending', 'published');
        CREATE TABLE IF NOT EXISTS community_entry_photos (
            post_id INT PRIMARY KEY
                REFERENCES community_feed_posts(id) ON DELETE CASCADE,
            image BYTEA NOT NULL,
            mime TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS community_challenge_votes (
            challenge_id TEXT NOT NULL
                REFERENCES community_challenges(id) ON DELETE CASCADE,
            member_id INT NOT NULL
                REFERENCES community_members(id) ON DELETE CASCADE,
            post_id INT NOT NULL
                REFERENCES community_feed_posts(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (challenge_id, member_id)
        );
        -- Vivo Edits: creator-curated editorial shopping stories. Staff manage
        -- them in the CRM app (/api/crm/community-edits*); the member app shows
        -- active edits on Home (max 3 featured) plus a detail page. Each active
        -- edit mirrors into ONE community_feed_posts row (mock_key
        -- 'vivoedit_<id>') so likes/comments/shares reuse the feed machinery;
        -- archiving an edit hides (never deletes) its feed post. Images inline
        -- as BYTEA (3MB cap, magic-byte checked) like other in-house imagery;
        -- tagged product JSONB uses the feed's [{sku,name,price}] shape.
        CREATE TABLE IF NOT EXISTS community_edits (
            id SERIAL PRIMARY KEY,
            edit_key TEXT UNIQUE,
            creator_name TEXT NOT NULL,
            creator_username TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            intro TEXT NOT NULL DEFAULT '',
            disclosure TEXT,
            featured BOOLEAN NOT NULL DEFAULT FALSE,
            sort_order INT NOT NULL DEFAULT 100,
            starts_at TIMESTAMPTZ,
            ends_at TIMESTAMPTZ,
            archived_at TIMESTAMPTZ,
            feed_post_id INT REFERENCES community_feed_posts(id)
                ON DELETE SET NULL,
            tagged JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS community_edits_active_idx
            ON community_edits (featured DESC, sort_order, created_at DESC)
            WHERE archived_at IS NULL;
        CREATE TABLE IF NOT EXISTS community_edit_images (
            id SERIAL PRIMARY KEY,
            edit_id INT NOT NULL REFERENCES community_edits(id)
                ON DELETE CASCADE,
            image BYTEA NOT NULL,
            mime TEXT NOT NULL,
            position INT NOT NULL DEFAULT 0,
            alt_text TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS community_edit_images_edit_idx
            ON community_edit_images (edit_id, position, id);
        -- Restock alerts: members subscribe to be notified when a sold-out
        -- size comes back in stock. UNIQUE(member_id, sku) deduplicates taps.
        -- notified_at is NULL while pending; set to now() once the email fires
        -- (the row is retained for audit — a second restock won't re-notify
        -- unless the member signs up again after cancelling).
        CREATE TABLE IF NOT EXISTS community_restock_alerts (
            id SERIAL PRIMARY KEY,
            member_id INT NOT NULL REFERENCES community_members(id) ON DELETE CASCADE,
            sku TEXT NOT NULL,
            style_name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '',
            size TEXT NOT NULL DEFAULT '',
            notified_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (member_id, sku)
        );
        CREATE INDEX IF NOT EXISTS community_restock_alerts_pending_idx
            ON community_restock_alerts (sku, style_name, color)
            WHERE notified_at IS NULL;
        """
        with _db() as conn:
            with conn.cursor() as cur:
                cur.execute(ddl)
                # Survey wave 1 seed — idempotent, and it keeps wave 1's
                # title/questions in sync with the constants (additive
                # mid-wave edits only; future waves are new rows).
                cur.execute(
                    """INSERT INTO community_survey_waves (wave_key, title, questions)
                       VALUES (%s, %s, %s::jsonb)
                       ON CONFLICT (wave_key) DO UPDATE
                           SET title = EXCLUDED.title,
                               questions = EXCLUDED.questions
                         WHERE community_survey_waves.title IS DISTINCT FROM EXCLUDED.title
                            OR community_survey_waves.questions IS DISTINCT FROM EXCLUDED.questions""",
                    (SURVEY_WAVE1_KEY, SURVEY_WAVE1_TITLE,
                     json.dumps(SURVEY_WAVE1_QUESTIONS)))
                # Launch campaign article seed — same upsert contract as the
                # survey wave: constants win only when they actually differ.
                cur.execute(
                    """INSERT INTO community_articles
                           (slug, article_type, title, subheading, cover_image,
                            tag, subject, byline, gallery, body)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb)
                       ON CONFLICT (slug) DO UPDATE
                           SET article_type = EXCLUDED.article_type,
                               title = EXCLUDED.title,
                               subheading = EXCLUDED.subheading,
                               cover_image = EXCLUDED.cover_image,
                               tag = EXCLUDED.tag,
                               subject = EXCLUDED.subject,
                               byline = EXCLUDED.byline,
                               gallery = EXCLUDED.gallery,
                               body = EXCLUDED.body
                         WHERE community_articles.article_type IS DISTINCT FROM EXCLUDED.article_type
                            OR community_articles.title IS DISTINCT FROM EXCLUDED.title
                            OR community_articles.subheading IS DISTINCT FROM EXCLUDED.subheading
                            OR community_articles.cover_image IS DISTINCT FROM EXCLUDED.cover_image
                            OR community_articles.tag IS DISTINCT FROM EXCLUDED.tag
                            OR community_articles.subject IS DISTINCT FROM EXCLUDED.subject
                            OR community_articles.byline IS DISTINCT FROM EXCLUDED.byline
                            OR community_articles.gallery IS DISTINCT FROM EXCLUDED.gallery
                            OR community_articles.body IS DISTINCT FROM EXCLUDED.body""",
                    (_ARTICLE_SEED["slug"], _ARTICLE_SEED["article_type"],
                     _ARTICLE_SEED["title"],
                     _ARTICLE_SEED["subheading"], _ARTICLE_SEED["cover_image"],
                     _ARTICLE_SEED["tag"], _ARTICLE_SEED["subject"],
                     _ARTICLE_SEED["byline"], json.dumps(_ARTICLE_SEED["gallery"]),
                     json.dumps(_ARTICLE_SEED["body"])))
                # Spotlight stories are launch content, not system defaults:
                # create each one once but never overwrite a future interview
                # or gallery replacement made by the Community team.
                for article in _SPOTLIGHT_ARTICLE_SEEDS:
                    cur.execute(
                        """INSERT INTO community_articles
                               (slug, article_type, title, subheading, cover_image,
                                tag, subject, byline, gallery, body)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb)
                           ON CONFLICT (slug) DO NOTHING""",
                        (article["slug"], article["article_type"], article["title"],
                         article["subheading"], article["cover_image"], article["tag"],
                         article["subject"], article["byline"],
                         json.dumps(article["gallery"]), json.dumps(article["body"])))
                _seed_feed_posts(cur)
                _seed_challenges(cur)
                _seed_vivo_edits(cur)
            conn.commit()
            _tables_ready = True


# ---------------------------------------------------------------------------
# Interactive feed seed — the launch content set (previously frontend mock
# data). Inserts once when community_feed_posts is empty; shoppable tags come
# from the live catalogue, and posts seeded before the catalogue was loaded
# (fresh production boots) get their tags healed on a later boot.
_SEED_MEMBER_ROWS = [
    # (phone, username, full_name) — real member rows so seeded comments
    # have genuine authors (comment reads join community_members). Reserved
    # 2547000001xx range; excluded from "new jewels" in celebrations.
    ("254700000101", "asha.k", "Asha Kamau"),
    ("254700000102", "wanjiku.m", "Wanjiku Mwangi"),
    ("254700000103", "achieng.o", "Achieng Odhiambo"),
    ("254700000104", "zawadi.n", "Zawadi Njeri"),
    ("254700000105", "makena_w", "Makena Wambui"),
    ("254700000106", "nyambura.k", "Nyambura Kariuki"),
    ("254700000107", "halima.s", "Halima Said"),
    ("254700000108", "njoki.g", "Njoki Gathoni"),
]

_FEED_SEED_POSTS = [
    # v2 launch content: the feed teaches its own purpose — outfit moments
    # with occasions, #MyVivoStory posts, style questions with genuine
    # answers, and hauls. Tags + product imagery resolve from the live
    # catalogue; a few authors show their tier gem, most don't (privacy
    # model in the samples).
    dict(key="fp2_kimono", u="asha.k", ini="AK", tier="Tanzanite", show=True,
         type="look", variant="standard", visual="light", likes=134, hrs=3,
         tags=1, fit=None,
         cap="Wore the Safari Print Kimono to my daughter's graduation — "
             "proudest day of my life, best-dressed mum on the lawn 😄 "
             "#MyVivoStory",
         comments=[("wanjiku.m", "Congratulations mama! You must have "
                                 "glowed 🧡"),
                   ("njoki.g", "The kimono was MADE for days like this")]),
    dict(key="fp2_wrap3", u="wanjiku.m", ini="WM", tier="Ruby", show=False,
         type="look", variant="standard", visual="dark", likes=98, hrs=7,
         tags=1, fit=None,
         cap="Three weddings this year, one Vivo wrap dress. Different "
             "shoes, different lipstick, zero repeats noticed — and "
             "honestly I'd wear it to a fourth. #MyVivoStory",
         comments=[]),
    dict(key="fp2_q_anga", u="halima.s", ini="HS", tier="Tsavorite",
         show=False, type="question", variant="quote", visual="light",
         likes=21, hrs=10, tags=1, fit=None,
         cap="Style question: how would you style the Anga Top for a work "
             "dinner? First dinner with the new team and I want "
             "easy-elegant, not trying-too-hard.",
         comments=[("asha.k", "High-waisted wide-leg trousers, one gold "
                              "cuff, done. You'll look like the "
                              "decision-maker you are"),
                   ("makena_w", "I did mine with a midi pencil skirt and "
                                "flats — elegant and you can still eat 😄")]),
    dict(key="fp2_q_maxi", u="zawadi.n", ini="ZN", tier="Tsavorite",
         show=False, type="question", variant="quote", visual="light",
         likes=33, hrs=14, tags=1, fit=None,
         cap="Fit question, honest answers please: I'm between sizes in "
             "the Amara Maxi. Size up for the flow or stay true for the "
             "shape?",
         comments=[("makena_w", "I sized up and belted it — best of both, "
                                "it flows when you walk"),
                   ("achieng.o", "True to size for me; the fabric relaxes "
                                 "about half a size by evening"),
                   ("njoki.g", "The store team let me try both — go with "
                               "your shoulders, the rest follows")]),
    dict(key="fp2_haul_moi", u="makena_w", ini="MW", tier="Tanzanite",
         show=True, type="haul", variant="landscape", visual="light",
         likes=76, hrs=20, tags=2, fit=None,
         cap="Little haul from the Moi Avenue store 😄 the ladies there "
             "deserve medals for their patience. Three prints, one denim, "
             "zero regrets.",
         comments=[("zawadi.n", "The Moi Avenue team is a national "
                                "treasure, agreed")]),
    dict(key="fp2_boardroom", u="achieng.o", ini="AO", tier="Ruby",
         show=True, type="look", variant="standard", visual="light",
         likes=145, hrs=26, tags=1, fit=None,
         cap="Kitenge blazer, boardroom Monday. If the quarterly review "
             "must happen, it will happen in print.",
         comments=[]),
    dict(key="fp2_sunday", u="njoki.g", ini="NG", tier="Tsavorite",
         show=False, type="look", variant="square", visual="light",
         likes=54, hrs=31, tags=1, fit=None,
         cap="Sunday brunch co-ord. Comfortable enough for seconds, chic "
             "enough for the group photo.",
         comments=[]),
    dict(key="fp2_q_shoes", u="wanjiku.m", ini="WM", tier="Ruby",
         show=False, type="question", variant="quote", visual="dark",
         likes=18, hrs=38, tags=0, fit=None,
         cap="Which shoes with a bold print midi — nude flats or a colour "
             "picked from the print? Wedding-guest duty on Saturday.",
         comments=[("halima.s", "Pick the quietest colour IN the print and "
                                "match it — always works")]),
    dict(key="fp2_haul_gift", u="nyambura.k", ini="NK", tier="Tanzanite",
         show=True, type="haul", variant="landscape", visual="dark",
         likes=112, hrs=48, tags=2, fit=None,
         cap="Gift-shopping haul: one piece for mum, one for my sister, "
             "and fine, two for me. Balance.",
         comments=[]),
    dict(key="fp2_travel", u="halima.s", ini="HS", tier="Tsavorite",
         show=False, type="look", variant="standard", visual="light",
         likes=87, hrs=55, tags=1, fit={"fit": "true", "size": "L"},
         cap="Nairobi to Kigali in the Amara Maxi — airport, meetings, "
             "dinner, same dress. Runs true to size and doesn't crease, "
             "which is frankly showing off.",
         comments=[]),
    dict(key="fp2_friday", u="zawadi.n", ini="ZN", tier="Tsavorite",
         show=False, type="look", variant="square", visual="light",
         likes=41, hrs=70, tags=1, fit=None,
         cap="Casual Friday but make it Vivo. The co-ord does all the "
             "work, I just answer emails.",
         comments=[]),
    dict(key="fp2_q_care", u="njoki.g", ini="NG", tier="Tsavorite",
         show=False, type="question", variant="quote", visual="light",
         likes=26, hrs=78, tags=0, fit=None,
         cap="How do you all care for your wax print pieces? First wash "
             "coming up and I'm nervous to lose the crispness.",
         comments=[("asha.k", "Cold hand wash, inside out, shade dry — "
                              "mine still look brand new after two years")]),
    dict(key="fp2_date", u="nyambura.k", ini="NK", tier="Tanzanite",
         show=True, type="look", variant="standard", visual="dark",
         likes=203, hrs=96, tags=1, fit=None,
         cap="Anniversary dinner in the Lamu Sunset Gown. Fifteen years "
             "and he still reached for my chair first 🧡",
         comments=[]),
    dict(key="fp2_story_first", u="asha.k", ini="AK", tier="Tanzanite",
         show=False, type="look", variant="quote", visual="light",
         likes=92, hrs=120, tags=0, fit=None,
         cap="My first Vivo piece was a graduation gift to myself in 2019. "
             "Six years later half my wardrobe is Vivo and every piece has "
             "a story. #MyVivoStory",
         comments=[]),
]


def _heal_seed_winners(cur):
    """Restore seeded demo winner ribbons when a podium slot is vacant.

    Fill-only: an existing (e.g. staff-picked) winner holds the slot; the
    heal never displaces a winner row, it only refills empty positions
    left by crashes or manual clearing."""
    for e in _ENTRY_SEEDS:
        key, wpos = e[0], e[-1]
        if not wpos:
            continue
        cur.execute(
            """UPDATE community_feed_posts fp SET winner_position = %s
                WHERE fp.mock_key = %s AND fp.winner_position IS NULL
                  AND NOT EXISTS (SELECT 1 FROM community_feed_posts x
                                   WHERE x.challenge_id = fp.challenge_id
                                     AND x.winner_position = %s)""",
            (wpos, key, wpos))


def _seed_feed_posts(cur):
    """Idempotent v2 launch-content seed. Retires the v1 'postN' rows,
    creates the seed-member cast (for genuine comment authorship), inserts
    the rich post set with catalogue tags + product imagery, and seeds the
    conversations. Runs inside _ensure_tables' transaction on a plain tuple
    cursor — catalogue presence is probed via to_regclass, never try/except."""
    from urllib.parse import quote
    keys = [p["key"] for p in _FEED_SEED_POSTS]
    cur.execute(
        "SELECT COUNT(*) FROM community_feed_posts WHERE mock_key = ANY(%s)",
        (keys,))
    have = int(cur.fetchone()[0] or 0)
    tag_keys = [p["key"] for p in _FEED_SEED_POSTS if p["tags"] > 0]
    if have == len(keys):
        cur.execute(
            """SELECT COUNT(*) FROM community_feed_posts
                WHERE mock_key = ANY(%s)
                  AND (tagged = '[]'::jsonb
                       OR (tagged <> '[]'::jsonb AND image_url IS NULL))""",
            (tag_keys,))
        _need = int(cur.fetchone()[0] or 0)
        _heal_seed_winners(cur)
        if not _need:
            return  # fully seeded, tagged and imaged — nothing to do

    # v1 rows retire (fictional-author posts only — member content is never
    # touched; real members were never able to write mock_key rows).
    cur.execute("""DELETE FROM community_feed_posts
                    WHERE mock_key LIKE 'post%'
                      AND author_member_id IS NULL
                      AND challenge_id IS NULL""")

    # Seed-member cast — guarded insert (phone OR username may already
    # exist; a real member always wins the name).
    for phone, uname, full in _SEED_MEMBER_ROWS:
        cur.execute(
            """INSERT INTO community_members
                   (phone, full_name, email, consent_at, username,
                    consent_terms_version)
               SELECT %s, %s, %s, now(), %s, 'launch-seed'
                WHERE NOT EXISTS (SELECT 1 FROM community_members
                                   WHERE phone = %s
                                      OR LOWER(username) = LOWER(%s))""",
            (phone, full, f"{uname}@members.vivo.example", uname,
             phone, uname))

    # Live-catalogue tags + product imagery (image column probed so the
    # seed works whatever the products table exposes).
    tags = []
    cur.execute("SELECT to_regclass('public.all_products_clean') IS NOT NULL"
                " AND to_regclass('public.all_inventory') IS NOT NULL"
                " AND to_regclass('public.product_image_map') IS NOT NULL"
                " AND to_regclass('public.product_images') IS NOT NULL")
    if cur.fetchone()[0]:
        cur.execute("""SELECT sku, style_name, price FROM (
                           SELECT DISTINCT ON (p.style_name) p.sku,
                                  p.style_name, p.price::float AS price
                           FROM all_products_clean p
                           JOIN (SELECT sku, SUM(COALESCE(available,0)) AS soh
                                   FROM all_inventory GROUP BY sku) i
                             ON i.sku = p.sku AND i.soh > 0
                           JOIN product_image_map pim ON pim.sku = p.sku
                           JOIN product_images pi
                             ON pi.tmpl_id = pim.tmpl_id
                                AND COALESCE(pi.image_512, '') <> ''
                           WHERE p.active IS TRUE
                             AND COALESCE(p.price::float, 0) > 0
                             AND COALESCE(p.style_name, '') <> ''
                           ORDER BY p.style_name, p.sku
                       ) t ORDER BY random() LIMIT 30""")
        tags = [{"sku": r[0], "name": r[1], "price": float(r[2] or 0),
                 "img": "/api/community/product-image/"
                        + quote(str(r[0]), safe="")}
                for r in cur.fetchall()]

    ti = 0

    def _take(n):
        nonlocal ti
        if not tags or n <= 0:
            return []
        out = [tags[(ti + k) % len(tags)] for k in range(n)]
        ti += n
        return out

    for p in _FEED_SEED_POSTS:
        picked = _take(p["tags"])
        clean = [{k: v for k, v in t.items() if k != "img"} for t in picked]
        img_url = next((t["img"] for t in picked if t.get("img")), None)
        cur.execute(
            """INSERT INTO community_feed_posts
                   (mock_key, author_username, author_initials, author_tier,
                    author_show_tier, caption, variant, visual, tagged,
                    like_seed, created_at, post_type, fit_note, image_url)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s,
                       now() - (%s || ' hours')::interval, %s, %s::jsonb, %s)
               ON CONFLICT (mock_key) DO NOTHING""",
            (p["key"], p["u"], p["ini"], p["tier"], p["show"], p["cap"],
             p["variant"], p["visual"], json.dumps(clean), p["likes"],
             p["hrs"], p["type"],
             json.dumps(p["fit"]) if p.get("fit") else None, img_url))

    # Tag/image self-heal — rows seeded on a fresh boot before the
    # catalogue existed pick their products up on a later boot.
    if tags:
        for p in _FEED_SEED_POSTS:
            if p["tags"] <= 0:
                continue
            picked = _take(p["tags"])
            clean = [{k: v for k, v in t.items() if k != "img"}
                     for t in picked]
            img_url = next((t["img"] for t in picked if t.get("img")), None)
            cur.execute(
                """UPDATE community_feed_posts
                      SET tagged = %s::jsonb,
                          image_url = COALESCE(image_url, %s)
                    WHERE mock_key = %s AND tagged = '[]'::jsonb""",
                (json.dumps(clean), img_url, p["key"]))
        # image-only heal: rows tagged by an earlier seed version pick up
        # their first tag's product image (sku URL-encoded — slash sizes).
        cur.execute(
            """SELECT mock_key, tagged->0->>'sku'
                 FROM community_feed_posts
                WHERE mock_key = ANY(%s) AND image_url IS NULL
                  AND tagged <> '[]'::jsonb""", (tag_keys,))
        for mk_, sku_ in cur.fetchall():
            if sku_:
                cur.execute(
                    """UPDATE community_feed_posts SET image_url = %s
                        WHERE mock_key = %s""",
                    ("/api/community/product-image/"
                     + quote(str(sku_), safe=""), mk_))

    # Seeded conversation — idempotent by (post, author, body).
    for p in _FEED_SEED_POSTS:
        for cu, body in p.get("comments") or ():
            cur.execute(
                """INSERT INTO community_post_comments
                       (post_id, member_id, body)
                   SELECT fp.id, m.id, %s
                     FROM community_feed_posts fp, community_members m
                    WHERE fp.mock_key = %s AND LOWER(m.username) = LOWER(%s)
                      AND NOT EXISTS (
                          SELECT 1 FROM community_post_comments c
                           WHERE c.post_id = fp.id AND c.member_id = m.id
                             AND c.body = %s)""",
                (body, p["key"], cu, body))


# Challenge catalogue + launch entries. Challenge rows are inserted ONCE
# (ON CONFLICT DO NOTHING) so deadlines are fixed at first boot and age
# naturally into the closed state. Seeded entries are showcase content by
# fictional authors (same approach as the feed seeds) so every gallery is
# browsable on day one; c3 closed three weeks ago with decided winners —
# the same three names the Past Winners section always showed.
_CHALLENGE_SEEDS = [
    # id, title, hashtag, description, rules, caption_prompt, points,
    # prize, days_from_now, voting, flagship, entry_seed
    ("c1", "#MyVivoStory", "#MyVivoStory",
     "Share why your Vivo piece makes you feel good. Earn 50 points when "
     "your story is published — plus a chance to be This Week's Jewel.",
     "Post a photo of you in your favourite Vivo piece and tell us the "
     "story behind it. One entry per member — our team reviews every "
     "entry before it goes live, and your points land the moment it's "
     "published.",
     "Tell us why this piece makes you feel good", 50,
     "This Week's Jewel feature", 4, False, True, 124),
    ("c2", "Style It 3 Ways", "#StyleIt3Ways",
     "Show us how you style one piece for work, weekend, and evening. The "
     "most versatile looks win — and you'll earn 75 points when your entry "
     "goes live.",
     "Pick one piece and photograph it styled three different ways. "
     "Community voting picks the crowd favourite; one vote per member.",
     "Which piece did you style — and how?", 75,
     "150pts style bonus + a feature in the app", 2, True, False, 42),
    ("c3", "Holiday Lights Edit", "#HolidayLights",
     "December's challenge: your festive Vivo look, from office parties to "
     "family lunches. Community votes crowned three winners.",
     "Closed — winners announced. Thank you to everyone who entered!",
     "Where did this festive look take you?", 50,
     "Featured looks + 150pts bonus", -21, True, False, 31),
]

_ENTRY_SEEDS = [
    # mock_key, challenge, username, initials, tier, show, caption,
    # variant, visual, like_seed, days_ago, winner_position
    ("entry_c1_1", "c1", "amina.k", "AK", "Ruby", False,
     "Three job interviews and a promotion later, this blazer is basically "
     "my lucky charm. It sits like it was cut for me. #MyVivoStory",
     "standard", "light", 31, 3, None),
    ("entry_c1_2", "c1", "njeri_styles", "NS", "Tsavorite", False,
     "Bought this dress the week I moved to Nairobi. Every time I wear it "
     "I remember how brave that felt. #MyVivoStory",
     "square", "dark", 24, 2, None),
    ("entry_c1_3", "c1", "zawadi.m", "ZM", "Tanzanite", True,
     "My mum said this print reminded her of her own mother's kitenge. Now "
     "it's the piece I wear when I need to feel held. #MyVivoStory",
     "standard", "light", 42, 2, None),
    ("entry_c1_4", "c1", "kui_wears", "KW", "Ruby", False,
     "First thing I ever saved up for after my first salary. Still my "
     "favourite thing I own. #MyVivoStory",
     "landscape", "dark", 18, 1, None),
    ("entry_c2_1", "c2", "wanjiku.m", "WM", "Tanzanite", False,
     "One wrap skirt: boardroom with a blazer, market day with a tee, "
     "dinner with heels and gold hoops. #StyleIt3Ways",
     "standard", "light", 27, 1, None),
    ("entry_c2_2", "c2", "makena_w", "MW", "Tanzanite", True,
     "The shirt dress that refuses to stay in one lane — belted, open as "
     "a duster, then knotted at the waist. #StyleIt3Ways",
     "square", "dark", 21, 1, None),
    ("entry_c2_3", "c2", "achieng.o", "AO", "Ruby", False,
     "Same palazzo trousers, three completely different moods. Proof you "
     "don't need a big wardrobe, just a clever one. #StyleIt3Ways",
     "standard", "light", 33, 0, None),
    ("entry_c3_1", "c3", "achieng.o", "AO", "Ruby", False,
     "Office party in emerald green — the compliments have not stopped. "
     "#HolidayLights",
     "standard", "dark", 58, 24, 1),
    ("entry_c3_2", "c3", "wanjiku.m", "WM", "Tanzanite", False,
     "Christmas lunch hosting look: comfortable enough for the kitchen, "
     "elegant enough for the photos. #HolidayLights",
     "square", "light", 46, 25, 2),
    ("entry_c3_3", "c3", "makena_w", "MW", "Tanzanite", True,
     "New Year's Eve in gold pleats. If you can't shine tonight, when? "
     "#HolidayLights",
     "standard", "dark", 41, 23, 3),
    ("entry_c3_4", "c3", "kui_wears", "KW", "Ruby", False,
     "Family photo day co-ordinated around my dress — no regrets. "
     "#HolidayLights",
     "landscape", "light", 22, 26, None),
    ("entry_c3_5", "c3", "njeri_styles", "NS", "Tsavorite", False,
     "Midnight service then straight to the afterparty. One look, both "
     "worlds. #HolidayLights",
     "square", "dark", 17, 24, None),
]


def _seed_challenges(cur):
    for (cid, title, tag, desc, rules, prompt, pts, prize, days, voting,
         flagship, eseed) in _CHALLENGE_SEEDS:
        cur.execute(
            """INSERT INTO community_challenges
                   (id, title, hashtag, description, rules, caption_prompt,
                    points, prize, deadline, voting_enabled, is_flagship,
                    entry_seed)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s,
                       now() + (%s || ' days')::interval, %s, %s, %s)
               ON CONFLICT (id) DO NOTHING""",
            (cid, title, tag, desc, rules, prompt, pts, prize, days,
             voting, flagship, eseed))
    # Winner model per challenge: community_shortlist (votes shortlist the
    # top ten, the team picks) is the default; team_pick skips public voting.
    # Idempotent UPDATE so existing rows adopt the config on any boot.
    for cid, dec in (("c1", "team_pick"), ("c2", "community_shortlist"),
                     ("c3", "community_shortlist")):
        cur.execute("""UPDATE community_challenges SET deciding = %s
                        WHERE id = %s AND deciding IS DISTINCT FROM %s""",
                    (dec, cid, dec))
    keys = [e[0] for e in _ENTRY_SEEDS]
    cur.execute(
        "SELECT COUNT(*) FROM community_feed_posts WHERE mock_key = ANY(%s)",
        (keys,))
    if int(cur.fetchone()[0]) >= len(keys):
        return
    for (key, cid, uname, ini, tier, show, caption, variant, visual,
         like_seed, days_ago, winner) in _ENTRY_SEEDS:
        cur.execute(
            """INSERT INTO community_feed_posts
                   (mock_key, author_username, author_initials, author_tier,
                    author_show_tier, caption, variant, visual, tagged,
                    like_seed, status, challenge_id, entry_status,
                    winner_position, published_at, created_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, '[]'::jsonb, %s,
                       'approved', %s, 'published', %s,
                       now() - (%s || ' days')::interval,
                       now() - (%s || ' days')::interval)
               ON CONFLICT (mock_key) DO NOTHING""",
            (key, uname, ini, tier, show, caption, variant, visual,
             like_seed, cid, winner, days_ago, days_ago))


# ---------------------------------------------------------------------------
# Vivo Edits seed — the launch set of three creator edits, built from the
# uploaded creator photography in attached_assets/. Idempotent: an edit_key
# that already exists is never touched (staff edits win), and image files
# missing from disk (e.g. a fresh prod container without the assets) simply
# skip that edit rather than failing boot. Product tags come from the live
# catalogue exactly like _seed_feed_posts.

_VIVO_EDIT_SEEDS = [
    {
        "key": "edit_sharon_v1", "creator": "Sharon", "username": "sharon.vivo",
        "title": "After-Hours, Softened",
        "desc": "Confident knits chosen for long days that turn into evening plans.",
        "intro": "Sharon builds her week around pieces that hold their shape "
                 "from the first meeting to the last plan — soft knits, deep "
                 "colour and easy polish.",
        "disclosure": "In partnership with Vivo",
        "images": [
            ("Sharon_1_1786968380981.png",
             "Sharon in a white dress, styling a relaxed Vivo look"),
            ("Sharon_2_1786968380937.png",
             "Sharon in a berry-red soft-knit dress with balloon sleeves"),
        ],
        "likes": 44, "hrs": 26, "tags": 4,
    },
    {
        "key": "edit_phinie_v1", "creator": "Phinie", "username": "phinie.vivo",
        "title": "City Ease to Evening Silk",
        "desc": "Effortless silhouettes for daytime wandering and evening shine.",
        "intro": "Phinie keeps daytime light — one long line, sunglasses, a "
                 "small bag — then lets satin and gold jewellery do the "
                 "talking after dark.",
        "disclosure": "In partnership with Vivo",
        "images": [
            ("Phinie_1__1786968380971.png",
             "Phinie in a beige knit maxi slip dress on a garden path"),
            ("Phinie_2_1786968380979.png",
             "Phinie in a purple satin halter dress with gold jewellery"),
        ],
        "likes": 37, "hrs": 50, "tags": 4,
    },
    {
        "key": "edit_grace_v1", "creator": "Grace", "username": "grace.vivo",
        "title": "Soft Neutrals, Easy Layers",
        "desc": "Warm neutrals and one great layer that finishes every outfit.",
        "intro": "Grace starts with an easy base — a white tank, a printed "
                 "trouser — and finishes with a layer that turns heads "
                 "without trying.",
        "disclosure": "In partnership with Vivo",
        "images": [
            ("Grace_1_1786968380980.png",
             "Grace in a white tank and pastel printed trousers with a "
             "crossbody bag"),
            ("Grace_2_1786968380981.png",
             "Grace layering a cream fringed cape over a black dress in store"),
        ],
        "likes": 29, "hrs": 74, "tags": 4,
    },
]


def _edit_catalogue_tags(cur, limit=30):
    """Random in-stock, imaged catalogue products as feed-shaped tag dicts —
    same probe/shape as _seed_feed_posts. [] when the catalogue is absent."""
    cur.execute("SELECT to_regclass('public.all_products_clean') IS NOT NULL"
                " AND to_regclass('public.all_inventory') IS NOT NULL"
                " AND to_regclass('public.product_image_map') IS NOT NULL"
                " AND to_regclass('public.product_images') IS NOT NULL")
    if not cur.fetchone()[0]:
        return []
    cur.execute("""SELECT sku, style_name, price FROM (
                       SELECT DISTINCT ON (p.style_name) p.sku,
                              p.style_name, p.price::float AS price
                       FROM all_products_clean p
                       JOIN (SELECT sku, SUM(COALESCE(available,0)) AS soh
                               FROM all_inventory GROUP BY sku) i
                         ON i.sku = p.sku AND i.soh > 0
                       JOIN product_image_map pim ON pim.sku = p.sku
                       JOIN product_images pi
                         ON pi.tmpl_id = pim.tmpl_id
                            AND COALESCE(pi.image_512, '') <> ''
                       WHERE p.active IS TRUE
                         AND COALESCE(p.price::float, 0) > 0
                         AND COALESCE(p.style_name, '') <> ''
                       ORDER BY p.style_name, p.sku
                   ) t ORDER BY random() LIMIT %s""", (limit,))
    return [{"sku": r[0], "name": r[1], "price": float(r[2] or 0)}
            for r in cur.fetchall()]


def _seed_vivo_edits(cur):
    keys = [e["key"] for e in _VIVO_EDIT_SEEDS]
    cur.execute("SELECT COUNT(*) FROM community_edits WHERE edit_key = ANY(%s)",
                (keys,))
    if int(cur.fetchone()[0] or 0) >= len(keys):
        return
    _base = os.path.dirname(os.path.abspath(__file__))
    # community_seeds/ ships with the deployment image (not in .replitignore);
    # attached_assets/ is the dev source but is excluded from prod deploys.
    assets = os.path.join(_base, "community_seeds")
    if not os.path.isdir(assets):
        assets = os.path.join(_base, "attached_assets")
    tags = _edit_catalogue_tags(cur)
    ti = 0
    for order, seed in enumerate(_VIVO_EDIT_SEEDS):
        files = []
        for fname, alt in seed["images"]:
            path = os.path.join(assets, fname)
            if os.path.isfile(path):
                with open(path, "rb") as fh:
                    files.append((fh.read(), alt))
        if not files:
            continue  # assets absent (fresh container) — staff can upload
        picked = []
        if tags:
            picked = [tags[(ti + k) % len(tags)] for k in range(seed["tags"])]
            ti += seed["tags"]
        cur.execute(
            """INSERT INTO community_edits
                   (edit_key, creator_name, creator_username, title,
                    description, intro, disclosure, featured, sort_order,
                    tagged, created_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, TRUE, %s, %s::jsonb,
                       now() - (%s || ' hours')::interval)
               ON CONFLICT (edit_key) DO NOTHING
               RETURNING id""",
            (seed["key"], seed["creator"], seed["username"], seed["title"],
             seed["desc"], seed["intro"], seed["disclosure"], (order + 1) * 10,
             json.dumps(picked), seed["hrs"]))
        row = cur.fetchone()
        if not row:
            continue
        eid = row[0]
        cover_img_id = None
        for pos, (raw, alt) in enumerate(files):
            cur.execute(
                """INSERT INTO community_edit_images
                       (edit_id, image, mime, position, alt_text)
                   VALUES (%s, %s, 'image/png', %s, %s) RETURNING id""",
                (eid, psycopg2.Binary(raw), pos, alt))
            iid = cur.fetchone()[0]
            if pos == 0:
                cover_img_id = iid
        # Mirror into the feed so likes/comments/shares reuse feed machinery.
        cur.execute(
            """INSERT INTO community_feed_posts
                   (mock_key, author_username, author_initials, caption,
                    variant, visual, tagged, like_seed, status, post_type,
                    image_url, created_at)
               VALUES (%s, %s, %s, %s, 'standard', 'light', %s::jsonb, %s,
                       'approved', 'look', %s,
                       now() - (%s || ' hours')::interval)
               ON CONFLICT (mock_key) DO NOTHING RETURNING id""",
            ("vivoedit_" + seed["key"], seed["username"],
             seed["creator"][:1].upper() + "V",
             "VIVO EDIT — “" + seed["title"] + "” curated by "
             + seed["creator"] + ". " + seed["desc"],
             json.dumps(picked), seed["likes"],
             f"/api/community/edit-image/{cover_img_id}", seed["hrs"]))
        prow = cur.fetchone()
        if prow:
            cur.execute("UPDATE community_edits SET feed_post_id = %s"
                        " WHERE id = %s", (prow[0], eid))


def _norm_phone(raw):
    """Canonicalise to bare digits with country code, e.g. 2547XXXXXXXX.

    Accepts +2547.., 2547.., 07.. (assumed Kenya), 7.. (9 digits, Kenya).
    Returns None when it can't be a sane E.164-ish number.
    """
    d = re.sub(r"\D", "", str(raw or ""))
    if d.startswith("00"):
        d = d[2:]
    if len(d) == 10 and d.startswith("0"):
        d = "254" + d[1:]
    elif len(d) == 9 and not d.startswith("0"):
        d = "254" + d
    if len(d) < 11 or len(d) > 13:
        return None
    return d


def _mask_phone(digits):
    if not digits:
        return ""
    return "+" + digits[:3] + "•••" + digits[-3:]


# ---------- usernames (public identity — real names stay private) ----------

_USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._]{1,18}[a-z0-9]$")
_USERNAME_RESERVED = {
    "vivo", "vivofashion", "vivowoman", "shopzetu", "safari", "zoya",
    "admin", "administrator", "support", "help", "official", "team",
    "staff", "moderator", "mod", "member", "community", "everyone",
    "anonymous", "vivocommunity",
}


def _norm_username(raw):
    return re.sub(r"\s+", "", str(raw or "")).lower()


def _username_problem(u):
    """Return a human message when the username is not acceptable, else None."""
    if len(u) < 3 or len(u) > 20:
        return "Usernames are 3–20 characters"
    if not _USERNAME_RE.match(u):
        return "Use lowercase letters, numbers, dots or underscores — starting and ending with a letter or number"
    if ".." in u or "__" in u or "._" in u or "_." in u:
        return "Dots and underscores can't sit next to each other"
    if u in _USERNAME_RESERVED:
        return "That username is reserved"
    return None


def _username_taken(cur, u, exclude_id=None):
    if exclude_id is None:
        cur.execute("SELECT 1 FROM community_members WHERE LOWER(username) = %s LIMIT 1", (u,))
    else:
        cur.execute("SELECT 1 FROM community_members WHERE LOWER(username) = %s AND id <> %s LIMIT 1",
                    (u, exclude_id))
    return cur.fetchone() is not None


def _suggest_usernames(cur, base, want=3):
    """Up to `want` available variations of `base` (already-normalized input)."""
    stem = re.sub(r"[^a-z0-9._]", "", _norm_username(base)).strip("._") or "member"
    stem = stem[:14]
    if len(stem) < 3:
        stem = (stem + "vivo")[:14]
    cands = [stem + "_ke", stem + "." + secrets.choice("123456789")]
    for _ in range(12):
        cands.append(stem + str(secrets.randbelow(90) + 10))
    out, seen = [], set()
    for c in cands:
        c = c[:20]
        if c in seen or _username_problem(c):
            continue
        seen.add(c)
        if not _username_taken(cur, c):
            out.append(c)
        if len(out) >= want:
            break
    return out


def _sms_configured():
    """True when a real SMS provider is wired up. Plug-in point: set
    COMMUNITY_SMS_PROVIDER (+ its credentials) and implement _send_otp_sms."""
    return bool(os.environ.get("COMMUNITY_SMS_PROVIDER"))


def _send_otp_sms(phone_digits, code):
    """Send the OTP via the configured SMS provider. Returns True on success.
    No provider is configured yet, so this is a stub that reports failure and
    the caller falls back to demo mode."""
    if not _sms_configured():
        return False
    # Future: dispatch on COMMUNITY_SMS_PROVIDER (e.g. Twilio, Africa's Talking).
    return False


def _hash_token(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _new_session(cur, phone, member_id=None, purpose="member"):
    token = secrets.token_urlsafe(32)
    ttl = SESSION_TTL_SEC if purpose == "member" else SIGNUP_TOKEN_TTL_SEC
    cur.execute(
        """INSERT INTO community_sessions (token_hash, member_id, phone, purpose, expires_at)
           VALUES (%s, %s, %s, %s, now() + make_interval(secs => %s))""",
        (_hash_token(token), member_id, phone, purpose, ttl),
    )
    return token


def _session_for(cur, token, purpose="member"):
    if not token:
        return None
    cur.execute(
        """SELECT token_hash, member_id, phone FROM community_sessions
           WHERE token_hash = %s AND purpose = %s AND expires_at > now()""",
        (_hash_token(token), purpose),
    )
    return cur.fetchone()


def _bearer(request: Request):
    h = request.headers.get("authorization") or ""
    if h.lower().startswith("bearer "):
        return h[7:].strip()
    return ""


def _require_member(cur, request: Request):
    sess = _session_for(cur, _bearer(request), purpose="member")
    if not sess or not sess["member_id"]:
        raise HTTPException(status_code=401, detail="Not signed in")
    cur.execute("SELECT * FROM community_members WHERE id = %s", (sess["member_id"],))
    m = cur.fetchone()
    if not m:
        raise HTTPException(status_code=401, detail="Not signed in")
    return m


def _initials(name):
    parts = [p for p in re.split(r"\s+", (name or "").strip()) if p]
    ini = "".join(p[0] for p in parts[:2]).upper()
    return ini or "V"


def _member_barcode(member_id):
    """Stable, non-PII Code 128 value for the signed-in member's account card."""
    return f"JH{int(member_id):08d}"


def _earned_bonus_points(cur, member_id):
    """Extra lifetime points from community_points_events (quiz bonus etc.) —
    folded into BOTH lifetime formulas (/me and the event tier gates) so the
    two can never disagree."""
    cur.execute(
        "SELECT COALESCE(SUM(points),0) AS p FROM community_points_events WHERE member_id = %s",
        (member_id,),
    )
    return int((cur.fetchone() or {}).get("p") or 0)


_REFERRAL_CODE_RE = re.compile(r"^[A-Za-z0-9_-]{8,32}$")
REFERRAL_REWARD_POINTS = 200
COMMUNITY_APP_PATH = "/app/"
COMMUNITY_PUBLIC_ORIGIN = (os.environ.get("COMMUNITY_PUBLIC_ORIGIN") or "").rstrip("/")
REFERRAL_RECON_INTERVAL_SEC = 60
_referral_reconciler_started = False
_referral_reconciler_lock = threading.Lock()


def _new_referral_code(cur):
    """Return a collision-free, URL-safe code without exposing member ids."""
    for _ in range(8):
        code = secrets.token_urlsafe(9)
        cur.execute(
            "SELECT 1 FROM community_members WHERE referral_code = %s LIMIT 1",
            (code,),
        )
        if not cur.fetchone():
            return code
    raise RuntimeError("Could not generate a referral code")


def _referral_code_for_member(cur, member):
    """Lazily provision legacy members' referral codes, safely under races."""
    existing = (member.get("referral_code") or "").strip()
    if existing:
        return existing
    for _ in range(8):
        code = _new_referral_code(cur)
        cur.execute(
            """UPDATE community_members
                  SET referral_code = %s
                WHERE id = %s AND referral_code IS NULL
              RETURNING referral_code""",
            (code, member["id"]),
        )
        row = cur.fetchone()
        if row:
            return row["referral_code"]
        cur.execute("SELECT referral_code FROM community_members WHERE id = %s", (member["id"],))
        row = cur.fetchone() or {}
        if row.get("referral_code"):
            return row["referral_code"]
    raise RuntimeError("Could not provision a referral code")


def _clean_referral_code(value):
    code = str(value or "").strip()
    return code if _REFERRAL_CODE_RE.fullmatch(code) else ""


def _award_referral_after_first_purchase(cur, member, order_count):
    """Credit a referrer exactly once after the new member has a real order.

    The aggregate customer record is only consulted after it has been linked
    to the member, and the unique reward row keeps repeated /me calls and
    sync backfills from double-crediting the referrer.
    """
    referrer_id = member.get("referred_by_member_id")
    if not referrer_id or int(order_count or 0) < 1:
        return
    cur.execute(
        """INSERT INTO community_referral_rewards
               (referred_member_id, referrer_member_id)
           VALUES (%s, %s)
           ON CONFLICT (referred_member_id) DO NOTHING
           RETURNING referrer_member_id""",
        (member["id"], referrer_id),
    )
    row = cur.fetchone()
    if not row:
        return
    cur.execute(
        """INSERT INTO community_points_events (member_id, kind, points)
           VALUES (%s, %s, %s)
           ON CONFLICT (member_id, kind) DO NOTHING""",
        (referrer_id, f"referral:{member['id']}", REFERRAL_REWARD_POINTS),
    )
    _me_cache.pop(referrer_id, None)


def _reconcile_referral_rewards():
    """Reconcile qualifying first purchases from the canonical customer sync.

    This runs independently of member reads so a reward follows the purchase
    data even when neither friend opens the app. The per-referred-member
    primary key remains the concurrency/idempotency fence.
    """
    _ensure_tables()
    with _db() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT m.id, m.referred_by_member_id
                   FROM community_members m
                   JOIN all_customers c
                     ON c.customer_id = m.customer_id
                    AND c.store_id = m.customer_store_id
                   LEFT JOIN community_referral_rewards rr
                     ON rr.referred_member_id = m.id
                  WHERE m.referred_by_member_id IS NOT NULL
                    AND COALESCE(c.total_orders, 0) >= 1
                    AND rr.referred_member_id IS NULL"""
            )
            for member in cur.fetchall():
                _award_referral_after_first_purchase(cur, member, 1)
        conn.commit()


def _referral_reconciler_loop():
    # Let the API bind its port before the optional DB reconciliation begins.
    time.sleep(15)
    while True:
        try:
            _reconcile_referral_rewards()
        except Exception as e:
            log.warning("community referral reconciliation failed: %s", type(e).__name__)
        time.sleep(REFERRAL_RECON_INTERVAL_SEC)


# ---- Style Quiz -------------------------------------------------------------
# Whitelisted answer ids -> warm descriptor tokens. The composer respects the
# member's own pick order, so the DNA reads like her taste, not our taxonomy.
QUIZ_STYLE_TOKENS = {
    "bold_colourful": "Bold", "classic_polished": "Polished",
    "relaxed_easy": "Relaxed", "statement_glam": "Glamorous",
    "modern_minimal": "Minimal", "print_loving": "Print-Loving",
}
QUIZ_OCCASION_TOKENS = {
    "events": "Event-Ready", "evenings_out": "Night-Out", "work": "Work-Smart",
    "sunday_best": "Sunday-Best", "travel": "Travel-Light", "everyday": "Everyday-Easy",
}
QUIZ_FIT_TOKENS = {
    "comfort": "Comfort-First", "curves": "Curve-Celebrating", "shaping": "Sculpted",
    "coverage": "Coverage-Confident", "fuss_free": "Fuss-Free",
}
QUIZ_REACH = {"dresses", "separates", "both"}
QUIZ_COLOUR_IDS = {"warm_earth", "jewel", "brights", "soft_neutrals", "prints"}
QUIZ_SIZES = {"xs_s", "m_l", "xl_2x", "3x_up", "varies"}
QUIZ_LEANS = {"true_to_size", "size_up", "size_down"}


def _quiz_clean_answers(raw):
    """Whitelist + trim submitted answers to the known schema. Unknown ids are
    dropped silently — client version skew must never 500 a save."""
    a = raw if isinstance(raw, dict) else {}

    def picks(key, allowed, cap):
        out = []
        for v in (a.get(key) or [])[:12]:
            v = str(v).strip()
            if v in allowed and v not in out:
                out.append(v)
        return out[:cap]

    def one(key, allowed):
        v = str(a.get(key) or "").strip()
        return v if v in allowed else ""

    return {
        "styles": picks("styles", QUIZ_STYLE_TOKENS, 3),
        "occasions": picks("occasions", QUIZ_OCCASION_TOKENS, 6),
        "reach_for": one("reach_for", QUIZ_REACH),
        "fit_priorities": picks("fit_priorities", QUIZ_FIT_TOKENS, 2),
        "colours": picks("colours", QUIZ_COLOUR_IDS, 5),
        "size_range": one("size_range", QUIZ_SIZES),
        "fit_lean": one("fit_lean", QUIZ_LEANS),
    }


def _quiz_complete(answers):
    """The five style questions make a complete quiz; the private fit details
    (size_range / fit_lean) are always optional."""
    return bool(answers["styles"] and answers["occasions"] and answers["reach_for"]
                and answers["fit_priorities"] and answers["colours"])


def _compose_style_dna(answers):
    """Three warm descriptors, e.g. ['Bold & Polished', 'Event-Ready',
    'Comfort-First'] — first two style picks, first occasion, first fit."""
    styles = [QUIZ_STYLE_TOKENS[x] for x in answers["styles"] if x in QUIZ_STYLE_TOKENS]
    d1 = " & ".join(styles[:2]) if styles else "Signature"
    d2 = next((QUIZ_OCCASION_TOKENS[x] for x in answers["occasions"] if x in QUIZ_OCCASION_TOKENS), "Everyday-Ready")
    d3 = next((QUIZ_FIT_TOKENS[x] for x in answers["fit_priorities"] if x in QUIZ_FIT_TOKENS), "Comfort-First")
    return [d1, d2, d3]


# Personalisation keyword maps. Matching is ILIKE on catalogue colour/name/
# category text, so it degrades gracefully as merch vocabulary drifts.
_QUIZ_COLOUR_WORDS = {
    "warm_earth": ["rust", "terracotta", "brown", "tan", "camel", "mustard", "olive", "khaki", "chocolate", "coffee", "mocha", "bronze", "sand"],
    "jewel": ["emerald", "sapphire", "teal", "burgundy", "wine", "maroon", "purple", "plum", "royal"],
    "brights": ["red", "orange", "yellow", "pink", "fuchsia", "lime", "coral", "cobalt", "turquoise"],
    "soft_neutrals": ["white", "cream", "ivory", "grey", "gray", "black", "nude", "blush", "stone", "taupe", "beige"],
    "prints": ["print", "floral", "animal", "leopard", "zebra", "stripe", "dot", "paisley", "abstract", "geometric", "check", "plaid", "batik", "ankara", "kitenge"],
}
_QUIZ_OCCASION_WORDS = {
    "events": ["gown", "occasion", "party", "sequin", "satin", "evening", "maxi"],
    "evenings_out": ["party", "sequin", "satin", "evening", "bodycon", "mini"],
    "work": ["blazer", "shirt", "trouser", "office", "pencil", "tailor", "suit"],
    "sunday_best": ["maxi", "midi", "floral", "lace"],
    "travel": ["knit", "jersey", "denim", "jean", "casual", "linen"],
    "everyday": ["tee", "t-shirt", "denim", "jean", "knit", "casual", "short"],
}
_QUIZ_STYLE_COLOUR_BOOST = {
    "print_loving": (2, "prints"),
    "modern_minimal": (1, "soft_neutrals"),
    "bold_colourful": (1, "brights"),
}


def _quiz_like(col, words):
    return " OR ".join("{} ILIKE '%%{}%%'".format(col, w) for w in words)


def _quiz_score_sql(quiz):
    """Personalisation score as a SQL expression over the cards CTE. Built
    ONLY from whitelisted answer ids mapped to constant keyword lists — no
    member-typed text ever reaches the SQL."""
    terms = []
    colour = "COALESCE(c.color,'')"
    namecat = "(COALESCE(c.style_name,'') || ' ' || COALESCE(c.category,''))"
    reach = quiz.get("reach_for")
    if reach == "dresses":
        terms.append("(CASE WHEN c.category ILIKE '%%dress%%' THEN 3 ELSE 0 END)")
    elif reach == "separates":
        terms.append("(CASE WHEN c.category ILIKE '%%top%%' OR c.category ILIKE '%%bottom%%'"
                     " OR c.category ILIKE '%%skirt%%' OR c.category ILIKE '%%trouser%%'"
                     " OR c.category ILIKE '%%pant%%' THEN 3 ELSE 0 END)")
    for cid in quiz.get("colours") or []:
        words = _QUIZ_COLOUR_WORDS.get(cid)
        if words:
            terms.append("(CASE WHEN {} THEN 2 ELSE 0 END)".format(_quiz_like(colour, words)))
    for oid in quiz.get("occasions") or []:
        words = _QUIZ_OCCASION_WORDS.get(oid)
        if words:
            terms.append("(CASE WHEN {} THEN 1 ELSE 0 END)".format(_quiz_like(namecat, words)))
    for sid in quiz.get("styles") or []:
        spec = _QUIZ_STYLE_COLOUR_BOOST.get(sid)
        if spec:
            terms.append("(CASE WHEN {} THEN {} ELSE 0 END)".format(
                _quiz_like(colour, _QUIZ_COLOUR_WORDS[spec[1]]), spec[0]))
    return " + ".join(terms) if terms else "0"


def _tier_for(points):
    tier = TIER_LADDER[0][0]
    for name, floor_pts in TIER_LADDER:
        if points >= floor_pts:
            tier = name
    nxt = None
    for name, floor_pts in TIER_LADDER:
        if points < floor_pts:
            nxt = {"name": name, "pts_needed": int(floor_pts - points)}
            break
    return tier, nxt


def _match_customer(cur, phone_digits):
    """Best matching real customer for a phone (right-9-digit equality)."""
    cur.execute(
        """SELECT customer_id, store_id, first_name, last_name,
                  COALESCE(total_orders,0) AS total_orders,
                  COALESCE(total_spend_kes,0)::float AS total_spend_kes
           FROM all_customers
           WHERE LENGTH(regexp_replace(COALESCE(phone,''), '\\D', '', 'g')) >= 9
             AND RIGHT(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 9) = RIGHT(%s, 9)
           ORDER BY COALESCE(total_orders,0) DESC, COALESCE(total_spend_kes,0) DESC
           LIMIT 1""",
        (phone_digits,),
    )
    return cur.fetchone()


def _month_year(val):
    """'2021-04-17' / date / datetime -> 'April 2021'."""
    if not val:
        return None
    try:
        if isinstance(val, (date, datetime)):
            d = val
        else:
            d = datetime.strptime(str(val)[:10], "%Y-%m-%d")
        return d.strftime("%B %Y")
    except Exception:
        return None


def _member_payload(cur, m):
    """Build the /me payload: member row + live purchase-derived stats."""
    cached = _me_cache.get(m["id"])
    if cached and time.time() - cached[0] < _ME_TTL:
        return cached[1]

    stats = None
    recent = []
    joined_src = m["created_at"]
    if m.get("customer_id"):
        cur.execute(
            """SELECT COALESCE(total_orders,0) AS total_orders,
                      COALESCE(total_spend_kes,0)::float AS total_spend_kes,
                      first_order_date, last_order_date, preferred_size, city
               FROM all_customers
               WHERE customer_id = %s AND store_id = %s
               LIMIT 1""",
            (m["customer_id"], m.get("customer_store_id")),
        )
        c = cur.fetchone()
        if c:
            stats = {
                "orders": int(c["total_orders"]),
                "spend_kes": float(c["total_spend_kes"]),
                "last_order": (str(c["last_order_date"])[:10] if c["last_order_date"] else None),
                "preferred_size": c["preferred_size"] or None,
                "city": (c["city"] or "").title() or None,
            }
            first_od = c["first_order_date"]
            if first_od:
                try:
                    fo = datetime.strptime(str(first_od)[:10], "%Y-%m-%d")
                    if fo.date() < m["created_at"].date():
                        joined_src = fo
                except Exception:
                    pass
            try:
                cur.execute(
                    """WITH ord AS (
                           SELECT s.order_name, s.sale_date, s.variant_sku,
                                  s.total_sales_kes, s.discounts_kes,
                                  s.returns_kes, s.ordered_item_quantity
                           FROM all_sales s
                           WHERE s.customer_id = %s AND s.store_id = %s
                             AND COALESCE(s.order_name,'') <> ''
                       ), p AS (
                           -- dedup by sku (twin rows exist) but only over the
                           -- member's own SKUs — never the whole catalogue
                           SELECT sku, MAX(style_number) AS style_number
                           FROM all_products_clean
                           WHERE sku IN (SELECT DISTINCT variant_sku FROM ord)
                           GROUP BY sku
                       )
                       SELECT o.order_name AS order_name,
                              MIN(o.sale_date::date) AS day,
                              SUM(COALESCE(o.total_sales_kes,0)
                                  - COALESCE(o.discounts_kes,0)
                                  - COALESCE(o.returns_kes,0))::float AS total_kes,
                              SUM(COALESCE(o.ordered_item_quantity,0))::int AS items,
                              STRING_AGG(DISTINCT NULLIF(TRIM(p.style_number),''), ', ') AS styles
                       FROM ord o
                       LEFT JOIN p ON p.sku = o.variant_sku
                       GROUP BY o.order_name
                       ORDER BY MIN(o.sale_date::date) DESC
                       LIMIT 3""",
                    (m["customer_id"], m.get("customer_store_id")),
                )
                for r in cur.fetchall():
                    total = max(float(r["total_kes"] or 0), 0.0)
                    recent.append({
                        "order": r["order_name"],
                        "date": str(r["day"]),
                        "total_kes": round(total, 2),
                        "items": int(r["items"] or 0),
                        "styles": r.get("styles") or None,
                        "pts": int(total // KES_PER_POINT),
                    })
            except Exception as e:
                log.warning("community recent orders failed: %s", e)

    spend = (stats or {}).get("spend_kes", 0.0)
    points = int(WELCOME_BONUS_PTS + spend // KES_PER_POINT) + _earned_bonus_points(cur, m["id"])
    # Spendable balance = lifetime earn − committed redemptions. Tier (and
    # tier progress) stays lifetime-based: redeeming must never demote.
    cur.execute(
        """SELECT COALESCE(SUM(points_cost), 0) AS spent
           FROM community_redemptions
           WHERE member_id = %s AND status <> 'cancelled'""",
        (m["id"],),
    )
    _srow = cur.fetchone()
    spent = int((_srow or {}).get("spent") or 0)
    cur.execute("SELECT dna, completed_at FROM community_style_quiz WHERE member_id = %s", (m["id"],))
    _qrow = cur.fetchone() or {}
    quiz_completed = bool(_qrow.get("completed_at"))
    style_dna = (_qrow.get("dna") or None) if quiz_completed else None
    available = max(points - spent, 0)
    tier, next_tier = _tier_for(points)

    payload = {
        "id": m["id"],
        "member_barcode": _member_barcode(m["id"]),
        "name": m["full_name"],
        "initials": _initials(m["full_name"]),
        "phone_masked": _mask_phone(m["phone"]),
        "email": m["email"],
        "dob": str(m["dob"]) if m.get("dob") else None,
        "joined": _month_year(joined_src) or _month_year(m["created_at"]),
        "tier": tier,
        "points": available,
        "lifetime_points": points,
        "next_tier": next_tier,
        "linked": bool(m.get("customer_id")),
        "username": m.get("username"),
        "show_tier": bool(m.get("show_tier")),
        "show_leaderboard": m.get("show_leaderboard") is not False,
        "stats": stats,
        "recent_orders": recent,
        "quiz_completed": quiz_completed,
        "style_dna": style_dna,
        "demo_sms": not _sms_configured(),
    }
    _me_cache[m["id"]] = (time.time(), payload)
    return payload


# ---------------------------------------------------------------- routes

_SIZE_ORDER = ["XXS", "XS", "XS/S", "S", "S/M", "M", "M/L", "L", "L/1X", "XL",
               "XL/1X", "1X", "1X/2X", "2X", "2X/3X", "3X", "3X/4X", "4X",
               "4X/5X", "5X", "F"]


def _size_sort_key(sz):
    """Order sizes the way a rail would: numeric sizes first in numeric
    order, then the letter ladder XXS..5X (slash sizes slot between their
    neighbours), anything unrecognised last alphabetically."""
    s = (sz or "").strip().upper()
    try:
        return (0, float(s), "")
    except ValueError:
        pass
    if s in _SIZE_ORDER:
        return (1, float(_SIZE_ORDER.index(s)), "")
    return (2, 0.0, s)


def _modal_price(prices):
    """Most-common price across a colourway's active rows (mode, not MAX —
    a stray FX/production-priced row must never set the customer price).
    Ties break toward the lower price."""
    counts = collections.Counter(round(float(p), 2) for p in prices)
    return max(counts.items(), key=lambda kv: (kv[1], -kv[0]))[0]


def _monogram_ok(t):
    """Monogram text: 2–14 chars, letters/digits plus space . & ' -, must
    start alphanumeric. Embroidery machines don't do emoji."""
    if not isinstance(t, str) or not (2 <= len(t) <= 14):
        return False
    if not t[0].isalnum():
        return False
    return all(ch.isalnum() or ch in " .&'-" for ch in t)


# ---------------- Contact Us ----------------
# Subject ids are the API contract with the app; labels are what care staff
# see in the CRM app's Community Inbox.
CONTACT_SUBJECTS = {
    "order": "My order",
    "sizing": "Sizing & fit help",
    "points": "My points or tier",
    "account": "My account",
    "events": "Events",
    "other": "Something else",
}
CONTACT_MAX_CHARS = 4000
CONTACT_STATUSES = ("new", "in_progress", "resolved")


def _decode_design(image_b64, noun="design"):
    """Decode + sanity-check an uploaded image (embroidery designs, Contact Us
    photos). PNG/JPEG only — the client's claimed mime is ignored and the
    magic bytes decide; the decoded size is capped at ~3MB."""
    b64 = image_b64 or ""
    label = noun.capitalize()
    if len(b64) > int(EMB_TANK_MAX_DESIGN_BYTES * 4 / 3) + 4096:
        raise HTTPException(status_code=400, detail=f"{label} file is too large — keep it under 3MB")
    try:
        raw = base64.b64decode(b64, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail=f"That {noun} didn't upload cleanly — please try again")
    if len(raw) > EMB_TANK_MAX_DESIGN_BYTES:
        raise HTTPException(status_code=400, detail=f"{label} file is too large — keep it under 3MB")
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return raw, "image/png"
    if raw[:3] == b"\xff\xd8\xff":
        return raw, "image/jpeg"
    raise HTTPException(status_code=400, detail=f"PNG or JPG {noun}s only")


def _decode_media(media_b64, noun="photo"):
    """Accept a photo (PNG/JPEG, design-cap size) or a short video (MP4 or
    WebM, ≤12MB). Returns (raw, mime, kind) with kind 'photo' | 'video'.
    Photos delegate to _decode_design so both paths share one size rule."""
    s = str(media_b64 or "")
    if s.startswith("data:") and "," in s[:96]:
        s = s.split(",", 1)[1]
    try:
        raw = base64.b64decode(s or "", validate=True)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail=f"Couldn't read that {noun} — try another file")
    if len(raw) >= 12 and raw[4:8] == b"ftyp":
        if len(raw) > 12 * 1024 * 1024:
            raise HTTPException(
                status_code=400,
                detail="That video is a little heavy — keep it under 12MB")
        return raw, "video/mp4", "video"
    if raw[:4] == b"\x1a\x45\xdf\xa3":
        if len(raw) > 12 * 1024 * 1024:
            raise HTTPException(
                status_code=400,
                detail="That video is a little heavy — keep it under 12MB")
        return raw, "video/webm", "video"
    raw2, mime = _decode_design(media_b64, noun=noun)
    return raw2, mime, "photo"


def _set_content_consent(cur, member_id, ctype, cid, ok):
    """Per-item marketing-consent ledger (DPA). One row per content item
    holds the CURRENT state (marketing_ok, granted_at = start of the active
    grant, withdrawn_at) plus an append-only `history` of every transition —
    so grant → withdraw → re-grant keeps the withdrawal interval on record.
    A marketing_ok=FALSE row is itself a record: the member was asked and
    said no (or later changed her mind)."""
    cur.execute(
        """INSERT INTO community_content_consents
               (member_id, content_type, content_id, marketing_ok, granted_at, history)
           VALUES (%s, %s, %s, %s, CASE WHEN %s THEN now() END,
                   jsonb_build_array(jsonb_build_object(
                       'event', CASE WHEN %s THEN 'granted' ELSE 'declined' END,
                       'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))))
           ON CONFLICT (member_id, content_type, content_id) DO UPDATE
              SET marketing_ok = EXCLUDED.marketing_ok,
                  granted_at   = CASE WHEN NOT EXCLUDED.marketing_ok
                                      THEN community_content_consents.granted_at
                                      WHEN community_content_consents.marketing_ok
                                      THEN community_content_consents.granted_at
                                      ELSE now() END,
                  withdrawn_at = CASE WHEN EXCLUDED.marketing_ok THEN NULL
                                      WHEN community_content_consents.marketing_ok THEN now()
                                      ELSE community_content_consents.withdrawn_at END,
                  history      = CASE WHEN community_content_consents.marketing_ok
                                           IS DISTINCT FROM EXCLUDED.marketing_ok
                                      THEN community_content_consents.history
                                           || jsonb_build_array(jsonb_build_object(
                                                  'event', CASE WHEN EXCLUDED.marketing_ok
                                                               THEN 'granted' ELSE 'withdrawn' END,
                                                  'at', to_char(now() AT TIME ZONE 'UTC',
                                                                'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
                                      ELSE community_content_consents.history END,
                  updated_at   = now()""",
        (member_id, ctype, cid, ok, ok, ok))


def _withdraw_content_consent(cur, member_id, ctype, cid):
    """Content was deleted: the consent record must reflect it — marketing
    permission ends with the item, and the ledger row stays as the audit
    trail (never deleted)."""
    cur.execute(
        """UPDATE community_content_consents
              SET withdrawn_at = CASE WHEN marketing_ok THEN now() ELSE withdrawn_at END,
                  history      = CASE WHEN marketing_ok
                                      THEN history || jsonb_build_array(jsonb_build_object(
                                               'event', 'withdrawn',
                                               'at', to_char(now() AT TIME ZONE 'UTC',
                                                             'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
                                      ELSE history END,
                  marketing_ok = FALSE,
                  updated_at = now()
            WHERE member_id = %s AND content_type = %s AND content_id = %s""",
        (member_id, ctype, cid))


def _parse_embroidery(emb):
    """Validate the embroidery choice → column values for a redemption row."""
    if not isinstance(emb, dict):
        raise HTTPException(status_code=400, detail="Pick a design or monogram first")
    kind = (emb.get("type") or "").strip()
    if kind == "upload":
        raw, mime = _decode_design(emb.get("image_b64"))
        return {
            "embroidery_type": "upload",
            "design_image": psycopg2.Binary(raw),
            "design_mime": mime,
            "monogram_text": None,
            "monogram_style": None,
        }
    if kind == "monogram":
        text = (emb.get("text") or "").strip()
        style = (emb.get("style") or "").strip()
        if not _monogram_ok(text):
            raise HTTPException(
                status_code=400,
                detail="Monograms are 2–14 letters or numbers (spaces, . & ' - are fine)",
            )
        if style not in {s["id"] for s in EMB_TANK_MONOGRAM_STYLES}:
            raise HTTPException(status_code=400, detail="Pick one of the embroidery styles")
        return {
            "embroidery_type": "monogram",
            "design_image": None,
            "design_mime": None,
            "monogram_text": text,
            "monogram_style": style,
        }
    raise HTTPException(status_code=400, detail="Pick a design or monogram first")


def _event_dt(iso):
    return datetime.fromisoformat(iso)


def _event_labels(ev):
    """Server-formatted display labels so every device shows Nairobi (EAT)
    wall-clock time regardless of the viewer's device timezone."""
    s, e = _event_dt(ev["starts_at"]), _event_dt(ev["ends_at"])

    def t(d):
        return d.strftime("%I:%M %p").lstrip("0")

    start_t, end_t = t(s), t(e)
    if start_t[-2:] == end_t[-2:]:
        start_t = start_t[:-3]           # "5:30 – 7:30 PM", not "5:30 PM – 7:30 PM"
    return {
        "date_label": f"{s:%a} {s.day} {s:%b}",
        "time_label": f"{start_t} – {end_t} EAT",
        "day_num": s.day,
        "month_abbr": f"{s:%b}",
        "month_key": f"{s:%Y-%m}",
        "month_label": f"{s:%B %Y}",
    }


def _lifetime_points(cur, m):
    """Lifetime earn (welcome bonus + spend-derived) — same maths as /me.
    Used for event tier gates; tier is lifetime-based so redeeming rewards
    never locks a member out of a Tanzanite evening."""
    spend = 0.0
    if m.get("customer_id"):
        cur.execute(
            """SELECT COALESCE(total_spend_kes,0)::float AS s FROM all_customers
               WHERE customer_id = %s AND store_id = %s LIMIT 1""",
            (m["customer_id"], m.get("customer_store_id")),
        )
        row = cur.fetchone()
        spend = float((row or {}).get("s") or 0.0)
    return int(WELCOME_BONUS_PTS + spend // KES_PER_POINT) + _earned_bonus_points(cur, m["id"])


def _event_unlocked(cur, m, gate):
    """True when the member clears a gated event: qualifying tier OR a held
    (non-cancelled) redemption of a qualifying reward."""
    if not gate:
        return True
    tiers = gate.get("tiers") or []
    if tiers:
        tier, _ = _tier_for(_lifetime_points(cur, m))
        if tier in tiers:
            return True
    rewards = gate.get("rewards") or []
    if rewards:
        cur.execute(
            """SELECT 1 FROM community_redemptions
               WHERE member_id = %s AND reward_key = ANY(%s)
                 AND status <> 'cancelled' LIMIT 1""",
            (m["id"], list(rewards)),
        )
        if cur.fetchone():
            return True
    return False


# 1-based waitlist position of RSVP row %s among rows still waitlisted on
# the same event; queue order is (waitlisted_at, id).
_WL_POS_SQL = """
    SELECT COUNT(*) AS p
      FROM community_event_rsvps w
      JOIN community_event_rsvps r ON r.id = %s
     WHERE w.event_id = r.event_id AND w.status = 'waitlisted'
       AND (w.waitlisted_at, w.id) <= (r.waitlisted_at, r.id)
"""


def _send_member_email(to_addr, subject, body):
    """Best-effort transactional mail via the shared retail SMTP account
    (the same sender the loyalty app uses). Runs on daemon threads — never
    raises and never blocks a request. Quietly skips when SMTP isn't
    configured or the member has no email."""
    host = (os.environ.get("LOYALTY_APP_SMTP_HOST") or "").strip()
    user = (os.environ.get("LOYALTY_APP_SMTP_USER") or "").strip()
    pw = os.environ.get("LOYALTY_APP_SMTP_PASS") or ""
    if not host or not to_addr:
        log.info("member email skipped (smtp=%s to=%s)", bool(host), bool(to_addr))
        return
    port = 587
    if ":" in host:
        host, _, p = host.rpartition(":")
        if p.isdigit():
            port = int(p)
    try:
        from email.message import EmailMessage
        msg = EmailMessage()
        msg["From"] = user or "community@vivofashiongroup.com"
        msg["To"] = to_addr
        msg["Subject"] = subject
        msg.set_content(body)
        with smtplib.SMTP(host, port, timeout=20) as s:
            s.starttls()
            if user:
                s.login(user, pw)
            s.send_message(msg)
        log.info("member email sent (%s)", subject)
    except Exception as e:
        # PII minimisation: SMTP exceptions (e.g. SMTPRecipientsRefused)
        # embed the recipient address in their repr — log only the
        # exception class, never its message/args.
        log.warning("member email failed (%s) subject=%s",
                    type(e).__name__, subject)

def _fire_restock_alerts(style_name, color, in_stock_map):
    """Fire pending restock alert emails for any sizes that just came back in
    stock. in_stock_map: {sku -> size_label} for currently in-stock sizes.
    Called from a daemon thread so it never blocks a PDP response.

    Concurrency safety: alerts are claimed with a single atomic
    UPDATE … RETURNING that joins community_members in one shot.  Only the
    transaction that commits first can claim any given row — concurrent sweeps
    (e.g. two simultaneous PDP cache-misses for the same style) will find
    notified_at already set and claim nothing, so each alert is emailed at
    most once even under parallel workers."""
    if not in_stock_map:
        return
    skus = list(in_stock_map.keys())
    try:
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                # Atomically stamp notified_at and retrieve member contact
                # details in one statement.  Any concurrent transaction racing
                # on the same rows will find notified_at IS NOT NULL and skip
                # them — guaranteeing at-most-once delivery per alert.
                cur.execute(
                    """UPDATE community_restock_alerts a
                          SET notified_at = now()
                         FROM community_members m
                        WHERE a.member_id = m.id
                          AND a.sku = ANY(%s)
                          AND a.notified_at IS NULL
                    RETURNING a.id, a.sku, a.size,
                              m.email, m.full_name""",
                    (skus,))
                rows = [dict(r) for r in cur.fetchall()]
            conn.commit()
        # Emails fire after commit — claimed rows can't be un-claimed, so a
        # mid-loop crash means the alert is silently swallowed (acceptable;
        # the alternative is duplicate email, which is worse for members).
        for r in rows:
            email = (r.get("email") or "").strip()
            if not email:
                continue
            first = ((r.get("full_name") or "").strip().split() or ["there"])[0]
            size_label = (r["size"] or "").strip()
            size_label = "One Size" if size_label in ("F", "") else size_label
            body = (
                f"Hi {first},\n\n"
                f"Good news — {style_name}"
                + (f" in {color}" if color else "")
                + f" is back in stock in {size_label}.\n\n"
                "Shop it before it sells out again — popular sizes can go fast "
                "once they're back.\n\n"
                "See you in the app,\nThe Vivo team"
            )
            _send_member_email(
                email,
                f"Back in stock: {style_name} — {size_label}",
                body,
            )
    except Exception:
        log.exception("restock alert sweep failed style=%r color=%r", style_name, color)
def _notify_promoted(member_row, ev):
    """Waitlist → confirmed: tell the member their spot opened up. The queue
    promise in the app is 'we'll email you the moment a spot opens' — this
    is that email. Fire-and-forget on a daemon thread."""
    email = (member_row.get("email") or "").strip()
    if not email:
        log.info("promotion email skipped — member %s has no email", member_row.get("id"))
        return
    labels = _event_labels(ev)
    first = ((member_row.get("full_name") or "").strip().split() or ["there"])[0]
    body = (
        f"Hi {first},\n\n"
        f"Good news — a spot just opened up for {ev['title']}, and it's yours.\n\n"
        f"When: {labels['date_label']}, {labels['time_label']}\n"
        f"Where: {ev['venue']}, {ev['area']}\n\n"
        "You were next on the waitlist, so your place is now confirmed — no "
        "need to do anything. If your plans have changed, you can free the "
        "spot from the event page in the Vivo Johari app so the next "
        "member can have it.\n\n"
        "See you there,\nThe Vivo team"
    )
    threading.Thread(
        target=_send_member_email,
        args=(email, "A spot opened up — you're in", body),
        daemon=True,
    ).start()


# ---------- Virtual Try-On (helpers + generation worker) ----------

def _product_image_bytes(cur, sku):
    """Garment photo bytes for a SKU — exact SKU first, then any style+colour
    sibling (same resolution the public /product-image route uses)."""
    cur.execute(
        """SELECT i.image_512 FROM product_image_map m
           JOIN product_images i ON i.tmpl_id = m.tmpl_id
           WHERE m.sku = %s AND COALESCE(i.image_512,'') <> ''
           LIMIT 1""",
        (sku,))
    row = cur.fetchone()
    if not row:
        cur.execute(
            """SELECT i.image_512
               FROM all_products_clean me
               JOIN all_products_clean sib
                 ON sib.style_name = me.style_name
                AND COALESCE(sib.color_print,'') = COALESCE(me.color_print,'')
               JOIN product_image_map m ON m.sku = sib.sku
               JOIN product_images i ON i.tmpl_id = m.tmpl_id
               WHERE me.sku = %s AND COALESCE(i.image_512,'') <> ''
               LIMIT 1""",
            (sku,))
        row = cur.fetchone()
    if not row:
        return None
    try:
        return base64.b64decode(row["image_512"])
    except Exception:
        return None


def _tryon_heal_stale(cur, member_id):
    """Pending looks older than TRYON_PENDING_STALE_SEC become failed (the
    worker died or the API hung). Failed rows never count against the weekly
    allowance, so a lost attempt is automatically given back."""
    cur.execute(
        """UPDATE community_tryon_looks
              SET status = 'failed',
                  error = 'Styling took too long — this attempt isn''t counted.',
                  updated_at = now()
            WHERE member_id = %s AND status = 'pending'
              AND created_at < now() - make_interval(secs => %s)""",
        (member_id, TRYON_PENDING_STALE_SEC))
    return cur.rowcount


def _tryon_allowance(cur, m):
    """(tier, weekly limit, used-this-week). Week = Monday 00:00 EAT;
    everything except failed attempts counts (pending blocks parallel spam).
    limit is None for unlimited tiers, 0 for tiers the perk excludes."""
    tier, _ = _tier_for(_lifetime_points(cur, m))
    limit = TRYON_WEEK_LIMITS.get(tier, TRYON_WEEK_LIMITS["Tsavorite"])
    cur.execute(
        """SELECT COUNT(*) AS n FROM community_tryon_looks
            WHERE member_id = %s AND status <> 'failed'
              AND (created_at AT TIME ZONE 'Africa/Nairobi')
                  >= date_trunc('week', now() AT TIME ZONE 'Africa/Nairobi')""",
        (m["id"],))
    used = int(cur.fetchone()["n"])
    return tier, limit, used


def _tryon_demo_image(person, garment, product_name):
    """Deterministic composite for demo mode: her photo with the garment
    inset and an unmissable DEMO strip. No AI call, no billing."""
    import io as _io
    from PIL import Image, ImageDraw
    pi = Image.open(_io.BytesIO(person)).convert("RGB")
    pi.thumbnail((900, 1200))
    canvas = pi.copy()
    try:
        gi = Image.open(_io.BytesIO(garment)).convert("RGB")
        gw = max(72, canvas.width // 3)
        gi.thumbnail((gw, gw * 2))
        x = canvas.width - gi.width - 12
        y = canvas.height - gi.height - 48
        canvas.paste(Image.new("RGB", (gi.width + 8, gi.height + 8), (255, 255, 255)), (x - 4, y - 4))
        canvas.paste(gi, (x, y))
    except Exception:
        pass
    d = ImageDraw.Draw(canvas)
    d.rectangle([(0, canvas.height - 30), (canvas.width, canvas.height)], fill=(17, 17, 17))
    d.text((10, canvas.height - 22), ("DEMO PREVIEW — " + (product_name or ""))[:60], fill=(255, 255, 255))
    out = _io.BytesIO()
    canvas.save(out, "JPEG", quality=88)
    return out.getvalue(), "image/jpeg"


def _generate_tryon(person, person_mime, garment, product_name):
    """THE single AI integration point. Returns (image_bytes, mime, demo).

    Real path: Gemini image editing via the Replit AI Integrations proxy
    (billed per call — the weekly allowance guards spend). Demo path (env
    not configured, or TRYON_DEMO_MODE=1): labeled local composite."""
    base = (os.environ.get("AI_INTEGRATIONS_GEMINI_BASE_URL") or "").rstrip("/")
    key = os.environ.get("AI_INTEGRATIONS_GEMINI_API_KEY") or ""
    if TRYON_FORCE_DEMO or not base or not key:
        img, mime = _tryon_demo_image(person, garment, product_name)
        return img, mime, True
    import requests
    prompt = (
        "Edit the first image (a full-length photo of a person). Dress the person in the "
        + ("garment shown in the second image (" + product_name + "), " if product_name
           else "garment shown in the second image, ")
        + "replacing their current outfit with it. Keep the person's face, hair, body shape, "
          "pose, skin tone and the background exactly the same. Make the garment fit and "
          "drape naturally and photorealistically on their body. Return only the edited photo."
    )
    body = {
        "contents": [{
            "role": "user",
            "parts": [
                {"text": prompt},
                {"inline_data": {"mime_type": person_mime or "image/jpeg",
                                 "data": base64.b64encode(person).decode()}},
                {"inline_data": {"mime_type": "image/jpeg",
                                 "data": base64.b64encode(garment).decode()}},
            ],
        }]
    }
    last = ""
    for attempt in range(2):
        try:
            r = requests.post(
                f"{base}/models/{TRYON_MODEL}:generateContent",
                headers={"x-goog-api-key": key, "Content-Type": "application/json"},
                json=body, timeout=120)
            if r.status_code == 200:
                parts = (((r.json().get("candidates") or [{}])[0]
                          .get("content") or {}).get("parts") or [])
                for p in parts:
                    d = p.get("inlineData") or p.get("inline_data")
                    if d and d.get("data"):
                        return (base64.b64decode(d["data"]),
                                d.get("mimeType") or d.get("mime_type") or "image/png",
                                False)
                last = "response had no image"
            else:
                last = f"HTTP {r.status_code}: {r.text[:200]}"
        except Exception as e:
            last = str(e)[:200]
        time.sleep(2 + attempt * 2)
    log.warning("tryon generation failed: %s", last)
    raise RuntimeError("Styling didn't work this time — please try again in a moment")


def _tryon_finish(look_id, status, result=None, mime=None, demo=False, error=None):
    """Write the outcome. Only ever flips a row that is still pending, so a
    late worker can never overwrite a stale-heal. Retries briefly because the
    borrowed pool can be momentarily saturated."""
    for attempt in range(3):
        try:
            with _db() as conn:
                with conn.cursor() as cur:
                    if status == "done":
                        cur.execute(
                            """UPDATE community_tryon_looks
                                  SET status = 'done', result = %s, result_mime = %s,
                                      demo = %s, error = NULL, updated_at = now()
                                WHERE id = %s AND status = 'pending'""",
                            (result, mime, demo, look_id))
                    else:
                        cur.execute(
                            """UPDATE community_tryon_looks
                                  SET status = 'failed', error = %s, updated_at = now()
                                WHERE id = %s AND status = 'pending'""",
                            (error, look_id))
                conn.commit()
            return
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 + attempt * 3)


def _tryon_worker(look_id):
    """Runs in a daemon thread. Critically, NO db connection is held during
    the 10–90s generation call — borrow, read inputs, release; generate;
    borrow again, write the outcome."""
    row = garment = None
    try:
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """SELECT l.product_sku, l.product_name,
                              p.image AS person, p.mime AS person_mime
                         FROM community_tryon_looks l
                         LEFT JOIN community_tryon_photos p ON p.id = l.photo_id
                        WHERE l.id = %s AND l.status = 'pending'""",
                    (look_id,))
                row = cur.fetchone()
                if row:
                    garment = _product_image_bytes(cur, row["product_sku"])
        if not row:
            return                      # already healed / deleted
        if not row["person"]:
            raise RuntimeError("That photo was deleted before styling finished — pick another one")
        if not garment:
            raise RuntimeError("This piece doesn't have a photo we can style from yet")
        img, mime, demo = _generate_tryon(bytes(row["person"]), row["person_mime"],
                                          garment, row["product_name"])
        _tryon_finish(look_id, "done", result=img, mime=mime, demo=demo)
    except Exception as e:
        log.exception("tryon worker failed for look %s", look_id)
        msg = str(e) if isinstance(e, RuntimeError) else \
            "Styling didn't work this time — please try again (this attempt isn't counted)"
        try:
            _tryon_finish(look_id, "failed", error=msg[:300])
        except Exception:
            log.exception("tryon failure write failed for look %s (stale-heal will catch it)", look_id)


def register_community_routes(app, api_pg_module):
    global A
    A = api_pg_module

    # Purchase ingestion is outside this module. Reconcile referral rewards in
    # a daemon worker after startup rather than coupling a customer-facing
    # request to an order-sync run. The worker itself is idempotent.
    global _referral_reconciler_started
    with _referral_reconciler_lock:
        if not _referral_reconciler_started:
            threading.Thread(target=_referral_reconciler_loop, daemon=True).start()
            _referral_reconciler_started = True

    # ---------- auth ----------

    @app.post("/api/community/auth/request-code")
    def community_request_code(request: Request, payload: dict = Body(...)):
        _ensure_tables()
        phone = _norm_phone(payload.get("phone"))
        if not phone:
            raise HTTPException(status_code=400, detail="Enter a valid phone number")
        _throttle(request, "req", [("phone", 6, 3600),
                                   ("ip", 15, 600), ("ip", 40, 3600),
                                   ("global", 500, 3600)], phone=phone)
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("SELECT last_sent_at FROM community_otp WHERE phone = %s", (phone,))
                row = cur.fetchone()
                if row:
                    cur.execute(
                        "SELECT EXTRACT(EPOCH FROM (now() - %s))::int AS age",
                        (row["last_sent_at"],),
                    )
                    if cur.fetchone()["age"] < OTP_RESEND_GAP_SEC:
                        raise HTTPException(
                            status_code=429,
                            detail="Please wait a moment before requesting another code",
                        )
                code = "".join(secrets.choice("0123456789") for _ in range(6))
                sent = _send_otp_sms(phone, code)
                demo = not sent
                if demo:
                    code = DEMO_CODE
                cur.execute(
                    """INSERT INTO community_otp (phone, code, expires_at, attempts, last_sent_at)
                       VALUES (%s, %s, now() + make_interval(secs => %s), 0, now())
                       ON CONFLICT (phone) DO UPDATE
                       SET code = EXCLUDED.code, expires_at = EXCLUDED.expires_at,
                           attempts = 0, last_sent_at = now()""",
                    (phone, code, OTP_TTL_SEC),
                )
            conn.commit()
            return {"ok": True, "demo": demo, "phone_masked": _mask_phone(phone)}

    @app.post("/api/community/auth/verify")
    def community_verify(request: Request, payload: dict = Body(...)):
        _ensure_tables()
        phone = _norm_phone(payload.get("phone"))
        code = re.sub(r"\D", "", str(payload.get("code") or ""))
        if not phone or len(code) != 6:
            raise HTTPException(status_code=400, detail="Enter the 6-digit code")
        _throttle(request, "ver", [("phone", 20, 3600),
                                   ("ip", 60, 600),
                                   ("global", 2000, 3600)], phone=phone)
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """SELECT code, attempts, expires_at > now() AS valid
                       FROM community_otp WHERE phone = %s""",
                    (phone,),
                )
                row = cur.fetchone()
                if not row or not row["valid"]:
                    raise HTTPException(status_code=400, detail="Code expired — request a new one")
                if row["attempts"] >= OTP_MAX_ATTEMPTS:
                    raise HTTPException(status_code=429, detail="Too many attempts — request a new code")
                if not secrets.compare_digest(str(row["code"]), code):
                    cur.execute(
                        "UPDATE community_otp SET attempts = attempts + 1 WHERE phone = %s",
                        (phone,),
                    )
                    conn.commit()
                    raise HTTPException(status_code=400, detail="That code doesn't match — try again")
                cur.execute("DELETE FROM community_otp WHERE phone = %s", (phone,))
                cur.execute("SELECT * FROM community_members WHERE phone = %s", (phone,))
                m = cur.fetchone()
                if m:
                    token = _new_session(cur, phone, member_id=m["id"], purpose="member")
                    cur.execute(
                        "UPDATE community_members SET last_login_at = now() WHERE id = %s",
                        (m["id"],),
                    )
                    payload_out = _member_payload(cur, m)
                    conn.commit()
                    # Evict after commit so a concurrent /me can't re-seed
                    # the cache with pre-commit data after our eviction.
                    _me_cache.pop(m["id"], None)
                    return {"token": token, "member": payload_out}
                signup_token = _new_session(cur, phone, member_id=None, purpose="signup")
                conn.commit()
                return {
                    "needs_signup": True,
                    "signup_token": signup_token,
                    "phone_masked": _mask_phone(phone),
                }

    @app.post("/api/community/auth/signup")
    def community_signup(request: Request, payload: dict = Body(...)):
        _ensure_tables()
        _throttle(request, "sup", [("ip", 20, 3600), ("global", 500, 3600)])
        token = str(payload.get("signup_token") or "")
        full_name = re.sub(r"\s+", " ", str(payload.get("full_name") or "")).strip()
        email = str(payload.get("email") or "").strip().lower()
        dob_raw = str(payload.get("dob") or "").strip()
        consent = payload.get("consent") is True
        if not consent:
            raise HTTPException(status_code=400, detail="Please accept the membership terms to continue")
        # Which Terms version this consent covers — server-authoritative:
        # only published versions are recordable (see COMMUNITY_TERMS_PUBLISHED).
        _claimed = str(payload.get("terms_version") or "").strip()
        terms_version = _claimed if _claimed in COMMUNITY_TERMS_PUBLISHED else COMMUNITY_TERMS_VERSION
        if len(full_name) < 2:
            raise HTTPException(status_code=400, detail="Enter your full name")
        if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
            raise HTTPException(status_code=400, detail="Enter a valid email address")
        try:
            dob = datetime.strptime(dob_raw, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(status_code=400, detail="Enter your date of birth")
        if dob.year < 1900 or dob > date.today():
            raise HTTPException(status_code=400, detail="Enter a valid date of birth")
        # Membership is 18+ (Terms §1). The client's date picker caps the
        # selectable date too, but the server is the enforcement point.
        _today = date.today()
        try:
            _adult_cutoff = _today.replace(year=_today.year - 18)
        except ValueError:  # born-on-29-Feb edge
            _adult_cutoff = _today.replace(year=_today.year - 18, day=28)
        if dob > _adult_cutoff:
            raise HTTPException(status_code=400, detail="Vivo Johari is for members aged 18 and over")
        username = _norm_username(payload.get("username"))
        uname_problem = _username_problem(username)
        if uname_problem:
            raise HTTPException(status_code=400, detail=uname_problem)

        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                sess = _session_for(cur, token, purpose="signup")
                if not sess:
                    raise HTTPException(status_code=401, detail="Verification expired — start again")
                phone = sess["phone"]
                if _username_taken(cur, username):
                    raise HTTPException(status_code=409, detail={
                        "code": "username_taken",
                        "message": "That username is taken — try one of these",
                        "suggestions": _suggest_usernames(cur, username),
                    })
                match = _match_customer(cur, phone)
                referral_code = _clean_referral_code(payload.get("referral_code"))
                referrer_id = None
                # A referral only applies to someone who has not already
                # purchased. Existing customers may join Johari, but cannot
                # turn historical spend into a referral reward.
                if referral_code and int((match or {}).get("total_orders") or 0) == 0:
                    cur.execute(
                        """SELECT id, phone FROM community_members
                           WHERE referral_code = %s LIMIT 1""",
                        (referral_code,),
                    )
                    referrer = cur.fetchone()
                    if referrer and referrer["phone"] != phone:
                        referrer_id = referrer["id"]
                member_referral_code = _new_referral_code(cur)
                try:
                    cur.execute(
                        """INSERT INTO community_members
                               (phone, full_name, email, dob, consent_at,
                                customer_id, customer_store_id, last_login_at, username,
                                 consent_terms_version, referral_code, referred_by_member_id)
                           VALUES (%s, %s, %s, %s, now(), %s, %s, now(), %s, %s, %s, %s)
                           ON CONFLICT (phone) DO NOTHING
                           RETURNING *""",
                        (
                            phone, full_name, email, dob,
                            (match or {}).get("customer_id"),
                            (match or {}).get("store_id"),
                            username,
                            terms_version,
                            member_referral_code,
                            referrer_id,
                        ),
                    )
                except psycopg2.IntegrityError:
                    # Raced another signup to the same username between the
                    # availability check and the insert.
                    conn.rollback()
                    raise HTTPException(status_code=409, detail={
                        "code": "username_taken",
                        "message": "That username was just taken — try one of these",
                        "suggestions": _suggest_usernames(cur, username),
                    })
                m = cur.fetchone()
                if not m:  # raced: member already exists for this phone
                    cur.execute("SELECT * FROM community_members WHERE phone = %s", (phone,))
                    m = cur.fetchone()
                # Atomically claim the single-use signup token: a concurrent
                # duplicate submit blocks on this DELETE, then sees 0 rows
                # and bails instead of minting a second session.
                cur.execute("DELETE FROM community_sessions WHERE token_hash = %s",
                            (_hash_token(token),))
                if cur.rowcount == 0:
                    conn.rollback()
                    raise HTTPException(status_code=401, detail="Verification expired — start again")
                member_token = _new_session(cur, phone, member_id=m["id"], purpose="member")
                payload_out = _member_payload(cur, m)
                conn.commit()
                return {"token": member_token, "member": payload_out}

    @app.post("/api/community/auth/logout")
    def community_logout(request: Request):
        _ensure_tables()
        _throttle(request, "lgo", [("ip", 30, 60), ("global", 1000, 60)])
        token = _bearer(request)
        if token:
            with _db() as conn:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM community_sessions WHERE token_hash = %s",
                                (_hash_token(token),))
                conn.commit()
        return {"ok": True}

    @app.get("/api/community/me")
    def community_me(request: Request):
        _ensure_tables()
        # Generous — the app calls this on boot/focus — but bounded, so
        # tokenless drive-by traffic can't hammer the pool.
        _throttle(request, "me", [("ip", 120, 60), ("global", 6000, 60)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                return {"member": _member_payload(cur, m)}

    @app.get("/api/community/referrals/me")
    def community_referral_me(request: Request):
        _ensure_tables()
        _throttle(request, "ref-me", [("ip", 60, 600), ("global", 3000, 3600)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                code = _referral_code_for_member(cur, m)
                conn.commit()
                return {
                    "code": code,
                    "reward_points": REFERRAL_REWARD_POINTS,
                    "reward_timing": "first_purchase",
                }

    @app.post("/api/community/referrals/invite")
    def community_referral_invite(request: Request, payload: dict = Body(...)):
        _ensure_tables()
        _throttle(request, "ref-invite", [("ip", 10, 3600), ("global", 1000, 3600)])
        email = str(payload.get("email") or "").strip().lower()
        if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
            raise HTTPException(status_code=400, detail="Enter a valid email address")
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                if email == (m.get("email") or "").strip().lower():
                    raise HTTPException(status_code=400, detail="Use a friend's email address")
                code = _referral_code_for_member(cur, m)
                conn.commit()
        # Never derive email destinations from caller-controlled request
        # headers. Community is mounted at /app/, so one canonical deployment
        # origin makes every invite safe and routable.
        if not re.fullmatch(r"https://[^/\s]+", COMMUNITY_PUBLIC_ORIGIN):
            log.error("COMMUNITY_PUBLIC_ORIGIN is missing or invalid")
            raise HTTPException(status_code=503, detail="Referral invites are temporarily unavailable")
        referral_url = f"{COMMUNITY_PUBLIC_ORIGIN}{COMMUNITY_APP_PATH}?ref={code}"
        name = (m.get("full_name") or "A Vivo Johari member").split()[0]
        body = (
            f"{name} has invited you to Vivo Johari.\n\n"
            "Join with their invitation, then make your first Vivo purchase "
            f"to thank them with {REFERRAL_REWARD_POINTS} Johari points.\n\n"
            f"Join Vivo Johari: {referral_url}\n"
        )
        threading.Thread(
            target=_send_member_email,
            args=(email, "You're invited to Vivo Johari", body),
            daemon=True,
        ).start()
        return {"ok": True, "message": "Your invitation is on its way."}

    @app.get("/api/community/auth/username-check")
    def community_username_check(request: Request, u: str = ""):
        """Live availability check — public (used mid-signup) but throttled."""
        _ensure_tables()
        _throttle(request, "uck", [("ip", 40, 60), ("global", 2000, 3600)])
        cand = _norm_username(u)
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                exclude_id = None
                token = _bearer(request)
                if token:  # settings editor: your own current name counts as available
                    sess = _session_for(cur, token, purpose="member")
                    if sess and sess.get("member_id"):
                        exclude_id = sess["member_id"]
                problem = _username_problem(cand)
                if problem:
                    return {"username": cand, "valid": False, "available": False,
                            "message": problem}
                if _username_taken(cur, cand, exclude_id=exclude_id):
                    return {"username": cand, "valid": True, "available": False,
                            "message": "That username is taken",
                            "suggestions": _suggest_usernames(cur, cand)}
                return {"username": cand, "valid": True, "available": True}

    @app.put("/api/community/me/settings")
    def community_update_settings(request: Request, payload: dict = Body(...)):
        """Privacy settings: username, tier-badge visibility, leaderboard opt-out."""
        _ensure_tables()
        _throttle(request, "set", [("ip", 30, 600), ("global", 2000, 3600)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                sets, args = [], []
                cand = None
                if "username" in payload:
                    cand = _norm_username(payload.get("username"))
                    problem = _username_problem(cand)
                    if problem:
                        raise HTTPException(status_code=400, detail=problem)
                    if _username_taken(cur, cand, exclude_id=m["id"]):
                        raise HTTPException(status_code=409, detail={
                            "code": "username_taken",
                            "message": "That username is taken — try one of these",
                            "suggestions": _suggest_usernames(cur, cand),
                        })
                    sets.append("username = %s"); args.append(cand)
                if "show_tier" in payload:
                    sets.append("show_tier = %s"); args.append(payload.get("show_tier") is True)
                if "show_leaderboard" in payload:
                    sets.append("show_leaderboard = %s"); args.append(payload.get("show_leaderboard") is not False)
                if not sets:
                    raise HTTPException(status_code=400, detail="Nothing to update")
                args.append(m["id"])
                try:
                    cur.execute(
                        "UPDATE community_members SET " + ", ".join(sets) +
                        " WHERE id = %s RETURNING *", args)
                except psycopg2.IntegrityError:
                    conn.rollback()
                    raise HTTPException(status_code=409, detail={
                        "code": "username_taken",
                        "message": "That username was just taken — try one of these",
                        "suggestions": _suggest_usernames(cur, cand or ""),
                    })
                m2 = cur.fetchone()
                payload_out = _member_payload(cur, m2)
                conn.commit()
                # Evict after commit so a concurrent /me can't re-seed the
                # cache with pre-commit data after our eviction.
                _me_cache.pop(m["id"], None)
                return {"member": payload_out}

    # ---------- live catalogue ----------

    @app.get("/api/community/style-quiz")
    def community_style_quiz_get(request: Request):
        """The member's saved quiz — answers prefill the editor, dna feeds the
        Profile chips. Bearer-authed; nothing here is served to other members."""
        _ensure_tables()
        _throttle(request, "quiz", [("ip", 60, 60)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute("SELECT answers, dna, completed_at, shared_at FROM community_style_quiz WHERE member_id = %s", (m["id"],))
                row = cur.fetchone()
                cur.execute("SELECT opted_in FROM community_style_prefs WHERE member_id = %s", (m["id"],))
                picks = cur.fetchone()
                if not row:
                    return {"answers": {}, "dna": None, "completed": False, "shared": False,
                            "weekly_picks_opted_in": bool((picks or {}).get("opted_in"))}
                return {"answers": row["answers"] or {}, "dna": row["dna"],
                        "completed": bool(row["completed_at"]), "shared": bool(row["shared_at"]),
                        "weekly_picks_opted_in": bool((picks or {}).get("opted_in"))}

    @app.put("/api/community/style-quiz")
    def community_style_quiz_save(request: Request, payload: dict = Body(...)):
        """Save (or re-save) the quiz. First-ever completion awards the
        one-time bonus — enforced by UNIQUE(member_id, kind), so a retake or
        a double-tap can never award twice. Quiz points are instant (no
        moderation). A retake updates answers + DNA but keeps completed_at."""
        _ensure_tables()
        _throttle(request, "quizsave", [("ip", 20, 60)])
        answers = _quiz_clean_answers((payload or {}).get("answers"))
        weekly_picks = (payload or {}).get("weekly_picks_opt_in")
        if not isinstance(weekly_picks, bool):
            weekly_picks = None
        complete = _quiz_complete(answers)
        dna = _compose_style_dna(answers) if complete else None
        awarded = False
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute("SELECT answers, dna, completed_at, shared_at FROM community_style_quiz WHERE member_id = %s FOR UPDATE",
                            (m["id"],))
                prev = cur.fetchone()
                if prev and prev.get("completed_at") and not complete:
                    # A finished member can only refine her quiz, never
                    # un-complete it: ignore the incomplete payload and echo
                    # the persisted state (personalisation keeps scoring from
                    # the full answers).
                    conn.commit()
                    return {"dna": prev["dna"], "completed": True, "points_awarded": False,
                            "shared": bool(prev.get("shared_at")), "member": _member_payload(cur, m)}
                cur.execute(
                    """INSERT INTO community_style_quiz (member_id, answers, dna, completed_at, updated_at)
                       VALUES (%s, %s::jsonb, %s::jsonb, CASE WHEN %s THEN now() END, now())
                       ON CONFLICT (member_id) DO UPDATE SET
                         answers = EXCLUDED.answers,
                         dna = COALESCE(EXCLUDED.dna, community_style_quiz.dna),
                         completed_at = COALESCE(community_style_quiz.completed_at, EXCLUDED.completed_at),
                         updated_at = now()""",
                    (m["id"], json.dumps(answers), json.dumps(dna) if dna else None, complete),
                )
                if complete and weekly_picks is not None:
                    cur.execute(
                        "INSERT INTO community_style_prefs (member_id) VALUES (%s) ON CONFLICT DO NOTHING",
                        (m["id"],),
                    )
                    cur.execute(
                        """UPDATE community_style_prefs SET
                             opted_in = %s,
                             opted_in_at = CASE WHEN %s AND opted_in_at IS NULL THEN now() ELSE opted_in_at END,
                             updated_at = now()
                           WHERE member_id = %s""",
                        (weekly_picks, weekly_picks, m["id"]),
                    )
                if complete:
                    cur.execute(
                        """INSERT INTO community_points_events (member_id, kind, points)
                           VALUES (%s, 'style_quiz', %s)
                           ON CONFLICT (member_id, kind) DO NOTHING
                           RETURNING id""",
                        (m["id"], QUIZ_BONUS_PTS),
                    )
                    awarded = cur.fetchone() is not None
                conn.commit()
                _me_cache.pop(m["id"], None)
                cur.execute("SELECT shared_at FROM community_style_quiz WHERE member_id = %s", (m["id"],))
                shared = bool((cur.fetchone() or {}).get("shared_at"))
                return {"dna": dna, "completed": complete, "points_awarded": awarded,
                        "shared": shared, "member": _member_payload(cur, m)}

    @app.post("/api/community/style-quiz/share")
    def community_style_quiz_share(request: Request):
        """Opt-in share of the Style DNA — never automatic. Records the
        consent timestamp; community surfaces can show her DNA chips later."""
        _ensure_tables()
        _throttle(request, "quizshare", [("ip", 20, 3600)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute(
                    """UPDATE community_style_quiz SET shared_at = COALESCE(shared_at, now())
                       WHERE member_id = %s AND completed_at IS NOT NULL RETURNING shared_at""",
                    (m["id"],),
                )
                row = cur.fetchone()
                conn.commit()
                if not row:
                    raise HTTPException(status_code=409, detail="Finish your Style Quiz first")
                return {"shared": True}

    # ------------------------------------------------------------------
    # "Styled for You" — opt-in weekly personalised recommendations.
    # Preferences are member-entered (size/fit/colours/prints/shades/fabrics/
    # categories/interests/avoid/frequency/notifications); purchase history is
    # used only while use_activity is true. Nobody is ever enrolled automatically.
    # ------------------------------------------------------------------
    _SFY_SIZES = ["XS", "S", "M", "L", "XL", "XXL", "1X", "2X", "3X", "4X"]
    _SFY_FITS = ["Fitted", "True to size", "Relaxed", "Flowy"]
    _SFY_INTERESTS = ["Workwear", "Casual", "Occasionwear", "Activewear"]
    _SFY_FREQS = ["weekly", "fortnightly", "monthly"]
    _SFY_PRINT_PREFS = ["Plain", "Prints"]
    _SFY_COLOUR_SHADES = [
        "Olive", "Sage", "Emerald", "Cobalt", "Navy", "Burgundy",
        "Blush", "Terracotta", "Cocoa", "Ivory", "Charcoal", "Black",
    ]
    _SFY_FABRICS = ["Cotton", "Silk", "Chiffon", "Denim", "Knit", "Linen"]
    _SFY_PRINT_KWS = (
        "print", "pattern", "floral", "stripe", "check", "polka", "animal",
        "abstract", "tie dye", "tropical", "leopard", "zebra",
    )
    _SFY_SHADE_KWS = {
        "Olive": ("olive",), "Sage": ("sage",), "Emerald": ("emerald",),
        "Cobalt": ("cobalt",), "Navy": ("navy",), "Burgundy": ("burgundy", "wine"),
        "Blush": ("blush", "dusty pink"), "Terracotta": ("terracotta", "rust"),
        "Cocoa": ("cocoa", "chocolate"), "Ivory": ("ivory", "cream"),
        "Charcoal": ("charcoal",), "Black": ("black",),
    }
    _SFY_FABRIC_KWS = {
        "Cotton": ("cotton",), "Silk": ("silk", "satin"),
        "Chiffon": ("chiffon",), "Denim": ("denim", "jean"),
        "Knit": ("knit", "rib"), "Linen": ("linen",),
    }
    _SFY_INTEREST_KWS = {
        "Workwear": ("blazer", "trouser", "pant", "shirt", "suit", "office", "work"),
        "Casual": ("tee", "t-shirt", "denim", "jean", "knit", "top", "short", "casual"),
        "Occasionwear": ("dress", "gown", "skirt", "occasion", "evening"),
        "Activewear": ("active", "legging", "sport", "jogger", "hood"),
    }
    _SFY_DEFAULTS = {
        "opted_in": False, "size": "", "fit": "", "colours": [], "categories": [],
        "print_preferences": [], "colour_shades": [], "fabrics": [],
        "interests": [], "avoid": [], "frequency": "weekly",
        "notify_push": True, "notify_email": False, "use_activity": False,
    }

    def _sfy_prefs(cur, member_id):
        cur.execute("SELECT * FROM community_style_prefs WHERE member_id = %s", (member_id,))
        row = cur.fetchone() or {}
        out = {}
        for k, d in _SFY_DEFAULTS.items():
            v = row.get(k, d)
            if isinstance(d, list):
                v = [str(x) for x in v] if isinstance(v, list) else []
            out[k] = v
        return out

    def _sfy_options():
        return {"sizes": _SFY_SIZES, "fits": _SFY_FITS,
                "colours": sorted(COMMUNITY_COLOR_BUCKETS.keys()),
                "print_preferences": _SFY_PRINT_PREFS,
                "colour_shades": _SFY_COLOUR_SHADES,
                "fabrics": _SFY_FABRICS,
                "interests": _SFY_INTERESTS, "frequencies": _SFY_FREQS,
                "journey": {"tenures": _JOURNEY_TENURES,
                            "discoveries": _JOURNEY_DISCOVERIES,
                            "shop_frequencies": _JOURNEY_SHOP_FREQS}}

    # "About your Vivo journey" — merged from the old "Help us dress you
    # better" survey. Optional/skippable independently of the style fields;
    # +30 pts awarded ONCE when all three selects are answered (open text
    # stays optional). Ledger kind 'vivo_journey' makes the award idempotent.
    JOURNEY_BONUS_PTS = 30
    _JOURNEY_TENURES = ["Under a year", "1–3 years", "3–5 years", "5+ years",
                        "First time browsing"]
    _JOURNEY_DISCOVERIES = ["Instagram/TikTok", "Friend/family", "In-store",
                            "Search", "Other"]
    _JOURNEY_SHOP_FREQS = ["Every week", "Once or twice a month",
                           "Every few months", "A few times a year"]

    def _journey_payload(cur, member_id):
        cur.execute("SELECT tenure, discovery, shop_frequency, feedback, completed_at "
                    "FROM community_journey_profile WHERE member_id = %s", (member_id,))
        row = cur.fetchone() or {}
        return {"tenure": row.get("tenure") or "",
                "discovery": row.get("discovery") or "",
                "shop_frequency": row.get("shop_frequency") or "",
                "feedback": row.get("feedback") or "",
                "completed": row.get("completed_at") is not None,
                "points": JOURNEY_BONUS_PTS}

    @app.get("/api/community/style-prefs")
    def community_style_prefs_get(request: Request):
        _ensure_tables()
        _throttle(request, "sfyprefs", [("ip", 60, 60)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                return {"prefs": _sfy_prefs(cur, m["id"]),
                        "journey": _journey_payload(cur, m["id"]),
                        "options": _sfy_options()}

    @app.put("/api/community/style-prefs")
    def community_style_prefs_save(request: Request, payload: dict = Body(...)):
        """Upsert her Styled-for-You preferences. Every field is whitelisted /
        length-capped; opted_in flips only when the payload says so explicitly,
        and the first opt-in stamps opted_in_at (the consent record)."""
        _ensure_tables()
        _throttle(request, "sfysave", [("ip", 30, 60)])
        p = payload or {}

        def _lst(key, allowed=None, cap=12, ln=40):
            v = p.get(key)
            if not isinstance(v, list):
                return None
            out, seen = [], set()
            for x in v:
                t = str(x).strip()[:ln]
                if not t or t.lower() in seen:
                    continue
                if allowed is not None and t not in allowed:
                    continue
                seen.add(t.lower())
                out.append(t)
                if len(out) >= cap:
                    break
            return out

        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute("INSERT INTO community_style_prefs (member_id) VALUES (%s) ON CONFLICT DO NOTHING",
                            (m["id"],))
                prev = _sfy_prefs(cur, m["id"])
                nxt = dict(prev)
                if isinstance(p.get("opted_in"), bool):
                    nxt["opted_in"] = p["opted_in"]
                if isinstance(p.get("size"), str):
                    nxt["size"] = p["size"] if p["size"] in _SFY_SIZES else ""
                if isinstance(p.get("fit"), str):
                    nxt["fit"] = p["fit"] if p["fit"] in _SFY_FITS else ""
                for key, allowed in (("colours", set(COMMUNITY_COLOR_BUCKETS)),
                                     ("print_preferences", set(_SFY_PRINT_PREFS)),
                                     ("colour_shades", set(_SFY_COLOUR_SHADES)),
                                     ("fabrics", set(_SFY_FABRICS)),
                                     ("categories", None),
                                     ("interests", set(_SFY_INTERESTS)),
                                     ("avoid", None)):
                    v = _lst(key, allowed)
                    if v is not None:
                        nxt[key] = v
                if isinstance(p.get("frequency"), str) and p["frequency"] in _SFY_FREQS:
                    nxt["frequency"] = p["frequency"]
                for key in ("notify_push", "notify_email", "use_activity"):
                    if isinstance(p.get(key), bool):
                        nxt[key] = p[key]
                cur.execute(
                    """UPDATE community_style_prefs SET
                         opted_in = %s,
                         opted_in_at = CASE WHEN %s AND opted_in_at IS NULL THEN now() ELSE opted_in_at END,
                         size = %s, fit = %s,
                         colours = %s::jsonb, print_preferences = %s::jsonb,
                         colour_shades = %s::jsonb, fabrics = %s::jsonb,
                         categories = %s::jsonb,
                         interests = %s::jsonb, avoid = %s::jsonb,
                         frequency = %s, notify_push = %s, notify_email = %s,
                         use_activity = %s, updated_at = now()
                       WHERE member_id = %s""",
                    (nxt["opted_in"], nxt["opted_in"], nxt["size"], nxt["fit"],
                     json.dumps(nxt["colours"]), json.dumps(nxt["print_preferences"]),
                     json.dumps(nxt["colour_shades"]), json.dumps(nxt["fabrics"]),
                     json.dumps(nxt["categories"]),
                     json.dumps(nxt["interests"]), json.dumps(nxt["avoid"]),
                     nxt["frequency"], nxt["notify_push"], nxt["notify_email"],
                     nxt["use_activity"], m["id"]),
                )

                # "About your Vivo journey" — optional; partial saves of the
                # style fields above never depend on it. Award fires once,
                # only when all three selects are answered.
                journey_awarded = False
                jp = p.get("journey")
                if isinstance(jp, dict):
                    j = _journey_payload(cur, m["id"])
                    if isinstance(jp.get("tenure"), str):
                        j["tenure"] = jp["tenure"] if jp["tenure"] in _JOURNEY_TENURES else j["tenure"]
                    if isinstance(jp.get("discovery"), str):
                        j["discovery"] = jp["discovery"] if jp["discovery"] in _JOURNEY_DISCOVERIES else j["discovery"]
                    if isinstance(jp.get("shop_frequency"), str):
                        j["shop_frequency"] = jp["shop_frequency"] if jp["shop_frequency"] in _JOURNEY_SHOP_FREQS else j["shop_frequency"]
                    if isinstance(jp.get("feedback"), str):
                        j["feedback"] = jp["feedback"].strip()[:1000]
                    if any([j["tenure"], j["discovery"], j["shop_frequency"], j["feedback"]]):
                        complete = bool(j["tenure"] and j["discovery"] and j["shop_frequency"])
                        cur.execute(
                            """INSERT INTO community_journey_profile
                                 (member_id, tenure, discovery, shop_frequency, feedback,
                                  completed_at, updated_at)
                               VALUES (%s, %s, %s, %s, %s,
                                       CASE WHEN %s THEN now() END, now())
                               ON CONFLICT (member_id) DO UPDATE SET
                                 tenure = EXCLUDED.tenure,
                                 discovery = EXCLUDED.discovery,
                                 shop_frequency = EXCLUDED.shop_frequency,
                                 feedback = EXCLUDED.feedback,
                                 completed_at = COALESCE(community_journey_profile.completed_at,
                                                         EXCLUDED.completed_at),
                                 updated_at = now()""",
                            (m["id"], j["tenure"], j["discovery"], j["shop_frequency"],
                             j["feedback"], complete),
                        )
                        if complete:
                            cur.execute(
                                """INSERT INTO community_points_events (member_id, kind, points)
                                   VALUES (%s, 'vivo_journey', %s)
                                   ON CONFLICT (member_id, kind) DO NOTHING
                                   RETURNING id""",
                                (m["id"], JOURNEY_BONUS_PTS))
                            journey_awarded = cur.fetchone() is not None
                            if journey_awarded:
                                _me_cache.pop(m["id"], None)

                conn.commit()
                return {"prefs": nxt,
                        "journey": _journey_payload(cur, m["id"]),
                        "journey_awarded": journey_awarded,
                        "options": _sfy_options()}

    @app.get("/api/community/styled-for-you")
    def community_styled_for_you(request: Request):
        """Her weekly picks. Requires an explicit opt-in; the selection blends
        her stated preferences, her Style DNA-adjacent colour/category tastes
        and (only with use_activity permission) her purchase history — with a
        deterministic weekly rotation so 'Updated weekly' is literally true.
        Members with thin data still get useful general picks."""
        _ensure_tables()
        _throttle(request, "sfy", [("ip", 60, 60)])
        from urllib.parse import quote
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                prefs = _sfy_prefs(cur, m["id"])
                if not prefs["opted_in"]:
                    return {"opted_in": False, "sections": []}

                # Lightweight status probe — Home only needs the opt-in flag
                # (Home-vs-Shop rewire: no recommendation/product payloads are
                # fetched on Home; the full picks fetch belongs to Shop).
                if (request.query_params.get("meta_only") or "") in ("1", "true"):
                    return {"opted_in": True, "sections": [], "cadence_label": "Updated weekly"}

                in_size_sql = "FALSE"
                params = {}
                if prefs["size"]:
                    in_size_sql = """EXISTS (
                        SELECT 1 FROM all_products_clean sp
                        JOIN inv iv ON iv.sku = sp.sku
                        WHERE sp.style_name = c.style_name
                          AND COALESCE(sp.color_print,'') = c.color
                          AND sp.active IS TRUE AND sp.price::float > 0
                          AND UPPER(TRIM(COALESCE(sp.size,''))) = %(psize)s
                          AND iv.soh > 0)"""
                    params["psize"] = prefs["size"]
                cur.execute("""
                WITH inv AS (
                    SELECT sku, SUM(COALESCE(available,0)) AS soh
                    FROM all_inventory GROUP BY sku
                ),
                stock AS (
                    SELECT sk.style_name, sk.color, SUM(COALESCE(i.soh,0)) AS soh
                    FROM (
                        SELECT DISTINCT p.style_name, COALESCE(p.color_print,'') AS color, p.sku
                        FROM all_products_clean p
                        WHERE p.active IS TRUE AND p.price::float > 0
                    ) sk
                    LEFT JOIN inv i ON i.sku = sk.sku
                    GROUP BY 1, 2
                ),
                cards AS (
                    SELECT DISTINCT ON (p.style_name, COALESCE(p.color_print,''))
                        p.style_name,
                        COALESCE(p.color_print,'') AS color,
                        p.sku,
                        COALESCE(NULLIF(TRIM(p.category),''),'Uncategorised') AS category,
                        COALESCE(NULLIF(TRIM(p.product_type),''),'') AS subcategory,
                        p.price::float AS price,
                        NULLIF(TRIM(COALESCE(p.style_launch_date,'')),'') AS launch
                    FROM all_products_clean p
                    JOIN product_image_map mp ON mp.sku = p.sku
                    JOIN product_images img ON img.tmpl_id = mp.tmpl_id
                         AND COALESCE(img.image_512,'') <> ''
                    WHERE p.style_name IS NOT NULL AND p.style_name <> ''
                      AND COALESCE(p.brand,'') NOT ILIKE '%%third party%%'
                      AND p.active IS TRUE
                      AND p.price::float > 0
                    ORDER BY p.style_name, COALESCE(p.color_print,''), p.sku
                )
                SELECT c.style_name, c.color, c.sku, c.category, c.subcategory,
                       c.price, c.launch, """ + in_size_sql + """ AS in_size
                FROM cards c
                JOIN stock s ON s.style_name = c.style_name AND s.color = c.color
                WHERE s.soh > 0
                ORDER BY c.launch DESC NULLS LAST, c.style_name, c.color
                LIMIT 300
                """, params)
                pool = [dict(r) for r in cur.fetchall()]

                fav_cats = []
                if prefs["use_activity"] and m.get("customer_id"):
                    try:
                        cur.execute(
                            """SELECT COALESCE(NULLIF(TRIM(p.category),''),'') AS category,
                                      SUM(COALESCE(s.ordered_item_quantity,0)) AS units
                               FROM all_sales s
                               JOIN all_products_clean p ON p.sku = s.variant_sku
                               WHERE s.customer_id = %s AND s.store_id = %s
                               GROUP BY 1 ORDER BY units DESC LIMIT 3""",
                            (m["customer_id"], m.get("customer_store_id")))
                        fav_cats = [r["category"] for r in cur.fetchall() if r["category"]]
                    except Exception as e:
                        log.warning("styled-for-you favourites failed: %s", e)

        avoid = {a.lower() for a in prefs["avoid"]}
        if avoid:
            pool = [it for it in pool
                    if it["category"].lower() not in avoid
                    and (it["subcategory"] or "").lower() not in avoid]

        colour_kws = sorted({kw for b in prefs["colours"]
                             for kw in COMMUNITY_COLOR_BUCKETS.get(b, ())})
        shade_kws = sorted({kw for s in prefs["colour_shades"]
                            for kw in _SFY_SHADE_KWS.get(s, ())})
        fabric_kws = sorted({kw for f in prefs["fabrics"]
                             for kw in _SFY_FABRIC_KWS.get(f, ())})
        print_prefs = set(prefs["print_preferences"])
        pref_cats = {c.lower() for c in prefs["categories"]}
        fav_set = {c.lower() for c in fav_cats}
        interest_kws = {i: _SFY_INTEREST_KWS[i] for i in prefs["interests"] if i in _SFY_INTEREST_KWS}

        def _match_interest(it, kws):
            hay = (it["category"] + " " + (it["subcategory"] or "")).lower()
            return any(k in hay for k in kws)

        def _score(it):
            sc = 0
            if it["category"].lower() in pref_cats:
                sc += 4
            if it["category"].lower() in fav_set:
                sc += 3
            col = (it["color"] or "").lower()
            if colour_kws and any(k in col for k in colour_kws):
                sc += 2
            hay = " ".join((it["style_name"], col, it["subcategory"] or "")).lower()
            if shade_kws and any(k in hay for k in shade_kws):
                sc += 3
            if fabric_kws and any(k in hay for k in fabric_kws):
                sc += 2
            is_print = any(k in hay for k in _SFY_PRINT_KWS)
            if ("Prints" in print_prefs and is_print) or ("Plain" in print_prefs and not is_print):
                sc += 2
            if interest_kws and any(_match_interest(it, kws) for kws in interest_kws.values()):
                sc += 2
            if it["in_size"]:
                sc += 1
            return sc

        # Deterministic rotation matched to her chosen cadence: the same
        # picks for the whole period, then a fresh set (weekly = Mondays,
        # fortnightly = every other ISO week, monthly = the 1st).
        now = datetime.utcnow()
        iso = now.isocalendar()
        freq = prefs["frequency"]
        if freq == "monthly":
            seed = "{}-m{}".format(now.year, now.month)
            cadence_word = "monthly"
        elif freq == "fortnightly":
            seed = "{}-f{}".format(iso[0], iso[1] // 2)
            cadence_word = "fortnightly"
        else:
            seed = "{}-w{}".format(iso[0], iso[1])
            cadence_word = "weekly"
        def _rot(it):
            return hashlib.md5((seed + "|" + str(it["sku"])).encode()).hexdigest()

        newest = pool[:8]  # pool arrives launch-ordered
        ranked = sorted(pool, key=lambda it: (-_score(it), _rot(it)))

        def _pack(items, n):
            out = []
            for it in items[:n]:
                out.append({
                    "style_name": it["style_name"], "color": it["color"],
                    "sku": it["sku"], "category": it["category"],
                    "subcategory": it["subcategory"], "price": it["price"],
                    "image_url": "/api/community/product-image/" + quote(str(it["sku"]), safe=""),
                })
            return out

        picks = ranked[:12]
        pick_skus = {it["sku"] for it in picks}
        sections = [{"key": "picks", "kicker": "Updated " + cadence_word,
                     "title": "Styled for You",
                     "sub": "Your {} picks are here.".format(cadence_word),
                     "items": _pack(picks, 12)}]
        top_cat = picks[0]["category"].lower() if picks else ""
        complete = [it for it in ranked
                    if it["sku"] not in pick_skus and it["category"].lower() != top_cat]
        if complete:
            sections.append({"key": "complete_look", "title": "Complete the Look",
                             "sub": "Pieces that pair with this week's picks.",
                             "items": _pack(complete, 8)})
        if "Workwear" in interest_kws:
            ww = [it for it in ranked if _match_interest(it, _SFY_INTEREST_KWS["Workwear"])]
            if ww:
                sections.append({"key": "workwear", "title": "Workwear Picks",
                                 "sub": "Polished pieces for the working week.",
                                 "items": _pack(ww, 8)})
        if newest:
            sections.append({"key": "new_week", "title": "New This Week",
                             "sub": "The freshest arrivals, filtered for you.",
                             "items": _pack(newest, 8)})
        if fav_set:
            fav_items = [it for it in ranked if it["category"].lower() in fav_set]
            if fav_items:
                sections.append({"key": "favourites", "title": "Based on Your Favourites",
                                 "sub": "More from the categories you shop most.",
                                 "items": _pack(fav_items, 8)})
        if prefs["size"]:
            sized = [it for it in ranked if it["in_size"]]
            if sized:
                sections.append({"key": "in_size", "title": "Recommended in Your Size",
                                 "sub": "Everything here is in stock in {}.".format(prefs["size"]),
                                 "items": _pack(sized, 8)})
        if freq == "monthly":
            week_label = now.strftime("%B") + " picks"
        else:
            monday = now.date() - timedelta(days=now.weekday())
            week_label = "Week of " + monday.strftime("%-d %b")
        return {"opted_in": True,
                "week_label": week_label,
                "cadence_label": "Updated " + cadence_word,
                "cadence": cadence_word,
                "sections": sections}

    @app.get("/api/community/products")
    def community_products(request: Request, category: str = "",
                           limit: int = 24, offset: int = 0,
                           personalize: str = "", categories: str = "",
                           brands: str = "", sizes: str = "",
                           colors: str = "", prints: str = "",
                           price_bands: str = "", sort: str = "new",
                           count_only: int = 0, gender: str = "", q: str = ""):
        _ensure_tables()
        _throttle(request, "prod", [("ip", 120, 60)])
        limit = max(1, min(int(limit or 24), 48))
        offset = max(0, min(int(offset or 0), 960))
        category = (category or "").strip()[:60]
        search = " ".join((q or "").split())[:80]

        def _csv(v, cap=12, ln=60):
            out, seen = [], set()
            for t in str(v or "").split(","):
                t = t.strip()[:ln]
                if t and t.lower() not in seen:
                    seen.add(t.lower())
                    out.append(t)
                if len(out) >= cap:
                    break
            return out

        f_cats = _csv(categories)
        if category and category not in f_cats:
            # Legacy single-category param (pills, cached clients) folds in.
            f_cats.append(category)
        f_brands = _csv(brands)
        f_sizes = [s.upper() for s in _csv(sizes, cap=20, ln=10)]
        f_colors = [c for c in _csv(colors) if c in COMMUNITY_COLOR_BUCKETS]
        f_prints = [x for x in _csv(prints, cap=2) if x in ("Print", "Plain")]
        f_bands = [b for b in _csv(price_bands, cap=4, ln=10) if b in _PRICE_BAND_MAP]
        # Gender filter: derive from style_name.
        # "men" = style names containing a standalone 'men' / 'mens' word
        # (Postgres word-boundary anchors; the NOT-women guard is implicit
        # because \mmen\M never matches 'women' — 'm' is not at a word boundary
        # inside 'women').
        f_gender = (gender or "").strip().lower()
        if f_gender not in ("men", "women"):
            f_gender = ""
        sort = (sort or "new").strip()
        if sort not in COMMUNITY_SHOP_SORTS:
            sort = "new"
        count_only = 1 if str(count_only) in ("1", "true") else 0
        filtered = bool(f_cats or f_brands or f_sizes or f_colors
                        or f_prints or f_bands or f_gender or search)
        # Optional Style-DNA re-ranking: only when asked for, and only when
        # the Bearer token resolves to a member with a completed quiz. Public
        # callers and quiz-skippers keep the curated default order — and only
        # that default order touches the shared response cache.
        quiz = None
        if sort == "new" and str(personalize or "").strip() in ("1", "true", "yes"):
            with _db() as conn:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    try:
                        sess = _session_for(cur, _bearer(request), purpose="member")
                    except Exception:
                        sess = None
                    if sess and sess.get("member_id"):
                        cur.execute("SELECT answers, completed_at FROM community_style_quiz WHERE member_id = %s",
                                    (sess["member_id"],))
                        qrow = cur.fetchone()
                        if qrow and qrow.get("completed_at"):
                            quiz = _quiz_clean_answers(qrow["answers"])
        key = (category, limit, offset, sort, search)
        cacheable = (quiz is None and not filtered and not count_only
                     and sort in ("new", "best"))
        if cacheable:
            cached = _products_cache.get(key)
            if cached and time.time() - cached[0] < _PRODUCTS_TTL:
                return _stamp_badges(cached[1])

        extra, extra_params = [], {}
        if f_gender == "men":
            # Match styles whose name contains 'men' or 'mens' as a standalone
            # word (Postgres \m = word-start boundary, \M = word-end boundary).
            extra.append(r"AND LOWER(c.style_name) ~ '\m(mens|men)\M'")
        elif f_gender == "women":
            extra.append(r"AND NOT (LOWER(c.style_name) ~ '\m(mens|men)\M')")
        if search:
            extra.append("""AND (
                c.style_name ILIKE %(search)s
                OR c.color ILIKE %(search)s
                OR c.category ILIKE %(search)s
                OR c.subcategory ILIKE %(search)s
                OR c.brand ILIKE %(search)s
                OR c.print_plain ILIKE %(search)s
            )""")
            extra_params["search"] = "%" + search + "%"
        if f_cats:
            extra.append("AND c.category = ANY(%(f_cats)s)")
            extra_params["f_cats"] = f_cats
        if f_brands:
            extra.append("AND c.brand = ANY(%(f_brands)s)")
            extra_params["f_brands"] = f_brands
        if f_prints:
            extra.append("AND c.print_plain = ANY(%(f_prints)s)")
            extra_params["f_prints"] = f_prints
        if f_colors:
            kws = sorted({kw for b in f_colors
                          for kw in COMMUNITY_COLOR_BUCKETS[b]})
            extra.append("AND c.color ILIKE ANY(%(f_colkws)s)")
            extra_params["f_colkws"] = ["%" + k + "%" for k in kws]
        if f_bands:
            ors = []
            for b in f_bands:
                lo, hi = _PRICE_BAND_MAP[b]
                clause = "c.price >= {:.0f}".format(lo)
                if hi is not None:
                    clause += " AND c.price < {:.0f}".format(hi)
                ors.append("(" + clause + ")")
            extra.append("AND (" + " OR ".join(ors) + ")")
        if f_sizes:
            extra.append(
                """AND EXISTS (
                SELECT 1 FROM all_products_clean sp
                JOIN inv iv ON iv.sku = sp.sku
                WHERE sp.style_name = c.style_name
                  AND COALESCE(sp.color_print,'') = c.color
                  AND sp.active IS TRUE AND sp.price::float > 0
                  AND UPPER(TRIM(COALESCE(sp.size,''))) = ANY(%(f_sizes)s)
                  AND iv.soh > 0)""")
            extra_params["f_sizes"] = f_sizes

        best_cte = """units30 AS (
            SELECT pp.style_name, COALESCE(pp.color_print,'') AS color,
                   SUM(CASE WHEN s.sale_kind IN ('sale','order')
                            THEN COALESCE(s.ordered_item_quantity,0)
                            ELSE 0 END) AS units
            FROM all_sales s
            JOIN all_products_clean pp ON pp.sku = s.variant_sku
            WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '30 days'
            GROUP BY 1, 2
        ),
        """

        order_sql = "ORDER BY c.launch DESC NULLS LAST, c.style_name, c.color"
        if sort == "price_asc":
            order_sql = "ORDER BY c.price ASC, c.style_name, c.color"
        elif sort == "price_desc":
            order_sql = "ORDER BY c.price DESC, c.style_name, c.color"
        elif sort == "best":
            order_sql = ("ORDER BY COALESCE(u.units,0) DESC, "
                         "c.launch DESC NULLS LAST, c.style_name, c.color")

        sql = """
        WITH """ + (best_cte if sort == "best" and not count_only else "") + """inv AS (
            SELECT sku, SUM(COALESCE(available,0)) AS soh
            FROM all_inventory
            GROUP BY sku
        ),
        stock AS (
            -- Dedupe catalogue rows to one (style, colour, sku) each BEFORE
            -- summing, so a SKU with duplicate product rows counts its
            -- pre-aggregated inventory exactly once.
            SELECT sk.style_name, sk.color, SUM(COALESCE(i.soh,0)) AS soh
            FROM (
                SELECT DISTINCT p.style_name, COALESCE(p.color_print,'') AS color, p.sku
                FROM all_products_clean p
                WHERE p.active IS TRUE AND p.price::float > 0
            ) sk
            LEFT JOIN inv i ON i.sku = sk.sku
            GROUP BY 1, 2
        ),
        cards AS (
            SELECT DISTINCT ON (p.style_name, COALESCE(p.color_print,''))
                p.style_name,
                COALESCE(p.color_print,'') AS color,
                p.sku,
                COALESCE(NULLIF(TRIM(p.category),''),'Uncategorised') AS category,
                COALESCE(NULLIF(TRIM(p.product_type),''),'') AS subcategory,
                COALESCE(NULLIF(TRIM(p.brand),''),'') AS brand,
                COALESCE(NULLIF(TRIM(p.print_plain),''),'') AS print_plain,
                p.price::float AS price,
                NULLIF(TRIM(COALESCE(p.style_launch_date,'')),'') AS launch
            FROM all_products_clean p
            JOIN product_image_map m ON m.sku = p.sku
            JOIN product_images img ON img.tmpl_id = m.tmpl_id
                 AND COALESCE(img.image_512,'') <> ''
            WHERE p.style_name IS NOT NULL AND p.style_name <> ''
              AND COALESCE(p.brand,'') NOT ILIKE '%%third party%%'
              AND p.active IS TRUE
              AND p.price::float > 0
            ORDER BY p.style_name, COALESCE(p.color_print,''), p.sku
        )
        """
        where_sql = """
        WHERE s.soh > 0
          AND (%(cat)s = '' OR c.category = %(cat)s)
          """ + "\n          ".join(extra)
        if count_only:
            sql += """SELECT COUNT(*) AS n
        FROM cards c
        JOIN stock s ON s.style_name = c.style_name AND s.color = c.color""" + where_sql
        else:
            sql += """SELECT c.style_name, c.color, c.sku, c.category, c.subcategory,
               c.price, c.launch, s.soh::int AS soh
        FROM cards c
        """ + ("""LEFT JOIN units30 u ON u.style_name = c.style_name AND u.color = c.color
        """ if sort == "best" else "") + """JOIN stock s ON s.style_name = c.style_name AND s.color = c.color""" + where_sql + "\n        " + order_sql + """
        LIMIT %(lim)s OFFSET %(off)s
        """
        if quiz is not None:
            sql = sql.replace(
                "ORDER BY c.launch DESC NULLS LAST",
                "ORDER BY ({}) DESC, c.launch DESC NULLS LAST".format(_quiz_score_sql(quiz)), 1)
        facet_sql = """
        WITH inv AS (
            SELECT sku, SUM(COALESCE(available,0)) AS soh
            FROM all_inventory GROUP BY sku
        ),
        stock AS (
            -- Dedupe catalogue rows to one (style, colour, sku) each BEFORE
            -- summing, so a SKU with duplicate product rows counts its
            -- pre-aggregated inventory exactly once.
            SELECT sk.style_name, sk.color, SUM(COALESCE(i.soh,0)) AS soh
            FROM (
                SELECT DISTINCT p.style_name, COALESCE(p.color_print,'') AS color, p.sku
                FROM all_products_clean p
                WHERE p.active IS TRUE AND p.price::float > 0
            ) sk
            LEFT JOIN inv i ON i.sku = sk.sku
            GROUP BY 1, 2
        ),
        cards AS (
            SELECT DISTINCT ON (p.style_name, COALESCE(p.color_print,''))
                p.style_name, COALESCE(p.color_print,'') AS color,
                COALESCE(NULLIF(TRIM(p.category),''),'Uncategorised') AS category
            FROM all_products_clean p
            JOIN product_image_map m ON m.sku = p.sku
            JOIN product_images img ON img.tmpl_id = m.tmpl_id
                 AND COALESCE(img.image_512,'') <> ''
            WHERE p.style_name IS NOT NULL AND p.style_name <> ''
              AND COALESCE(p.brand,'') NOT ILIKE '%%third party%%'
              AND p.active IS TRUE
              AND p.price::float > 0
            ORDER BY p.style_name, COALESCE(p.color_print,''), p.sku
        )
        SELECT c.category, COUNT(*) AS n
        FROM cards c
        JOIN stock s ON s.style_name = c.style_name AND s.color = c.color
        WHERE s.soh > 0
        GROUP BY c.category
        ORDER BY n DESC
        LIMIT 12
        """
        from urllib.parse import quote
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                if count_only:
                    cur.execute(sql, {"cat": category, **extra_params})
                    return {"total": int(cur.fetchone()["n"])}
                cur.execute(sql, {"cat": category, "lim": limit + 1,
                                  "off": offset, **extra_params})
                rows = [dict(r) for r in cur.fetchall()]
                cur.execute(facet_sql)
                cats = [{"name": r["category"], "count": int(r["n"])} for r in cur.fetchall()]
        has_more = len(rows) > limit
        items = rows[:limit]
        for r in items:
            r["image_url"] = "/api/community/product-image/" + quote(str(r["sku"]), safe="")
            r.pop("launch", None)
            # Exact stock counts never reach the customer payload
            # ("Only N left" is banned shop-wide).
            r.pop("soh", None)

        # -- Colourway siblings -------------------------------------------------
        # For each style on this page, collect all in-stock imaged colourways so
        # product cards can show tappable swatches without a second fetch per card.
        # One representative SKU per colourway (lowest sku for determinism),
        # ordered by colour name. Only injected when count_only is False.
        if items and not count_only:
            style_names = list({r["style_name"] for r in items})
            cw_sql = """
            WITH inv AS (
                SELECT sku, SUM(COALESCE(available,0)) AS soh
                FROM all_inventory GROUP BY sku
            ),
            stock AS (
                SELECT sk.style_name, sk.color, SUM(COALESCE(i.soh,0)) AS soh
                FROM (
                    SELECT DISTINCT p.style_name, COALESCE(p.color_print,'') AS color, p.sku
                    FROM all_products_clean p
                    WHERE p.active IS TRUE AND p.price::float > 0
                ) sk
                LEFT JOIN inv i ON i.sku = sk.sku
                GROUP BY 1, 2
            ),
            cw AS (
                SELECT DISTINCT ON (p.style_name, COALESCE(p.color_print,''))
                    p.style_name,
                    COALESCE(p.color_print,'') AS color,
                    p.sku
                FROM all_products_clean p
                JOIN product_image_map m ON m.sku = p.sku
                JOIN product_images img ON img.tmpl_id = m.tmpl_id
                     AND COALESCE(img.image_512,'') <> ''
                WHERE p.style_name = ANY(%(names)s)
                  AND p.active IS TRUE AND p.price::float > 0
                  AND COALESCE(p.brand,'') NOT ILIKE '%%third party%%'
                ORDER BY p.style_name, COALESCE(p.color_print,''), p.sku
            )
            SELECT cw.style_name, cw.color, cw.sku
            FROM cw
            JOIN stock s ON s.style_name = cw.style_name AND s.color = cw.color
            WHERE s.soh > 0
            ORDER BY cw.style_name, cw.color
            """
            with _db() as cconn:
                with cconn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as ccur:
                    ccur.execute(cw_sql, {"names": style_names})
                    cw_rows = [dict(r) for r in ccur.fetchall()]
            # Group by style_name
            cw_by_style = collections.defaultdict(list)
            for cw in cw_rows:
                cw_by_style[cw["style_name"]].append({
                    "sku": cw["sku"],
                    "color": cw["color"],
                    "image_url": "/api/community/product-image/" + quote(str(cw["sku"]), safe=""),
                })
            # Attach to items; only include colourways array when >1 exists
            for r in items:
                siblings = cw_by_style.get(r["style_name"], [])
                if len(siblings) > 1:
                    r["colourways"] = siblings

        resp = {"items": items, "categories": cats, "has_more": has_more,
                "limit": limit, "offset": offset, "personalized": quiz is not None}
        if cacheable:
            _cache_put(_products_cache, key, resp)
        # Badges are overlaid at response time so this cached payload never
        # freezes a cold (empty) badge map.
        return _stamp_badges(resp)

    _facets_cache = {}

    @app.get("/api/community/products/facets")
    def community_product_facets(request: Request):
        """Filter options for the Shop drawer, mirroring the grid universe
        exactly (active, priced, imaged, non-third-party, in stock). Colour
        families are bucketed server-side from color_print keywords; sizes
        count colourways with that size in stock. Values are decorative
        counts — filters re-check everything server-side. Cached ~15 min."""
        _ensure_tables()
        _throttle(request, "prod", [("ip", 120, 60)])
        cached = _facets_cache.get("v")
        if cached and time.time() - cached[0] < 900:
            return cached[1]
        sql = """
        WITH inv AS (
            SELECT sku, SUM(COALESCE(available,0)) AS soh
            FROM all_inventory GROUP BY sku
        ),
        stock AS (
            SELECT sk.style_name, sk.color, SUM(COALESCE(i.soh,0)) AS soh
            FROM (
                SELECT DISTINCT p.style_name, COALESCE(p.color_print,'') AS color, p.sku
                FROM all_products_clean p
                WHERE p.active IS TRUE AND p.price::float > 0
            ) sk
            LEFT JOIN inv i ON i.sku = sk.sku
            GROUP BY 1, 2
        ),
        cards AS (
            SELECT DISTINCT ON (p.style_name, COALESCE(p.color_print,''))
                p.style_name,
                COALESCE(p.color_print,'') AS color,
                COALESCE(NULLIF(TRIM(p.category),''),'Uncategorised') AS category,
                COALESCE(NULLIF(TRIM(p.brand),''),'') AS brand,
                COALESCE(NULLIF(TRIM(p.print_plain),''),'') AS print_plain
            FROM all_products_clean p
            JOIN product_image_map m ON m.sku = p.sku
            JOIN product_images img ON img.tmpl_id = m.tmpl_id
                 AND COALESCE(img.image_512,'') <> ''
            WHERE p.style_name IS NOT NULL AND p.style_name <> ''
              AND COALESCE(p.brand,'') NOT ILIKE '%%third party%%'
              AND p.active IS TRUE
              AND p.price::float > 0
            ORDER BY p.style_name, COALESCE(p.color_print,''), p.sku
        ),
        live AS (
            SELECT c.* FROM cards c
            JOIN stock s ON s.style_name = c.style_name AND s.color = c.color
            WHERE s.soh > 0
        ),
        size_rows AS (
            SELECT DISTINCT l.style_name, l.color, UPPER(TRIM(sp.size)) AS size
            FROM live l
            JOIN all_products_clean sp
                 ON sp.style_name = l.style_name
                AND COALESCE(sp.color_print,'') = l.color
                AND sp.active IS TRUE AND sp.price::float > 0
            JOIN inv iv ON iv.sku = sp.sku AND iv.soh > 0
            WHERE NULLIF(TRIM(COALESCE(sp.size,'')),'') IS NOT NULL
        )
        SELECT 'category' AS facet, category AS val, COUNT(*) AS n FROM live GROUP BY 2
        UNION ALL SELECT 'brand', brand, COUNT(*) FROM live WHERE brand <> '' GROUP BY 2
        UNION ALL SELECT 'print', print_plain, COUNT(*) FROM live
                  WHERE print_plain IN ('Print','Plain') GROUP BY 2
        UNION ALL SELECT 'size', size, COUNT(*) FROM size_rows GROUP BY 2
        UNION ALL SELECT 'color_raw', color, COUNT(*) FROM live WHERE color <> '' GROUP BY 2
        """
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql)
                rows = [dict(r) for r in cur.fetchall()]

        def _facet(name):
            return {r["val"]: int(r["n"]) for r in rows if r["facet"] == name}

        cats = sorted(_facet("category").items(), key=lambda kv: -kv[1])
        brands_f = sorted(_facet("brand").items(), key=lambda kv: -kv[1])
        prints_f = _facet("print")
        sizes_f = _facet("size")
        size_rank = {s: i for i, s in enumerate(COMMUNITY_SIZE_ORDER)}
        sizes_out = sorted(sizes_f.items(),
                           key=lambda kv: (size_rank.get(kv[0], 99), kv[0]))
        color_counts = {}
        for val, n in _facet("color_raw").items():
            low = val.lower()
            for bucket, kws in COMMUNITY_COLOR_BUCKETS.items():
                if any(k in low for k in kws):
                    color_counts[bucket] = color_counts.get(bucket, 0) + n
        colors_out = [(b, color_counts[b]) for b in COMMUNITY_COLOR_BUCKETS
                      if color_counts.get(b)]
        resp = {
            "categories": [{"name": k, "count": n} for k, n in cats],
            "brands": [{"name": k, "count": n} for k, n in brands_f],
            "sizes": [{"name": k, "count": n} for k, n in sizes_out],
            "colors": [{"name": k, "count": n} for k, n in colors_out],
            "prints": [{"name": k, "count": prints_f[k]}
                       for k in ("Print", "Plain") if prints_f.get(k)],
            "price_bands": [{"id": b[0], "label": b[3]}
                            for b in COMMUNITY_PRICE_BANDS],
            "size_ranges": QUIZ_SIZE_RANGE_SIZES,
            "sorts": [
                {"id": "new", "label": "Newest first"},
                {"id": "price_asc", "label": "Price low to high"},
                {"id": "price_desc", "label": "Price high to low"},
                {"id": "best", "label": "Best sellers"},
            ],
        }
        _facets_cache["v"] = (time.time(), resp)
        return resp

    @app.get("/api/community/product/{sku:path}")
    def community_product_detail(request: Request, sku: str):
        """Full product detail for the PDP. Expands the card's SKU to its
        style+colour siblings for the size run (live stock per size from
        all_inventory), returns the Shopify gallery URLs shared by the
        colourway, the modal price, and whatever catalogue attributes exist.
        Public + throttled + cached like /products; never exposes cost or
        supplier fields."""
        _ensure_tables()
        _throttle(request, "pdp", [("ip", 120, 60)])
        sku = (sku or "").strip()[:80]
        if not sku:
            raise HTTPException(status_code=404, detail="Not found")
        cached = _pdp_cache.get(sku)
        if cached and time.time() - cached[0] < _PDP_TTL:
            return _stamp_pdp_badge(cached[1])

        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """SELECT style_name, COALESCE(color_print,'') AS color,
                              COALESCE(NULLIF(TRIM(brand),''),'Vivo') AS brand,
                              COALESCE(NULLIF(TRIM(category),''),'Uncategorised') AS category,
                              COALESCE(NULLIF(TRIM(product_type),''),'') AS subcategory,
                              NULLIF(TRIM(COALESCE(collection,'')),'') AS collection,
                              NULLIF(TRIM(COALESCE(season,'')),'') AS season,
                              NULLIF(TRIM(COALESCE(fiber_content,'')),'') AS fiber_content,
                              NULLIF(TRIM(COALESCE(fabric_structure,'')),'') AS fabric_structure,
                              NULLIF(TRIM(COALESCE(gsm,'')),'') AS gsm,
                              NULLIF(TRIM(COALESCE(style_number,'')),'') AS style_number
                       FROM all_products_clean
                       WHERE sku = %s AND style_name IS NOT NULL AND style_name <> ''
                       LIMIT 1""",
                    (sku,),
                )
                head = cur.fetchone()
                if not head:
                    raise HTTPException(status_code=404, detail="Not found")
                style, color = head["style_name"], head["color"]

                # Size run: one row per active sibling SKU with live stock.
                # Inventory is pre-aggregated per SKU in its own CTE first —
                # joining raw all_inventory rows onto product rows fans out
                # whenever a SKU has duplicate catalogue rows.
                cur.execute(
                    """WITH inv AS (
                           SELECT sku, SUM(COALESCE(available,0))::int AS soh
                           FROM all_inventory
                           GROUP BY sku
                       )
                       SELECT p.sku, COALESCE(NULLIF(TRIM(p.size),''),'') AS size,
                              p.price::float AS price,
                              COALESCE(MAX(inv.soh),0)::int AS soh
                       FROM all_products_clean p
                       LEFT JOIN inv ON inv.sku = p.sku
                       WHERE p.style_name = %s
                         AND COALESCE(p.color_print,'') = %s
                         AND p.active IS TRUE AND p.price::float > 0
                       GROUP BY p.sku, p.size, p.price""",
                    (style, color),
                )
                variants = [dict(r) for r in cur.fetchall()]

                # Shopify gallery shared by the colourway (deduped by URL).
                cur.execute(
                    """SELECT u.image_url,
                              BOOL_OR(u.is_primary) AS is_primary,
                              MIN(u.position) AS position
                       FROM all_products_clean sib
                       JOIN product_image_urls u ON u.sku = sib.sku
                       WHERE sib.style_name = %s
                         AND COALESCE(sib.color_print,'') = %s
                       GROUP BY u.image_url
                       ORDER BY BOOL_OR(u.is_primary) DESC, MIN(u.position) ASC
                       LIMIT 16""",
                    (style, color),
                )
                img_rows = cur.fetchall()

                # Sibling colourways of the same style, for the PDP colour
                # selector. One representative SKU per colourway — any
                # sibling SKU resolves to the colourway's shared photos via
                # /product-image. soh is only used as an in-stock boolean,
                # so duplicate catalogue rows inflating the SUM is harmless.
                cur.execute(
                    """WITH sty AS (
                           SELECT p.sku, COALESCE(p.color_print,'') AS color
                           FROM all_products_clean p
                           WHERE p.style_name = %s
                             AND p.active IS TRUE AND p.price::float > 0
                       ),
                       inv AS (
                           SELECT i.sku, SUM(COALESCE(i.available,0))::int AS soh
                           FROM all_inventory i
                           WHERE i.sku IN (SELECT sku FROM sty)
                           GROUP BY i.sku
                       )
                       SELECT sty.color,
                              MIN(sty.sku) AS rep_sku,
                              SUM(COALESCE(inv.soh,0))::int AS soh
                       FROM sty
                       LEFT JOIN inv ON inv.sku = sty.sku
                       GROUP BY sty.color
                       ORDER BY (sty.color = %s) DESC,
                                SUM(COALESCE(inv.soh,0)) DESC
                       LIMIT 8""",
                    (style, color),
                )
                cw_rows = cur.fetchall()

        # One row per size label; duplicate-SKU twins keep the stocked one.
        by_size = {}
        for v in variants:
            best = by_size.get(v["size"])
            if best is None or v["soh"] > best["soh"]:
                by_size[v["size"]] = v
        size_rows = sorted(by_size.values(), key=lambda v: _size_sort_key(v["size"]))

        prices = [v["price"] for v in variants if v["price"] > 0]
        price = _modal_price(prices) if prices else 0.0

        from urllib.parse import quote
        seen, images = set(), []
        for r in img_rows:
            base = (r["image_url"] or "").split("?")[0]
            if not base or base in seen:
                continue
            seen.add(base)
            images.append(r["image_url"])
            if len(images) >= 8:
                break
        if not images:
            images = ["/api/community/product-image/" + quote(sku, safe="")]

        # Colour selector entries — only when the style genuinely has more
        # than one colourway. Raw colour keys can carry sheet noise
        # ("FUSCHIA / FU12 / M"); display labels are tidied to the first
        # " / " segment, falling back to the raw key when tidying collides
        # (two distinct raw colours must never share one label).
        colorways = []
        if len(cw_rows) > 1:
            def _tidy(c):
                c = (c or "").strip()
                return (c.split(" / ")[0].strip() or c) if c else "Original"
            label_counts = {}
            for r in cw_rows:
                t = _tidy(r["color"])
                label_counts[t] = label_counts.get(t, 0) + 1
            for r in cw_rows:
                t = _tidy(r["color"])
                colorways.append({
                    "color": r["color"],
                    "label": (r["color"] or "Original") if label_counts[t] > 1 else t,
                    "sku": r["rep_sku"],
                    "in_stock": int(r["soh"] or 0) > 0,
                    "image": "/api/community/product-image/"
                             + quote(str(r["rep_sku"]), safe=""),
                })

        resp = {
            "sku": sku,
            "name": style,
            "style_number": head.get("style_number"),
            "brand": head["brand"],
            "color": color,
            "category": head["category"],
            "subcategory": head["subcategory"],
            "collection": head["collection"],
            "season": head["season"],
            "price": price,
            "currency": "KES",
            "images": images,
            # Availability only — exact counts must never reach the public
            # payload ("Only N left" is banned shop-wide, incl. the API).
            "sizes": [{"size": v["size"] or "One Size", "sku": v["sku"],
                       "in_stock": int(v["soh"]) > 0,
                       "low": 0 < int(v["soh"]) <= 5} for v in size_rows],
            "in_stock": any(int(v["soh"]) > 0 for v in size_rows),
            "colorways": colorways,
            "fabric": {k: head[k] for k in
                       ("fiber_content", "fabric_structure", "gsm")
                       if head.get(k)},
        }
        _cache_put(_pdp_cache, sku, resp)

        # Lazy restock check: if any sizes are back in stock, fire pending
        # alerts off-thread so this never blocks the PDP response.
        if resp["in_stock"]:
            in_stock_map = {
                s["sku"]: (s["size"] or "One Size")
                for s in resp["sizes"] if s["in_stock"]
            }
            if in_stock_map:
                threading.Thread(
                    target=_fire_restock_alerts,
                    args=(style, color, in_stock_map),
                    daemon=True,
                    name="restock-alert",
                ).start()

        return _stamp_pdp_badge(resp)

    # ------------------------------------------------------------------ #
    # Restock alerts                                                       #
    # ------------------------------------------------------------------ #

    @app.get("/api/community/restock-alert")
    def community_restock_alert_get(request: Request, sku: str = ""):
        """Return which sizes this member already has pending restock alerts
        for on the same style+colour as the given sku.  Requires auth."""
        _ensure_tables()
        sku = (sku or "").strip()[:80]
        if not sku:
            raise HTTPException(status_code=400, detail="sku required")
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute(
                    """SELECT style_name, COALESCE(color_print,'') AS color
                         FROM all_products_clean
                        WHERE sku = %s AND style_name IS NOT NULL LIMIT 1""",
                    (sku,))
                head = cur.fetchone()
                if not head:
                    return {"skus": [], "sizes": []}
                cur.execute(
                    """SELECT a.sku, a.size
                         FROM community_restock_alerts a
                        WHERE a.member_id = %s
                          AND a.style_name = %s AND a.color = %s
                          AND a.notified_at IS NULL""",
                    (m["id"], head["style_name"], head["color"]))
                rows = [dict(r) for r in cur.fetchall()]
        return {
            "skus": [r["sku"] for r in rows],
            "sizes": [r["size"] for r in rows],
        }

    @app.post("/api/community/restock-alert")
    def community_restock_alert_post(request: Request,
                                     payload: dict = Body(default={})):
        """Register a restock alert for a specific size-variant SKU.
        Idempotent — ON CONFLICT (member_id, sku) DO NOTHING."""
        _ensure_tables()
        _throttle(request, "ntfy", [("ip", 30, 60), ("global", 2000, 60)])
        size_sku = str(payload.get("size_sku") or "").strip()[:80]
        if not size_sku:
            raise HTTPException(status_code=400, detail="size_sku required")
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute(
                    """SELECT style_name, COALESCE(color_print,'') AS color,
                              COALESCE(NULLIF(TRIM(size),''),'') AS size
                         FROM all_products_clean
                        WHERE sku = %s AND style_name IS NOT NULL LIMIT 1""",
                    (size_sku,))
                info = cur.fetchone()
                if not info:
                    raise HTTPException(status_code=404, detail="Product not found")
                # Confirm the SKU is actually out of stock before storing
                # (no point alerting for something already available).
                cur.execute(
                    """SELECT COALESCE(SUM(COALESCE(available,0)),0)::int AS soh
                         FROM all_inventory WHERE sku = %s""",
                    (size_sku,))
                soh_row = cur.fetchone()
                if soh_row and int(soh_row["soh"] or 0) > 0:
                    raise HTTPException(
                        status_code=409,
                        detail="This size is already in stock — add it to your bag!")
                cur.execute(
                    """INSERT INTO community_restock_alerts
                               (member_id, sku, style_name, color, size)
                           VALUES (%s, %s, %s, %s, %s)
                           ON CONFLICT (member_id, sku) DO NOTHING""",
                    (m["id"], size_sku, info["style_name"],
                     info["color"], info["size"]))
            conn.commit()
        return {"ok": True, "sku": size_sku, "size": info["size"]}

    @app.delete("/api/community/restock-alert")
    def community_restock_alert_delete(request: Request,
                                       payload: dict = Body(default={})):
        """Cancel a pending restock alert for a size-variant SKU."""
        _ensure_tables()
        size_sku = str(payload.get("size_sku") or "").strip()[:80]
        if not size_sku:
            raise HTTPException(status_code=400, detail="size_sku required")
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute(
                    """DELETE FROM community_restock_alerts
                        WHERE member_id = %s AND sku = %s
                          AND notified_at IS NULL""",
                    (m["id"], size_sku))
                gone = cur.rowcount
            conn.commit()
        if not gone:
            raise HTTPException(status_code=404, detail="No active alert for this size")
        return {"ok": True}

    @app.get("/api/community/rewards/tank")
    def community_rewards_tank(request: Request):
        """The personalised-tank reward: live colourways + size run for the
        Chela rib tank (same active/price/stock rules as the PDP; inventory
        pre-aggregated per SKU in its own CTE), plus monogram styles and
        pickup stores. Public and member-agnostic — affordability comes from
        /me; enforcement happens on redeem."""
        from urllib.parse import quote
        _ensure_tables()
        _throttle(request, "tank", [("ip", 60, 60)])
        now = time.time()
        if _tank_cache and now - _tank_cache["t"] < _TANK_TTL:
            return _tank_cache["v"]
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """WITH inv AS (
                           SELECT sku, SUM(COALESCE(available,0))::int AS soh
                           FROM all_inventory
                           GROUP BY sku
                       )
                       SELECT p.sku, COALESCE(p.color_print,'') AS colour,
                              COALESCE(NULLIF(TRIM(p.size),''),'') AS size,
                              COALESCE(MAX(inv.soh),0)::int AS soh
                       FROM all_products_clean p
                       LEFT JOIN inv ON inv.sku = p.sku
                       WHERE p.style_name = %s AND p.active IS TRUE
                         AND p.price::float > 0
                       GROUP BY p.sku, p.color_print, p.size""",
                    (EMB_TANK_STYLE,),
                )
                rows = cur.fetchall()
        by_colour = {}
        for r in rows:
            by_colour.setdefault(r["colour"], []).append(r)
        colourways = []
        for colour, vs in by_colour.items():
            # One row per size label; duplicate-SKU twins keep the stocked one.
            by_size = {}
            for v in vs:
                b = by_size.get(v["size"])
                if b is None or v["soh"] > b["soh"]:
                    by_size[v["size"]] = v
            sizes = sorted(by_size.values(), key=lambda v: _size_sort_key(v["size"]))
            stocked = [s for s in sizes if s["soh"] > 0]
            if len(stocked) < EMB_TANK_MIN_SIZES:
                continue   # colourways down to scraps make a sad reward rail
            rep = stocked[0]["sku"]
            colourways.append({
                "colour": colour,
                "rep_sku": rep,
                "image": "/api/community/product-image/" + quote(rep, safe=""),
                "sizes": [{"sku": s["sku"], "size": s["size"], "in_stock": s["soh"] > 0}
                          for s in sizes],
                "stocked_sizes": len(stocked),
            })
        colourways.sort(key=lambda c: (-c["stocked_sizes"], c["colour"]))
        payload = {
            "reward": {
                "key": "emb_tank",
                "title": "Personalised Embroidered Tank",
                "points": EMB_TANK_POINTS,
                "style_name": EMB_TANK_STYLE,
            },
            "colourways": colourways,
            "monogram_styles": EMB_TANK_MONOGRAM_STYLES,
            "pickup_stores": EMB_TANK_PICKUP_STORES,
        }
        _tank_cache.update({"t": now, "v": payload})
        return payload

    @app.post("/api/community/rewards/tank/redeem")
    def community_tank_redeem(request: Request, payload: dict = Body(...)):
        """Redeem the personalised tank. Validates the size SKU against live
        stock, the embroidery (upload or monogram) and the collection choice,
        then commits the points by inserting the redemption under the
        member's row lock (spendable = lifetime − non-cancelled redemptions,
        so concurrent redeems can't double-spend)."""
        _ensure_tables()
        _throttle(request, "redeem", [("ip", 10, 3600), ("global", 200, 3600)])
        sku = (payload.get("sku") or "").strip()[:80]
        emb = _parse_embroidery(payload.get("embroidery"))
        coll = payload.get("collection") or {}
        method = (coll.get("method") or "").strip()
        store = (coll.get("store") or "").strip()
        if method == "pickup":
            if store not in EMB_TANK_PICKUP_STORES:
                raise HTTPException(status_code=400, detail="Pick one of the Vivo stores for collection")
        elif method == "delivery":
            store = ""
        else:
            raise HTTPException(status_code=400, detail="Choose pick-up or delivery")
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute(
                    """WITH inv AS (
                           SELECT SUM(COALESCE(available,0))::int AS soh
                           FROM all_inventory WHERE sku = %s
                       )
                       SELECT p.sku, COALESCE(NULLIF(TRIM(p.size),''),'') AS size,
                              COALESCE(p.color_print,'') AS colour,
                              COALESCE((SELECT soh FROM inv), 0) AS soh
                       FROM all_products_clean p
                       WHERE p.sku = %s AND p.style_name = %s
                         AND p.active IS TRUE AND p.price::float > 0
                       LIMIT 1""",
                    (sku, sku, EMB_TANK_STYLE),
                )
                v = cur.fetchone()
                if not v:
                    raise HTTPException(status_code=400, detail="Pick a size first")
                if int(v["soh"]) <= 0:
                    raise HTTPException(status_code=409, detail="That size just sold out — pick another")
                # Points check under the member row lock so parallel redeems
                # serialize; all redemption inserts happen inside this lock.
                cur.execute("SELECT id FROM community_members WHERE id = %s FOR UPDATE", (m["id"],))
                spend = 0.0
                if m.get("customer_id"):
                    cur.execute(
                        """SELECT COALESCE(total_spend_kes,0)::float AS s
                           FROM all_customers
                           WHERE customer_id = %s AND store_id = %s LIMIT 1""",
                        (m["customer_id"], m.get("customer_store_id")),
                    )
                    row = cur.fetchone()
                    spend = float(row["s"]) if row else 0.0
                lifetime = _lifetime_points(cur, m)  # same helper as /me — bonus points must count toward redemption affordability
                cur.execute(
                    """SELECT COALESCE(SUM(points_cost), 0) AS spent
                       FROM community_redemptions
                       WHERE member_id = %s AND status <> 'cancelled'""",
                    (m["id"],),
                )
                spent = int(cur.fetchone()["spent"])
                short = EMB_TANK_POINTS - (lifetime - spent)
                if short > 0:
                    raise HTTPException(
                        status_code=400,
                        detail=f"You need {short:,} more points for this one",
                    )
                cur.execute(
                    """INSERT INTO community_redemptions
                           (member_id, reward_key, points_cost, sku, size, colour,
                            embroidery_type, design_image, design_mime,
                            monogram_text, monogram_style,
                            collection_method, pickup_store)
                       VALUES (%s,'emb_tank',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                       RETURNING id""",
                    (m["id"], EMB_TANK_POINTS, v["sku"], v["size"], v["colour"],
                     emb["embroidery_type"], emb["design_image"], emb["design_mime"],
                     emb["monogram_text"], emb["monogram_style"], method, store or None),
                )
                rid = cur.fetchone()["id"]
                # Optional per-item marketing consent for an uploaded design
                # (only meaningful when artwork was actually uploaded).
                if emb.get("design_image") is not None and isinstance(payload.get("marketing_ok"), bool):
                    _set_content_consent(cur, m["id"], "design", rid, bool(payload.get("marketing_ok")))
            conn.commit()
        _me_cache.pop(m["id"], None)
        return {
            "id": rid,
            "status": "in_review",
            "points_cost": EMB_TANK_POINTS,
            "message": "We'll review your design and get stitching — we'll let you know when your tank is ready.",
        }

    @app.get("/api/community/rewards/redemptions")
    def community_my_redemptions(request: Request):
        """The member's own redemptions, newest first — status card fuel.
        Design bytes never ride along; the thumbnail endpoint serves them."""
        _ensure_tables()
        _throttle(request, "rdm", [("ip", 60, 60)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute(
                    """SELECT id, reward_key, points_cost, sku, size, colour,
                              embroidery_type, monogram_text, monogram_style,
                              (design_image IS NOT NULL) AS has_design,
                              collection_method, pickup_store,
                              status, status_note, created_at::date AS created
                       FROM community_redemptions
                       WHERE member_id = %s
                       ORDER BY created_at DESC
                       LIMIT 20""",
                    (m["id"],),
                )
                rows = [dict(r) for r in cur.fetchall()]
        for r in rows:
            r["created"] = str(r["created"])
        return {"redemptions": rows}

    @app.get("/api/community/rewards/redemptions/{rid}/design")
    def community_redemption_design(request: Request, rid: int):
        """The member's own uploaded design (image bytes). Owner-gated —
        designs are personal content, unlike catalogue product photos."""
        _ensure_tables()
        _throttle(request, "rdmimg", [("ip", 120, 60)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute(
                    """SELECT design_image, design_mime FROM community_redemptions
                       WHERE id = %s AND member_id = %s""",
                    (rid, m["id"]),
                )
                row = cur.fetchone()
        if not row or row["design_image"] is None:
            raise HTTPException(status_code=404, detail="Not found")
        return Response(
            content=bytes(row["design_image"]),
            media_type=row["design_mime"] or "image/png",
            headers={"Cache-Control": "private, max-age=300"},
        )

    @app.put("/api/community/rewards/redemptions/{rid}/design")
    def community_redemption_update_design(request: Request, rid: int, payload: dict = Body(...)):
        """Swap the embroidery on a pending tank — the non-punitive loop: a
        design we can't stitch goes back to the member with a note, they
        adjust it here and it re-enters review. Points stay committed."""
        _ensure_tables()
        _throttle(request, "rdmupd", [("ip", 20, 3600)])
        emb = _parse_embroidery(payload.get("embroidery"))
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute(
                    """UPDATE community_redemptions
                       SET embroidery_type = %s, design_image = %s, design_mime = %s,
                           monogram_text = %s, monogram_style = %s,
                           status = 'in_review', status_note = NULL, updated_at = now()
                       WHERE id = %s AND member_id = %s
                         AND status IN ('in_review','needs_changes')
                       RETURNING id""",
                    (emb["embroidery_type"], emb["design_image"], emb["design_mime"],
                     emb["monogram_text"], emb["monogram_style"], rid, m["id"]),
                )
                ok = cur.fetchone()
                if not ok:
                    raise HTTPException(
                        status_code=409,
                        detail="This one's already with the stitching team — message us if something needs changing",
                    )
                # New artwork is new content: any marketing consent given for
                # the previous design must not carry over — she can re-grant
                # it from Profile → My data.
                _withdraw_content_consent(cur, m["id"], "design", rid)
            conn.commit()
        return {
            "ok": True,
            "status": "in_review",
            "message": "We'll review your design and get stitching — we'll let you know when your tank is ready.",
        }

    @app.get("/api/community/product-image/{sku:path}")
    def community_product_image(request: Request, sku: str):
        """Public product photo (JPEG bytes) for the customer app. Resolves
        the exact SKU first, then any style+colour sibling (all sizes share
        photos). Product photos are non-sensitive; endpoint is public.
        LRU-cached (positive AND negative results) so random-SKU probing
        can't turn into a per-request DB hit."""
        sku = (sku or "").strip()[:80]
        if not sku:
            raise HTTPException(status_code=404, detail="Not found")
        _throttle(request, "img", [("ip", 400, 60)])

        def _serve(data):
            if data is None:
                raise HTTPException(status_code=404, detail="Not found")
            return Response(
                content=data,
                media_type="image/jpeg",
                headers={"Cache-Control": "public, max-age=86400"},
            )

        with _IMG_LOCK:
            hit = _IMG_CACHE.get(sku)
            if hit and time.time() - hit[0] < _IMG_TTL:
                _IMG_CACHE.move_to_end(sku)
                cached_data = hit[1]
                hit_valid = True
            else:
                _IMG_CACHE.pop(sku, None)
                hit_valid = False
        if hit_valid:
            return _serve(cached_data)

        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """SELECT i.image_512 FROM product_image_map m
                       JOIN product_images i ON i.tmpl_id = m.tmpl_id
                       WHERE m.sku = %s AND COALESCE(i.image_512,'') <> ''
                       LIMIT 1""",
                    (sku,),
                )
                row = cur.fetchone()
                if not row:
                    cur.execute(
                        """SELECT i.image_512
                           FROM all_products_clean me
                           JOIN all_products_clean sib
                             ON sib.style_name = me.style_name
                            AND COALESCE(sib.color_print,'') = COALESCE(me.color_print,'')
                           JOIN product_image_map m ON m.sku = sib.sku
                           JOIN product_images i ON i.tmpl_id = m.tmpl_id
                           WHERE me.sku = %s AND COALESCE(i.image_512,'') <> ''
                           LIMIT 1""",
                        (sku,),
                    )
                    row = cur.fetchone()
        data = None
        if row:
            try:
                data = base64.b64decode(row["image_512"])
            except Exception:
                data = None
        if data is None or len(data) <= _IMG_MAX_BYTES:
            with _IMG_LOCK:
                _IMG_CACHE[sku] = (time.time(), data)
                _IMG_CACHE.move_to_end(sku)
                while len(_IMG_CACHE) > _IMG_CAP:
                    _IMG_CACHE.popitem(last=False)
        return _serve(data)

    # ---------- events ----------

    @app.get("/api/community/events")
    def community_events_list(request: Request):
        """Upcoming member events, soonest first. Metadata is public; when a
        valid member token is presented each event also carries my_rsvp and
        gate-unlock state. Spot counts are public by product decision (Aug
        2026 feedback — cards read "18 of 30 spots taken"): `taken` folds the
        demo-layer seed_taken baseline into live confirmed RSVPs. my_rsvp is
        null | {status:'confirmed'} | {status:'waitlisted', position:N}
        where position is the member's 1-based place in the queue."""
        _ensure_tables()
        _throttle(request, "events", [("ip", 60, 60), ("global", 1200, 60)])
        now = datetime.now(timezone.utc)
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                member = None
                sess = _session_for(cur, _bearer(request), purpose="member")
                if sess and sess["member_id"]:
                    cur.execute("SELECT * FROM community_members WHERE id = %s",
                                (sess["member_id"],))
                    member = cur.fetchone()
                cur.execute(
                    """SELECT event_id, COUNT(*) AS n FROM community_event_rsvps
                       WHERE status = 'confirmed' GROUP BY event_id"""
                )
                counts = {r["event_id"]: int(r["n"]) for r in cur.fetchall()}
                mine = {}
                if member:
                    # Waitlist position = 1-based rank by (waitlisted_at, id)
                    # among rows still waitlisted on the same event.
                    cur.execute(
                        """SELECT r.event_id, r.status,
                                  CASE WHEN r.status = 'waitlisted' THEN
                                    (SELECT COUNT(*) FROM community_event_rsvps w
                                      WHERE w.event_id = r.event_id
                                        AND w.status = 'waitlisted'
                                        AND (w.waitlisted_at, w.id)
                                            <= (r.waitlisted_at, r.id))
                                  END AS wl_pos
                             FROM community_event_rsvps r
                            WHERE r.member_id = %s""",
                        (member["id"],),
                    )
                    mine = {r["event_id"]: r for r in cur.fetchall()}
                items = []
                for ev in COMMUNITY_EVENTS:
                    if _event_dt(ev["ends_at"]) < now:
                        continue         # past events drop off the list
                    cap = int(ev["capacity"])
                    taken = min(cap, int(ev.get("seed_taken", 0)) + counts.get(ev["id"], 0))
                    my = mine.get(ev["id"])
                    my_rsvp = None
                    if my and my["status"] == "confirmed":
                        my_rsvp = {"status": "confirmed"}
                    elif my and my["status"] == "waitlisted":
                        my_rsvp = {"status": "waitlisted",
                                   "position": int(my["wl_pos"] or 1)}
                    item = {
                        "id": ev["id"],
                        "kicker": ev["kicker"],
                        "title": ev["title"],
                        "starts_at": ev["starts_at"],
                        "ends_at": ev["ends_at"],
                        "venue": ev["venue"],
                        "area": ev["area"],
                        "blurb": ev["blurb"],
                        "about": ev.get("about") or [],
                        "expect": ev.get("expect") or [],
                        "host": ev.get("host"),
                        "image": ev.get("image"),
                        "cover": ev["cover"],
                        "news_id": ev.get("news_id"),
                        "capacity": cap,
                        "taken": taken,
                        "spots_left": cap - taken,
                        "full": taken >= cap,
                        "my_rsvp": my_rsvp,
                        "gate": None,
                    }
                    item.update(_event_labels(ev))
                    gate = ev.get("gate")
                    if gate:
                        item["gate"] = {
                            "label": gate["label"],
                            "copy": gate["copy"],
                            "unlocked": bool(member and _event_unlocked(cur, member, gate)),
                        }
                    items.append(item)
                items.sort(key=lambda x: x["starts_at"])
                return {"items": items}

    @app.post("/api/community/events/{event_id}/rsvp")
    def community_event_rsvp(event_id: str, request: Request):
        _ensure_tables()
        _throttle(request, "rsvp", [("ip", 20, 3600), ("global", 400, 3600)])
        ev = next((e for e in COMMUNITY_EVENTS if e["id"] == event_id), None)
        if not ev:
            raise HTTPException(status_code=404, detail="That event isn't available")
        if _event_dt(ev["ends_at"]) < datetime.now(timezone.utc):
            raise HTTPException(status_code=409, detail="This event has already happened")
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                gate = ev.get("gate")
                if gate and not _event_unlocked(cur, m, gate):
                    raise HTTPException(status_code=403, detail=gate["copy"])
                # Serialize confirms per event with a row lock. _db() conns are
                # autocommit=False, so everything below runs in one transaction
                # pinned to one backend — the row lock holds even through the
                # txn-mode pooler (where advisory locks silently no-op). The
                # lock-row INSERT is rolled back on early-return paths, which
                # is fine: ON CONFLICT keeps it idempotent.
                cur.execute(
                    """INSERT INTO community_event_locks (event_id) VALUES (%s)
                       ON CONFLICT (event_id) DO NOTHING""", (event_id,))
                cur.execute(
                    """SELECT event_id FROM community_event_locks
                       WHERE event_id = %s FOR UPDATE""", (event_id,))
                cur.execute(
                    """SELECT id, status FROM community_event_rsvps
                       WHERE event_id = %s AND member_id = %s""",
                    (event_id, m["id"]),
                )
                row = cur.fetchone()
                if row and row["status"] == "confirmed":
                    return {"ok": True, "status": "confirmed", "already": True}
                cap = int(ev["capacity"])
                # The DB may hold at most capacity − seed_taken confirmed
                # rows (seed_taken = demo-layer baseline signups).
                db_cap = cap - int(ev.get("seed_taken", 0))
                # Under the event row lock the count below is authoritative;
                # the count<db_cap guards inside the writes are belt-and-braces.
                got = None
                if db_cap > 0:
                    if row:
                        cur.execute(
                            """UPDATE community_event_rsvps
                                  SET status = 'confirmed', updated_at = now()
                                WHERE id = %s
                                  AND (SELECT COUNT(*) FROM community_event_rsvps
                                       WHERE event_id = %s AND status = 'confirmed') < %s
                                RETURNING id""",
                            (row["id"], event_id, db_cap),
                        )
                    else:
                        cur.execute(
                            """INSERT INTO community_event_rsvps (event_id, member_id, status)
                               SELECT %s, %s, 'confirmed'
                                WHERE (SELECT COUNT(*) FROM community_event_rsvps
                                       WHERE event_id = %s AND status = 'confirmed') < %s
                               ON CONFLICT (event_id, member_id) DO NOTHING
                               RETURNING id""",
                            (event_id, m["id"], event_id, db_cap),
                        )
                    got = cur.fetchone()
                if got:
                    conn.commit()
                    return {"ok": True, "status": "confirmed",
                            "message": "You're in — see you there."}
                # Fully booked → the waitlist. A member already on it keeps
                # their original join time (re-taps never lose queue position).
                if row and row["status"] == "waitlisted":
                    cur.execute(_WL_POS_SQL, (row["id"],))
                    pos = int(cur.fetchone()["p"] or 1)
                    conn.commit()
                    return {"ok": True, "status": "waitlisted", "position": pos,
                            "already": True,
                            "message": f"You're already on the list — #{pos} in the queue."}
                if row:
                    cur.execute(
                        """UPDATE community_event_rsvps
                              SET status = 'waitlisted', waitlisted_at = now(),
                                  updated_at = now()
                            WHERE id = %s RETURNING id""",
                        (row["id"],),
                    )
                else:
                    # Safe plain INSERT: we hold this event's lock row, and
                    # the UNIQUE key is (event_id, member_id).
                    cur.execute(
                        """INSERT INTO community_event_rsvps
                               (event_id, member_id, status, waitlisted_at)
                           VALUES (%s, %s, 'waitlisted', now())
                           RETURNING id""",
                        (event_id, m["id"]),
                    )
                rid = cur.fetchone()["id"]
                cur.execute(_WL_POS_SQL, (rid,))
                pos = int(cur.fetchone()["p"] or 1)
                conn.commit()
                return {"ok": True, "status": "waitlisted", "position": pos,
                        "message": (f"Fully booked — you're #{pos} on the waitlist. "
                                    "We'll email you the moment a spot opens.")}

    @app.delete("/api/community/events/{event_id}/rsvp")
    def community_event_rsvp_cancel(event_id: str, request: Request):
        """Cancel a confirmed RSVP or leave the waitlist. Freeing a confirmed
        seat promotes the earliest-waitlisted member inside the same
        event-locked transaction (two concurrent cancels must not promote the
        same member twice); the promotion email goes out after commit."""
        _ensure_tables()
        _throttle(request, "rsvp", [("ip", 20, 3600)])
        ev = next((e for e in COMMUNITY_EVENTS if e["id"] == event_id), None)
        if not ev:
            raise HTTPException(status_code=404, detail="That event isn't available")
        promoted = []
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                # Same per-event serialization as the RSVP path.
                cur.execute(
                    """INSERT INTO community_event_locks (event_id) VALUES (%s)
                       ON CONFLICT (event_id) DO NOTHING""", (event_id,))
                cur.execute(
                    """SELECT event_id FROM community_event_locks
                       WHERE event_id = %s FOR UPDATE""", (event_id,))
                cur.execute(
                    """SELECT id, status FROM community_event_rsvps
                       WHERE event_id = %s AND member_id = %s""",
                    (event_id, m["id"]),
                )
                row = cur.fetchone()
                if not row or row["status"] == "cancelled":
                    conn.rollback()
                    raise HTTPException(status_code=404, detail="No RSVP to cancel")
                was = row["status"]
                cur.execute(
                    """UPDATE community_event_rsvps
                          SET status = 'cancelled', updated_at = now()
                        WHERE id = %s""",
                    (row["id"],),
                )
                if was == "confirmed":
                    # Seat freed — promote from the head of the queue while
                    # capacity allows (normally exactly one member).
                    db_cap = int(ev["capacity"]) - int(ev.get("seed_taken", 0))
                    while True:
                        cur.execute(
                            """SELECT COUNT(*) AS n FROM community_event_rsvps
                               WHERE event_id = %s AND status = 'confirmed'""",
                            (event_id,),
                        )
                        if int(cur.fetchone()["n"]) >= db_cap:
                            break
                        cur.execute(
                            """UPDATE community_event_rsvps
                                  SET status = 'confirmed', updated_at = now()
                                WHERE id = (SELECT id FROM community_event_rsvps
                                             WHERE event_id = %s AND status = 'waitlisted'
                                             ORDER BY waitlisted_at, id LIMIT 1)
                                RETURNING member_id""",
                            (event_id,),
                        )
                        p = cur.fetchone()
                        if not p:
                            break
                        cur.execute(
                            """SELECT id, full_name, email FROM community_members
                               WHERE id = %s""", (p["member_id"],))
                        pm = cur.fetchone()
                        if pm:
                            promoted.append(dict(pm))
                conn.commit()
        for pm in promoted:
            # Promotion is already committed; the email is a courtesy. Nothing
            # on this path (thread construction included) may fail the request.
            try:
                _notify_promoted(pm, ev)
            except Exception:
                log.exception("promotion email dispatch failed for member %s",
                              pm.get("id"))
        return {"ok": True, "status": "cancelled", "was": was,
                "promoted": len(promoted)}

    # ---------------- Contact Us ----------------

    # ---- Customer survey ("Help us dress you better") ----------------------
    # Responses are linked to the member for segmentation (tier at completion,
    # join date) but staff reporting is aggregate-only — the CRM summary never
    # exposes who said what. One completion per wave per member; the +30 rides
    # community_points_events UNIQUE(member_id, kind) with a per-wave kind, so
    # a re-post can never double-award.

    def _survey_active_wave(cur):
        cur.execute("""SELECT id, wave_key, title, status, questions
                         FROM community_survey_waves
                        WHERE status = 'active'
                     ORDER BY id DESC LIMIT 1""")
        return cur.fetchone()

    def _survey_validate(questions, raw):
        """Whitelist answers against the wave's question schema. Unknown keys
        drop; multi picks are de-duped and trimmed to their cap; warm 400s."""
        out, nps_val = {}, None
        for q in questions:
            qid, kind = q.get("id"), q.get("kind")
            v = raw.get(qid)
            if kind == "single":
                if not isinstance(v, str) or v not in (q.get("options") or []):
                    raise HTTPException(status_code=400,
                                        detail="Please answer every question — each one really helps")
                out[qid] = v
                f = q.get("followup") or {}
                if f and v in (f.get("when") or []):
                    fv = raw.get(f.get("id"))
                    if not isinstance(fv, str) or fv not in (f.get("options") or []):
                        raise HTTPException(status_code=400,
                                            detail="Please pick the store you visit most")
                    out[f["id"]] = fv
            elif kind == "multi":
                opts = q.get("options") or []
                picks = [x for x in (v if isinstance(v, list) else []) if isinstance(x, str) and x in opts]
                seen = set()
                picks = [x for x in picks if not (x in seen or seen.add(x))]
                cap = q.get("max")
                if cap:
                    picks = picks[:int(cap)]
                if not picks:
                    raise HTTPException(status_code=400,
                                        detail="Please answer every question — each one really helps")
                out[qid] = picks
            elif kind == "nps":
                try:
                    nv = int(v)
                except (TypeError, ValueError):
                    raise HTTPException(status_code=400, detail="Tap a number from 0 to 10")
                if nv < 0 or nv > 10:
                    raise HTTPException(status_code=400, detail="Tap a number from 0 to 10")
                out[qid] = nv
                nps_val = nv
            elif kind == "text":
                s = str(v or "").strip()[:2000]
                if s:
                    out[qid] = s
                elif not q.get("optional"):
                    raise HTTPException(status_code=400, detail="A few words would really help")
        return out, nps_val

    @app.get("/api/community/survey/state")
    def community_survey_state(request: Request):
        """Everything the app needs to render survey entry points: the active
        wave (with questions), whether this member completed it, and whether
        the Home card should show (dismiss/re-surface logic lives here)."""
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                _throttle(request, "svs", [("ip", 120, 60)])
                w = _survey_active_wave(cur)
                if not w:
                    return {"wave": None, "completed": False,
                            "points": SURVEY_BONUS_PTS, "show_home_card": False}
                cur.execute("""SELECT 1 FROM community_survey_responses
                                WHERE wave_id = %s AND member_id = %s""",
                            (w["id"], m["id"]))
                completed = cur.fetchone() is not None
                show_home = not completed
                if show_home:
                    cur.execute(
                        """SELECT count,
                                  (last_at <= now() - make_interval(days => %s)) AS quiet
                             FROM community_survey_dismissals
                            WHERE wave_id = %s AND member_id = %s""",
                        (SURVEY_RESURFACE_DAYS, w["id"], m["id"]))
                    d = cur.fetchone()
                    if d:
                        show_home = bool(d["quiet"]) if d["count"] < 2 else False
        return {"wave": {"id": w["id"], "wave_key": w["wave_key"],
                         "title": w["title"], "questions": w["questions"]},
                "completed": completed,
                "points": SURVEY_BONUS_PTS,
                "show_home_card": show_home}

    @app.post("/api/community/survey/complete")
    def community_survey_complete(request: Request, payload: dict = Body(...)):
        """Store the wave response and award the bonus exactly once."""
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                _throttle(request, "svc",
                          [("ip", 20, 3600), ("phone", 8, 3600)],
                          phone=m.get("phone"))
                w = _survey_active_wave(cur)
                if not w:
                    raise HTTPException(status_code=409,
                                        detail="This survey has closed — asante for wanting to help!")
                if int(payload.get("wave_id") or 0) != int(w["id"]):
                    raise HTTPException(status_code=409,
                                        detail="This survey round has moved on — please reopen it and try again")
                raw = payload.get("answers")
                if not isinstance(raw, dict):
                    raise HTTPException(status_code=400, detail="answers must be an object")
                answers, nps_val = _survey_validate(w["questions"] or [], raw)
                duration = payload.get("duration_secs")
                try:
                    duration = max(0, min(int(duration), 3600)) if duration is not None else None
                except (TypeError, ValueError):
                    duration = None
                tier = _tier_for(_lifetime_points(cur, m))[0]
                cur.execute(
                    """INSERT INTO community_survey_responses
                           (wave_id, member_id, answers, nps, tier_at, member_since, duration_secs)
                       VALUES (%s, %s, %s::jsonb, %s, %s,
                               (SELECT created_at FROM community_members WHERE id = %s), %s)
                       ON CONFLICT (wave_id, member_id) DO NOTHING
                       RETURNING id""",
                    (w["id"], m["id"], json.dumps(answers), nps_val, tier,
                     m["id"], duration))
                stored = cur.fetchone() is not None
                awarded = False
                if stored:
                    cur.execute(
                        """INSERT INTO community_points_events (member_id, kind, points)
                           VALUES (%s, %s, %s)
                           ON CONFLICT (member_id, kind) DO NOTHING
                           RETURNING id""",
                        (m["id"], "survey_" + str(w["wave_key"]), SURVEY_BONUS_PTS))
                    awarded = cur.fetchone() is not None
                conn.commit()
                _me_cache.pop(m["id"], None)
                member = _member_payload(cur, m)
        return {"ok": True, "already": not stored, "awarded": awarded,
                "points": SURVEY_BONUS_PTS if awarded else 0, "member": member}

    @app.post("/api/community/survey/dismiss")
    def community_survey_dismiss(request: Request, payload: dict = Body(default={})):
        """The Home card's "Maybe later". First dismiss hides the card; it
        re-surfaces once after the quiet window; a second dismiss retires it
        for this wave. Rewards and Profile entry points are unaffected."""
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                _throttle(request, "svd", [("ip", 60, 3600)])
                w = _survey_active_wave(cur)
                if w and int(payload.get("wave_id") or 0) != int(w["id"]):
                    # A stale client (older wave still on screen) must not
                    # burn a dismissal of a wave it has never shown.
                    raise HTTPException(status_code=409,
                                        detail="This survey round has moved on — please refresh")
                if w:
                    cur.execute(
                        """INSERT INTO community_survey_dismissals (wave_id, member_id)
                           VALUES (%s, %s)
                           ON CONFLICT (wave_id, member_id)
                           DO UPDATE SET count = LEAST(community_survey_dismissals.count + 1, 2),
                                         last_at = now()""",
                        (w["id"], m["id"]))
            conn.commit()
        return {"ok": True}

    @app.post("/api/community/contact")
    def community_contact_submit(request: Request, payload: dict = Body(...)):
        """The in-app "Contact Us" form. The member's account is attached
        server-side (never trusted from the client); care staff review the
        message in the CRM app's Community Inbox."""
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                _throttle(request, "ctc",
                          [("ip", 12, 3600), ("phone", 6, 3600), ("global", 500, 3600)],
                          phone=m.get("phone"))
                subject = str(payload.get("subject") or "").strip()
                if subject not in CONTACT_SUBJECTS:
                    raise HTTPException(status_code=400,
                                        detail="Pick a subject so we can route your message to the right person")
                message = str(payload.get("message") or "").strip()
                if len(message) < 5:
                    raise HTTPException(status_code=400,
                                        detail="Tell us a little more — a sentence or two helps us help you")
                if len(message) > CONTACT_MAX_CHARS:
                    raise HTTPException(status_code=400,
                                        detail="That message is a bit long — please keep it under 4,000 characters")
                photo = mime = None
                if payload.get("photo_b64"):
                    photo, mime = _decode_design(payload["photo_b64"], noun="photo")
                cur.execute(
                    """INSERT INTO community_contact_messages
                           (member_id, subject, message, photo, photo_mime)
                       VALUES (%s, %s, %s, %s, %s)
                       RETURNING id""",
                    (m["id"], subject, message, photo, mime))
                new_id = cur.fetchone()["id"]
            conn.commit()
        return {"ok": True, "id": new_id,
                "note": "Thank you — our team will get back to you within 1 working day."}

    # ---------------- Interactive community feed ----------------
    # DB-backed posts with real per-member likes and comments. Comments
    # publish immediately (posts stay curated); every comment has a Report
    # action feeding the staff queue below. Deliberately NO points for likes
    # or comments — points stay on the defined earning actions only, so
    # conversation can't be farmed.

    def _feed_member_id(cur, request):
        """Optional member id — feed reads personalise when signed in."""
        try:
            sess = _session_for(cur, _bearer(request), purpose="member")
            return int(sess["member_id"]) if sess and sess["member_id"] else None
        except HTTPException:
            return None

    _FEED_SELECT = """
        SELECT p.id, p.author_username, p.author_initials, p.author_tier,
               p.author_show_tier, p.caption, p.variant, p.visual,
               p.tagged, p.created_at, p.post_type, p.fit_note,
               p.image_url, p.media_kind,
               EXISTS (SELECT 1 FROM community_entry_photos ph
                        WHERE ph.post_id = p.id) AS has_photo,
               (p.like_seed
                + (SELECT COUNT(*) FROM community_post_likes pl
                    WHERE pl.post_id = p.id))::int AS like_count,
               (SELECT COUNT(*) FROM community_post_comments c
                 WHERE c.post_id = p.id AND c.status = 'visible')::int AS comment_count,
               EXISTS (SELECT 1 FROM community_post_likes pl2
                        WHERE pl2.post_id = p.id AND pl2.member_id = %s) AS my_liked
        FROM community_feed_posts p
        WHERE p.status = 'approved' AND p.challenge_id IS NULL"""

    def _post_row(r):
        return {
            "id": r["id"],
            "author": {"username": r["author_username"],
                       "initials": r["author_initials"],
                       "tier": r["author_tier"],
                       "show_tier": bool(r["author_show_tier"])},
            "caption": r["caption"],
            "variant": r["variant"],
            "visual": r["visual"],
            "tagged": r["tagged"] or [],
            "post_type": r.get("post_type") or "look",
            "fit_note": r.get("fit_note"),
            "image_url": r.get("image_url"),
            "media_kind": r.get("media_kind"),
            "has_photo": bool(r.get("has_photo")),
            "photo_path": (f"/entry-photo/{r['id']}"
                           if r.get("has_photo") else None),
            "like_count": int(r["like_count"] or 0),
            "comment_count": int(r["comment_count"] or 0),
            "my_liked": bool(r["my_liked"]),
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        }

    @app.get("/api/community/feed")
    def community_feed_list(request: Request, limit: int = 24,
                            offset: int = 0, type: str = ""):
        _ensure_tables()
        _throttle(request, "fee", [("ip", 120, 60), ("global", 6000, 60)])
        _edits_reconcile_feed()
        lim = max(1, min(int(limit or 24), 50))
        off = max(0, int(offset or 0))
        tf = type if type in ("look", "question", "haul") else ""
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                mid = _feed_member_id(cur, request) or -1
                q = _FEED_SELECT
                params = [mid]
                if tf:
                    q += " AND p.post_type = %s"
                    params.append(tf)
                q += """
                     ORDER BY p.created_at DESC, p.id DESC
                     LIMIT %s OFFSET %s"""
                cur.execute(q, params + [lim, off])
                rows = cur.fetchall()
                cq = """SELECT COUNT(*) AS n FROM community_feed_posts
                         WHERE status = 'approved'
                           AND challenge_id IS NULL"""
                cur.execute(cq + (" AND post_type = %s" if tf else ""),
                            ((tf,) if tf else None))
                total = int(cur.fetchone()["n"])
        return {"items": [_post_row(r) for r in rows], "total": total}

    @app.get("/api/community/posts/{pid}")
    def community_feed_post_detail(pid: int, request: Request):
        _ensure_tables()
        _throttle(request, "fee", [("ip", 120, 60), ("global", 6000, 60)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                mid = _feed_member_id(cur, request) or -1
                cur.execute(_FEED_SELECT + " AND p.id = %s", (mid, pid))
                row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Post not found")
        return _post_row(row)

    @app.get("/api/community/posts/{pid}/comments")
    def community_feed_comments(pid: int, request: Request):
        _ensure_tables()
        _throttle(request, "fee", [("ip", 120, 60), ("global", 6000, 60)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                mid = _feed_member_id(cur, request) or -1
                cur.execute("""SELECT 1 FROM community_feed_posts
                                WHERE id = %s AND status = 'approved'""", (pid,))
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Post not found")
                cur.execute("""
                    SELECT c.id, c.body, c.created_at, c.member_id,
                           m.username, m.full_name,
                           (SELECT COUNT(*) FROM community_comment_likes cl
                             WHERE cl.comment_id = c.id)::int AS like_count,
                           EXISTS (SELECT 1 FROM community_comment_likes cl2
                                    WHERE cl2.comment_id = c.id
                                      AND cl2.member_id = %s) AS my_liked
                    FROM community_post_comments c
                    JOIN community_members m ON m.id = c.member_id
                    WHERE c.post_id = %s AND c.status = 'visible'
                    ORDER BY c.created_at ASC, c.id ASC
                    LIMIT 500""", (mid, pid))
                rows = cur.fetchall()
        return {"items": [{
            "id": r["id"],
            "body": r["body"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "username": (r["username"] or "").strip() or "vivomember",
            "initials": _initials(r["full_name"] or r["username"]),
            "like_count": int(r["like_count"] or 0),
            "my_liked": bool(r["my_liked"]),
            "mine": bool(mid > 0 and r["member_id"] == mid),
        } for r in rows]}

    @app.post("/api/community/posts/{pid}/like")
    def community_feed_post_like(pid: int, request: Request):
        _ensure_tables()
        _throttle(request, "fpl", [("ip", 60, 60), ("global", 4000, 3600)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute("""SELECT like_seed FROM community_feed_posts
                                WHERE id = %s AND status = 'approved'""", (pid,))
                post = cur.fetchone()
                if not post:
                    raise HTTPException(status_code=404, detail="Post not found")
                cur.execute("""DELETE FROM community_post_likes
                                WHERE post_id = %s AND member_id = %s""",
                            (pid, m["id"]))
                liked = cur.rowcount == 0
                if liked:
                    cur.execute("""INSERT INTO community_post_likes (post_id, member_id)
                                   VALUES (%s, %s) ON CONFLICT DO NOTHING""",
                                (pid, m["id"]))
                cur.execute("""SELECT COUNT(*)::int AS n FROM community_post_likes
                                WHERE post_id = %s""", (pid,))
                n = int(post["like_seed"] or 0) + int(cur.fetchone()["n"])
            conn.commit()
        # No points event — likes never earn.
        return {"ok": True, "liked": liked, "like_count": n}

    @app.post("/api/community/posts/{pid}/comments")
    def community_feed_comment_add(pid: int, request: Request,
                                   payload: dict = Body(...)):
        _ensure_tables()
        _throttle(request, "fca", [("ip", 10, 60), ("ip", 200, 86400),
                                   ("global", 2000, 3600)])
        body = re.sub(r"\s+", " ", str((payload or {}).get("body") or "")).strip()
        if not body:
            raise HTTPException(status_code=400, detail="Say something first")
        if len(body) > 500:
            raise HTTPException(status_code=400,
                                detail="Keep it under 500 characters")
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute("""SELECT 1 FROM community_feed_posts
                                WHERE id = %s AND status = 'approved'""", (pid,))
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Post not found")
                cur.execute("""INSERT INTO community_post_comments
                                   (post_id, member_id, body)
                               VALUES (%s, %s, %s)
                               RETURNING id, created_at""", (pid, m["id"], body))
                row = cur.fetchone()
                cur.execute("""SELECT COUNT(*)::int AS n FROM community_post_comments
                                WHERE post_id = %s AND status = 'visible'""", (pid,))
                n = int(cur.fetchone()["n"])
            conn.commit()
        # Deliberately NO points event — comments never earn (anti-spam).
        return {"ok": True, "comment_count": n, "comment": {
            "id": row["id"], "body": body,
            "created_at": row["created_at"].isoformat(),
            "username": (m.get("username") or "").strip() or "you",
            "initials": _initials(m.get("full_name") or m.get("username")),
            "like_count": 0, "my_liked": False, "mine": True}}

    @app.post("/api/community/comments/{cid}/like")
    def community_feed_comment_like(cid: int, request: Request):
        _ensure_tables()
        _throttle(request, "fcl", [("ip", 60, 60), ("global", 4000, 3600)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute("""SELECT 1 FROM community_post_comments
                                WHERE id = %s AND status = 'visible'""", (cid,))
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Comment not found")
                cur.execute("""DELETE FROM community_comment_likes
                                WHERE comment_id = %s AND member_id = %s""",
                            (cid, m["id"]))
                liked = cur.rowcount == 0
                if liked:
                    cur.execute("""INSERT INTO community_comment_likes
                                       (comment_id, member_id)
                                   VALUES (%s, %s) ON CONFLICT DO NOTHING""",
                                (cid, m["id"]))
                cur.execute("""SELECT COUNT(*)::int AS n FROM community_comment_likes
                                WHERE comment_id = %s""", (cid,))
                n = int(cur.fetchone()["n"])
            conn.commit()
        return {"ok": True, "liked": liked, "like_count": n}

    @app.post("/api/community/comments/{cid}/report")
    def community_feed_comment_report(cid: int, request: Request,
                                      payload: dict = Body(default={})):
        _ensure_tables()
        _throttle(request, "fcr", [("ip", 20, 3600), ("global", 1000, 3600)])
        reason = str((payload or {}).get("reason") or "").strip()[:300]
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute("""SELECT 1 FROM community_post_comments
                                WHERE id = %s AND status = 'visible'""", (cid,))
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Comment not found")
                cur.execute("""INSERT INTO community_comment_reports
                                   (comment_id, reporter_member_id, reason)
                               VALUES (%s, %s, %s)
                               ON CONFLICT (comment_id, reporter_member_id)
                               DO NOTHING""", (cid, m["id"], reason or None))
            conn.commit()
        return {"ok": True, "note": "Thank you — our team will take a look."}

    # Flagged-comment review lives under /api/crm/ (staff session + CRM role
    # gates run upstream, same as the contact-message queue below).

    # ---- Campaign articles: "Join the Conversation" blog + comments ----
    # Mirrors the feed-comment endpoints one-for-one (same auth, throttle
    # and response shapes) over the article tables. Reads are guest-open;
    # every write requires a member session. First comment on an article
    # earns ARTICLE_COMMENT_BONUS_PTS once via the shared points ledger
    # (UNIQUE(member_id, kind) — kind is per-article, so per-article cap).

    def _article_row(cur, slug):
        cur.execute("""SELECT id, slug, article_type, title, subheading, cover_image,
                              tag, subject, byline, gallery, body, published_at
                        FROM community_articles WHERE slug = %s""", (slug,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Article not found")
        return row

    @app.get("/api/community/articles/{slug}")
    def community_article(slug: str, request: Request):
        _ensure_tables()
        _throttle(request, "art", [("ip", 120, 60), ("global", 6000, 60)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                a = _article_row(cur, slug)
                cur.execute("""SELECT COUNT(*)::int AS n
                                FROM community_article_comments
                                WHERE article_id = %s AND status = 'visible'""",
                            (a["id"],))
                n = int(cur.fetchone()["n"])
        return {"article": {
            "slug": a["slug"], "article_type": a["article_type"],
            "title": a["title"],
            "subheading": a["subheading"], "cover_image": a["cover_image"],
            "tag": a["tag"], "subject": a["subject"], "byline": a["byline"],
            "gallery": a["gallery"] or [], "body": a["body"] or [],
            "published_at": a["published_at"].isoformat() if a["published_at"] else None,
            "comment_count": n,
        }}

    @app.get("/api/community/articles/{slug}/comments")
    def community_article_comments_list(slug: str, request: Request):
        _ensure_tables()
        _throttle(request, "arc", [("ip", 120, 60), ("global", 6000, 60)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                mid = _feed_member_id(cur, request) or -1
                a = _article_row(cur, slug)
                # Newest-first — the campaign page reads like a comment wall.
                cur.execute("""
                    SELECT c.id, c.body, c.created_at, c.member_id,
                           m.username, m.full_name, m.show_tier,
                           m.customer_id, m.customer_store_id,
                           (SELECT COUNT(*) FROM community_article_comment_likes cl
                             WHERE cl.comment_id = c.id)::int AS like_count,
                           EXISTS (SELECT 1 FROM community_article_comment_likes cl2
                                    WHERE cl2.comment_id = c.id
                                      AND cl2.member_id = %s) AS my_liked
                    FROM community_article_comments c
                    JOIN community_members m ON m.id = c.member_id
                    WHERE c.article_id = %s AND c.status = 'visible'
                    ORDER BY c.created_at DESC, c.id DESC
                    LIMIT 500""", (mid, a["id"]))
                rows = cur.fetchall()
                # Tier badge honours the member's show_tier opt-in; computed
                # once per distinct opted-in commenter (lifetime-based, same
                # maths as /me and event gates).
                tiers = {}
                for r in rows:
                    key = r["member_id"]
                    if r["show_tier"] and key not in tiers:
                        tiers[key] = _tier_for(_lifetime_points(cur, r))[0]
        return {"items": [{
            "tier": tiers.get(r["member_id"]),
            "id": r["id"],
            "body": r["body"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "username": (r["username"] or "").strip() or "vivomember",
            "initials": _initials(r["full_name"] or r["username"]),
            "like_count": int(r["like_count"] or 0),
            "my_liked": bool(r["my_liked"]),
            "mine": bool(mid > 0 and r["member_id"] == mid),
        } for r in rows]}

    @app.post("/api/community/articles/{slug}/comments")
    def community_article_comment_add(slug: str, request: Request,
                                      payload: dict = Body(...)):
        _ensure_tables()
        _throttle(request, "aca", [("ip", 10, 60), ("ip", 200, 86400),
                                   ("global", 2000, 3600)])
        body = re.sub(r"\s+", " ", str((payload or {}).get("body") or "")).strip()
        if not body:
            raise HTTPException(status_code=400, detail="Say something first")
        if len(body) > 500:
            raise HTTPException(status_code=400,
                                detail="Keep it under 500 characters")
        if _COMMENT_BLOCKLIST.search(body):
            raise HTTPException(
                status_code=400,
                detail="Let's keep it kind — please rephrase (no links).")
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                a = _article_row(cur, slug)
                cur.execute("""INSERT INTO community_article_comments
                                   (article_id, member_id, body)
                               VALUES (%s, %s, %s)
                               RETURNING id, created_at""",
                            (a["id"], m["id"], body))
                row = cur.fetchone()
                # +5 for her FIRST comment on this article — idempotent via
                # the shared ledger's UNIQUE(member_id, kind); the kind is
                # per-article so more comments never farm more points.
                cur.execute("""INSERT INTO community_points_events
                                   (member_id, kind, points)
                               VALUES (%s, %s, %s)
                               ON CONFLICT (member_id, kind) DO NOTHING
                               RETURNING id""",
                            (m["id"], f"article_comment_{slug}",
                             ARTICLE_COMMENT_BONUS_PTS))
                awarded = cur.fetchone() is not None
                cur.execute("""SELECT COUNT(*)::int AS n
                                FROM community_article_comments
                                WHERE article_id = %s AND status = 'visible'""",
                            (a["id"],))
                n = int(cur.fetchone()["n"])
                my_tier = (_tier_for(_lifetime_points(cur, m))[0]
                           if m.get("show_tier") else None)
            conn.commit()
        return {"ok": True, "comment_count": n,
                "awarded": awarded,
                "awarded_points": ARTICLE_COMMENT_BONUS_PTS if awarded else 0,
                "comment": {
                    "id": row["id"], "body": body,
                    "created_at": row["created_at"].isoformat(),
                    "username": (m.get("username") or "").strip() or "you",
                    "initials": _initials(m.get("full_name") or m.get("username")),
                    "tier": my_tier,
                    "like_count": 0, "my_liked": False, "mine": True}}

    @app.post("/api/community/article-comments/{cid}/like")
    def community_article_comment_like(cid: int, request: Request):
        _ensure_tables()
        _throttle(request, "acl", [("ip", 60, 60), ("global", 4000, 3600)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute("""SELECT 1 FROM community_article_comments
                                WHERE id = %s AND status = 'visible'""", (cid,))
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Comment not found")
                cur.execute("""DELETE FROM community_article_comment_likes
                                WHERE comment_id = %s AND member_id = %s""",
                            (cid, m["id"]))
                liked = cur.rowcount == 0
                if liked:
                    cur.execute("""INSERT INTO community_article_comment_likes
                                       (comment_id, member_id)
                                   VALUES (%s, %s) ON CONFLICT DO NOTHING""",
                                (cid, m["id"]))
                cur.execute("""SELECT COUNT(*)::int AS n
                                FROM community_article_comment_likes
                                WHERE comment_id = %s""", (cid,))
                n = int(cur.fetchone()["n"])
            conn.commit()
        return {"ok": True, "liked": liked, "like_count": n}

    @app.delete("/api/community/article-comments/{cid}")
    def community_article_comment_delete(cid: int, request: Request):
        """Author-only removal (soft delete) — the My Data / DPA path.
        Points already earned stay (same contract as survey deletion)."""
        _ensure_tables()
        _throttle(request, "acd", [("ip", 30, 3600), ("global", 1000, 3600)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute("""UPDATE community_article_comments
                                SET status = 'removed', removed_by = 'author',
                                    removed_at = now()
                                WHERE id = %s AND member_id = %s
                                  AND status = 'visible'""", (cid, m["id"]))
                if cur.rowcount == 0:
                    raise HTTPException(status_code=404, detail="Comment not found")
            conn.commit()
        return {"ok": True}

    @app.post("/api/community/article-comments/{cid}/report")
    def community_article_comment_report(cid: int, request: Request,
                                         payload: dict = Body(default={})):
        _ensure_tables()
        _throttle(request, "acr", [("ip", 20, 3600), ("global", 1000, 3600)])
        reason = str((payload or {}).get("reason") or "").strip()[:300]
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute("""SELECT 1 FROM community_article_comments
                                WHERE id = %s AND status = 'visible'""", (cid,))
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Comment not found")
                cur.execute("""INSERT INTO community_article_comment_reports
                                   (comment_id, reporter_member_id, reason)
                               VALUES (%s, %s, %s)
                               ON CONFLICT (comment_id, reporter_member_id)
                               DO NOTHING""", (cid, m["id"], reason or None))
            conn.commit()
        return {"ok": True, "note": "Thank you — our team will take a look."}

    # ---- Challenges: catalogue, gallery, enter flow, voting ------------
    # Entries reuse the feed machinery (same post ids → same like/comment
    # endpoints and the same CRM flagged-comments queue). Pending entries
    # are status='pending', so the existing status='approved' guards on
    # likes/comments/detail block interaction until publication for free.

    _CH_SELECT = """
        SELECT c.id, c.title, c.hashtag, c.description, c.rules,
               c.caption_prompt, c.points, c.prize, c.deadline,
               c.voting_enabled, c.is_flagship, c.deciding,
               (c.deadline <= now()) AS closed,
               (c.entry_seed
                + (SELECT COUNT(*) FROM community_feed_posts e
                    WHERE e.challenge_id = c.id
                      AND e.entry_status = 'published'))::int AS entries_display
        FROM community_challenges c"""

    def _challenge_row(r):
        return {
            "id": r["id"], "title": r["title"], "hashtag": r["hashtag"],
            "description": r["description"], "rules": r["rules"],
            "caption_prompt": r["caption_prompt"],
            "points": int(r["points"] or 0), "prize": r["prize"],
            "deadline": r["deadline"].isoformat() if r["deadline"] else None,
            "closed": bool(r["closed"]),
            "voting_enabled": bool(r["voting_enabled"]),
            "is_flagship": bool(r["is_flagship"]),
            "deciding": r["deciding"] or "community_shortlist",
            "entries_display": int(r["entries_display"] or 0),
        }

    # Params, in order: my_liked mid, my_vote mid — then WHERE params.
    _ENTRY_SELECT = """
        SELECT p.id, p.author_username, p.author_initials, p.author_tier,
               p.author_show_tier, p.caption, p.variant, p.visual,
               p.tagged, p.created_at, p.challenge_id, p.entry_status,
               p.winner_position, p.author_member_id,
               (p.like_seed
                + (SELECT COUNT(*) FROM community_post_likes pl
                    WHERE pl.post_id = p.id))::int AS like_count,
               (SELECT COUNT(*) FROM community_post_comments c
                 WHERE c.post_id = p.id AND c.status = 'visible')::int
                   AS comment_count,
               EXISTS (SELECT 1 FROM community_post_likes pl2
                        WHERE pl2.post_id = p.id AND pl2.member_id = %s)
                   AS my_liked,
               EXISTS (SELECT 1 FROM community_entry_photos ph
                        WHERE ph.post_id = p.id) AS has_photo,
               (SELECT COUNT(*) FROM community_challenge_votes v
                 WHERE v.post_id = p.id)::int AS vote_count,
               EXISTS (SELECT 1 FROM community_challenge_votes v2
                        WHERE v2.post_id = p.id AND v2.member_id = %s)
                   AS my_vote
        FROM community_feed_posts p"""

    def _entry_extra(r, mid):
        base = _post_row(r)
        base.update({
            "challenge_id": r["challenge_id"],
            "entry_status": r["entry_status"],
            "winner_position": r["winner_position"],
            "mine": bool(mid and mid > 0 and r["author_member_id"] == mid),
            "has_photo": bool(r["has_photo"]),
            "photo_path": (f"/entry-photo/{r['id']}" if r["has_photo"] else None),
            "my_vote": bool(r["my_vote"]),
        })
        return base

    def _challenge_winners(cur, mid, cid):
        cur.execute(_ENTRY_SELECT + """
             WHERE p.challenge_id = %s AND p.entry_status = 'published'
               AND p.winner_position IS NOT NULL
             ORDER BY p.winner_position ASC LIMIT 3""", (mid, mid, cid))
        return [_entry_extra(r, mid) for r in cur.fetchall()]

    def _my_entry_brief(cur, mid, cid):
        if not mid or mid <= 0:
            return None
        cur.execute(
            """SELECT id, entry_status, winner_position
                 FROM community_feed_posts
                WHERE challenge_id = %s AND author_member_id = %s
                  AND entry_status IN ('pending', 'published')
                ORDER BY created_at DESC LIMIT 1""", (cid, mid))
        r = cur.fetchone()
        return ({"post_id": r["id"], "entry_status": r["entry_status"],
                 "winner_position": r["winner_position"]} if r else None)

    @app.get("/api/community/challenges")
    def community_challenges_list(request: Request):
        _ensure_tables()
        _throttle(request, "fee", [("ip", 120, 60), ("global", 6000, 60)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                mid = _feed_member_id(cur, request) or -1
                cur.execute(_CH_SELECT + """
                     ORDER BY (c.deadline <= now()) ASC, c.deadline ASC""")
                rows = cur.fetchall()
                items = []
                for r in rows:
                    d = _challenge_row(r)
                    d["my_entry"] = _my_entry_brief(cur, mid, d["id"])
                    d["winners"] = (_challenge_winners(cur, mid, d["id"])
                                    if d["closed"] else [])
                    items.append(d)
        return {"items": items}

    @app.get("/api/community/challenges/{cid}")
    def community_challenge_detail(cid: str, request: Request):
        _ensure_tables()
        _throttle(request, "fee", [("ip", 120, 60), ("global", 6000, 60)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                mid = _feed_member_id(cur, request) or -1
                cur.execute(_CH_SELECT + " WHERE c.id = %s", (cid,))
                ch = cur.fetchone()
                if not ch:
                    raise HTTPException(status_code=404,
                                        detail="Challenge not found")
                d = _challenge_row(ch)
                d["my_entry"] = _my_entry_brief(cur, mid, cid)
                d["winners"] = (_challenge_winners(cur, mid, cid)
                                if d["closed"] else [])
                # Gallery: everyone's published entries, plus HER pending
                # one (visible only to her, pinned first). Winners lead.
                cur.execute(_ENTRY_SELECT + """
                     WHERE p.challenge_id = %s
                       AND (p.entry_status = 'published'
                            OR (p.entry_status = 'pending'
                                AND p.author_member_id = %s))
                     ORDER BY (p.entry_status = 'pending') DESC,
                              COALESCE(p.winner_position, 99) ASC,
                              p.created_at DESC
                     LIMIT 120""", (mid, mid, cid, mid))
                d["entries"] = [_entry_extra(r, mid) for r in cur.fetchall()]
                my_vote = None
                if mid > 0:
                    cur.execute(
                        """SELECT post_id FROM community_challenge_votes
                            WHERE challenge_id = %s AND member_id = %s""",
                        (cid, mid))
                    vr = cur.fetchone()
                    my_vote = vr["post_id"] if vr else None
                d["my_vote"] = my_vote
        return d

    @app.post("/api/community/challenges/{cid}/entries")
    def community_challenge_enter(cid: str, request: Request,
                                  payload: dict = Body(...)):
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                _throttle(request, "cen",
                          [("ip", 10, 3600), ("phone", 6, 3600),
                           ("global", 400, 3600)], phone=m.get("phone"))
                cur.execute(_CH_SELECT + " WHERE c.id = %s", (cid,))
                ch = cur.fetchone()
                if not ch:
                    raise HTTPException(status_code=404,
                                        detail="Challenge not found")
                if bool(ch["closed"]):
                    raise HTTPException(
                        status_code=400,
                        detail="Entries have closed — winners announced soon")
                raw, mime, mkind = _decode_media(
                    payload.get("media_b64") or payload.get("photo_b64"),
                    noun="photo")
                caption = str(payload.get("caption") or "").strip()[:600]
                marketing_ok = bool(payload.get("marketing_ok"))
                tagged = []
                tags_in = payload.get("tagged") or []
                if len(tags_in) > 3:
                    raise HTTPException(status_code=400,
                                        detail="Tag up to 3 products")
                for t in tags_in:
                    if not isinstance(t, dict):
                        continue
                    sku = str(t.get("sku") or "").strip()[:64]
                    name = str(t.get("name") or "").strip()[:120]
                    if not sku:
                        continue
                    item = {"sku": sku, "name": name or sku}
                    try:
                        if t.get("price") is not None:
                            item["price"] = float(t["price"])
                    except (TypeError, ValueError):
                        pass
                    tagged.append(item)
                # Serialize per member: without the row lock two rapid
                # submits can both see "no active entry" and overshoot the
                # one-entry rule (the partial unique index is the backstop).
                cur.execute("SELECT id FROM community_members WHERE id = %s FOR UPDATE",
                            (m["id"],))
                cur.execute(
                    """SELECT entry_status FROM community_feed_posts
                        WHERE challenge_id = %s AND author_member_id = %s
                          AND entry_status IN ('pending', 'published')
                        LIMIT 1""", (cid, m["id"]))
                ex = cur.fetchone()
                if ex:
                    raise HTTPException(
                        status_code=409,
                        detail=("Your entry is already live in the gallery"
                                if ex["entry_status"] == "published" else
                                "You've already entered — your entry is in review"))
                uname = (m.get("username") or "").strip() or "member"
                cur.execute(
                    """INSERT INTO community_feed_posts
                           (author_member_id, author_username,
                            author_initials, author_show_tier, caption,
                            variant, visual, tagged, like_seed, status,
                            challenge_id, entry_status, marketing_ok,
                            media_kind)
                       VALUES (%s, %s, %s, FALSE, %s, 'standard', 'light',
                               %s::jsonb, 0, 'pending', %s, 'pending', %s,
                               %s)
                       RETURNING id""",
                    (m["id"], uname,
                     _initials(m.get("full_name") or uname), caption,
                     json.dumps(tagged), cid, marketing_ok, mkind))
                pid = int(cur.fetchone()["id"])
                cur.execute(
                    """INSERT INTO community_entry_photos (post_id, image, mime)
                       VALUES (%s, %s, %s)""", (pid, raw, mime))
                # DPA ledger: the form always asks, so record both answers —
                # a FALSE row documents "asked and said no".
                _set_content_consent(cur, m["id"], "challenge_entry", pid,
                                     marketing_ok)
                cur.execute(_ENTRY_SELECT + " WHERE p.id = %s",
                            (m["id"], m["id"], pid))
                row = cur.fetchone()
            conn.commit()
        # Points arrive at PUBLICATION (review), never at submission.
        return {"ok": True, "entry": _entry_extra(row, m["id"])}

    @app.post("/api/community/posts")
    def community_post_create(request: Request, payload: dict = Body(...)):
        """Member-created feed post. Two shapes: 'Share a look' (media
        required — that's the point) and 'Ask the community' (words are
        enough, photo optional). Both take the same review pipeline as
        challenge entries; points land at publication, and only for looks."""
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                _throttle(request, "cpo",
                          [("ip", 10, 3600), ("phone", 6, 3600),
                           ("global", 600, 3600)], phone=m.get("phone"))
                ptype = str(payload.get("post_type") or "look").strip()
                if ptype not in ("look", "question", "haul"):
                    raise HTTPException(status_code=400,
                                        detail="post_type must be look, question or haul")
                caption = str(payload.get("caption") or "").strip()[:600]
                media_b64 = payload.get("media_b64") or payload.get("photo_b64")
                if ptype == "question":
                    if not caption:
                        raise HTTPException(
                            status_code=400,
                            detail="Ask away — a question needs a few words")
                elif not media_b64:
                    raise HTTPException(
                        status_code=400,
                        detail="A look needs a photo or a short video")
                raw = mime = mkind = None
                if media_b64:
                    raw, mime, mkind = _decode_media(media_b64, noun="photo")
                marketing_ok = bool(payload.get("marketing_ok"))
                tags_in = payload.get("tagged") or []
                if len(tags_in) > 3:
                    raise HTTPException(status_code=400,
                                        detail="Tag up to 3 products")
                tagged = []
                for t in tags_in:
                    if not isinstance(t, dict):
                        continue
                    sku = str(t.get("sku") or "").strip()[:64]
                    name = str(t.get("name") or "").strip()[:120]
                    if not sku:
                        continue
                    item = {"sku": sku, "name": name or sku}
                    try:
                        if t.get("price") is not None:
                            item["price"] = float(t["price"])
                    except (TypeError, ValueError):
                        pass
                    tagged.append(item)
                fit_note = None
                fn = payload.get("fit_note")
                if isinstance(fn, dict) and (fn.get("fit") or fn.get("size")):
                    fv = str(fn.get("fit") or "").strip()
                    sz = str(fn.get("size") or "").strip()[:12]
                    if fv not in ("small", "true", "large"):
                        raise HTTPException(
                            status_code=400,
                            detail="fit must be small, true or large")
                    fit_note = {"fit": fv}
                    if sz:
                        fit_note["size"] = sz
                uname = (m.get("username") or "").strip() or "member"
                cur.execute(
                    """INSERT INTO community_feed_posts
                           (author_member_id, author_username,
                            author_initials, author_show_tier, caption,
                            variant, visual, tagged, like_seed, status,
                            challenge_id, entry_status, marketing_ok,
                            post_type, fit_note, media_kind)
                       VALUES (%s, %s, %s, FALSE, %s, 'standard', 'light',
                               %s::jsonb, 0, 'pending', NULL, 'pending', %s,
                               %s, %s::jsonb, %s)
                       RETURNING id""",
                    (m["id"], uname,
                     _initials(m.get("full_name") or uname), caption,
                     json.dumps(tagged), marketing_ok, ptype,
                     json.dumps(fit_note) if fit_note else None, mkind))
                pid = int(cur.fetchone()["id"])
                if raw is not None:
                    cur.execute(
                        """INSERT INTO community_entry_photos
                               (post_id, image, mime)
                           VALUES (%s, %s, %s)""", (pid, raw, mime))
                    # DPA ledger — the form always asks when media rides
                    # along, so record both answers.
                    _set_content_consent(cur, m["id"], "community_post",
                                         pid, marketing_ok)
            conn.commit()
        return {"ok": True, "post_id": pid, "entry_status": "pending",
                "post_type": ptype,
                "note": "Thank you — our team gives every share a quick look"
                        " before it goes live."}

    @app.post("/api/community/rewards/zetu/redeem")
    def community_zetu_redeem(request: Request, payload: dict = Body(default={})):
        """Photoshoot at Zetu Studios — top of the rewards ladder. Same
        affordability rule as the tank (lifetime − non-cancelled spends,
        under the member row lock); lands as a 'booking' the team follows
        up on personally within two working days."""
        _ensure_tables()
        _throttle(request, "redeem", [("ip", 10, 3600), ("global", 200, 3600)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute("SELECT id FROM community_members WHERE id = %s FOR UPDATE",
                            (m["id"],))
                cur.execute(
                    """SELECT id FROM community_redemptions
                        WHERE member_id = %s AND reward_key = 'zetu_shoot'
                          AND status <> 'cancelled' LIMIT 1""", (m["id"],))
                if cur.fetchone():
                    raise HTTPException(
                        status_code=409,
                        detail="Your shoot is already booked — we'll be in touch")
                lifetime = _lifetime_points(cur, m)
                cur.execute(
                    """SELECT COALESCE(SUM(points_cost), 0) AS spent
                       FROM community_redemptions
                       WHERE member_id = %s AND status <> 'cancelled'""",
                    (m["id"],))
                spent = int(cur.fetchone()["spent"])
                short = ZETU_SHOOT_POINTS - (lifetime - spent)
                if short > 0:
                    raise HTTPException(
                        status_code=400,
                        detail=f"You need {short:,} more points for this one")
                cur.execute(
                    """INSERT INTO community_redemptions
                           (member_id, reward_key, points_cost, status)
                       VALUES (%s, 'zetu_shoot', %s, 'booking')
                       RETURNING id""",
                    (m["id"], ZETU_SHOOT_POINTS))
                rid = cur.fetchone()["id"]
            conn.commit()
        _me_cache.pop(m["id"], None)
        return {
            "id": rid,
            "status": "booking",
            "points_cost": ZETU_SHOOT_POINTS,
            "message": "Your moment in front of the lens is booked in — "
                       "we'll be in touch within 2 working days to arrange "
                       "your session at Zetu Studios.",
        }

    @app.get("/api/community/celebrations")
    def community_celebrations(request: Request):
        """The 'Shining This Week' wall — appreciation, never comparison.
        No ranks, no numbers: a curated jewel of the week, warm editorial
        reasons, real challenge winners and a welcome for new members
        (only those who chose to appear in celebrations)."""
        _ensure_tables()
        _throttle(request, "fee", [("ip", 120, 60), ("global", 6000, 60)])
        import datetime as _dt
        week = _dt.date.today().isocalendar()
        jewel = _CELEBRATION_JEWELS[(week[0] * 53 + week[1])
                                    % len(_CELEBRATION_JEWELS)]
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """SELECT p.id AS post_id, p.author_username AS username,
                              p.winner_position, c.id AS challenge_id,
                              c.title, c.hashtag
                         FROM community_feed_posts p
                         JOIN community_challenges c ON c.id = p.challenge_id
                        WHERE p.winner_position IS NOT NULL
                          AND p.entry_status = 'published'
                          AND c.deadline <= now()
                        ORDER BY c.deadline DESC, p.winner_position ASC
                        LIMIT 9""")
                winners = [dict(r) for r in cur.fetchall()]
                cur.execute(
                    """SELECT username,
                              to_char(created_at, 'FMDD Mon') AS joined
                         FROM community_members
                        WHERE username IS NOT NULL
                          AND COALESCE(show_leaderboard, TRUE)
                          AND phone NOT LIKE '2547000001%'
                          AND created_at >= now() - interval '7 days'
                        ORDER BY created_at DESC LIMIT 6""")
                new_jewels = [dict(r) for r in cur.fetchall()]
        return {"jewel": jewel, "celebrated": list(_CELEBRATED),
                "winners": winners, "new_jewels": new_jewels}

    @app.post("/api/community/challenges/{cid}/vote")
    def community_challenge_vote(cid: str, request: Request,
                                 payload: dict = Body(...)):
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                _throttle(request, "cvt",
                          [("ip", 60, 60), ("global", 4000, 3600)],
                          phone=m.get("phone"))
                cur.execute(_CH_SELECT + " WHERE c.id = %s", (cid,))
                ch = cur.fetchone()
                if not ch:
                    raise HTTPException(status_code=404,
                                        detail="Challenge not found")
                if not bool(ch["voting_enabled"]):
                    raise HTTPException(status_code=400,
                                        detail="This challenge doesn't have community voting")
                if bool(ch["closed"]):
                    raise HTTPException(status_code=400,
                                        detail="Voting closed with the challenge")
                try:
                    pid = int(payload.get("post_id"))
                except (TypeError, ValueError):
                    raise HTTPException(status_code=400,
                                        detail="post_id required")
                cur.execute(
                    """SELECT author_member_id FROM community_feed_posts
                        WHERE id = %s AND challenge_id = %s
                          AND entry_status = 'published'""", (pid, cid))
                target = cur.fetchone()
                if not target:
                    raise HTTPException(status_code=404,
                                        detail="Entry not found")
                if target["author_member_id"] == m["id"]:
                    raise HTTPException(
                        status_code=400,
                        detail="You can't vote for your own entry — but we love the confidence")
                cur.execute(
                    """SELECT post_id FROM community_challenge_votes
                        WHERE challenge_id = %s AND member_id = %s
                        FOR UPDATE""", (cid, m["id"]))
                existing = cur.fetchone()
                if existing and existing["post_id"] == pid:
                    cur.execute(
                        """DELETE FROM community_challenge_votes
                            WHERE challenge_id = %s AND member_id = %s""",
                        (cid, m["id"]))
                    my_vote = None
                else:
                    cur.execute(
                        """INSERT INTO community_challenge_votes
                               (challenge_id, member_id, post_id)
                           VALUES (%s, %s, %s)
                           ON CONFLICT (challenge_id, member_id)
                           DO UPDATE SET post_id = EXCLUDED.post_id,
                                         created_at = now()""",
                        (cid, m["id"], pid))
                    my_vote = pid
            conn.commit()
        # No public tallies — votes shortlist quietly (top ten on close) and
        # the Vivo team announces winners. Counts are staff-only, in the CRM.
        return {"ok": True, "my_vote": my_vote}

    @app.get("/api/community/entry-photo/{pid}")
    def community_entry_photo(pid: int, request: Request):
        _ensure_tables()
        _throttle(request, "fee", [("ip", 120, 60), ("global", 6000, 60)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                mid = _feed_member_id(cur, request) or -1
                cur.execute(
                    """SELECT ph.image, ph.mime FROM community_entry_photos ph
                        JOIN community_feed_posts p ON p.id = ph.post_id
                       WHERE ph.post_id = %s
                         AND (p.entry_status = 'published'
                              OR p.author_member_id = %s)""", (pid, mid))
                row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="No photo")
        return Response(content=bytes(row["image"]),
                        media_type=row.get("mime") or "image/jpeg",
                        headers={"Cache-Control": "private, max-age=3600"})

    @app.get("/api/community/my-entries")
    def community_my_entries(request: Request):
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute(
                    """SELECT p.id, p.challenge_id, p.caption,
                              p.entry_status, p.winner_position,
                              p.created_at, p.published_at,
                              p.post_type, p.media_kind,
                              EXISTS (SELECT 1 FROM community_entry_photos ph
                                       WHERE ph.post_id = p.id) AS has_media,
                              c.title AS challenge_title, c.points
                         FROM community_feed_posts p
                         LEFT JOIN community_challenges c
                                ON c.id = p.challenge_id
                        WHERE p.author_member_id = %s
                          AND p.entry_status IS NOT NULL
                        ORDER BY p.created_at DESC LIMIT 50""", (m["id"],))
                rows = cur.fetchall()
        items = []
        for r in rows:
            ptype = r["post_type"] or "look"
            if r["challenge_id"]:
                pts = int(r["points"] or 0)
            elif ptype == "question" or not r["has_media"]:
                pts = 0
            elif (r["media_kind"] or "") == "video":
                pts = POST_VIDEO_PTS
            else:
                pts = POST_PHOTO_PTS
            items.append({
                "post_id": r["id"], "challenge_id": r["challenge_id"],
                "challenge_title": r["challenge_title"],
                "post_type": ptype,
                "media_kind": r["media_kind"],
                "points": pts,
                "caption": r["caption"],
                "entry_status": r["entry_status"],
                "winner_position": r["winner_position"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "published_at": r["published_at"].isoformat() if r["published_at"] else None,
            })
        return {"items": items}

    # ---------------- Vivo Edits (member-facing) ----------------

    _EDIT_ACTIVE_SQL = """e.archived_at IS NULL
          AND (e.starts_at IS NULL OR e.starts_at <= now())
          AND (e.ends_at IS NULL OR e.ends_at > now())"""

    def _edit_cover_sql():
        return """(SELECT i.id FROM community_edit_images i
                    WHERE i.edit_id = e.id
                    ORDER BY i.position, i.id LIMIT 1) AS cover_image_id"""

    def _edit_card(r):
        cov = r.get("cover_image_id")
        return {
            "id": r["id"],
            "creator_name": r["creator_name"],
            "title": r["title"],
            "description": r["description"],
            "disclosure": r["disclosure"],
            "featured": bool(r["featured"]),
            "cover_image": (f"/api/community/edit-image/{cov}" if cov else None),
            "cover_alt": r.get("cover_alt") or (r["creator_name"] + " — "
                                                + r["title"]),
            "feed_post_id": r.get("feed_post_id"),
        }

    # Schedules flip edits active/inactive with no mutation to trigger the
    # feed-post sync, so reads reconcile lazily: any edit whose active state
    # disagrees with its mirrored feed post (or that is active with no post
    # yet) gets synced. Rate-limited to once a minute per process.
    _edits_reconcile_last = {"t": 0.0}

    def _edits_reconcile_feed():
        now = time.time()
        if now - _edits_reconcile_last["t"] < 60:
            return
        _edits_reconcile_last["t"] = now
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(f"""
                    SELECT e.id FROM community_edits e
                    LEFT JOIN community_feed_posts p ON p.id = e.feed_post_id
                    WHERE (({_EDIT_ACTIVE_SQL})
                           AND (p.id IS NULL OR p.status <> 'approved'))
                       OR (NOT ({_EDIT_ACTIVE_SQL})
                           AND p.status = 'approved')
                    LIMIT 50""")
                ids = [r["id"] for r in cur.fetchall()]
                for eid in ids:
                    _edit_sync_feed_post(cur, eid)
            if ids:
                conn.commit()

    @app.get("/api/community/edits")
    def community_edits_list(request: Request, limit: int = 12,
                             offset: int = 0):
        _ensure_tables()
        _throttle(request, "edt", [("ip", 120, 60), ("global", 6000, 60)])
        _edits_reconcile_feed()
        lim = max(1, min(int(limit or 12), 50))
        off = max(0, int(offset or 0))
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(f"""
                    SELECT e.id, e.creator_name, e.title, e.description,
                           e.disclosure, e.featured, e.feed_post_id,
                           {_edit_cover_sql()},
                           (SELECT i.alt_text FROM community_edit_images i
                             WHERE i.edit_id = e.id
                             ORDER BY i.position, i.id LIMIT 1) AS cover_alt,
                           COUNT(*) OVER ()::int AS total
                    FROM community_edits e
                    WHERE {_EDIT_ACTIVE_SQL}
                    ORDER BY e.featured DESC, e.sort_order, e.created_at DESC
                    LIMIT %s OFFSET %s""", (lim, off))
                rows = cur.fetchall()
        return {"items": [_edit_card(r) for r in rows],
                "total": int(rows[0]["total"]) if rows else 0}

    @app.get("/api/community/edits/{eid}")
    def community_edit_detail(eid: int, request: Request):
        _ensure_tables()
        _throttle(request, "edt", [("ip", 120, 60), ("global", 6000, 60)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(f"""
                    SELECT e.*, {_edit_cover_sql()}
                    FROM community_edits e
                    WHERE e.id = %s AND {_EDIT_ACTIVE_SQL}""", (eid,))
                e = cur.fetchone()
                if not e:
                    raise HTTPException(status_code=404, detail="Edit not found")
                cur.execute("""SELECT id, position, alt_text
                                 FROM community_edit_images
                                WHERE edit_id = %s
                                ORDER BY position, id""", (eid,))
                imgs = cur.fetchall()
        from urllib.parse import quote as _q
        tagged = []
        for t in (e["tagged"] or []):
            d = dict(t)
            d["img"] = ("/api/community/product-image/"
                        + _q(str(d.get("sku") or ""), safe=""))
            tagged.append(d)
        out = _edit_card(e)
        out.update({
            "intro": e["intro"],
            "creator_username": e["creator_username"],
            "images": [{"id": i["id"],
                        "path": f"/api/community/edit-image/{i['id']}",
                        "alt": i["alt_text"] or (e["creator_name"] + " — "
                                                 + e["title"])}
                       for i in imgs],
            "tagged": tagged,
        })
        return out

    @app.get("/api/community/edit-image/{img_id}")
    def community_edit_image(img_id: int, request: Request):
        """Public like entry-photo: native <img> loads carry no Bearer header.
        Only images of edits that have gone public are served: currently
        active, or ever mirrored into the feed (feed history may reference
        them). Scheduled/unpublished edits stay private."""
        _ensure_tables()
        _throttle(request, "edt", [("ip", 240, 60), ("global", 9000, 60)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(f"""SELECT i.image, i.mime
                                 FROM community_edit_images i
                                 JOIN community_edits e ON e.id = i.edit_id
                                WHERE i.id = %s
                                  AND (({_EDIT_ACTIVE_SQL})
                                       OR e.feed_post_id IS NOT NULL)""",
                            (img_id,))
                row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="No image")
        return Response(content=bytes(row["image"]),
                        media_type=row.get("mime") or "image/png",
                        headers={"Cache-Control": "public, max-age=3600"})

    # ---------------- Vivo Edits (CRM staff management) ----------------
    # Staff management lives under /api/crm/ on purpose (staff-session gate +
    # CRM role gate both run first), exactly like the moderation endpoints.

    _EDIT_FIELDS = ("creator_name", "creator_username", "title", "description",
                    "intro", "disclosure")

    def _edit_resolve_skus(cur, skus):
        """SKU list -> feed-shaped tag dicts from the live catalogue; unknown
        SKUs are a 400 so staff never publish dead shopping links."""
        skus = [str(s).strip() for s in (skus or []) if str(s).strip()]
        if not skus:
            return []
        if len(skus) > 24:
            raise HTTPException(status_code=400,
                                detail="Tag at most 24 products per edit")
        cur.execute("SELECT to_regclass('public.all_products_clean') IS NOT NULL")
        if not list(cur.fetchone().values())[0]:
            raise HTTPException(status_code=503,
                                detail="Catalogue unavailable — try again shortly")
        cur.execute("""SELECT DISTINCT ON (sku) sku, style_name,
                              price::float AS price
                         FROM all_products_clean
                        WHERE sku = ANY(%s)
                        ORDER BY sku""", (skus,))
        found = {r["sku"]: r for r in cur.fetchall()}
        missing = [s for s in skus if s not in found]
        if missing:
            raise HTTPException(status_code=400,
                                detail="Unknown SKUs: " + ", ".join(missing[:8]))
        return [{"sku": s, "name": found[s]["style_name"],
                 "price": float(found[s]["price"] or 0)} for s in skus]

    def _edit_parse_when(payload, key):
        v = (payload or {}).get(key)
        if v in (None, ""):
            return None
        try:
            return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400,
                                detail=f"{key} must be an ISO date/time")

    def _edit_sync_feed_post(cur, eid):
        """Keep the edit's mirrored feed post in lockstep: caption/tags/cover
        follow the edit; active edits post 'approved', inactive ones 'hidden'
        (likes and comments are preserved, never deleted)."""
        cur.execute(f"""
            SELECT e.*, {_edit_cover_sql()},
                   ({_EDIT_ACTIVE_SQL}) AS is_active
              FROM community_edits e WHERE e.id = %s""", (eid,))
        e = cur.fetchone()
        if not e:
            return
        caption = ("VIVO EDIT — “" + e["title"] + "” curated by "
                   + e["creator_name"] + ". " + (e["description"] or ""))
        img = (f"/api/community/edit-image/{e['cover_image_id']}"
               if e["cover_image_id"] else None)
        status = "approved" if e["is_active"] else "hidden"
        uname = e["creator_username"] or e["creator_name"].lower()
        ini = (e["creator_name"][:1].upper() or "V") + "V"
        if e["feed_post_id"]:
            cur.execute("""UPDATE community_feed_posts
                              SET caption = %s, tagged = %s::jsonb,
                                  image_url = %s, status = %s,
                                  author_username = %s
                            WHERE id = %s""",
                        (caption, json.dumps(e["tagged"] or []), img, status,
                         uname, e["feed_post_id"]))
        elif e["is_active"]:
            cur.execute("""INSERT INTO community_feed_posts
                               (mock_key, author_username, author_initials,
                                caption, variant, visual, tagged, like_seed,
                                status, post_type, image_url)
                           VALUES (%s, %s, %s, %s, 'standard', 'light',
                                   %s::jsonb, 0, 'approved', 'look', %s)
                           ON CONFLICT (mock_key) DO UPDATE
                               SET caption = EXCLUDED.caption,
                                   tagged = EXCLUDED.tagged,
                                   image_url = EXCLUDED.image_url,
                                   status = 'approved'
                           RETURNING id""",
                        (f"vivoedit_id_{eid}", uname, ini, caption,
                         json.dumps(e["tagged"] or []), img))
            cur.execute("UPDATE community_edits SET feed_post_id = %s"
                        " WHERE id = %s", (cur.fetchone()["id"], eid))

    @app.get("/api/crm/community-edits")
    def crm_edits_list(request: Request):
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(f"""
                    SELECT e.id, e.edit_key, e.creator_name,
                           e.creator_username, e.title, e.description,
                           e.intro, e.disclosure, e.featured, e.sort_order,
                           e.starts_at, e.ends_at, e.archived_at,
                           e.feed_post_id, e.tagged, e.created_at,
                           e.updated_at, {_edit_cover_sql()},
                           ({_EDIT_ACTIVE_SQL}) AS is_active,
                           (SELECT COALESCE(json_agg(json_build_object(
                                       'id', i.id, 'position', i.position,
                                       'alt_text', i.alt_text)
                                   ORDER BY i.position, i.id), '[]'::json)
                              FROM community_edit_images i
                             WHERE i.edit_id = e.id) AS images,
                           (SELECT COUNT(*) FROM community_post_likes pl
                             WHERE pl.post_id = e.feed_post_id)::int
                               AS like_count,
                           (SELECT COUNT(*) FROM community_post_comments c
                             WHERE c.post_id = e.feed_post_id
                               AND c.status = 'visible')::int AS comment_count
                    FROM community_edits e
                    ORDER BY (e.archived_at IS NOT NULL),
                             e.featured DESC, e.sort_order, e.created_at DESC""")
                rows = [dict(r) for r in cur.fetchall()]
        for r in rows:
            for k in ("starts_at", "ends_at", "archived_at", "created_at",
                      "updated_at"):
                if r.get(k):
                    r[k] = r[k].isoformat()
            cov = r.pop("cover_image_id", None)
            # Staff-gated image URL: works for scheduled/unpublished edits too.
            r["cover_image"] = (f"/api/crm/community-edit-image/{cov}"
                                if cov else None)
        return {"items": rows}

    @app.post("/api/crm/community-edits")
    def crm_edits_create(request: Request, payload: dict = Body(...)):
        _ensure_tables()
        p = payload or {}
        name = str(p.get("creator_name") or "").strip()
        title = str(p.get("title") or "").strip()
        if not name or not title:
            raise HTTPException(status_code=400,
                                detail="creator_name and title are required")
        images = p.get("images") or []
        if not isinstance(images, list) or len(images) > 8:
            raise HTTPException(status_code=400,
                                detail="images must be a list of at most 8")
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                tagged = _edit_resolve_skus(cur, p.get("skus"))
                cur.execute(
                    """INSERT INTO community_edits
                           (creator_name, creator_username, title, description,
                            intro, disclosure, featured, sort_order, starts_at,
                            ends_at, tagged)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                               %s::jsonb)
                       RETURNING id""",
                    (name, str(p.get("creator_username") or "").strip(),
                     title, str(p.get("description") or "").strip(),
                     str(p.get("intro") or "").strip(),
                     (str(p.get("disclosure")).strip()
                      if p.get("disclosure") else None),
                     bool(p.get("featured")), int(p.get("sort_order") or 100),
                     _edit_parse_when(p, "starts_at"),
                     _edit_parse_when(p, "ends_at"), json.dumps(tagged)))
                eid = cur.fetchone()["id"]
                for pos, img in enumerate(images):
                    raw, mime = _decode_design(
                        (img or {}).get("image_b64"), noun="edit image")
                    cur.execute(
                        """INSERT INTO community_edit_images
                               (edit_id, image, mime, position, alt_text)
                           VALUES (%s, %s, %s, %s, %s)""",
                        (eid, psycopg2.Binary(raw), mime, pos,
                         str((img or {}).get("alt_text") or "").strip()))
                _edit_sync_feed_post(cur, eid)
            conn.commit()
        return {"ok": True, "id": eid}

    @app.put("/api/crm/community-edits/reorder")
    def crm_edits_reorder(request: Request, payload: dict = Body(...)):
        ids = [int(i) for i in (payload or {}).get("ids") or []]
        if not ids:
            raise HTTPException(status_code=400, detail="ids required")
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                for pos, eid in enumerate(ids):
                    cur.execute("""UPDATE community_edits
                                      SET sort_order = %s, updated_at = now()
                                    WHERE id = %s""", ((pos + 1) * 10, eid))
            conn.commit()
        return {"ok": True}

    @app.put("/api/crm/community-edits/{eid}")
    def crm_edits_update(eid: int, request: Request, payload: dict = Body(...)):
        _ensure_tables()
        p = payload or {}
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("SELECT id FROM community_edits WHERE id = %s",
                            (eid,))
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Edit not found")
                sets, vals = [], []
                for f in _EDIT_FIELDS:
                    if f in p:
                        v = p[f]
                        v = (str(v).strip() if v is not None else None)
                        if f in ("creator_name", "title") and not v:
                            raise HTTPException(status_code=400,
                                                detail=f"{f} can't be empty")
                        sets.append(f"{f} = %s")
                        vals.append(v if (v or f == "disclosure") else "")
                if "featured" in p:
                    sets.append("featured = %s")
                    vals.append(bool(p["featured"]))
                if "sort_order" in p:
                    sets.append("sort_order = %s")
                    vals.append(int(p["sort_order"] or 100))
                for k in ("starts_at", "ends_at"):
                    if k in p:
                        sets.append(f"{k} = %s")
                        vals.append(_edit_parse_when(p, k))
                if "skus" in p:
                    sets.append("tagged = %s::jsonb")
                    vals.append(json.dumps(_edit_resolve_skus(cur, p["skus"])))
                if "archived" in p:
                    sets.append("archived_at = " +
                                ("COALESCE(archived_at, now())"
                                 if p["archived"] else "NULL"))
                if sets:
                    cur.execute("UPDATE community_edits SET "
                                + ", ".join(sets)
                                + ", updated_at = now() WHERE id = %s",
                                vals + [eid])
                _edit_sync_feed_post(cur, eid)
            conn.commit()
        return {"ok": True}

    @app.post("/api/crm/community-edits/{eid}/images")
    def crm_edits_add_image(eid: int, request: Request,
                            payload: dict = Body(...)):
        _ensure_tables()
        p = payload or {}
        raw, mime = _decode_design(p.get("image_b64"), noun="edit image")
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("SELECT id FROM community_edits WHERE id = %s",
                            (eid,))
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Edit not found")
                if p.get("cover"):
                    cur.execute("""UPDATE community_edit_images
                                      SET position = position + 1
                                    WHERE edit_id = %s""", (eid,))
                    pos = 0
                else:
                    cur.execute("""SELECT COALESCE(MAX(position), -1) + 1 AS p
                                     FROM community_edit_images
                                    WHERE edit_id = %s""", (eid,))
                    pos = int(cur.fetchone()["p"])
                cur.execute(
                    """INSERT INTO community_edit_images
                           (edit_id, image, mime, position, alt_text)
                       VALUES (%s, %s, %s, %s, %s) RETURNING id""",
                    (eid, psycopg2.Binary(raw), mime, pos,
                     str(p.get("alt_text") or "").strip()))
                iid = cur.fetchone()["id"]
                cur.execute("UPDATE community_edits SET updated_at = now()"
                            " WHERE id = %s", (eid,))
                _edit_sync_feed_post(cur, eid)
            conn.commit()
        return {"ok": True, "id": iid,
                "path": f"/api/community/edit-image/{iid}"}

    @app.delete("/api/crm/community-edits/{eid}/images/{img_id}")
    def crm_edits_delete_image(eid: int, img_id: int, request: Request):
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""DELETE FROM community_edit_images
                                WHERE id = %s AND edit_id = %s""",
                            (img_id, eid))
                if not cur.rowcount:
                    raise HTTPException(status_code=404, detail="Image not found")
                cur.execute("UPDATE community_edits SET updated_at = now()"
                            " WHERE id = %s", (eid,))
                _edit_sync_feed_post(cur, eid)
            conn.commit()
        return {"ok": True}

    @app.get("/api/crm/community-edit-image/{img_id}")
    def crm_edit_image(img_id: int, request: Request):
        """Staff-only image route: serves any edit image regardless of
        active/scheduled state. Used by the CRM preview and edit dialog so
        staff can review images on scheduled/unpublished edits without
        exposing them to the public /api/community/edit-image route."""
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""SELECT i.image, i.mime
                                 FROM community_edit_images i
                                WHERE i.id = %s""", (img_id,))
                row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="No image")
        return Response(content=bytes(row["image"]),
                        media_type=row.get("mime") or "image/png",
                        headers={"Cache-Control": "private, max-age=300"})

    @app.get("/api/crm/community-edits/{eid}/preview")
    def crm_edit_preview(eid: int, request: Request):
        """Staff preview of any edit — including scheduled/unpublished ones.

        Returns the same shape as GET /api/community/edits/{eid} (member
        detail) but with two differences:
          • no active-state filter — any non-deleted edit is shown
          • image paths use /api/crm/community-edit-image/* so the staff
            session cookie authorises the <img> loads without exposing
            unpublished assets to the public route
        Members cannot reach this endpoint: /api/crm/* is staff-session-gated
        by the api_pg middleware."""
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(f"""
                    SELECT e.*, {_edit_cover_sql()}
                      FROM community_edits e
                     WHERE e.id = %s""", (eid,))
                e = cur.fetchone()
                if not e:
                    raise HTTPException(status_code=404, detail="Edit not found")
                cur.execute("""SELECT id, position, alt_text
                                 FROM community_edit_images
                                WHERE edit_id = %s
                                ORDER BY position, id""", (eid,))
                imgs = cur.fetchall()
        from urllib.parse import quote as _q
        tagged = []
        for t in (e["tagged"] or []):
            d = dict(t)
            d["img"] = ("/api/community/product-image/"
                        + _q(str(d.get("sku") or ""), safe=""))
            tagged.append(d)
        cov = e.get("cover_image_id")
        # Compute is_active so the preview banner can show the real status.
        now_utc = datetime.now(timezone.utc)
        sa = e.get("starts_at")
        ea = e.get("ends_at")
        is_active = (
            not e.get("archived_at")
            and (sa is None or (hasattr(sa, "tzinfo") and sa <= now_utc))
            and (ea is None or (hasattr(ea, "tzinfo") and ea > now_utc))
        )
        def _iso(v):
            return v.isoformat() if v else None
        return {
            "id": e["id"],
            "creator_name": e["creator_name"],
            "creator_username": e["creator_username"],
            "title": e["title"],
            "description": e["description"],
            "intro": e["intro"],
            "disclosure": e["disclosure"],
            "featured": bool(e["featured"]),
            "feed_post_id": e.get("feed_post_id"),
            "cover_image": (f"/api/crm/community-edit-image/{cov}"
                            if cov else None),
            "cover_alt": ((e["creator_name"] or "") + " — "
                          + (e["title"] or "")),
            "images": [
                {"id": i["id"],
                 "path": f"/api/crm/community-edit-image/{i['id']}",
                 "alt": i["alt_text"] or ((e["creator_name"] or "")
                                          + " — " + (e["title"] or ""))}
                for i in imgs
            ],
            "tagged": tagged,
            "starts_at": _iso(e.get("starts_at")),
            "ends_at": _iso(e.get("ends_at")),
            "archived_at": _iso(e.get("archived_at")),
            "is_active": is_active,
        }

    @app.get("/api/crm/community-flagged-comments")
    def crm_flagged_comments(request: Request, status: str = "open",
                             limit: int = 200):
        _ensure_tables()
        st = status if status in ("open", "dismissed", "removed") else "open"
        lim = max(1, min(int(limit or 200), 1000))
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT c.id AS comment_id, c.body,
                           c.created_at AS commented_at,
                           c.status AS comment_status,
                           m.username AS author_username,
                           p.id AS post_id, LEFT(p.caption, 90) AS post_caption,
                           p.author_username AS post_author,
                           COUNT(r.id)::int AS report_count,
                           MIN(r.created_at) AS first_reported,
                           STRING_AGG(DISTINCT NULLIF(TRIM(r.reason), ''),
                                      ' · ') AS reasons
                    FROM community_comment_reports r
                    JOIN community_post_comments c ON c.id = r.comment_id
                    JOIN community_members m ON m.id = c.member_id
                    JOIN community_feed_posts p ON p.id = c.post_id
                    WHERE r.status = %s
                    GROUP BY c.id, c.body, c.created_at, c.status, m.username,
                             p.id, p.caption, p.author_username
                    ORDER BY MIN(r.created_at) ASC
                    LIMIT %s""", (st, lim))
                rows = cur.fetchall()
        items = []
        for r in rows:
            d = dict(r)
            for k in ("commented_at", "first_reported"):
                if d.get(k):
                    d[k] = d[k].isoformat()
            items.append(d)
        return {"items": items, "status": st}

    @app.post("/api/crm/community-flagged-comments/{cid}/resolve")
    def crm_flagged_comment_resolve(cid: int, request: Request,
                                    payload: dict = Body(...)):
        _ensure_tables()
        action = str((payload or {}).get("action") or "").strip()
        if action not in ("dismiss", "remove"):
            raise HTTPException(status_code=400,
                                detail="action must be dismiss or remove")
        u = getattr(request.state, "user", None) or {}
        staff = u.get("email") or u.get("username") or "staff"
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""SELECT id, status FROM community_post_comments
                                WHERE id = %s""", (cid,))
                c = cur.fetchone()
                if not c:
                    raise HTTPException(status_code=404, detail="Comment not found")
                if action == "remove" and c["status"] == "visible":
                    cur.execute("""UPDATE community_post_comments
                                      SET status = 'removed', removed_by = %s,
                                          removed_at = now()
                                    WHERE id = %s""", (staff, cid))
                cur.execute("""UPDATE community_comment_reports
                                  SET status = %s, resolved_by = %s,
                                      resolved_at = now()
                                WHERE comment_id = %s AND status = 'open'""",
                            ("removed" if action == "remove" else "dismissed",
                             staff, cid))
                n = cur.rowcount
            conn.commit()
        return {"ok": True, "action": action, "reports_resolved": n}

    # Staff review lives OUTSIDE the /api/community/ member-token bypass, under
    # /api/crm/ on purpose: the global staff-session gate AND the CRM role gate
    # (customer_service / marketing / leadership / smt / admin) both run before
    # these handlers do.

    @app.get("/api/crm/community-challenges")
    def crm_community_challenges(request: Request):
        """Challenge board for staff: status, entry pipeline and the winner
        model (deciding) per challenge."""
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT c.id, c.title, c.hashtag, c.points, c.prize,
                           c.deadline, c.voting_enabled, c.deciding,
                           (c.deadline <= now()) AS closed,
                           COUNT(*) FILTER (WHERE p.entry_status = 'pending')::int
                               AS pending,
                           COUNT(*) FILTER (WHERE p.entry_status = 'published')::int
                               AS published,
                           COUNT(*) FILTER (WHERE p.winner_position IS NOT NULL)::int
                               AS winners_set
                    FROM community_challenges c
                    LEFT JOIN community_feed_posts p ON p.challenge_id = c.id
                    GROUP BY c.id
                    ORDER BY (c.deadline <= now()) ASC, c.deadline ASC""")
                rows = [dict(r) for r in cur.fetchall()]
        for r in rows:
            if r.get("deadline"):
                r["deadline"] = r["deadline"].isoformat()
        return {"items": rows}

    @app.get("/api/crm/community-challenges/{cid}/shortlist")
    def crm_community_challenge_shortlist(cid: str, request: Request):
        """Winner-picking view. community_shortlist challenges surface the
        community's top ten by votes (ties broken by earliest entry) once
        closed; team_pick (and still-open) challenges list every published
        entry. Vote counts are staff-only — members never see tallies."""
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""SELECT id, title, hashtag, points, prize,
                                      deciding, voting_enabled,
                                      (deadline <= now()) AS closed, deadline
                                 FROM community_challenges WHERE id = %s""",
                            (cid,))
                ch = cur.fetchone()
                if not ch:
                    raise HTTPException(status_code=404,
                                        detail="Challenge not found")
                shortlisted = (ch["deciding"] == "community_shortlist"
                               and bool(ch["closed"]))
                cur.execute("""
                    SELECT p.id AS post_id, p.author_username, p.caption,
                           p.created_at, p.winner_position, p.marketing_ok,
                           p.media_kind,
                           EXISTS (SELECT 1 FROM community_entry_photos ph
                                    WHERE ph.post_id = p.id) AS has_photo,
                           (SELECT COUNT(*) FROM community_challenge_votes v
                             WHERE v.post_id = p.id)::int AS vote_count
                    FROM community_feed_posts p
                    WHERE p.challenge_id = %s
                      AND p.entry_status = 'published'
                    ORDER BY vote_count DESC, p.created_at ASC
                    LIMIT %s""", (cid, 10 if shortlisted else 200))
                entries = []
                for r in cur.fetchall():
                    d = dict(r)
                    if d.get("created_at"):
                        d["created_at"] = d["created_at"].isoformat()
                    entries.append(d)
        ch = dict(ch)
        if ch.get("deadline"):
            ch["deadline"] = ch["deadline"].isoformat()
        ch["closed"] = bool(ch["closed"])
        return {"challenge": ch, "shortlist": shortlisted,
                "winner_bonus": CHALLENGE_WINNER_BONUS_PTS,
                "entries": entries}

    @app.get("/api/crm/community-redemptions")
    def crm_community_redemptions(request: Request, status: str = "",
                                  reward_key: str = "", limit: int = 200):
        """Redemption queue for staff — Zetu shoots to schedule, tanks to
        stitch. Member contact details ride along so the team can call;
        design bytes never do (has_design flag only)."""
        _ensure_tables()
        lim = max(1, min(int(limit or 200), 500))
        conds, args = [], []
        if status:
            conds.append("r.status = %s")
            args.append(status)
        if reward_key:
            conds.append("r.reward_key = %s")
            args.append(reward_key)
        where = (" WHERE " + " AND ".join(conds)) if conds else ""
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT r.id, r.member_id, r.reward_key, r.points_cost,
                           r.sku, r.size, r.colour, r.embroidery_type,
                           r.monogram_text, r.monogram_style,
                           (r.design_image IS NOT NULL) AS has_design,
                           r.collection_method, r.pickup_store,
                           r.status, r.status_note, r.created_at,
                           m.full_name, m.username, m.phone
                    FROM community_redemptions r
                    JOIN community_members m ON m.id = r.member_id""" + where + """
                    ORDER BY (r.status IN ('in_review', 'booking')) DESC,
                             r.created_at DESC
                    LIMIT %s""", (*args, lim))
                rows = []
                for r in cur.fetchall():
                    d = dict(r)
                    if d.get("created_at"):
                        d["created_at"] = d["created_at"].isoformat()
                    rows.append(d)
                cur.execute("""SELECT status, COUNT(*)::int AS n
                                 FROM community_redemptions
                                GROUP BY status""")
                counts = {r["status"]: int(r["n"]) for r in cur.fetchall()}
        return {"items": rows, "counts": counts}

    @app.put("/api/crm/community-redemptions/{rid}/status")
    def crm_community_redemption_status(rid: int, request: Request,
                                        payload: dict = Body(...)):
        """Staff move a redemption along (Zetu shoots: booking → scheduled →
        done). Cancelling refunds automatically — spendable points are
        derived from non-cancelled redemptions."""
        _ensure_tables()
        status = str((payload or {}).get("status") or "").strip()
        note = str((payload or {}).get("note") or "").strip()[:300] or None
        allowed = ("in_review", "needs_changes", "stitching", "booking",
                   "scheduled", "ready", "collected", "done", "cancelled")
        if status not in allowed:
            raise HTTPException(status_code=400,
                                detail=f"status must be one of {', '.join(allowed)}")
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """UPDATE community_redemptions
                          SET status = %s, status_note = %s
                        WHERE id = %s
                        RETURNING id, member_id, reward_key, status""",
                    (status, note, rid))
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404,
                                        detail="Redemption not found")
            conn.commit()
        _me_cache.pop(row["member_id"], None)
        return {"ok": True, "id": row["id"], "status": row["status"],
                "reward_key": row["reward_key"]}

    @app.get("/api/crm/community-entries")
    def crm_community_entries(request: Request, status: str = "pending",
                              limit: int = 200, scope: str = "all"):
        _ensure_tables()
        st = status if status in ("pending", "published", "rejected") else "pending"
        lim = max(1, min(int(limit or 200), 1000))
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                sc = scope if scope in ("all", "challenges", "posts") else "all"
                extra = {"challenges": " AND p.challenge_id IS NOT NULL",
                         "posts": " AND p.challenge_id IS NULL"}.get(sc, "")
                cur.execute("""
                    SELECT p.id AS post_id, p.caption, p.created_at,
                           p.published_at, p.entry_status, p.marketing_ok,
                           p.winner_position, p.author_username,
                           p.author_member_id, p.tagged,
                           p.post_type, p.media_kind, p.fit_note, p.image_url,
                           c.id AS challenge_id, c.title AS challenge_title,
                           c.points, (c.deadline <= now()) AS challenge_closed,
                           EXISTS (SELECT 1 FROM community_entry_photos ph
                                    WHERE ph.post_id = p.id) AS has_photo,
                           (SELECT COUNT(*) FROM community_challenge_votes v
                             WHERE v.post_id = p.id)::int AS vote_count
                    FROM community_feed_posts p
                    LEFT JOIN community_challenges c ON c.id = p.challenge_id
                    WHERE p.entry_status = %s""" + extra + """
                    ORDER BY p.created_at ASC LIMIT %s""", (st, lim))
                rows = cur.fetchall()
                counts = {}
                cur.execute("""SELECT entry_status, COUNT(*)::int AS n
                                 FROM community_feed_posts
                                WHERE entry_status IS NOT NULL
                                GROUP BY entry_status""")
                for r in cur.fetchall():
                    counts[r["entry_status"]] = int(r["n"])
        items = []
        for r in rows:
            d = dict(r)
            for k in ("created_at", "published_at"):
                if d.get(k):
                    d[k] = d[k].isoformat()
            items.append(d)
        return {"items": items, "status": st, "counts": counts}

    @app.get("/api/crm/community-entries/{pid}/photo")
    def crm_community_entry_photo(pid: int, request: Request):
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""SELECT image, mime FROM community_entry_photos
                                WHERE post_id = %s""", (pid,))
                row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="No photo on this entry")
        return Response(content=bytes(row["image"]),
                        media_type=row.get("mime") or "image/jpeg")

    @app.post("/api/crm/community-entries/{pid}/review")
    def crm_community_entry_review(pid: int, request: Request,
                                   payload: dict = Body(...)):
        _ensure_tables()
        action = str((payload or {}).get("action") or "").strip()
        if action not in ("publish", "reject"):
            raise HTTPException(status_code=400,
                                detail="action must be publish or reject")
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """SELECT p.id, p.entry_status, p.author_member_id,
                              p.challenge_id, p.post_type,
                              (SELECT ph.mime FROM community_entry_photos ph
                                WHERE ph.post_id = p.id) AS media_mime,
                              c.points
                         FROM community_feed_posts p
                         LEFT JOIN community_challenges c
                                ON c.id = p.challenge_id
                        WHERE p.id = %s FOR UPDATE OF p""", (pid,))
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404,
                                        detail="Entry not found")
                if row["entry_status"] != "pending":
                    raise HTTPException(
                        status_code=409,
                        detail=f"Entry already {row['entry_status']}")
                awarded = False
                if action == "publish":
                    cur.execute(
                        """UPDATE community_feed_posts
                              SET status = 'approved',
                                  entry_status = 'published',
                                  published_at = now()
                            WHERE id = %s""", (pid,))
                    # Points land HERE — on publication, never submission.
                    # kind is per-entry so the award is idempotent forever.
                    # Typed award: challenge entries pay the challenge's
                    # points; community looks pay by media (video > photo);
                    # questions are conversation, never paid (and the UI
                    # never mentions points around them).
                    pts, kind = 0, None
                    if row["challenge_id"]:
                        pts = int(row["points"] or 0)
                        kind = f"challenge_entry_{pid}"
                    elif (row["post_type"] or "look") != "question":
                        mime = row["media_mime"] or ""
                        pts = (POST_VIDEO_PTS if mime.startswith("video/")
                               else POST_PHOTO_PTS if mime else 0)
                        kind = f"post_{pid}"
                    if row["author_member_id"] and kind and pts > 0:
                        cur.execute(
                            """INSERT INTO community_points_events
                                   (member_id, kind, points)
                               VALUES (%s, %s, %s)
                               ON CONFLICT (member_id, kind) DO NOTHING
                               RETURNING id""",
                            (row["author_member_id"], kind, pts))
                        awarded = cur.fetchone() is not None
                        _me_cache.pop(row["author_member_id"], None)
                else:
                    cur.execute(
                        """UPDATE community_feed_posts
                              SET status = 'rejected',
                                  entry_status = 'rejected'
                            WHERE id = %s""", (pid,))
            conn.commit()
        return {"ok": True, "action": action, "points_awarded": awarded}

    @app.post("/api/crm/community-entries/{pid}/winner")
    def crm_community_entry_winner(pid: int, request: Request,
                                   payload: dict = Body(...)):
        _ensure_tables()
        pos = (payload or {}).get("position")
        if pos is not None:
            try:
                pos = int(pos)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400,
                                    detail="position must be 1-3 or null")
            if pos not in (1, 2, 3):
                raise HTTPException(status_code=400,
                                    detail="position must be 1-3 or null")
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """SELECT p.id, p.challenge_id, p.entry_status,
                              p.author_member_id,
                              (c.deadline <= now()) AS closed
                         FROM community_feed_posts p
                         JOIN community_challenges c ON c.id = p.challenge_id
                        WHERE p.id = %s FOR UPDATE OF p""", (pid,))
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404,
                                        detail="Entry not found")
                if row["entry_status"] != "published":
                    raise HTTPException(status_code=400,
                                        detail="Only published entries can win")
                if not bool(row["closed"]):
                    raise HTTPException(
                        status_code=400,
                        detail="Winners are picked after the challenge closes")
                displaced = []
                if pos is not None:
                    cur.execute(
                        """UPDATE community_feed_posts
                              SET winner_position = NULL
                            WHERE challenge_id = %s AND winner_position = %s
                              AND id <> %s
                            RETURNING id, author_member_id""",
                        (row["challenge_id"], pos, pid))
                    displaced = cur.fetchall()
                cur.execute(
                    """UPDATE community_feed_posts SET winner_position = %s
                        WHERE id = %s""", (pos, pid))
                # Winner bonus reconciles with the ribbon: +200 lands when a
                # position is set (idempotent — kind is entry-scoped and
                # UNIQUE per member), and is removed when the position is
                # cleared or the entry is displaced by a re-pick.
                touched = set()
                if pos is not None and row["author_member_id"]:
                    cur.execute(
                        """INSERT INTO community_points_events
                               (member_id, kind, points)
                           VALUES (%s, %s, %s)
                           ON CONFLICT (member_id, kind) DO NOTHING""",
                        (row["author_member_id"],
                         f"challenge_winner_{pid}",
                         CHALLENGE_WINNER_BONUS_PTS))
                    touched.add(row["author_member_id"])
                clear_ids = [d["id"] for d in displaced]
                if pos is None:
                    clear_ids.append(pid)
                if clear_ids:
                    cur.execute(
                        """DELETE FROM community_points_events
                            WHERE kind = ANY(%s)
                            RETURNING member_id""",
                        ([f"challenge_winner_{i}" for i in clear_ids],))
                    touched.update(r["member_id"] for r in cur.fetchall())
            conn.commit()
        for mid_ in touched:
            _me_cache.pop(mid_, None)
        return {"ok": True, "position": pos,
                "winner_bonus": CHALLENGE_WINNER_BONUS_PTS}

    @app.get("/api/crm/community-survey/summary")
    def crm_community_survey_summary(request: Request, wave_id: int = 0):
        """Aggregate-only survey results for staff: counts per option, NPS
        (%promoters − %detractors), tier split, anonymous comments.
        Individual member rows are deliberately never exposed here."""
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""SELECT w.id, w.wave_key, w.title, w.status, w.created_at,
                                      COUNT(r.id) AS responses
                                 FROM community_survey_waves w
                                 LEFT JOIN community_survey_responses r ON r.wave_id = w.id
                             GROUP BY w.id
                             ORDER BY w.id DESC""")
                waves = [dict(r) for r in cur.fetchall()]
                if not waves:
                    return {"waves": [], "wave": None, "n": 0, "questions": [],
                            "nps": None, "by_tier": [], "median_duration_secs": None}
                sel = next((x for x in waves if x["id"] == wave_id), waves[0])
                cur.execute("SELECT questions FROM community_survey_waves WHERE id = %s",
                            (sel["id"],))
                questions = (cur.fetchone() or {}).get("questions") or []
                cur.execute("""SELECT answers, nps, tier_at, duration_secs
                                 FROM community_survey_responses
                                WHERE wave_id = %s""", (sel["id"],))
                rows = cur.fetchall()
        n = len(rows)
        qs = []
        for q in questions:
            entries = [q]
            f = q.get("followup")
            if f:
                entries.append({"id": f.get("id"), "kind": "single",
                                "title": f.get("title"), "options": f.get("options")})
            for e in entries:
                qid, kind = e.get("id"), e.get("kind")
                if kind in ("single", "multi"):
                    counts = {o: 0 for o in (e.get("options") or [])}
                    answered = 0
                    for r in rows:
                        v = (r.get("answers") or {}).get(qid)
                        if v is None:
                            continue
                        answered += 1
                        for x in (v if isinstance(v, list) else [v]):
                            if x in counts:
                                counts[x] += 1
                    qs.append({"id": qid, "title": e.get("title"), "kind": kind,
                               "answered": answered,
                               "options": [{"label": o, "n": c,
                                            "pct": round(100.0 * c / answered, 1) if answered else 0.0}
                                           for o, c in counts.items()]})
                elif kind == "nps":
                    vals = [r["nps"] for r in rows if r.get("nps") is not None]
                    qs.append({"id": qid, "title": e.get("title"), "kind": "nps",
                               "answered": len(vals),
                               "options": [{"label": str(i),
                                            "n": sum(1 for v in vals if v == i),
                                            "pct": round(100.0 * sum(1 for v in vals if v == i) / len(vals), 1) if vals else 0.0}
                                           for i in range(11)]})
                elif kind == "text":
                    comments = [c for c in
                                ((r.get("answers") or {}).get(qid) for r in rows) if c]
                    qs.append({"id": qid, "title": e.get("title"), "kind": "text",
                               "answered": len(comments),
                               "comments": comments[-50:][::-1]})
        vals = [r["nps"] for r in rows if r.get("nps") is not None]
        nps = None
        if vals:
            promoters = sum(1 for v in vals if v >= 9)
            detractors = sum(1 for v in vals if v <= 6)
            nps = {"score": int(round(100.0 * (promoters - detractors) / len(vals))),
                   "promoters": promoters,
                   "passives": len(vals) - promoters - detractors,
                   "detractors": detractors,
                   "avg": round(sum(vals) / float(len(vals)), 1),
                   "n": len(vals)}
        tiers = {}
        for r in rows:
            t = r.get("tier_at") or "—"
            b = tiers.setdefault(t, {"tier": t, "n": 0, "vals": []})
            b["n"] += 1
            if r.get("nps") is not None:
                b["vals"].append(r["nps"])
        by_tier = []
        for t in ("Tsavorite", "Ruby", "Tanzanite", "—"):
            b = tiers.get(t)
            if not b:
                continue
            tv = b.pop("vals")
            b["nps"] = (int(round(100.0 * (sum(1 for v in tv if v >= 9) - sum(1 for v in tv if v <= 6)) / len(tv)))
                        if tv else None)
            by_tier.append(b)
        durations = sorted(r["duration_secs"] for r in rows if r.get("duration_secs") is not None)
        return {"waves": waves, "wave": sel, "n": n, "questions": qs, "nps": nps,
                "by_tier": by_tier,
                "median_duration_secs": durations[len(durations) // 2] if durations else None}

    @app.get("/api/crm/community-contact")
    def crm_community_contact_list(request: Request, status: str = "all", limit: int = 200):
        _ensure_tables()
        lim = max(1, min(int(limit or 200), 1000))
        where, params = "", []
        if status and status != "all":
            if status not in CONTACT_STATUSES:
                raise HTTPException(status_code=400, detail="Unknown status filter")
            where, params = "WHERE c.status = %s", [status]
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    f"""SELECT c.id, c.subject, c.message, c.status, c.staff_note,
                               c.handled_by, c.created_at, c.updated_at,
                               (c.photo IS NOT NULL) AS has_photo,
                               m.username, m.full_name, m.phone, m.email
                          FROM community_contact_messages c
                          JOIN community_members m ON m.id = c.member_id
                          {where}
                         ORDER BY c.created_at DESC
                         LIMIT %s""",
                    params + [lim])
                items = [dict(r) for r in cur.fetchall()]
                cur.execute("""SELECT status, COUNT(*) AS n
                                 FROM community_contact_messages GROUP BY status""")
                counts = {r["status"]: r["n"] for r in cur.fetchall()}
        for r in items:
            r["subject_label"] = CONTACT_SUBJECTS.get(r["subject"], r["subject"])
        return {"items": items, "counts": counts}

    @app.get("/api/crm/community-contact/{msg_id}/photo")
    def crm_community_contact_photo(msg_id: int, request: Request):
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""SELECT photo, photo_mime FROM community_contact_messages
                                WHERE id = %s""", (msg_id,))
                row = cur.fetchone()
        if not row or not row.get("photo"):
            raise HTTPException(status_code=404, detail="No photo on this message")
        return Response(content=bytes(row["photo"]),
                        media_type=row.get("photo_mime") or "image/jpeg")

    @app.patch("/api/crm/community-contact/{msg_id}")
    def crm_community_contact_update(msg_id: int, request: Request,
                                     payload: dict = Body(...)):
        _ensure_tables()
        sets, params = [], []
        if "status" in payload:
            st = str(payload.get("status") or "").strip()
            if st not in CONTACT_STATUSES:
                raise HTTPException(status_code=400,
                                    detail="status must be new, in_progress or resolved")
            sets.append("status = %s"); params.append(st)
        if "staff_note" in payload:
            note = str(payload.get("staff_note") or "").strip()[:2000]
            sets.append("staff_note = %s"); params.append(note or None)
        if not sets:
            raise HTTPException(status_code=400, detail="Nothing to update")
        u = getattr(request.state, "user", None) or {}
        sets.append("handled_by = COALESCE(%s, handled_by)")
        params.append(u.get("email") or u.get("username"))
        sets.append("updated_at = now()")
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    f"""UPDATE community_contact_messages
                           SET {', '.join(sets)}
                         WHERE id = %s
                     RETURNING id, status, staff_note, handled_by""",
                    params + [msg_id])
                row = cur.fetchone()
            conn.commit()
        if not row:
            raise HTTPException(status_code=404, detail="Message not found")
        return {"ok": True, **dict(row)}

    # ---------------- Virtual Try-On ----------------
    # Member photos are private by default; generated looks are private until
    # the member explicitly shares one to the community strip. All endpoints
    # are member-token gated; images are served through owner checks (the
    # client fetches them with the Bearer header into blob URLs — a plain
    # <img src> would arrive without credentials).

    @app.post("/api/community/tryon/photos")
    def community_tryon_photo_upload(request: Request, payload: dict = Body(...)):
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                _throttle(request, "typh",
                          [("ip", 20, 3600), ("phone", 12, 3600), ("global", 800, 3600)],
                          phone=m.get("phone"))
                raw, mime = _decode_design(payload.get("photo_b64"), noun="photo")
                # Serialize the cap check + insert per member: without the row
                # lock, concurrent uploads can all observe n < cap and overshoot
                # the 12-photo limit. Same pattern as look creation (row locks,
                # not advisory locks — those no-op through the txn pooler).
                cur.execute("SELECT id FROM community_members WHERE id = %s FOR UPDATE",
                            (m["id"],))
                cur.execute("SELECT COUNT(*) AS n FROM community_tryon_photos WHERE member_id = %s",
                            (m["id"],))
                if int(cur.fetchone()["n"]) >= TRYON_PHOTO_CAP:
                    raise HTTPException(
                        status_code=400,
                        detail=f"You can keep up to {TRYON_PHOTO_CAP} photos — delete one you no longer use first")
                cur.execute(
                    """INSERT INTO community_tryon_photos (member_id, image, mime)
                       VALUES (%s, %s, %s) RETURNING id, created_at""",
                    (m["id"], raw, mime))
                row = cur.fetchone()
            conn.commit()
        return {"ok": True, **dict(row)}

    @app.get("/api/community/tryon/photos")
    def community_tryon_photos(request: Request):
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute(
                    """SELECT id, mime, created_at FROM community_tryon_photos
                        WHERE member_id = %s ORDER BY created_at DESC""",
                    (m["id"],))
                items = [dict(r) for r in cur.fetchall()]
        return {"items": items, "cap": TRYON_PHOTO_CAP}

    @app.get("/api/community/tryon/photos/{photo_id}/image")
    def community_tryon_photo_image(photo_id: int, request: Request):
        _ensure_tables()
        _throttle(request, "tyimg", [("ip", 300, 60)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute(
                    """SELECT image, mime FROM community_tryon_photos
                        WHERE id = %s AND member_id = %s""",
                    (photo_id, m["id"]))
                row = cur.fetchone()
        if not row or not row.get("image"):
            raise HTTPException(status_code=404, detail="Photo not found")
        return Response(content=bytes(row["image"]),
                        media_type=row.get("mime") or "image/jpeg",
                        headers={"Cache-Control": "private, max-age=300"})

    @app.delete("/api/community/tryon/photos/{photo_id}")
    def community_tryon_photo_delete(photo_id: int, request: Request):
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute("DELETE FROM community_tryon_photos WHERE id = %s AND member_id = %s",
                            (photo_id, m["id"]))
                gone = cur.rowcount
            conn.commit()
        if not gone:
            raise HTTPException(status_code=404, detail="Photo not found")
        return {"ok": True}

    @app.get("/api/community/tryon/allowance")
    def community_tryon_allowance_route(request: Request):
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                _tryon_heal_stale(cur, m["id"])
                tier, limit, used = _tryon_allowance(cur, m)
            conn.commit()
        return {"tier": tier, "limit": limit, "used": used,
                "remaining": (None if limit is None else max(0, limit - used)),
                "unlimited": limit is None,
                "locked": limit == 0,
                # Full per-tier ladder (TIER_LADDER order) so app copy always
                # mirrors TRYON_WEEK_LIMITS — no rebuild when the split changes.
                "ladder": [{"tier": t, "limit": TRYON_WEEK_LIMITS.get(t)}
                           for t, _ in TIER_LADDER],
                "demo": TRYON_FORCE_DEMO or not (
                    os.environ.get("AI_INTEGRATIONS_GEMINI_BASE_URL")
                    and os.environ.get("AI_INTEGRATIONS_GEMINI_API_KEY"))}

    @app.post("/api/community/tryon/looks")
    def community_tryon_create(request: Request, payload: dict = Body(...)):
        _ensure_tables()
        new_id = remaining = None
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                _throttle(request, "tygn",
                          [("ip", 30, 3600), ("phone", 20, 3600), ("global", 1200, 3600)],
                          phone=m.get("phone"))
                try:
                    photo_id = int(payload.get("photo_id") or 0)
                except Exception:
                    photo_id = 0
                sku = str(payload.get("sku") or "").strip()[:80]
                if not photo_id or not sku:
                    raise HTTPException(status_code=400, detail="Pick a photo and a piece first")
                cur.execute("SELECT id FROM community_tryon_photos WHERE id = %s AND member_id = %s",
                            (photo_id, m["id"]))
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Photo not found")
                cur.execute("SELECT style_name FROM all_products_clean WHERE sku = %s LIMIT 1",
                            (sku,))
                prod = cur.fetchone()
                if not prod:
                    raise HTTPException(status_code=404, detail="That piece isn't in the collection")
                if _product_image_bytes(cur, sku) is None:
                    raise HTTPException(
                        status_code=400,
                        detail="This piece doesn't have a photo we can style from yet — try another")
                # Serialize per member (row lock survives the txn pooler),
                # then check pending + weekly allowance atomically.
                cur.execute("SELECT id FROM community_members WHERE id = %s FOR UPDATE", (m["id"],))
                _tryon_heal_stale(cur, m["id"])
                cur.execute(
                    """SELECT COUNT(*) AS n FROM community_tryon_looks
                        WHERE member_id = %s AND status = 'pending'""", (m["id"],))
                if int(cur.fetchone()["n"]) > 0:
                    raise HTTPException(status_code=409,
                                        detail="One look is already being styled — give it a moment")
                tier, limit, used = _tryon_allowance(cur, m)
                if limit == 0:
                    raise HTTPException(
                        status_code=403,
                        detail="Virtual try-on unlocks at a higher Johari tier — keep earning to get there")
                if limit is not None and used >= limit:
                    raise HTTPException(
                        status_code=403,
                        detail=f"You've used all {limit} try-ons this week — your allowance resets on Monday")
                cur.execute(
                    """INSERT INTO community_tryon_looks (member_id, photo_id, product_sku, product_name)
                       VALUES (%s, %s, %s, %s) RETURNING id""",
                    (m["id"], photo_id, sku, prod["style_name"] or sku))
                new_id = cur.fetchone()["id"]
                remaining = None if limit is None else max(0, limit - used - 1)
            conn.commit()
        threading.Thread(target=_tryon_worker, args=(new_id,), daemon=True).start()
        return {"ok": True, "id": new_id, "status": "pending", "remaining": remaining}

    @app.get("/api/community/tryon/looks")
    def community_tryon_looks_route(request: Request):
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                _tryon_heal_stale(cur, m["id"])
                cur.execute(
                    """SELECT id, photo_id, product_sku, product_name, status, error,
                              demo, is_shared, created_at
                         FROM community_tryon_looks
                        WHERE member_id = %s
                        ORDER BY created_at DESC LIMIT 60""",
                    (m["id"],))
                items = [dict(r) for r in cur.fetchall()]
            conn.commit()
        return {"items": items}

    @app.get("/api/community/tryon/looks/{look_id}")
    def community_tryon_look_route(look_id: int, request: Request):
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                _tryon_heal_stale(cur, m["id"])
                cur.execute(
                    """SELECT id, photo_id, product_sku, product_name, status, error,
                              demo, is_shared, created_at
                         FROM community_tryon_looks
                        WHERE id = %s AND member_id = %s""",
                    (look_id, m["id"]))
                row = cur.fetchone()
            conn.commit()
        if not row:
            raise HTTPException(status_code=404, detail="Look not found")
        return dict(row)

    @app.get("/api/community/tryon/looks/{look_id}/image")
    def community_tryon_look_image(look_id: int, request: Request):
        _ensure_tables()
        _throttle(request, "tyimg", [("ip", 300, 60)])
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute(
                    """SELECT result, result_mime FROM community_tryon_looks
                        WHERE id = %s AND status = 'done'
                          AND (member_id = %s OR is_shared)""",
                    (look_id, m["id"]))
                row = cur.fetchone()
        if not row or not row.get("result"):
            raise HTTPException(status_code=404, detail="No image for this look")
        return Response(content=bytes(row["result"]),
                        media_type=row.get("result_mime") or "image/png",
                        headers={"Cache-Control": "private, max-age=300"})

    @app.delete("/api/community/tryon/looks/{look_id}")
    def community_tryon_look_delete(look_id: int, request: Request):
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute("DELETE FROM community_tryon_looks WHERE id = %s AND member_id = %s",
                            (look_id, m["id"]))
                gone = cur.rowcount
                if gone:
                    _withdraw_content_consent(cur, m["id"], "tryon_look", look_id)
            conn.commit()
        if not gone:
            raise HTTPException(status_code=404, detail="Look not found")
        return {"ok": True}

    @app.post("/api/community/tryon/looks/{look_id}/share")
    def community_tryon_share(look_id: int, request: Request, payload: dict = Body(...)):
        _ensure_tables()
        share = bool(payload.get("share"))
        marketing = payload.get("marketing_ok")  # optional; recorded only when the box was shown
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute(
                    """UPDATE community_tryon_looks
                          SET is_shared = %s,
                              shared_at = CASE WHEN %s THEN now() ELSE NULL END,
                              updated_at = now()
                        WHERE id = %s AND member_id = %s AND status = 'done'
                    RETURNING id, is_shared""",
                    (share, share, look_id, m["id"]))
                row = cur.fetchone()
                if row and isinstance(marketing, bool):
                    _set_content_consent(cur, m["id"], "tryon_look", look_id, marketing)
            conn.commit()
        if not row:
            raise HTTPException(status_code=404, detail="Only finished looks can be shared")
        return {"ok": True, "is_shared": row["is_shared"]}

    @app.get("/api/community/tryon/shared")
    def community_tryon_shared(request: Request):
        """Community strip: looks members have EXPLICITLY shared. Public
        identity only (username) — never real names or private photos."""
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                _require_member(cur, request)
                cur.execute(
                    """SELECT l.id, l.product_sku, l.product_name, l.demo,
                              l.shared_at, mb.username
                         FROM community_tryon_looks l
                         JOIN community_members mb ON mb.id = l.member_id
                        WHERE l.is_shared AND l.status = 'done'
                        ORDER BY l.shared_at DESC LIMIT 12""")
                items = [dict(r) for r in cur.fetchall()]
        return {"items": items}


    # ------------------------------------------------------------------ #
    # My data (Kenya DPA): one place to see, delete, and control the      #
    # marketing consent on everything a member has uploaded.              #
    # ------------------------------------------------------------------ #

    # A design can be removed once its order no longer needs it. Unknown /
    # future ACTIVE statuses stay protected by default (fail-safe).
    _DESIGN_RELEASED = ("cancelled", "rejected", "fulfilled", "collected",
                        "delivered", "done", "completed", "closed")
    _CONSENTABLE = ("tryon_look", "design")
    _REQUEST_KINDS = ("download", "delete_account")

    @app.get("/api/community/mydata")
    def community_mydata(request: Request):
        """Everything she has uploaded, grouped by type, with per-item
        marketing-consent state and any open data requests."""
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                mid = m["id"]
                cur.execute(
                    """SELECT id, created_at FROM community_tryon_photos
                        WHERE member_id = %s ORDER BY created_at DESC""", (mid,))
                photos = [dict(r) for r in cur.fetchall()]
                cur.execute(
                    """SELECT l.id, l.product_sku, l.product_name, l.status,
                              l.is_shared, l.demo, l.created_at,
                              COALESCE(c.marketing_ok, FALSE) AS marketing_ok
                         FROM community_tryon_looks l
                         LEFT JOIN community_content_consents c
                                ON c.member_id = l.member_id
                               AND c.content_type = 'tryon_look'
                               AND c.content_id = l.id
                        WHERE l.member_id = %s
                        ORDER BY l.created_at DESC""", (mid,))
                looks = [dict(r) for r in cur.fetchall()]
                cur.execute(
                    """SELECT r.id, r.sku, r.size, r.colour, r.embroidery_type,
                              r.monogram_text, r.status, r.created_at,
                              (r.design_image IS NOT NULL) AS has_design,
                              (r.status IN %s) AS design_deletable,
                              COALESCE(c.marketing_ok, FALSE) AS marketing_ok
                         FROM community_redemptions r
                         LEFT JOIN community_content_consents c
                                ON c.member_id = r.member_id
                               AND c.content_type = 'design'
                               AND c.content_id = r.id
                        WHERE r.member_id = %s
                        ORDER BY r.created_at DESC""", (_DESIGN_RELEASED, mid))
                designs = [dict(r) for r in cur.fetchall()]
                cur.execute(
                    """SELECT id, subject, status, (photo IS NOT NULL) AS has_photo,
                              created_at
                         FROM community_contact_messages
                        WHERE member_id = %s
                        ORDER BY created_at DESC LIMIT 50""", (mid,))
                messages = [dict(r) for r in cur.fetchall()]
                cur.execute(
                    """SELECT completed_at, shared_at FROM community_style_quiz
                        WHERE member_id = %s""", (mid,))
                quiz = cur.fetchone()
                cur.execute(
                    """SELECT r.answers, r.nps, r.duration_secs, r.completed_at,
                              w.wave_key, w.title
                         FROM community_survey_responses r
                         JOIN community_survey_waves w ON w.id = r.wave_id
                        WHERE r.member_id = %s
                        ORDER BY r.completed_at DESC""", (mid,))
                surveys = [dict(r) for r in cur.fetchall()]
                cur.execute(
                    """SELECT tenure, discovery, shop_frequency, feedback, completed_at
                         FROM community_journey_profile WHERE member_id = %s""", (mid,))
                journey = cur.fetchone()
                cur.execute(
                    """SELECT c.id, c.body, c.created_at, a.title, a.slug
                         FROM community_article_comments c
                         JOIN community_articles a ON a.id = c.article_id
                        WHERE c.member_id = %s AND c.status = 'visible'
                        ORDER BY c.created_at DESC""", (mid,))
                article_comments = [dict(r) for r in cur.fetchall()]
                cur.execute(
                    """SELECT id, kind, status, created_at
                         FROM community_data_requests
                        WHERE member_id = %s
                        ORDER BY created_at DESC LIMIT 10""", (mid,))
                reqs = [dict(r) for r in cur.fetchall()]
        return {
            "tryon_photos": photos,
            "tryon_looks": looks,
            "designs": designs,
            "messages": messages,
            "style_quiz": dict(quiz) if quiz else None,
            "surveys": surveys,
            "journey": dict(journey) if journey else None,
            "article_comments": article_comments,
            "requests": reqs,
        }

    @app.post("/api/community/mydata/consent")
    def community_mydata_consent(request: Request, payload: dict = Body(...)):
        """Grant or withdraw the per-item marketing consent. Withdrawal is
        forward-only: Vivo stops NEW marketing use of the item."""
        _ensure_tables()
        ctype = payload.get("content_type")
        try:
            cid = int(payload.get("content_id"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Bad content reference")
        ok = payload.get("marketing_ok")
        if ctype not in _CONSENTABLE or not isinstance(ok, bool):
            raise HTTPException(status_code=400, detail="Bad consent payload")
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                _throttle(request, "mdcs", [("ip", 60, 3600)], phone=m.get("phone"))
                if ctype == "tryon_look":
                    cur.execute("SELECT 1 FROM community_tryon_looks WHERE id = %s AND member_id = %s",
                                (cid, m["id"]))
                else:
                    cur.execute("""SELECT 1 FROM community_redemptions
                                    WHERE id = %s AND member_id = %s AND design_image IS NOT NULL""",
                                (cid, m["id"]))
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="That item isn't yours or no longer exists")
                _set_content_consent(cur, m["id"], ctype, cid, ok)
            conn.commit()
        return {"ok": True, "content_type": ctype, "content_id": cid, "marketing_ok": ok}

    @app.post("/api/community/mydata/requests")
    def community_mydata_request(request: Request, payload: dict = Body(...)):
        """Log a download-my-data or delete-my-account request and drop it
        into the staff contact queue so the CX team sees it where they
        already work. Simple request-logged flow by design."""
        _ensure_tables()
        kind = payload.get("kind")
        if kind not in _REQUEST_KINDS:
            raise HTTPException(status_code=400, detail="Unknown request type")
        note = (payload.get("note") or "").strip()[:500]
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                _throttle(request, "mdrq",
                          [("ip", 10, 3600), ("phone", 6, 3600)], phone=m.get("phone"))
                cur.execute(
                    """SELECT 1 FROM community_data_requests
                        WHERE member_id = %s AND kind = %s
                          AND status IN ('open', 'in_progress')""",
                    (m["id"], kind))
                if cur.fetchone():
                    raise HTTPException(
                        status_code=409,
                        detail="This request is already with our team — we'll be in touch soon")
                try:
                    cur.execute(
                        """INSERT INTO community_data_requests (member_id, kind, note)
                           VALUES (%s, %s, %s) RETURNING id, created_at""",
                        (m["id"], kind, note or None))
                except psycopg2.errors.UniqueViolation:
                    conn.rollback()
                    raise HTTPException(
                        status_code=409,
                        detail="You already have an open request like this — we're on it.")
                row = cur.fetchone()
                who = m.get("username") or m.get("full_name") or "member"
                if kind == "download":
                    subject = "Data request — download my data"
                    asked = "asked for a copy of their personal data"
                else:
                    subject = "Data request — close account & delete my data"
                    asked = "asked to close their account and delete their personal data"
                body = (f"{who} ({m.get('phone')}) {asked} via Profile - My data.\n\n"
                        f"Member note: {note or '(none)'}\n\n"
                        "DPA handling: verify identity, action within the statutory "
                        "timeline, then mark this message resolved. "
                        f"Request ref #{row['id']}.")
                cur.execute(
                    """INSERT INTO community_contact_messages (member_id, subject, message)
                       VALUES (%s, %s, %s)""",
                    (m["id"], subject, body))
            conn.commit()
        return {"ok": True, "id": row["id"], "kind": kind,
                "status": "open", "created_at": row["created_at"]}

    @app.delete("/api/community/rewards/redemptions/{rid}/design")
    def community_redemption_design_delete(rid: int, request: Request):
        """Remove the uploaded design artwork once the order no longer needs
        it. The redemption record itself stays — order/points history is
        kept for the legal retention period."""
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute(
                    """SELECT status, (design_image IS NOT NULL) AS has_design
                         FROM community_redemptions
                        WHERE id = %s AND member_id = %s""", (rid, m["id"]))
                row = cur.fetchone()
                if not row or not row["has_design"]:
                    raise HTTPException(status_code=404, detail="No design to remove")
                if row["status"] not in _DESIGN_RELEASED:
                    raise HTTPException(
                        status_code=409,
                        detail="We're using this design to make your piece — you can remove it once the order is finished")
                cur.execute(
                    """UPDATE community_redemptions
                          SET design_image = NULL, design_mime = NULL, updated_at = now()
                        WHERE id = %s AND member_id = %s""", (rid, m["id"]))
                _withdraw_content_consent(cur, m["id"], "design", rid)
            conn.commit()
        return {"ok": True}

    @app.delete("/api/community/contact/{msg_id}/photo")
    def community_contact_photo_delete(msg_id: int, request: Request):
        """A member can pull her attachment back any time — the message text
        stays so the support thread still makes sense."""
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute(
                    """UPDATE community_contact_messages
                          SET photo = NULL, photo_mime = NULL, updated_at = now()
                        WHERE id = %s AND member_id = %s AND photo IS NOT NULL""",
                    (msg_id, m["id"]))
                gone = cur.rowcount
            conn.commit()
        if not gone:
            raise HTTPException(status_code=404, detail="No attachment to remove")
        return {"ok": True}

    @app.delete("/api/community/style-quiz")
    def community_style_quiz_delete(request: Request):
        """Delete quiz answers + style DNA. Points already earned stay put
        (UNIQUE(member_id, kind) also means a retake never re-awards)."""
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute("DELETE FROM community_style_quiz WHERE member_id = %s", (m["id"],))
                gone = cur.rowcount
            conn.commit()
        if not gone:
            raise HTTPException(status_code=404, detail="Nothing to delete")
        return {"ok": True}

    @app.delete("/api/community/survey/response")
    def community_survey_response_delete(request: Request):
        """DPA: delete her survey answers (every wave) AND her "About your
        Vivo journey" profile (the survey's successor on Style Preferences).
        Points already earned stay put — UNIQUE(member_id, kind) on the
        points ledger means a later retake never re-awards."""
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                cur.execute("DELETE FROM community_survey_responses WHERE member_id = %s",
                            (m["id"],))
                gone = cur.rowcount
                cur.execute("DELETE FROM community_journey_profile WHERE member_id = %s",
                            (m["id"],))
                gone += cur.rowcount
            conn.commit()
        if not gone:
            raise HTTPException(status_code=404, detail="Nothing to delete")
        return {"ok": True}

    log.info("community app routes registered")
