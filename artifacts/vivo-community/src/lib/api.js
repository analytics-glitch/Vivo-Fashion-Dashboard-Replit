// Thin client for the public Vivo Johari community API (/api/community/*).
// The API server is a sibling artifact mounted at /api — root-relative on
// purpose (same pattern as the other Vivo apps in this workspace).
const BASE = "/api/community";
const TOKEN_KEY = "vivo_community_token";

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
export function setToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode */ }
}

async function req(path, { method = "GET", body, auth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    const t = getToken();
    if (t) headers["Authorization"] = "Bearer " + t;
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && auth) {
    setToken("");
    if (onUnauthorized) onUnauthorized();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail;
    const msg = typeof detail === "string"
      ? detail
      : (detail && typeof detail.message === "string"
        ? detail.message
        : "Something went wrong — please try again");
    const err = new Error(msg);
    err.status = res.status;
    err.detail = detail && typeof detail === "object" ? detail : null;
    throw err;
  }
  return data;
}

// Shop grid query builder — the grid fetch and the drawer's live count share
// this so a selection can never mean two different things.
const buildProductQuery = ({
  category = "", categories = [], brands = [], sizes = [], colors = [],
  prints = [], priceBands = [], sort = "new", limit = 24, offset = 0,
  personalize = false,
} = {}) => {
  const q = new URLSearchParams();
  if (category) q.set("category", category);
  const csv = { categories, brands, sizes, colors, prints, price_bands: priceBands };
  for (const [k, v] of Object.entries(csv)) {
    if (v && v.length) q.set(k, v.join(","));
  }
  if (sort && sort !== "new") q.set("sort", sort);
  q.set("limit", String(limit));
  q.set("offset", String(offset));
  if (personalize) q.set("personalize", "1");
  return q;
};

