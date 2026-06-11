/**
 * Customer-facing loyalty membership client for the Vivo Loyalty web app.
 *
 * This is the standalone shopper experience (separate from the staff BI cockpit
 * and the staff Expo app). A loyalty member enrols with their phone + a short
 * PIN — no staff account, no approval — and receives a scannable membership
 * barcode plus a points/tier card. The backend gates these `/api/loyalty/*`
 * endpoints with a member card token sent as `X-Member-Token` (NOT a staff
 * Bearer token), so the two session types never collide.
 */

export const API_BASE = "/api";

const MEMBER_TOKEN_KEY = "vivo_member_token";

// Module-level card token, mirrored to localStorage. Attached to every member
// request as X-Member-Token.
let memberToken: string | null = null;

export function loadMemberToken(): string | null {
  try {
    memberToken = localStorage.getItem(MEMBER_TOKEN_KEY);
  } catch {
    memberToken = null;
  }
  return memberToken;
}

export function setMemberToken(token: string | null): void {
  memberToken = token;
  try {
    if (token) localStorage.setItem(MEMBER_TOKEN_KEY, token);
    else localStorage.removeItem(MEMBER_TOKEN_KEY);
  } catch {
    // ignore storage errors; in-memory token still works for this session
  }
}

export function getMemberToken(): string | null {
  return memberToken;
}

function memberHeaders(): Record<string, string> {
  return memberToken ? { "X-Member-Token": memberToken } : {};
}

function friendly(status: number): string {
  if (status === 502 || status === 503 || status === 504)
    return "The server is temporarily unavailable. Please try again in a moment.";
  if (status >= 500)
    return "Something went wrong on the server. Please try again.";
  return `Request failed (${status})`;
}

async function detailOf(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { detail?: unknown };
    if (j && typeof j.detail === "string") return j.detail;
  } catch {
    // non-JSON error body; fall through to the friendly status message
  }
  return friendly(res.status);
}

export interface ApiError extends Error {
  status?: number;
}

export async function memberGet<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { headers: { ...memberHeaders() } });
  } catch {
    const err = new Error(
      "Cannot reach the server. Check your connection and try again.",
    ) as ApiError;
    err.status = 0;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(await detailOf(res)) as ApiError;
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export async function memberPost<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...memberHeaders() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    const err = new Error(
      "Cannot reach the server. Check your connection and try again.",
    ) as ApiError;
    err.status = 0;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(await detailOf(res)) as ApiError;
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

// --- Response shapes -------------------------------------------------------

export interface LoyaltyMember {
  member_id: string;
  customer_id: string;
  brand_code: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  membership_code: string;
  tier: string;
  points_balance: number;
  points_lifetime: number;
}

export interface LedgerEntry {
  points_change: number;
  reason: string;
  balance_after: number;
  transaction_id: string | null;
  created_at: string;
}

export interface RedemptionEntry {
  points_redeemed: number;
  kes_value: number;
  discount_code: string;
  code_status: string | null;
  issued_at: string;
  used_at: string | null;
}

export interface LoyaltyConfig {
  earn_rate_kes: number;
  points_per_kes_redeem: number;
  redemption_floor: number;
  tiers: Record<string, number>;
}

export interface MemberMe {
  member: LoyaltyMember;
  ledger: LedgerEntry[];
  redemptions: RedemptionEntry[];
  unread_messages: number;
  config: LoyaltyConfig;
}

export interface MemberMessage {
  id: number;
  title: string;
  body: string;
  created_at: string;
  created_by_name: string | null;
  read: boolean;
}

// --- API calls -------------------------------------------------------------

export async function enrolMember(input: {
  name: string;
  phone: string;
  pin: string;
  email?: string;
}): Promise<{ token: string; member: LoyaltyMember }> {
  const res = await memberPost<{ token: string; member: LoyaltyMember }>(
    "/loyalty/enrol",
    input,
  );
  setMemberToken(res.token);
  return res;
}

export async function loginMember(input: {
  phone: string;
  pin: string;
}): Promise<{ token: string; member: LoyaltyMember }> {
  const res = await memberPost<{ token: string; member: LoyaltyMember }>(
    "/loyalty/login",
    input,
  );
  setMemberToken(res.token);
  return res;
}

export async function fetchMemberMe(): Promise<MemberMe> {
  return memberGet<MemberMe>("/loyalty/me");
}

export async function redeemPoints(points: number): Promise<{
  discount_code: string;
  kes_value: number;
  points_balance: number;
}> {
  return memberPost("/loyalty/redeem", { points });
}

export async function fetchMemberMessages(): Promise<{
  messages: MemberMessage[];
  unread: number;
}> {
  return memberGet("/loyalty/messages");
}

export async function markMessageRead(
  id: number,
): Promise<{ ok: boolean; unread: number }> {
  return memberPost(`/loyalty/messages/${id}/read`);
}

export async function logoutMember(): Promise<void> {
  try {
    await memberPost("/loyalty/logout");
  } catch {
    // best-effort; local token is cleared regardless
  }
  setMemberToken(null);
}
