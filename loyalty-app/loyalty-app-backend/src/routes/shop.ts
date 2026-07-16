import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env, shopifyEnabled, storefrontEnabled } from "../config/env.js";
import {
  listCollections,
  getCollectionMeta,
  getCollectionProducts,
  getStorefrontProduct,
  cartCreate,
  cartLinesAdd,
  cartLinesUpdate,
  cartLinesRemove,
  getCart,
} from "../lib/shopify.js";

/**
 * Shop endpoints — powers the Shop tab. Collections build the drawer menu;
 * products (by collection handle) build the shoppable grid. "Buy" links point
 * at the public storefront.
 */
export default async function shopRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  // Collections → drawer menu. Restricted to the curated (Vivo) handles from
  // SHOP_COLLECTIONS, in that order. Empty list = show everything.
  app.get("/collections", async () => {
    if (!shopifyEnabled) return { linked: false, collections: [] };
    const curated = env.SHOP_COLLECTIONS;
    // Curated: fetch each handle directly (reliable regardless of store size).
    // Uncurated: list everything.
    const collections = curated.length
      ? (await Promise.all(curated.map((h: string) => getCollectionMeta(h)))).filter(
          (c): c is NonNullable<typeof c> => Boolean(c),
        )
      : await listCollections();
    return { linked: true, storefront: env.STOREFRONT_BASE_URL, collections };
  });

  // Products in a collection → shoppable grid.
  app.get("/collections/:handle/products", async (req, reply) => {
    const { handle } = z.object({ handle: z.string() }).parse(req.params);
    if (!shopifyEnabled) return { linked: false, title: "", products: [] };

    const result = await getCollectionProducts(handle);
    if (!result) return reply.notFound("Collection not found.");

    // Always build buy links against the public storefront (www.shopzetu.com),
    // not Shopify's onlineStoreUrl (which points at the legacy pay.* domain).
    const products = result.products.map((p) => ({
      ...p,
      url: `${env.STOREFRONT_BASE_URL}/products/${p.handle}`,
    }));
    return {
      linked: true,
      title: result.title,
      collectionUrl: `${env.STOREFRONT_BASE_URL}/collections/${handle}`,
      products,
    };
  });

  // ── Product detail (Storefront API) ────────────────────────
  app.get("/products/:handle", async (req, reply) => {
    const { handle } = z.object({ handle: z.string() }).parse(req.params);
    if (!storefrontEnabled) return reply.notImplemented("Storefront is not configured.");
    const product = await getStorefrontProduct(handle);
    if (!product) return reply.notFound("Product not found.");
    return { product };
  });

  // ── Cart (Storefront API) ──────────────────────────────────
  // Persist the active cart id on the customer so it follows the account.
  const saveCartId = (customerId: string, cartId: string | null) =>
    app.prisma.customer.update({ where: { id: customerId }, data: { cartId } }).catch(() => {});

  // The account's active cart (works across devices for the same login).
  app.get("/cart/active", async (req, reply) => {
    if (!storefrontEnabled) return { cart: null };
    const customer = await app.prisma.customer.findUniqueOrThrow({ where: { id: req.user.sub } });
    if (!customer.cartId) return { cart: null };
    const cart = await getCart(customer.cartId);
    if (!cart) {
      await saveCartId(req.user.sub, null); // expired / checked out
      return { cart: null };
    }
    return { cart };
  });

  // Add to cart — creates a cart on first add, otherwise appends. Also binds
  // the cart to the customer's account.
  app.post("/cart/add", async (req, reply) => {
    if (!storefrontEnabled) return reply.notImplemented("Storefront is not configured.");
    const body = z
      .object({
        cartId: z.string().optional(),
        variantId: z.string(),
        quantity: z.number().int().min(1).default(1),
      })
      .parse(req.body);

    // Prefer the id sent by the client, else the one saved on the account.
    let cartId = body.cartId;
    if (!cartId) {
      const c = await app.prisma.customer.findUnique({ where: { id: req.user.sub } });
      cartId = c?.cartId ?? undefined;
    }

    let cart = cartId ? await cartLinesAdd(cartId, body.variantId, body.quantity) : null;
    // No cart yet, or the stored cart expired/completed → start a fresh one.
    if (!cart) cart = await cartCreate(body.variantId, body.quantity);
    if (cart) await saveCartId(req.user.sub, cart.id);
    return { cart };
  });

  app.post("/cart/update", async (req, reply) => {
    if (!storefrontEnabled) return reply.notImplemented("Storefront is not configured.");
    const body = z
      .object({ cartId: z.string(), lineId: z.string(), quantity: z.number().int().min(0) })
      .parse(req.body);
    const cart =
      body.quantity <= 0
        ? await cartLinesRemove(body.cartId, body.lineId)
        : await cartLinesUpdate(body.cartId, body.lineId, body.quantity);
    return { cart };
  });

  app.post("/cart/remove", async (req, reply) => {
    if (!storefrontEnabled) return reply.notImplemented("Storefront is not configured.");
    const body = z.object({ cartId: z.string(), lineId: z.string() }).parse(req.body);
    const cart = await cartLinesRemove(body.cartId, body.lineId);
    return { cart };
  });

  app.get("/cart", async (req, reply) => {
    if (!storefrontEnabled) return reply.notImplemented("Storefront is not configured.");
    const { id } = z.object({ id: z.string() }).parse(req.query);
    const cart = await getCart(id);
    return { cart };
  });

  // ── Wishlist (saved products, per customer) ────────────────
  const listWishlist = (customerId: string) =>
    app.prisma.wishlistItem.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
    });

  app.get("/wishlist", async (req) => {
    return { items: await listWishlist(req.user.sub) };
  });

  app.post("/wishlist", async (req) => {
    const body = z
      .object({
        handle: z.string(),
        title: z.string(),
        image: z.string().nullable().optional(),
        price: z.number().default(0),
        currency: z.string().default("KES"),
      })
      .parse(req.body);
    await app.prisma.wishlistItem.upsert({
      where: { customerId_handle: { customerId: req.user.sub, handle: body.handle } },
      update: { title: body.title, image: body.image ?? null, price: body.price, currency: body.currency },
      create: {
        customerId: req.user.sub,
        handle: body.handle,
        title: body.title,
        image: body.image ?? null,
        price: body.price,
        currency: body.currency,
      },
    });
    return { items: await listWishlist(req.user.sub) };
  });

  app.post("/wishlist/remove", async (req) => {
    const { handle } = z.object({ handle: z.string() }).parse(req.body);
    await app.prisma.wishlistItem.deleteMany({ where: { customerId: req.user.sub, handle } });
    return { items: await listWishlist(req.user.sub) };
  });
}
