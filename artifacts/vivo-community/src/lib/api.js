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

export const api = {
  requestCode: (phone) => req("/auth/request-code", { method: "POST", body: { phone } }),
  verify: (phone, code) => req("/auth/verify", { method: "POST", body: { phone, code } }),
  signup: (payload) => req("/auth/signup", { method: "POST", body: payload }),
  me: () => req("/me", { auth: true }),
  logout: () => req("/auth/logout", { method: "POST", auth: true }),
  usernameCheck: (u) => req("/auth/username-check?u=" + encodeURIComponent(u), { auth: true }),
  updateSettings: (payload) => req("/me/settings", { method: "PUT", body: payload, auth: true }),
  products: ({ category = "", limit = 24, offset = 0, personalize = false } = {}) => {
    const q = new URLSearchParams();
    if (category) q.set("category", category);
    q.set("limit", String(limit));
    q.set("offset", String(offset));
    if (personalize) q.set("personalize", "1");
    // personalize needs the Bearer token so the server can find her Style DNA;
    // without it (or without a finished quiz) the server just returns the
    // curated default order with personalized:false.
    return req("/products?" + q.toString(), { auth: !!personalize });
  },
  styleQuiz: () => req("/style-quiz", { auth: true }),
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
  // My data (DPA): grouped uploads, per-item marketing consent, data requests.
  myData: () => req("/mydata", { auth: true }),
  myDataConsent: (content_type, content_id, marketing_ok) =>
    req("/mydata/consent", { method: "POST", body: { content_type, content_id, marketing_ok }, auth: true }),
  myDataRequest: (kind, note) =>
    req("/mydata/requests", { method: "POST", body: { kind, note }, auth: true }),
  deleteRedemptionDesign: (id) => req("/rewards/redemptions/" + id + "/design", { method: "DELETE", auth: true }),
  deleteContactPhoto: (id) => req("/contact/" + id + "/photo", { method: "DELETE", auth: true }),
  deleteStyleQuiz: () => req("/style-quiz", { method: "DELETE", auth: true }),
};
