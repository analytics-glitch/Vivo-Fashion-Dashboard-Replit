/**
 * Tiny typed fetch client for the Vivo Loyalty backend.
 * Uses cookie-based sessions (credentials: "include").
 */

// VITE_API_URL_LOYALTY_APP points at the backend. Leave it EMPTY for single-origin
// production (backend serves this SPA) → calls become same-origin "/api/…".
// In dev, .env sets it to http://localhost:4001.
// Served under the /loyalty-app base path in this workspace: same-origin calls
// become "/loyalty-app/api/…". VITE_API_URL_LOYALTY_APP stays EMPTY.
export const API_URL =
  ((import.meta.env.VITE_API_URL_LOYALTY_APP as string | undefined) ?? "").replace(/\/$/, "") ||
  "/loyalty-app";

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    signal: signal ?? init.signal,
    credentials: "include",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const message =
      (data && (data.message || data.error)) || `Request failed (${res.status})`;
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, {}, signal),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
};

// ── Domain types ─────────────────────────────────────────────

export interface Tier {
  id: string;
  name: string;
  slug: string;
  minPoints: number;
  multiplier: number;
  color: string;
  icon: string | null;
  perks: string[];
  sortOrder: number;
}

export interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  phone: string | null;
  birthday: string | null;
  role: "CUSTOMER" | "ADMIN";
  emailVerified: boolean;
  pointsBalance: number;
  lifetimePoints: number;
  streakCount: number;
  referralCode: string;
  shopifyLinked: boolean;
  tier: Tier | null;
  nextTier: Tier | null;
  pointsToNext: number;
  tierProgress: number;
  tiers: Tier[];
  createdAt: string;
}

export interface Reward {
  id: string;
  title: string;
  description: string;
  pointsCost: number;
  type: "PERCENT_DISCOUNT" | "FIXED_DISCOUNT" | "FREE_SHIPPING" | "FREE_PRODUCT";
  value: number;
  imageUrl: string | null;
  stock: number | null;
  minTierId: string | null;
}

export interface PointsTxn {
  id: string;
  type: string;
  points: number;
  description: string;
  createdAt: string;
}

export interface Redemption {
  id: string;
  pointsSpent: number;
  status: string;
  discountCode: string | null;
  expiresAt: string | null;
  createdAt: string;
  reward: Reward;
}

export interface OrderItem {
  id: number;
  title: string;
  variantTitle?: string | null;
  quantity: number;
  price: number;
  image: string | null;
}

export interface Order {
  id: number;
  name: string;
  createdAt: string;
  financialStatus: string;
  fulfillmentStatus: string | null;
  currency: string;
  subtotal: number;
  total: number;
  itemCount: number;
  items: OrderItem[];
}

export interface OrderDetail extends Order {
  tax: number;
  shipping: number;
  discounts: number;
  note: string | null;
  shippingAddress: {
    name?: string;
    address1?: string;
    address2?: string;
    city?: string;
    province?: string;
    zip?: string;
    country?: string;
    phone?: string;
  } | null;
  tracking: { number: string | null; company: string | null; url: string | null }[];
}

export interface ReturnItem {
  id: string;
  name: string;
  status: string;
  orderName: string;
  createdAt: string;
  totalQuantity: number;
}

export interface ReferralOverview {
  referralCode: string;
  shareUrl: string;
  rewardPoints: number;
  friendPoints: number;
  stats: { invited: number; completed: number; pointsEarned: number };
  referrals: { id: string; refereeEmail: string; status: string; createdAt: string }[];
}

// ── Endpoints ────────────────────────────────────────────────

export const auth = {
  me: (signal?: AbortSignal) => api.get<{ user: User }>("/api/auth/me", signal),
  status: () => api.get<{ google: boolean; otp: boolean }>("/api/auth/status"),
  requestOtp: (email: string, referralCode?: string) =>
    api.post<{ ok: boolean; ttlMinutes: number }>("/api/auth/otp/request", { email, referralCode }),
  verifyOtp: (email: string, code: string, referralCode?: string) =>
    api.post<{ user: User }>("/api/auth/otp/verify", { email, code, referralCode }),
  googleToken: (credential: string, referralCode?: string) =>
    api.post<{ user: User }>("/api/auth/google/token", { credential, referralCode }),
  logout: () => api.post<{ ok: boolean }>("/api/auth/logout"),
  heartbeat: (installed: boolean, version: string | null) =>
    api.post<{ ok: boolean }>("/api/auth/heartbeat", { installed, version }),
  googleRedirectUrl: (referralCode?: string, next = "/dashboard") =>
    `${API_URL}/api/auth/google?next=${encodeURIComponent(next)}${
      referralCode ? `&ref=${encodeURIComponent(referralCode)}` : ""
    }`,
};

