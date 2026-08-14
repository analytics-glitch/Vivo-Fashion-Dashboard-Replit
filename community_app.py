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
from datetime import date, datetime, timezone

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
COMMUNITY_TERMS_VERSION = "0.9.6"
COMMUNITY_TERMS_PUBLISHED = {"0.9", "0.9.1", "0.9.2", "0.9.3", "0.9.4", "0.9.5", "0.9.6"}
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
TRYON_WEEK_LIMITS = {"Tsavorite": 3, "Ruby": 5, "Tanzanite": 10}
TRYON_PHOTO_CAP = 12                 # stored photos per member
TRYON_MODEL = "gemini-2.5-flash-image"
TRYON_PENDING_STALE_SEC = 300        # pending older than this self-heals to failed
# Force demo composites even when the AI integration is configured (testing).
TRYON_FORCE_DEMO = os.environ.get("TRYON_DEMO_MODE", "").strip() == "1"
QUIZ_BONUS_PTS = 50            # one-time Style Quiz completion bonus (instant, no moderation)

# ---- Personalised embroidered tank reward ---------------------------------
# The first real, fulfillable redemption: Vivo's ribbed Chela tank finished
# with a member-supplied embroidered design, stitched in-house. Sits between
# the styling session (1,200) and members' event (2,000) rungs of the ladder.
# Tier is lifetime-based, so redeeming never demotes a member; spendable
# balance = lifetime earn − non-cancelled redemptions.
EMB_TANK_STYLE = "Vivo Chela Tank Top in Stretch Rib"
EMB_TANK_POINTS = 1600
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
            log.warning("community throttle hit: %s", key)
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
        CREATE UNIQUE INDEX IF NOT EXISTS community_members_username_uq
            ON community_members (LOWER(username)) WHERE username IS NOT NULL;
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
        """
        with _db() as conn:
            with conn.cursor() as cur:
                cur.execute(ddl)
            conn.commit()
            _tables_ready = True


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


def _earned_bonus_points(cur, member_id):
    """Extra lifetime points from community_points_events (quiz bonus etc.) —
    folded into BOTH lifetime formulas (/me and the event tier gates) so the
    two can never disagree."""
    cur.execute(
        "SELECT COALESCE(SUM(points),0) AS p FROM community_points_events WHERE member_id = %s",
        (member_id,),
    )
    return int((cur.fetchone() or {}).get("p") or 0)


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
                    """SELECT order_name,
                              MIN(sale_date::date) AS day,
                              SUM(COALESCE(total_sales_kes,0)
                                  - COALESCE(discounts_kes,0)
                                  - COALESCE(returns_kes,0))::float AS total_kes,
                              SUM(COALESCE(ordered_item_quantity,0))::int AS items
                       FROM all_sales
                       WHERE customer_id = %s AND store_id = %s
                         AND COALESCE(order_name,'') <> ''
                       GROUP BY order_name
                       ORDER BY MIN(sale_date::date) DESC
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
        log.warning("member email failed: %s", e)


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
    everything except failed attempts counts (pending blocks parallel spam)."""
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
                try:
                    cur.execute(
                        """INSERT INTO community_members
                               (phone, full_name, email, dob, consent_at,
                                customer_id, customer_store_id, last_login_at, username,
                                consent_terms_version)
                           VALUES (%s, %s, %s, %s, now(), %s, %s, now(), %s, %s)
                           ON CONFLICT (phone) DO NOTHING
                           RETURNING *""",
                        (
                            phone, full_name, email, dob,
                            (match or {}).get("customer_id"),
                            (match or {}).get("store_id"),
                            username,
                            terms_version,
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
                if not row:
                    return {"answers": {}, "dna": None, "completed": False, "shared": False}
                return {"answers": row["answers"] or {}, "dna": row["dna"],
                        "completed": bool(row["completed_at"]), "shared": bool(row["shared_at"])}

    @app.put("/api/community/style-quiz")
    def community_style_quiz_save(request: Request, payload: dict = Body(...)):
        """Save (or re-save) the quiz. First-ever completion awards the
        one-time bonus — enforced by UNIQUE(member_id, kind), so a retake or
        a double-tap can never award twice. Quiz points are instant (no
        moderation). A retake updates answers + DNA but keeps completed_at."""
        _ensure_tables()
        _throttle(request, "quizsave", [("ip", 20, 60)])
        answers = _quiz_clean_answers((payload or {}).get("answers"))
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

    @app.get("/api/community/products")
    def community_products(request: Request, category: str = "",
                           limit: int = 24, offset: int = 0,
                           personalize: str = ""):
        _ensure_tables()
        _throttle(request, "prod", [("ip", 120, 60)])
        limit = max(1, min(int(limit or 24), 48))
        offset = max(0, min(int(offset or 0), 960))
        category = (category or "").strip()[:60]
        # Optional Style-DNA re-ranking: only when asked for, and only when
        # the Bearer token resolves to a member with a completed quiz. Public
        # callers and quiz-skippers keep the curated default order — and only
        # that default order touches the shared response cache.
        quiz = None
        if str(personalize or "").strip() in ("1", "true", "yes"):
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
        key = (category, limit, offset)
        if quiz is None:
            cached = _products_cache.get(key)
            if cached and time.time() - cached[0] < _PRODUCTS_TTL:
                return _stamp_badges(cached[1])

        sql = """
        WITH inv AS (
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
        SELECT c.style_name, c.color, c.sku, c.category, c.subcategory,
               c.price, c.launch, s.soh::int AS soh
        FROM cards c
        JOIN stock s ON s.style_name = c.style_name AND s.color = c.color
        WHERE s.soh > 0
          AND (%(cat)s = '' OR c.category = %(cat)s)
        ORDER BY c.launch DESC NULLS LAST, c.style_name, c.color
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
                cur.execute(sql, {"cat": category, "lim": limit + 1, "off": offset})
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
        resp = {"items": items, "categories": cats, "has_more": has_more,
                "limit": limit, "offset": offset, "personalized": quiz is not None}
        if quiz is None:
            _cache_put(_products_cache, key, resp)
        # Badges are overlaid at response time so this cached payload never
        # freezes a cold (empty) badge map.
        return _stamp_badges(resp)

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
                              NULLIF(TRIM(COALESCE(gsm,'')),'') AS gsm
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
        return _stamp_pdp_badge(resp)

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

    # Staff review lives OUTSIDE the /api/community/ member-token bypass, under
    # /api/crm/ on purpose: the global staff-session gate AND the CRM role gate
    # (customer_service / marketing / leadership / smt / admin) both run before
    # these handlers do.

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
                "remaining": max(0, limit - used),
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
                if used >= limit:
                    raise HTTPException(
                        status_code=403,
                        detail=f"You've used all {limit} try-ons this week — your allowance resets on Monday")
                cur.execute(
                    """INSERT INTO community_tryon_looks (member_id, photo_id, product_sku, product_name)
                       VALUES (%s, %s, %s, %s) RETURNING id""",
                    (m["id"], photo_id, sku, prod["style_name"] or sku))
                new_id = cur.fetchone()["id"]
                remaining = max(0, limit - used - 1)
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

    log.info("community app routes registered")
