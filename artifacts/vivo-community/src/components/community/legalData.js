// ---------------------------------------------------------------------------
// Vivo Johari — help & legal content (single source of truth).
//
// LEGAL STATUS: DRAFT — PENDING LEGAL REVIEW.
// The Terms & Conditions and Privacy Policy below are structured drafts
// written for product review; counsel must approve them before public launch.
// This status is deliberately NOT shown to members — it is carried as a
// data-legal-status attribute on each page (visible to admins via inspect)
// and in these comments.
//
// Version lockstep: the terms version recorded against each member's consent
// at sign-up (community_members.consent_terms_version) comes from
// LEGAL_META.terms.version below. If the wording changes materially, bump it
// here AND in community_app.py (fallback constant in the signup handler).
// ---------------------------------------------------------------------------

export const LEGAL_META = {
  terms: {
    version: "0.9.7",
    effective: "14 August 2026",
    status: "draft-pending-legal-review",
  },
  privacy: {
    version: "0.9.2",
    effective: "14 August 2026",
    status: "draft-pending-legal-review",
  },
};

/* ------------------------------------------------------------------ */
/* FAQ — grouped, searchable. Answers must describe what the app       */
/* actually does today; celebrate, never oversell.                     */
/* ------------------------------------------------------------------ */

export const FAQ_SECTIONS = [
  {
    id: "earning",
    title: "Earning points",
    items: [
      {
        id: "earn-how",
        q: "How do I earn points?",
        a: "Shopping is the simplest way — give your phone number at the till and you earn 1 point for every KES 100 you spend. On top of that: share looks, write reviews, add fit notes, enter style challenges, complete weekly missions and refer friends.",
      },
      {
        id: "earn-survey",
        q: "What's \"About your Vivo journey\", and what do I get for it?",
        a: "At the bottom of Style Preferences you'll find four quick questions about you and Vivo — how long you've shopped with us, how you found us, how often you shop, and anything you wish we did differently. Answering the first three earns you 30 points instantly, once. It's completely optional, and your answers are private: we only ever read them anonymously and in aggregate, to decide what to make, stock and improve next. Find it via Rewards or Profile → Style Preferences.",
      },
      {
        id: "earn-published",
        q: "When do shared posts and reviews earn their points?",
        a: "The moment they're published — never on submission. Everything you share is reviewed by our team first, and your points land as soon as it goes live in the community: 50 points for a photo look, 100 for a video. You can watch pending entries in your Style Journal. (Questions you ask the community are just conversation — they're shared for answers, not points.)",
      },
      {
        id: "earn-declined",
        q: "My entry wasn't published — do I still get the points?",
        a: "Not that time — points only come with publishing. We'll let you know if something doesn't go live, and you're always welcome to tweak it and share it again.",
      },
      {
        id: "earn-limits",
        q: "Is there a limit to what I can earn?",
        a: "Weekly missions have their own caps (that's the 'up to' on each one), and we keep light fair-play limits so the community stays genuine. The Terms & Conditions have the detail.",
      },
    ],
  },
  {
    id: "tiers",
    title: "Tiers & perks",
    items: [
      {
        id: "tiers-how",
        q: "How do tiers work?",
        a: "Everyone starts at Tsavorite. Your lifetime points carry you up to Ruby at 500 and Tanzanite at 1,000 — the more you shop and share, the higher you climb. Jewel names on purpose: johari is Swahili for jewel, and every tier is a stone from East African soil.",
      },
      {
        id: "our-gems",
        q: "Why Tsavorite, Ruby and Tanzanite?",
        a: "Each tier is a gemstone from East African soil. Tsavorite is the vivid green garnet discovered in Kenya's Tsavo; Ruby is mined in East Africa's ruby heartlands; and Tanzanite is found only at the foot of Kilimanjaro — rarer than diamond. Your journey moves through the treasures of our own region.",
      },
      {
        id: "tiers-perks",
        q: "What do the tiers get me?",
        a: "Richer rewards as you rise — from money-off vouchers and free delivery up to styling sessions and members' events. The Rewards tab always shows what your points unlock today.",
      },
      {
        id: "tiers-visible",
        q: "Who can see my tier?",
        a: "Only you, unless you switch on 'Show my tier badge' in Profile, under Privacy. Your points balance is always private either way.",
      },
    ],
  },
  {
    id: "redeeming",
    title: "Redeeming rewards",
    items: [
      {
        id: "redeem-what",
        q: "What can I redeem my points for?",
        a: "The ladder runs from everyday value to insider access: a KES 500 voucher off your next order, free delivery, a basic alteration on one piece, a personal styling session, a personalised embroidered tank stitched in-house, invitations to members' events like styling evenings and first looks — and, at the very top, a professional photoshoot at Zetu Studios. Point costs rise as you climb, and the Rewards tab always shows the current set.",
      },
      {
        id: "redeem-alterations",
        q: "What does the alteration reward cover?",
        a: "One basic alteration on one Vivo piece per redemption — think hems, waists, straps and simple adjustments. Our tailors confirm what's possible on the day, and complex re-workings aren't included. Redeem at participating stores, starting with our new tailoring studio at The Junction Mall.",
      },
      {
        id: "redeem-tank",
        q: "How does the personalised embroidered tank work?",
        a: "Redeem it and you'll pick your size and colour of our ribbed Chela tank, then add your embroidery — upload your own design or choose a monogram in one of three lettering styles. Small, chest-placed artwork with simple shapes and a few colours stitches best, and the finished embroidery can vary slightly from what's on screen. Every design is reviewed before we stitch: if yours is too intricate or doesn't meet our design standards, we'll ask you to adjust it rather than cancel, and your points stay put. Stitching happens in-house and usually takes about two weeks — then collect at a Vivo store or have it delivered.",
      },
      {
        id: "redeem-zetu",
        q: "How does the Zetu Studios photoshoot work?",
        a: "It's the top of the Johari ladder — 3,000 points for a professional solo session at Zetu Studios. Redeem it in the Rewards tab and our team calls you within two working days to schedule a date that suits you. On the day you'll be styled in Vivo pieces and photographed by the studio team, and your favourite images are yours to keep and share. One session per redemption, at Zetu Studios.",
      },
    ],
  },
  {
    id: "events",
    title: "Members' events",
    items: [
      {
        id: "events-rsvp",
        q: "How do RSVPs work?",
        a: "Everything that's on lives under Community → Events. Tap \"I'll be there\" and your spot is saved — you'll see it in your profile, you can add it to your calendar, and you can cancel any time from the same card if plans change.",
      },
      {
        id: "events-gated",
        q: "Why can't I RSVP to some events?",
        a: "A few evenings are reserved for Tanzanite members and Members' Event Invitation holders — first looks at new collections, mostly. They're always visible on the calendar so you know what you're working towards: reach Tanzanite, or redeem the invitation from the rewards ladder, and the RSVP opens up.",
      },
      {
        id: "events-spots",
        q: "Are spots limited?",
        a: "Yes — our stores are cosy, so most gatherings have a guest list. When one is nearly full you'll see \"Limited spots\", and once it's full, RSVPs close. Cancelling frees your chair for another member, so do tell us if you can't make it.",
      },
    ],
  },
  {
    id: "expiry",
    title: "Points expiry",
    items: [
      {
        id: "expiry-rule",
        q: "Do my points expire?",
        a: "Points stay alive as long as you do something in a 12-month stretch — a purchase, a published share or a redemption all count. Go fully quiet for 12 months and your balance expires.",
      },
      {
        id: "expiry-warning",
        q: "Will I get a warning first?",
        a: "Yes. We'll remind you in the app — and by email if you've opted into updates — before anything expires, with plenty of time to keep your balance.",
      },
      {
        id: "expiry-keep",
        q: "What's the easiest way to keep my points?",
        a: "Stay part of the fun: one purchase, one published post or one redemption in any 12 months keeps your whole balance safe.",
      },
    ],
  },
  {
    id: "privacy",
    title: "Privacy & usernames",
    items: [
      {
        id: "privacy-see",
        q: "What can other members see about me?",
        a: "Your username, your published posts and entries, and — only if you've turned it on — your tier badge. That's it.",
      },
      {
        id: "privacy-hidden",
        q: "What stays private?",
        a: "Your real name, phone number, email, date of birth, points balance and purchase history. Only you (and Vivo) ever see those.",
      },
      {
        id: "privacy-leaderboard",
        q: "Can I stay out of community celebrations?",
        a: "Absolutely. Turn off 'Appear in community celebrations' in Profile, under Privacy — we'll never feature you as jewel of the week, in weekly celebrations or winner spotlights, and you'll still earn points for everything you do, just privately. And a quiet promise either way: there are no public leaderboards or point tallies here at all. Meet a Gem celebrates moments, never numbers.",
      },
      {
        id: "privacy-username",
        q: "Can I change my username?",
        a: "Any time, in Profile under Privacy. Everything you've shared switches to the new name, and your real name stays private throughout.",
      },
    ],
  },
  {
    id: "sharing",
    title: "Sharing content & challenges",
    items: [
      {
        id: "sharing-review",
        q: "What happens after I share a look or enter a challenge?",
        a: "Our team gives every share a quick look before it goes live — it's how we keep this space warm and genuine. Once it's published it appears in the community and your points land instantly.",
      },
      {
        id: "sharing-winners",
        q: "How are challenge winners chosen?",
        a: "Each challenge says so right on its page. Some are picked by our styling team; for others the community's votes shape a shortlist and our team chooses from it. Votes are never shown as public tallies and there are no scoreboards — winners are simply celebrated when the challenge closes, with a 200-point bonus and a ribbon on the winning look. One vote per member per challenge, and you can change yours any time while voting is open.",
      },
      {
        id: "sharing-featuring",
        q: "How does featuring work?",
        a: "Published looks we love may be featured inside the app — on the home feed or style boards, always under your username. Featuring outside the app is a separate choice you make per post — see the next answer.",
      },
      {
        id: "sharing-marketing",
        q: "Will Vivo use my photos in marketing?",
        a: "Only if you say so. When you share, there's an optional box — 'Vivo may feature this in Vivo's marketing' — and it's never pre-ticked. Leave it empty and your content lives only in the app; tick it and we may proudly feature you on our socials or website. You can switch it off per item anytime in Profile → My data, and we stop new marketing use from that moment.",
      },
      {
        id: "sharing-declined",
        q: "Why would an entry be declined?",
        a: "Usually something simple — it isn't your own photo, it promotes another brand, or it doesn't fit our Community Guidelines. It's never a punishment, and we'd love to see a reworked version.",
      },
    ],
  },
  {
    id: "shopping",
    title: "Shopping",
    items: [
      {
        id: "shopping-size",
        q: "How do I find my size?",
        a: "Every piece has a size guide, and many have fit notes from members with your kind of curves. If a size is sold out it shows as unavailable — no guesswork.",
      },
      {
        id: "shopping-fitnotes",
        q: "What are fit notes?",
        a: "Real members sharing how a piece fit them — honest, kind and hugely helpful. Published fit notes earn 15 points.",
      },
      {
        id: "shopping-checkout",
        q: "Can I check out inside the app?",
        a: "Today the app is your fitting room: browse the live collection, save pieces to your wishlist and build your bag. Buy in any Vivo store — give your phone number at the till so points land automatically — or online. In-app checkout is on its way.",
      },
      {
        id: "shopping-returns",
        q: "How do delivery and returns work?",
        a: "In-store purchases are handled by the store team — keep your receipt and they'll gladly help with exchanges. Online orders follow the delivery and returns policy of the online store you bought from. Questions? Ask any Vivo store or message us.",
      },
      {
        id: "shopping-badges",
        q: "What do 'Selling fast' and 'Best seller' mean?",
        a: "'Best seller' marks the pieces the community is loving most right now. 'Selling fast' means stock is moving quickly and sizes may thin out. Neither is a countdown — just a friendly heads-up.",
      },
    ],
  },
  {
    id: "account",
    title: "Account",
    items: [
      {
        id: "account-login",
        q: "How does signing in work?",
        a: "With your phone number — we text you a 6-digit code and you're in. No passwords to remember, ever.",
      },
      {
        id: "account-newphone",
        q: "I have a new phone number — what happens to my points?",
        a: "Your membership (and every point) can move with you. Get in touch — message us or ask in any Vivo store — and we'll switch your account to the new number safely.",
      },
      {
        id: "account-details",
        q: "How do I update my details?",
        a: "Your username and privacy choices live in Profile, under Privacy. To change your name, email or date of birth, message us and we'll update it for you.",
      },
      {
        id: "account-close",
        q: "How do I close my account?",
        a: "Head to Profile → My data and tap 'I'd like to close my account'. We'll confirm with you by SMS before anything is deleted. Your profile, content and points go; records of purchases and redemptions stay only as long as tax and consumer rules require (typically up to five years in Kenya), kept securely and no longer linked to a live profile.",
      },
      {
        id: "account-age",
        q: "Who can join Vivo Johari?",
        a: "Anyone 18 or over who loves what we're about. The full detail is in the Terms & Conditions.",
      },
      {
        id: "why-johari",
        q: "Why \u201cJohari\u201d?",
        a: "Johari is Swahili for jewel — and that's the whole idea. We shine together: the programme's tiers — Tsavorite, Ruby and Tanzanite — are gemstones from East African soil, named for the women they celebrate.",
      },
    ],
  },
  {
    id: "your-data",
    title: "Your data & privacy",
    items: [
      {
        id: "your-data-own",
        q: "Who owns what I upload?",
        a: "You do — always. Posts, photos, try-on looks, embroidery designs: publishing something in the community doesn't change that it's yours. Vivo only ever shows it inside the app, unless you've ticked the optional marketing box on that specific item.",
      },
      {
        id: "your-data-delete",
        q: "How do I delete something I've shared?",
        a: "Profile → My data lists everything in one place — delete any item there, or straight from where you see it in the app. Published content comes off community surfaces immediately. And the points you earned along the way stay yours: deleting content never takes them back.",
      },
      {
        id: "your-data-close",
        q: "What happens to my data if I close my account?",
        a: "Your profile, try-on photos and looks, quiz answers, points and tier are deleted. What the law makes us keep — records of purchases and redemptions — is stored securely for the statutory period (typically up to five years in Kenya), no longer linked to a live profile. Marketing consents you'd given aren't used for anything new from the moment your account closes.",
      },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Legal documents. Blocks: { t: "p", text } or { t: "ul", items }.    */
/* ------------------------------------------------------------------ */

export const TERMS_SECTIONS = [
  {
    id: "welcome",
    heading: "1. Welcome",
    blocks: [
      {
        t: "p",
        text: "These terms govern your membership of Vivo Johari, the member programme of Vivo Fashion Group (\u201cVivo\u201d, \u201cwe\u201d). By creating an account you agree to them — so please read them. They're short and human on purpose.",
      },
      {
        t: "p",
        text: "You must be 18 or older to join, and you may hold one account, registered to your own phone number. We may decline or close accounts that don't meet these requirements.",
      },
    ],
  },
  {
    id: "points",
    heading: "2. Points & rewards",
    blocks: [
      {
        t: "p",
        text: "Points are a thank-you, not a currency. They have no cash value, can't be transferred, sold or exchanged for money, and can only be redeemed for the rewards we make available from time to time.",
      },
      {
        t: "ul",
        items: [
          "Purchases earn points at the published rate when your phone number is attached to the sale.",
          "Shared content — reviews, fit notes, looks and challenge entries — earns points only once it has been reviewed and published in the app. Submission alone earns nothing.",
          "Some activities carry caps (for example weekly missions), and we apply fair-play limits. Points earned through gaming, fraud or abuse of the programme may be reversed.",
          "Challenge winners are selected by Vivo's team — for some challenges from a shortlist shaped by community votes — and winner bonuses land when winners are announced. Curation decisions are final; they're celebration, not judgement.",
          "Points expire after 12 months without any earning or redemption activity on your account. We will remind you before that happens.",
        ],
      },
      {
        t: "p",
        text: "Rewards are subject to availability and may change. Where a reward has its own conditions, we'll say so at redemption.",
      },
      {
        t: "p",
        text: "Alteration rewards cover one basic alteration — hems, waists, straps and similar simple adjustments — on one Vivo garment per redemption, carried out at participating stores. Complex re-workings, non-Vivo pieces and repeat alterations of the same garment aren't included.",
      },
      {
        t: "p",
        text: "Money-off vouchers and free-delivery rewards are single-use and apply to one order only; they have no cash value and can't be exchanged for money or combined with other vouchers. Members' event invitations are personal to you, non-transferable and subject to capacity.",
      },
      {
        t: "p",
        text: "Zetu Studios photoshoot: the session is personal to you and non-transferable, one session per redemption, scheduled with the studio after you redeem and subject to studio availability. The images are for your personal use — Vivo features them only with the same optional, per-item marketing consent as anything else you share.",
      },
      {
        t: "p",
        text: "Personalised embroidery: designs you upload must be yours to use — nothing offensive or unlawful, and no third-party logos, artwork or trademarks unless you hold the rights. By submitting a design you confirm you have those rights. We review every design before stitching and may ask you to adjust one that we can't embroider cleanly or that doesn't meet these standards; your points stay committed while you adjust. Finished embroidery can differ slightly from the on-screen preview, and the tank itself is subject to available stock.",
      },
    ],
  },
  {
    id: "content",
    heading: "3. Your content & our licence",
    blocks: [
      {
        t: "p",
        text: "Everything you share stays yours. So the community can work, you grant Vivo a non-exclusive, royalty-free, worldwide licence to host, display, crop and resize the content you share, within the Vivo Johari app and member experience, for as long as it remains published.",
      },
      {
        t: "p",
        text: "Use of your content outside the app — for example on Vivo's social media or website — happens only with your separate, optional marketing consent, given per item at the moment you upload or share it. It is never pre-selected, and you can withdraw it at any time in Profile → My data (or just ask us); withdrawal stops new use from that moment.",
      },
      {
        t: "ul",
        items: [
          "You confirm that content you share is your own and doesn't infringe anyone's rights.",
          "We review everything before it's published and may decline or remove content that doesn't fit our Community Guidelines.",
          "Declining or removing content is a curation decision, not a penalty — you're always welcome to share again.",
        ],
      },
    ],
  },
  {
    id: "changes",
    heading: "4. The programme can evolve",
    blocks: [
      {
        t: "p",
        text: "We may change the programme — including earning rates, tiers, rewards and these terms — or pause or end it. For material changes we'll give reasonable notice in the app, and the version and effective date at the top of this page always tell you what you've agreed to.",
      },
    ],
  },
  {
    id: "closure",
    heading: "5. Closing an account",
    blocks: [
      {
        t: "p",
        text: "You can leave at any time by asking us to close your account. We may suspend or close accounts for breach of these terms, fraud or abuse — where fair, we'll tell you why. Unredeemed points lapse when an account closes.",
      },
    ],
  },
  {
    id: "smallprint",
    heading: "6. The honest small print",
    blocks: [
      {
        t: "p",
        text: "We work hard to keep the app available and accurate, but it's provided \u201cas is\u201d — we can't promise it will always be perfect or uninterrupted. Nothing in these terms limits rights you have under Kenyan consumer law.",
      },
      {
        t: "p",
        text: "If any part of these terms turns out to be unenforceable, the rest still stands.",
      },
    ],
  },
  {
    id: "law",
    heading: "7. Governing law",
    blocks: [
      {
        t: "p",
        text: "These terms are governed by the laws of Kenya, and the courts of Kenya have jurisdiction over any dispute. Questions first, always — talk to us and we'll usually sort it out much faster.",
      },
    ],
  },
];

export const PRIVACY_SECTIONS = [
  {
    id: "collect",
    heading: "1. What we collect",
    blocks: [
      {
        t: "ul",
        items: [
          "Identity & contact — your phone number, full name, email address and date of birth, given at sign-up.",
          "Profile — your username, privacy choices, style preferences and preferred sizes.",
          "Survey answers — what you tell us in member surveys, like fit, occasions and shopping preferences.",
          "Content you upload — posts, challenge entries, reviews, fit notes, style boards, try-on photos and looks, embroidery designs, and photos you send our support team. Section 2 covers each type: what it's for, how long we keep it, and how you delete it.",
          "Shopping — purchases linked to your phone number at the till or online, so points can land automatically.",
          "Technical basics — device and usage information that keeps the app working and secure.",
        ],
      },
    ],
  },
  {
    id: "your-content",
    heading: "2. Your content — what it's for, and how long we keep it",
    blocks: [
      {
        t: "p",
        text: "Everything you upload is your personal data, and all of it is protected the same way under Kenya's Data Protection Act. Here's each type in plain words:",
      },
      {
        t: "ul",
        items: [
          "Community posts & challenge entries — shared to run the community and celebrate your style. Published under your username, and kept until you take them down.",
          "Reviews & fit notes — help other members find pieces that fit. Published under your username, kept until you remove them.",
          "Style board content — the styling you build and share in the app; yours to unpublish or delete anytime.",
          "Virtual Try-On photos — used only to create your try-on previews. Private, never published anywhere, and kept until you delete them.",
          "Try-on looks — the previews we create for you. Private by default; one appears in the community feed only when you choose to share it, and unsharing or deleting removes it from the feed immediately.",
          "Embroidery & monogram designs — used to make the personalised piece you ordered. They stay attached to your order record for as long as tax and consumer law require (typically up to five years in Kenya), and you can remove the artwork itself once your order is finished.",
          "Messages & photos you send our support team — used to resolve your query, and kept for up to 24 months after it's resolved. You can remove an attachment anytime; the message stays so the conversation still makes sense.",
          "Style quiz answers — used to personalise what you see. Kept until you retake the quiz or delete your answers.",
          "Survey answers — used to improve what we design, make and stock, and only ever reported as anonymous totals; no report links an answer to you. Kept until you delete them in Profile → My data.",
        ],
      },
      {
        t: "p",
        text: "Published content is still your data. You can delete it even after it's public — it comes off community surfaces immediately — and deleting content never takes back points you've already earned. Everything above lives in one place: Profile → My data.",
      },
      {
        t: "p",
        text: "Marketing is always a separate choice. Vivo reuses your content outside the app only with the optional consent you give on that specific item, at the moment you upload or share it — never a blanket permission, never pre-ticked. You can withdraw it per item in Profile → My data, and we stop new marketing use from that moment.",
      },
    ],
  },
  {
    id: "why",
    heading: "3. Why we use it",
    blocks: [
      {
        t: "ul",
        items: [
          "To run your membership: points, tiers, rewards, and reminders before points expire.",
          "To personalise your experience — like showing pieces and content that fit your style.",
          "To improve what we design, make and stock — survey answers are used in anonymous, aggregated form only.",
          "To operate the community: displaying your username on what you publish, never your real name.",
          "To feature your content in marketing outside the app — only with the separate optional consent you give on that specific item, which you can switch off anytime in Profile → My data.",
          "To meet legal obligations and keep the community safe.",
        ],
      },
    ],
  },
  {
    id: "sharing",
    heading: "4. Who sees it",
    blocks: [
      {
        t: "p",
        text: "Other members see only your username, your published content and (if you choose) your tier badge. We never sell your personal data. We share it only with service providers who help us run the programme — under contract, on our instructions — and where the law requires.",
      },
    ],
  },
  {
    id: "retention",
    heading: "5. How long we keep it",
    blocks: [
      {
        t: "p",
        text: "For as long as your membership is active, and afterwards only as long as the law requires — for example tax records on purchases. Section 2 has the per-type detail for content you upload. When you close your account we delete or anonymise your personal data within a reasonable period.",
      },
    ],
  },
  {
    id: "rights",
    heading: "6. Your rights",
    blocks: [
      {
        t: "p",
        text: "Under Kenya's Data Protection Act, 2019 you can:",
      },
      {
        t: "ul",
        items: [
          "Ask what personal data we hold about you, and get a copy.",
          "Ask us to correct anything inaccurate.",
          "Ask us to delete your data or close your account.",
          "Object to, or restrict, certain uses of your data.",
          "Withdraw any consent — including the per-item marketing consent on things you've shared — at any time, in Profile → My data or by asking us. Withdrawal doesn't affect use that happened before it.",
          "Complain to the Office of the Data Protection Commissioner (ODPC) if you're unhappy with our answer.",
        ],
      },
    ],
  },
  {
    id: "contact",
    heading: "7. Data queries",
    blocks: [
      {
        t: "p",
        text: "Write to privacy@vivofashiongroup.com, or ask in any Vivo store and they'll route it to the right team. We respond promptly, and always within the timelines the Act sets.",
      },
    ],
  },
  {
    id: "changes",
    heading: "8. Changes to this policy",
    blocks: [
      {
        t: "p",
        text: "When this policy changes we'll update the version and effective date above and, for material changes, tell you in the app.",
      },
    ],
  },
];

export const GUIDELINES_SECTIONS = [
  {
    id: "intro",
    heading: "",
    blocks: [
      {
        t: "p",
        text: "Vivo Johari is a warm corner of the internet where real women celebrate real style. These few guidelines keep it that way — and they're exactly what our team checks before any share goes live.",
      },
    ],
  },
  {
    id: "belongs",
    heading: "What belongs here",
    blocks: [
      {
        t: "ul",
        items: [
          "Your own photos and your own words — real looks on real days.",
          "Every body, every shade, every age: celebrate yours and cheer for others.",
          "Honest reviews and fit notes — kind and specific beats gushing and vague.",
          "Style tips, styling questions and encouragement.",
        ],
      },
    ],
  },
  {
    id: "declined",
    heading: "What we'll decline",
    blocks: [
      {
        t: "ul",
        items: [
          "Content that isn't yours, or that shows other people — including children — without their okay.",
          "Anything unkind: body-shaming, hate, harassment or bullying.",
          "Nudity or explicit content — keep it stylish.",
          "Spam, adverts or promotion for other brands.",
          "Personal details — yours or anyone else's — like phone numbers or addresses.",
        ],
      },
    ],
  },
  {
    id: "review",
    heading: "How review works",
    blocks: [
      {
        t: "p",
        text: "A human on our team looks at every share before it's published. If something doesn't go live we'll tell you, and it never counts against you — tweak it and share again. Points always arrive with publishing.",
      },
    ],
  },
];
