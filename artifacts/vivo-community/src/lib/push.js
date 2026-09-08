// Web push for the community app.
//
// A member should learn what they earned while they are still in the shop, not
// when they next open their email. The subscription is keyed to the ACCOUNT,
// not to this app — the loyalty backend pushes to whichever devices a member
// has registered, whichever face of the app registered them.
import { api } from "./api";

const urlBase64ToUint8Array = (base64) => {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};

export const pushSupported = () =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

/**
 * Ask the BROWSER for permission. Must be called while the tap is still live.
 *
 * ⚠️ THIS MUST NOT BE PRECEDED BY AN AWAIT IN THE CALLER. On Chrome the order
 * does not matter. On WebKit it does: Safari requires
 * `Notification.requestPermission()` to be reached while the user gesture is
 * still active, and awaiting a network round trip first consumes it. The prompt
 * then never appears — no error, no dialog, nothing — so the member taps
 * "Join", sees nothing, and the app never shows up under iOS Settings →
 * Notifications, because iOS only lists a web app once permission is granted.
 *
 * Returns the browser's answer: "granted" | "denied" | "default".
 */
export function askNotifyPermission() {
  if (!pushSupported()) return Promise.resolve("unsupported");
  try {
    return Promise.resolve(Notification.requestPermission());
  } catch {
    return Promise.resolve("denied");
  }
}

/**
 * Register THIS device with the server. Requires a signed-in session, so it
 * runs after sign-up completes — permission is asked before, registration
 * happens after, and the two are deliberately separate calls.
 */
export async function registerDevice() {
  if (!pushSupported() || Notification.permission !== "granted") return false;

  const { enabled, publicKey } = await api.pushKey().catch(() => ({ enabled: false, publicKey: "" }));
  if (!enabled || !publicKey) return false;

  const reg = await navigator.serviceWorker.ready;
  // Reuse an existing subscription rather than minting a second one — the push
  // service returns the same endpoint anyway, and re-subscribing needlessly
  // invalidates the keys the server already holds.
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  await api.pushSubscribe(sub.toJSON());
  return true;
}

/** Ask and register in one go — for a button pressed by a signed-in member. */
export async function enablePush() {
  if (!pushSupported()) return "unsupported";
  const permission = await askNotifyPermission();
  if (permission !== "granted") return "denied";
  return (await registerDevice()) ? "subscribed" : "unsupported";
}

/**
 * Turn notifications off for this device.
 *
 * Unsubscribes locally AND tells the server to forget the endpoint. Doing only
 * the first would leave the server pushing to a subscription the browser has
 * discarded, which fails silently until the endpoint is finally reported gone.
 */
export async function disablePush() {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  if (!sub) return;
  const { endpoint } = sub;
  await sub.unsubscribe().catch(() => {});
  await api.pushUnsubscribe(endpoint).catch(() => {});
}

/**
 * What this device's notification state actually is, right now.
 *
 * "blocked" is not recoverable from code: once the member presses Block in the
 * browser prompt, `requestPermission()` resolves instantly as "denied" without
 * showing anything. A "Turn on" button would do nothing and look broken, so the
 * UI has to point at the browser's own site settings instead.
 */
export async function pushState() {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission === "default") return "off";
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  return sub ? "on" : "needs-resubscribe";
}