export const api = {
  requestCode: (phone) => req("/auth/request-code", { method: "POST", body: { phone } }),
  verify: (phone, code) => req("/auth/verify", { method: "POST", body: { phone, code } }),
  signup: (payload) => req("/auth/signup", { method: "POST", body: payload }),
  me: () => req("/me", { auth: true }),
  logout: () => req("/auth/logout", { method: "POST", auth: true }),
  usernameCheck: (u) => req("/auth/username-check?u=" + encodeURIComponent(u), { auth: true }),
  updateSettings: (payload) => req("/me/settings", { method: "PUT", body: payload, auth: true }),
  products: (opts = {}) => {
    // personalize needs the Bearer token so the server can find her Style DNA;
    // without it (or without a finished quiz) the server just returns the
    // curated default order with personalized:false.
    return req("/products?" + buildProductQuery(opts).toString(), { auth: !!opts.personalize });
  },
  // Same filter params, but only the matching-styles total — feeds the live
  // "Show N styles" label on the filter drawer's Apply button.
  productsCount: (opts = {}) => {
    const q = buildProductQuery({ ...opts, personalize: false });
    q.set("count_only", "1");
    return req("/products?" + q.toString());
  },
  productFacets: () => req("/products/facets"),
  styleQuiz: () => req("/style-quiz", { auth: true }),
  // Styled for You — opt-in weekly recommendations + the preference editor.
  stylePrefs: () => req("/style-prefs", { auth: true }),
  stylePrefsSave: (payload) => req("/style-prefs", { method: "PUT", body: payload, auth: true }),
  styledForYou: () => req("/styled-for-you", { auth: true }),
  // Home-only lightweight probe: opt-in status without product payloads.
  styledForYouStatus: () => req("/styled-for-you?meta_only=1", { auth: true }),
  styleQuizSave: (answers) => req("/style-quiz", { method: "PUT", body: { answers }, auth: true }),
  styleQuizShare: () => req("/style-quiz/share", { method: "POST", auth: true }),
  contactSubmit: (payload) => req("/contact", { method: "POST", body: payload, auth: true }),
  product: (sku) => req("/product/" + encodeURIComponent(sku)),
  events: () => req("/events", { auth: true }),
  rsvpEvent: (id) => req("/events/" + encodeURIComponent(id) + "/rsvp", { method: "POST", auth: true }),
  cancelEventRsvp: (id) => req("/events/" + encodeURIComponent(id) + "/rsvp", { method: "DELETE", auth: true }),
  rewardsTank: () => req("/rewards/tank"),
  redeemTank: (payload) => req("/rewards/tank/redeem", { method: "POST", body: payload, auth: true }),
  myRedemptions: () => req("/rewards/redemptions", { auth: true }),
  updateRedemptionDesign: (id, payload) =>
    req("/rewards/redemptions/" + id + "/design", { method: "PUT", body: payload, auth: true }),
  // Virtual Try-On (all member-token gated; images are fetched separately
  // with the Bearer header — see components/community/authImage.js).
  tryonAllowance: () => req("/tryon/allowance", { auth: true }),
  tryonPhotos: () => req("/tryon/photos", { auth: true }),
  tryonUploadPhoto: (photo_b64) => req("/tryon/photos", { method: "POST", body: { photo_b64 }, auth: true }),
  tryonDeletePhoto: (id) => req("/tryon/photos/" + id, { method: "DELETE", auth: true }),
  tryonCreateLook: (photo_id, sku) => req("/tryon/looks", { method: "POST", body: { photo_id, sku }, auth: true }),
  tryonLooks: () => req("/tryon/looks", { auth: true }),
  tryonLook: (id) => req("/tryon/looks/" + id, { auth: true }),
  tryonDeleteLook: (id) => req("/tryon/looks/" + id, { method: "DELETE", auth: true }),
  tryonShare: (id, share, marketingOk) =>
    req("/tryon/looks/" + id + "/share", {
      method: "POST",
      // marketing_ok travels only when the consent box was actually shown —
      // absence means "never asked", which the ledger must not record.
      body: typeof marketingOk === "boolean" ? { share, marketing_ok: marketingOk } : { share },
      auth: true,
    }),
  tryonShared: () => req("/tryon/shared", { auth: true }),
  // Interactive feed — reads carry my_liked when signed in; writes are
  // member-token gated. Likes and comments never earn points (anti-spam).
  feed: (limit = 24, offset = 0, type = "") =>
    req(`/feed?limit=${limit}&offset=${offset}${type ? `&type=${encodeURIComponent(type)}` : ""}`, { auth: true }),
  // Single feed post — my_liked rides along when signed in. Powers the
  // like/comment machinery reused by the Vivo Edits detail page.
  post: (id) => req(`/posts/${id}`, { auth: true }),
  postComments: (id) => req(`/posts/${id}/comments`, { auth: true }),
  likePost: (id) => req(`/posts/${id}/like`, { method: "POST", auth: true }),
  addComment: (id, body) => req(`/posts/${id}/comments`, { method: "POST", body: { body }, auth: true }),
  likeComment: (id) => req(`/comments/${id}/like`, { method: "POST", auth: true }),
  reportComment: (id, reason) => req(`/comments/${id}/report`, { method: "POST", body: reason ? { reason } : {}, auth: true }),
  surveyDataDelete: () => req("/survey/response", { method: "DELETE", auth: true }),
  // My data (DPA): grouped uploads, per-item marketing consent, data requests.
  myData: () => req("/mydata", { auth: true }),
  myDataConsent: (content_type, content_id, marketing_ok) =>
    req("/mydata/consent", { method: "POST", body: { content_type, content_id, marketing_ok }, auth: true }),
  myDataRequest: (kind, note) =>
    req("/mydata/requests", { method: "POST", body: { kind, note }, auth: true }),
  deleteRedemptionDesign: (id) => req("/rewards/redemptions/" + id + "/design", { method: "DELETE", auth: true }),
  deleteContactPhoto: (id) => req("/contact/" + id + "/photo", { method: "DELETE", auth: true }),
  deleteStyleQuiz: () => req("/style-quiz", { method: "DELETE", auth: true }),
  // Restock alerts — members can subscribe to be notified when a sold-out
  // size comes back in stock. Auth required for all three operations.
  restockAlerts: (sku) =>
    req("/restock-alert?sku=" + encodeURIComponent(sku), { auth: true }),
  restockAlertSet: (size_sku) =>
    req("/restock-alert", { method: "POST", body: { size_sku }, auth: true }),
  restockAlertCancel: (size_sku) =>
    req("/restock-alert", { method: "DELETE", body: { size_sku }, auth: true }),
  // Challenges — real entries (photo riding the same b64-JSON lane as
  // try-on uploads), review-then-publish, one vote per member per voting
  // challenge. Reads work signed-out; my_entry/my_vote appear signed-in.
  challenges: () => req("/challenges", { auth: true }),
  challenge: (id) => req("/challenges/" + encodeURIComponent(id), { auth: true }),
  enterChallenge: (id, body) =>
    req("/challenges/" + encodeURIComponent(id) + "/entries", { method: "POST", body, auth: true }),
  challengeVote: (id, post_id) =>
    req("/challenges/" + encodeURIComponent(id) + "/vote", { method: "POST", body: { post_id }, auth: true }),
  myEntries: () => req("/my-entries", { auth: true }),
  // Standalone feed posts (share a look / ask the community / haul) — same
  // review-then-publish lane as challenge entries. Points by media kind
  // (photo 50 / video 100) land on publish; questions never earn points.
  createPost: (body) => req("/posts", { method: "POST", body, auth: true }),
  // "Shining This Week" celebration wall — appreciation, never rankings.
  celebrations: () => req("/celebrations", { auth: true }),
  // Vivo Edits — editorial, creator-curated shoppable looks. Reads are open
  // to guests (public image URLs), so no auth on the GETs.
  edits: (limit = 3, offset = 0) => req(`/edits?limit=${limit}&offset=${offset}`),
  editDetail: (id) => req("/edits/" + encodeURIComponent(id)),
  // Zetu Studios photoshoot — 3000 pts, lands as a personal booking.
  zetuRedeem: () => req("/rewards/zetu/redeem", { method: "POST", body: {}, auth: true }),
};