export const loyalty = {
  profile: () => api.get<{ user: User }>("/api/loyalty/profile"),
  updateProfile: (data: Partial<Pick<User, "firstName" | "lastName" | "phone">> & { birthday?: string }) =>
    api.patch<{ user: User }>("/api/loyalty/profile", data),
  history: (cursor?: string) =>
    api.get<{ items: PointsTxn[]; nextCursor: string | null }>(
      `/api/loyalty/points/history?limit=20${cursor ? `&cursor=${cursor}` : ""}`,
    ),
  claimBirthday: () => api.post<{ user: User; awarded: number }>("/api/loyalty/bonus/birthday"),
};

export const rewards = {
  list: () => api.get<{ rewards: Reward[] }>("/api/rewards"),
  redemptions: () => api.get<{ redemptions: Redemption[] }>("/api/rewards/redemptions"),
  redeem: (rewardId: string) =>
    api.post<{ redemption: Redemption; user: User }>(`/api/rewards/${rewardId}/redeem`),
};

export const shopify = {
  orders: () => api.get<{ linked: boolean; orders: Order[] }>("/api/shopify/orders"),
  order: (id: string | number) => api.get<{ order: OrderDetail }>(`/api/shopify/orders/${id}`),
  returns: () => api.get<{ linked: boolean; returns: ReturnItem[] }>("/api/shopify/returns"),
};

export const referrals = {
  overview: () => api.get<ReferralOverview>("/api/referrals"),
  invite: (email: string) => api.post<{ ok: boolean }>("/api/referrals/invite", { email }),
};

// ── Shop ─────────────────────────────────────────────────────

export interface Collection {
  id: string;
  title: string;
  handle: string;
  image: string | null;
  description: string;
}

export interface ShopProduct {
  id: string;
  title: string;
  handle: string;
  image: string | null;
  price: number;
  currency: string;
  url: string | null;
}

export interface StorefrontVariant {
  id: string;
  title: string;
  available: boolean;
  price: number;
  currency: string;
  image: string | null;
  selectedOptions: { name: string; value: string }[];
}

export interface StorefrontProduct {
  id: string;
  title: string;
  handle: string;
  descriptionHtml: string;
  images: string[];
  options: { name: string; values: string[] }[];
  variants: StorefrontVariant[];
  price: number;
  currency: string;
}

export interface CartLine {
  id: string;
  variantId: string;
  quantity: number;
  title: string;
  variantTitle: string | null;
  handle: string;
  image: string | null;
  price: number;
  currency: string;
}

export interface Cart {
  id: string;
  checkoutUrl: string;
  totalQuantity: number;
  subtotal: number;
  currency: string;
  lines: CartLine[];
}

// ── Admin ────────────────────────────────────────────────────

export interface AdminUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  loginCount: number;
  lastLoginAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  pwaInstalled: boolean;
  appVersion: string | null;
  online: boolean;
  appUpToDate: boolean | null;
}

export interface AdminOverview {
  build: string | null;
  activeWindowMinutes: number;
  stats: { totalSignups: number; activeNow: number; installedCount: number; totalLogins: number };
  users: AdminUser[];
}

export const admin = {
  overview: () => api.get<AdminOverview>("/api/admin/overview"),
};

export const shop = {
  collections: () =>
    api.get<{ linked: boolean; storefront?: string; collections: Collection[] }>(
      "/api/shop/collections",
    ),
  products: (handle: string) =>
    api.get<{ linked: boolean; title: string; collectionUrl?: string; products: ShopProduct[] }>(
      `/api/shop/collections/${encodeURIComponent(handle)}/products`,
    ),
  product: (handle: string) =>
    api.get<{ product: StorefrontProduct }>(`/api/shop/products/${encodeURIComponent(handle)}`),
  cartGet: (id: string) =>
    api.get<{ cart: Cart | null }>(`/api/shop/cart?id=${encodeURIComponent(id)}`),
  cartActive: () => api.get<{ cart: Cart | null }>("/api/shop/cart/active"),
  cartAdd: (variantId: string, quantity: number, cartId?: string) =>
    api.post<{ cart: Cart }>("/api/shop/cart/add", { variantId, quantity, cartId }),
  cartUpdate: (cartId: string, lineId: string, quantity: number) =>
    api.post<{ cart: Cart }>("/api/shop/cart/update", { cartId, lineId, quantity }),
  cartRemove: (cartId: string, lineId: string) =>
    api.post<{ cart: Cart }>("/api/shop/cart/remove", { cartId, lineId }),
  wishlist: () => api.get<{ items: WishlistItem[] }>("/api/shop/wishlist"),
  wishlistAdd: (item: Omit<WishlistItem, "id">) =>
    api.post<{ items: WishlistItem[] }>("/api/shop/wishlist", item),
  wishlistRemove: (handle: string) =>
    api.post<{ items: WishlistItem[] }>("/api/shop/wishlist/remove", { handle }),
};

export interface WishlistItem {
  id?: string;
  handle: string;
  title: string;
  image: string | null;
  price: number;
  currency: string;
}
