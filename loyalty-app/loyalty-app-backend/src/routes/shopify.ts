import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { shopifyEnabled } from "../config/env.js";
import {
  listOrdersForCustomer,
  listReturnsForCustomer,
  getOrder,
  getProductImages,
  type ShopifyLineItem,
} from "../lib/shopify.js";

export default async function shopifyRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  // Map a Shopify line item → API shape, using the product image when present,
  // else the featured image resolved by product id (falls back to null → the
  // frontend shows a default placeholder).
  const mapItem = (li: ShopifyLineItem, images: Record<number, string>) => ({
    id: li.id,
    title: li.title,
    variantTitle: li.variant_title ?? null,
    quantity: li.quantity,
    price: Number(li.price),
    image: li.image?.src ?? (li.product_id ? images[li.product_id] ?? null : null),
  });

  // Order history pulled live from Shopify (falls back to empty if unlinked).
  app.get("/orders", async (req) => {
    const customer = await app.prisma.customer.findUniqueOrThrow({ where: { id: req.user.sub } });
    if (!customer.shopifyCustomerId || !shopifyEnabled) {
      return { linked: false, orders: [] };
    }
    const orders = await listOrdersForCustomer(customer.shopifyCustomerId);
    // Bulk-resolve featured images for every product across all orders.
    const productIds = orders.flatMap((o) => o.line_items.map((li) => li.product_id ?? 0));
    const images = await getProductImages(productIds);

    return {
      linked: true,
      orders: orders.map((o) => ({
        id: o.id,
        name: o.name,
        createdAt: o.processed_at || o.created_at,
        financialStatus: o.financial_status,
        fulfillmentStatus: o.fulfillment_status,
        currency: o.currency,
        subtotal: Number(o.subtotal_price),
        total: Number(o.total_price),
        itemCount: o.line_items.reduce((n, li) => n + li.quantity, 0),
        items: o.line_items.map((li) => mapItem(li, images)),
      })),
    };
  });

  // Full detail for a single order (ownership-checked by customer id).
  app.get("/orders/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const customer = await app.prisma.customer.findUniqueOrThrow({ where: { id: req.user.sub } });
    if (!customer.shopifyCustomerId || !shopifyEnabled) return reply.notFound("Order not found.");

    const order = await getOrder(id);
    if (!order) return reply.notFound("Order not found.");

    const images = await getProductImages(order.line_items.map((li) => li.product_id ?? 0));
    const shipping = Number(order.total_shipping_price_set?.shop_money?.amount ?? 0);
    const tracking = (order.fulfillments ?? [])
      .filter((f) => f.tracking_number)
      .map((f) => ({
        number: f.tracking_number,
        company: f.tracking_company ?? null,
        url: f.tracking_url ?? null,
      }));

    return {
      order: {
        id: order.id,
        name: order.name,
        createdAt: order.processed_at || order.created_at,
        financialStatus: order.financial_status,
        fulfillmentStatus: order.fulfillment_status,
        currency: order.currency,
        subtotal: Number(order.subtotal_price),
        tax: Number(order.total_tax ?? 0),
        shipping,
        discounts: Number(order.total_discounts ?? 0),
        total: Number(order.total_price),
        itemCount: order.line_items.reduce((n, li) => n + li.quantity, 0),
        note: order.note ?? null,
        shippingAddress: order.shipping_address ?? null,
        tracking,
        items: order.line_items.map((li) => mapItem(li, images)),
      },
    };
  });

  // Returns pulled from Shopify.
  app.get("/returns", async (req) => {
    const customer = await app.prisma.customer.findUniqueOrThrow({ where: { id: req.user.sub } });
    if (!customer.shopifyCustomerId || !shopifyEnabled) {
      return { linked: false, returns: [] };
    }
    try {
      const returns = await listReturnsForCustomer(customer.shopifyCustomerId);
      return { linked: true, returns };
    } catch (err) {
      req.log.error({ err }, "Failed to load returns");
      return { linked: true, returns: [] };
    }
  });
}
