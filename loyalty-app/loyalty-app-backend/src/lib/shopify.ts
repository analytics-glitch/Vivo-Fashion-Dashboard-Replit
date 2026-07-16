import { createHmac, timingSafeEqual } from "node:crypto";
import { env, shopifyEnabled, storefrontEnabled } from "../config/env.js";

/**
 * Thin Shopify Admin API client (REST + GraphQL) for the loyalty backend.
 * Uses a Custom App admin token. All calls no-op gracefully when Shopify
 * isn't configured so the rest of the app still runs in dev.
 */

const base = () => `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}`;

function headers() {
  return {
    "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_TOKEN,
    "Content-Type": "application/json",
  };
}

async function rest<T>(path: string, init?: RequestInit): Promise<T> {
  if (!shopifyEnabled) throw new Error("SHOPIFY_NOT_CONFIGURED");
  const res = await fetch(`${base()}${path}`, { ...init, headers: headers() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify REST ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

export async function graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  if (!shopifyEnabled) throw new Error("SHOPIFY_NOT_CONFIGURED");
  const res = await fetch(`${base()}/graphql.json`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

// ── Customers ────────────────────────────────────────────────

export interface ShopifyCustomer {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  orders_count: number;
  total_spent: string;
  tags: string;
}

export async function findCustomerByEmail(email: string): Promise<ShopifyCustomer | null> {
  if (!shopifyEnabled) return null;
  const data = await rest<{ customers: ShopifyCustomer[] }>(
    `/customers/search.json?query=${encodeURIComponent(`email:${email}`)}`,
  );
  return data.customers?.[0] ?? null;
}

// ── Orders ───────────────────────────────────────────────────

export interface ShopifyLineItem {
  id: number;
  title: string;
  variant_title?: string | null;
  quantity: number;
  price: string;
  product_id: number | null;
  variant_id: number | null;
  image?: { src: string } | null;
}

export interface ShopifyAddress {
  name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  zip?: string;
  country?: string;
  phone?: string;
}

export interface ShopifyFulfillment {
  status?: string;
  tracking_number?: string | null;
  tracking_company?: string | null;
  tracking_url?: string | null;
}

export interface ShopifyOrder {
  id: number;
  name: string;
  created_at: string;
  processed_at: string;
  financial_status: string;
  fulfillment_status: string | null;
  currency: string;
  total_price: string;
  subtotal_price: string;
  total_tax?: string;
  total_discounts?: string;
  total_shipping_price_set?: { shop_money?: { amount?: string } };
  note?: string | null;
  shipping_address?: ShopifyAddress | null;
  fulfillments?: ShopifyFulfillment[];
  line_items: ShopifyLineItem[];
}

export async function listOrdersForCustomer(shopifyCustomerId: string): Promise<ShopifyOrder[]> {
  if (!shopifyEnabled) return [];
  const data = await rest<{ orders: ShopifyOrder[] }>(
    `/customers/${shopifyCustomerId}/orders.json?status=any&limit=50`,
  );
  return data.orders ?? [];
}

export async function getOrder(orderId: string | number): Promise<ShopifyOrder | null> {
  if (!shopifyEnabled) return null;
  const data = await rest<{ order: ShopifyOrder }>(`/orders/${orderId}.json`);
  return data.order ?? null;
}

/**
 * Order line items don't carry product images, so resolve featured images by
 * product id in one bulk call. Returns { [productId]: imageSrc }.
 */
export async function getProductImages(productIds: number[]): Promise<Record<number, string>> {
  const ids = [...new Set(productIds.filter((id) => id))];
  if (!shopifyEnabled || ids.length === 0) return {};
  const data = await rest<{ products: Array<{ id: number; image?: { src: string } | null }> }>(
    `/products.json?ids=${ids.join(",")}&fields=id,image`,
  );
  const map: Record<number, string> = {};
  for (const p of data.products ?? []) {
    if (p.image?.src) map[p.id] = p.image.src;
  }
  return map;
}

// ── Returns (via GraphQL — returns aren't in REST) ───────────

export interface ShopifyReturn {
  id: string;
  name: string;
  status: string;
  orderName: string;
  createdAt: string;
  totalQuantity: number;
}

export async function listReturnsForCustomer(shopifyCustomerId: string): Promise<ShopifyReturn[]> {
  if (!shopifyEnabled) return [];
  const query = `
    query ($q: String!) {
      orders(first: 25, query: $q, sortKey: CREATED_AT, reverse: true) {
        edges { node {
          name
          returns(first: 10) {
            edges { node {
              id name status totalQuantity
              order { name createdAt }
            } }
          }
        } }
      }
    }`;
  const data = await graphql<{
    orders: { edges: Array<{ node: { name: string; returns: { edges: Array<{ node: any }> } } }> };
  }>(query, { q: `customer_id:${shopifyCustomerId}` });

  const returns: ShopifyReturn[] = [];
  for (const o of data.orders.edges) {
    for (const r of o.node.returns.edges) {
      returns.push({
        id: r.node.id,
        name: r.node.name,
        status: r.node.status,
        orderName: r.node.order?.name ?? o.node.name,
        createdAt: r.node.order?.createdAt ?? "",
        totalQuantity: r.node.totalQuantity ?? 0,
      });
    }
  }
  return returns;
}

// ── Shop: collections & products (Admin GraphQL) ─────────────

export interface ShopCollection {
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

/** All collections — used to build the Shop drawer menu. */
export async function listCollections(): Promise<ShopCollection[]> {
  if (!shopifyEnabled) return [];
  const query = `
    query {
      collections(first: 100, sortKey: TITLE) {
        edges { node { id title handle description image { url } } }
      }
    }`;
  const data = await graphql<{
    collections: { edges: Array<{ node: any }> };
  }>(query);
  return data.collections.edges
    .map((e) => ({
      id: e.node.id,
      title: e.node.title,
      handle: e.node.handle,
      description: e.node.description ?? "",
      image: e.node.image?.url ?? null,
    }))
    // Hide empty/utility collections without a handle.
    .filter((c) => c.handle);
}

/** Metadata for one collection by handle — used to build the curated drawer. */
export async function getCollectionMeta(handle: string): Promise<ShopCollection | null> {
  if (!shopifyEnabled) return null;
  const query = `
    query ($handle: String!) {
      collectionByHandle(handle: $handle) {
        id title handle description image { url }
      }
    }`;
  const data = await graphql<{ collectionByHandle: any }>(query, { handle });
  const c = data.collectionByHandle;
  if (!c) return null;
  return {
    id: c.id,
    title: c.title,
    handle: c.handle,
    description: c.description ?? "",
    image: c.image?.url ?? null,
  };
}

/** Products within a collection (by handle) — the shoppable grid. */
export async function getCollectionProducts(
  handle: string,
): Promise<{ title: string; products: ShopProduct[] } | null> {
  if (!shopifyEnabled) return null;
  const query = `
    query ($handle: String!) {
      collectionByHandle(handle: $handle) {
        title
        products(first: 60) {
          edges { node {
            id title handle status onlineStoreUrl
            featuredImage { url }
            priceRangeV2 { minVariantPrice { amount currencyCode } }
          } }
        }
      }
    }`;
  const data = await graphql<{ collectionByHandle: any }>(query, { handle });
  const col = data.collectionByHandle;
  if (!col) return null;

  const products: ShopProduct[] = col.products.edges
    .map((e: any) => e.node)
    // Only shoppable products: active, published to the online store, with an
    // image. Anything else 404s / shows blank, so we drop it.
    .filter((n: any) => n.status === "ACTIVE" && n.onlineStoreUrl && n.featuredImage?.url)
    .map((n: any) => {
      const price = n.priceRangeV2?.minVariantPrice;
      return {
        id: n.id,
        title: n.title,
        handle: n.handle,
        image: n.featuredImage.url,
        price: Number(price?.amount ?? 0),
        currency: price?.currencyCode ?? "KES",
        url: n.onlineStoreUrl ?? null,
      };
    });
  return { title: col.title, products };
}

// ── Storefront API (product detail + cart / checkout) ────────

async function storefront<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  if (!storefrontEnabled) throw new Error("STOREFRONT_NOT_CONFIGURED");
  const res = await fetch(
    `https://${env.SHOPIFY_STORE_DOMAIN}/api/${env.SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Storefront-Access-Token": env.SHOPIFY_STOREFRONT_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) throw new Error(`Storefront GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data as T;
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

export async function getStorefrontProduct(handle: string): Promise<StorefrontProduct | null> {
  if (!storefrontEnabled) return null;
  const query = `
    query ($handle: String!) {
      product(handle: $handle) {
        id title handle descriptionHtml
        options { name values }
        priceRange { minVariantPrice { amount currencyCode } }
        images(first: 8) { edges { node { url } } }
        variants(first: 100) {
          edges { node {
            id title availableForSale
            price { amount currencyCode }
            image { url }
            selectedOptions { name value }
          } }
        }
      }
    }`;
  const data = await storefront<{ product: any }>(query, { handle });
  const p = data.product;
  if (!p) return null;
  const price = p.priceRange?.minVariantPrice;
  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    descriptionHtml: p.descriptionHtml ?? "",
    images: p.images.edges.map((e: any) => e.node.url),
    options: (p.options ?? []).map((o: any) => ({ name: o.name, values: o.values })),
    price: Number(price?.amount ?? 0),
    currency: price?.currencyCode ?? "KES",
    variants: p.variants.edges.map((e: any) => ({
      id: e.node.id,
      title: e.node.title,
      available: e.node.availableForSale,
      price: Number(e.node.price?.amount ?? 0),
      currency: e.node.price?.currencyCode ?? "KES",
      image: e.node.image?.url ?? null,
      selectedOptions: e.node.selectedOptions ?? [],
    })),
  };
}

// ── Cart ─────────────────────────────────────────────────────

const CART_FIELDS = `
  id
  checkoutUrl
  totalQuantity
  cost { subtotalAmount { amount currencyCode } }
  lines(first: 100) {
    edges { node {
      id quantity
      merchandise {
        ... on ProductVariant {
          id title
          image { url }
          price { amount currencyCode }
          product { title handle featuredImage { url } }
        }
      }
    } }
  }
`;

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

function normalizeCart(c: any): Cart | null {
  if (!c) return null;
  const sub = c.cost?.subtotalAmount;
  return {
    id: c.id,
    checkoutUrl: c.checkoutUrl,
    totalQuantity: c.totalQuantity ?? 0,
    subtotal: Number(sub?.amount ?? 0),
    currency: sub?.currencyCode ?? "KES",
    lines: c.lines.edges.map((e: any) => {
      const m = e.node.merchandise;
      return {
        id: e.node.id,
        variantId: m.id,
        quantity: e.node.quantity,
        title: m.product?.title ?? m.title,
        variantTitle: m.title && m.title !== "Default Title" ? m.title : null,
        handle: m.product?.handle ?? "",
        image: m.image?.url ?? m.product?.featuredImage?.url ?? null,
        price: Number(m.price?.amount ?? 0),
        currency: m.price?.currencyCode ?? "KES",
      };
    }),
  };
}

export async function cartCreate(variantId: string, quantity: number): Promise<Cart | null> {
  const data = await storefront<{ cartCreate: { cart: any; userErrors: any[] } }>(
    `mutation ($lines: [CartLineInput!]!) {
      cartCreate(input: { lines: $lines }) { cart { ${CART_FIELDS} } userErrors { message } }
    }`,
    { lines: [{ merchandiseId: variantId, quantity }] },
  );
  return normalizeCart(data.cartCreate.cart);
}

export async function cartLinesAdd(cartId: string, variantId: string, quantity: number) {
  const data = await storefront<{ cartLinesAdd: { cart: any } }>(
    `mutation ($cartId: ID!, $lines: [CartLineInput!]!) {
      cartLinesAdd(cartId: $cartId, lines: $lines) { cart { ${CART_FIELDS} } userErrors { message } }
    }`,
    { cartId, lines: [{ merchandiseId: variantId, quantity }] },
  );
  return normalizeCart(data.cartLinesAdd.cart);
}

export async function cartLinesUpdate(cartId: string, lineId: string, quantity: number) {
  const data = await storefront<{ cartLinesUpdate: { cart: any } }>(
    `mutation ($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
      cartLinesUpdate(cartId: $cartId, lines: $lines) { cart { ${CART_FIELDS} } userErrors { message } }
    }`,
    { cartId, lines: [{ id: lineId, quantity }] },
  );
  return normalizeCart(data.cartLinesUpdate.cart);
}

export async function cartLinesRemove(cartId: string, lineId: string) {
  const data = await storefront<{ cartLinesRemove: { cart: any } }>(
    `mutation ($cartId: ID!, $lineIds: [ID!]!) {
      cartLinesRemove(cartId: $cartId, lineIds: $lineIds) { cart { ${CART_FIELDS} } userErrors { message } }
    }`,
    { cartId, lineIds: [lineId] },
  );
  return normalizeCart(data.cartLinesRemove.cart);
}

export async function getCart(cartId: string): Promise<Cart | null> {
  const data = await storefront<{ cart: any }>(`query ($id: ID!) { cart(id: $id) { ${CART_FIELDS} } }`, {
    id: cartId,
  });
  return normalizeCart(data.cart);
}

// ── Discount codes (for reward redemption) ───────────────────

export interface DiscountResult {
  code: string;
  priceRuleId: string;
  discountId: string;
}

export interface CreateDiscountArgs {
  code: string;
  type: "PERCENT_DISCOUNT" | "FIXED_DISCOUNT" | "FREE_SHIPPING" | "FREE_PRODUCT";
  value: number; // percent 0-100 or fixed amount
  customerEmail?: string;
  expiresAt?: Date | null;
}

/**
 * Creates a single-use discount code via a REST price rule.
 * Returns identifiers so we can revoke/track the redemption.
 */
export async function createDiscountCode(args: CreateDiscountArgs): Promise<DiscountResult> {
  if (!shopifyEnabled) {
    // Dev fallback: return a fake but deterministic-ish code.
    return { code: args.code, priceRuleId: "dev", discountId: "dev" };
  }

  const now = new Date().toISOString();
  const valueType = args.type === "PERCENT_DISCOUNT" ? "percentage" : "fixed_amount";
  const value =
    args.type === "PERCENT_DISCOUNT"
      ? `-${Math.abs(args.value)}`
      : `-${Math.abs(args.value)}`;

  const priceRule: Record<string, unknown> = {
    title: args.code,
    target_type: args.type === "FREE_SHIPPING" ? "shipping_line" : "line_item",
    target_selection: "all",
    allocation_method: args.type === "FREE_SHIPPING" ? "each" : "across",
    value_type: args.type === "FREE_SHIPPING" ? "percentage" : valueType,
    value: args.type === "FREE_SHIPPING" ? "-100.0" : value,
    customer_selection: "all",
    once_per_customer: true,
    usage_limit: 1,
    starts_at: now,
    ends_at: args.expiresAt ? args.expiresAt.toISOString() : null,
  };

  const created = await rest<{ price_rule: { id: number } }>(`/price_rules.json`, {
    method: "POST",
    body: JSON.stringify({ price_rule: priceRule }),
  });
  const priceRuleId = created.price_rule.id;

  const disc = await rest<{ discount_code: { id: number; code: string } }>(
    `/price_rules/${priceRuleId}/discount_codes.json`,
    { method: "POST", body: JSON.stringify({ discount_code: { code: args.code } }) },
  );

  return {
    code: disc.discount_code.code,
    priceRuleId: String(priceRuleId),
    discountId: String(disc.discount_code.id),
  };
}

// ── Webhook HMAC verification ────────────────────────────────

export function verifyWebhookHmac(rawBody: Buffer, hmacHeader: string | undefined): boolean {
  if (!env.SHOPIFY_WEBHOOK_SECRET || !hmacHeader) return false;
  const digest = createHmac("sha256", env.SHOPIFY_WEBHOOK_SECRET).update(rawBody).digest("base64");
  try {
    return timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}
