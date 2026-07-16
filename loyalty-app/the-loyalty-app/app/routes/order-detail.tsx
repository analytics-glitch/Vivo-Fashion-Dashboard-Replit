import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { shopify, type OrderDetail, ApiError } from "../lib/api";
import { formatMoney, formatDate } from "../lib/format";
import { Card, Skeleton, Badge, EmptyState } from "../components/ui";
import { BagIcon, ChevronRight } from "../components/icons";

export function meta() {
  return [{ title: "Order · Vivo Loyalty" }];
}

const statusColor = (s: string) => {
  const v = s?.toLowerCase();
  if (["paid", "fulfilled", "closed", "completed"].includes(v)) return "#16a34a";
  if (["pending", "open", "in_progress", "requested", "partial"].includes(v)) return "#f59e0b";
  if (["refunded", "cancelled", "voided", "declined"].includes(v)) return "#ef4444";
  return "#6b7280";
};

export default function OrderDetailPage() {
  const { orderId } = useParams();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orderId) return;
    shopify
      .order(orderId)
      .then((r) => setOrder(r.order))
      .catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't load this order."));
  }, [orderId]);

  return (
    <div className="space-y-4">
      {/* Back */}
      <Link to="/orders" className="tap inline-flex items-center gap-1 pt-2 text-sm font-medium text-muted">
        <ChevronRight className="h-4 w-4 rotate-180" /> Orders
      </Link>

      {error ? (
        <EmptyState icon={<BagIcon />} title="Order unavailable" subtitle={error} />
      ) : !order ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : (
        <>
          {/* Header */}
          <div
            className="overflow-hidden rounded-[1.5rem] p-5 text-white"
            style={{ background: "linear-gradient(135deg,#fe6a02,#e85f00)" }}
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm/none opacity-85">Order</p>
                <p className="mt-1 text-2xl font-black tracking-tight">{order.name}</p>
              </div>
              <p className="text-right text-2xl font-black">{formatMoney(order.total, order.currency)}</p>
            </div>
            <p className="mt-1 text-xs opacity-85">
              {formatDate(order.createdAt)} · {order.itemCount} item{order.itemCount === 1 ? "" : "s"}
            </p>
          </div>

          {/* Statuses */}
          <div className="flex flex-wrap gap-2">
            <Badge color={statusColor(order.financialStatus)}>Payment: {order.financialStatus}</Badge>
            <Badge color={statusColor(order.fulfillmentStatus ?? "unfulfilled")}>
              {order.fulfillmentStatus ? `Fulfilment: ${order.fulfillmentStatus}` : "Unfulfilled"}
            </Badge>
          </div>

          {/* Items */}
          <Card className="!p-4">
            <h2 className="mb-3 font-semibold">Items</h2>
            <ul className="space-y-3">
              {order.items.map((it) => (
                <li key={it.id} className="flex items-center gap-3">
                  {it.image ? (
                    <img src={it.image} alt="" className="h-14 w-14 rounded-xl object-cover" />
                  ) : (
                    <span className="grid h-14 w-14 place-items-center rounded-xl bg-[var(--bg)] text-xl">
                      🛍️
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{it.title}</p>
                    {it.variantTitle && it.variantTitle !== "Default Title" && (
                      <p className="truncate text-xs text-muted">{it.variantTitle}</p>
                    )}
                    <p className="text-xs text-muted">
                      Qty {it.quantity} · {formatMoney(it.price, order.currency)} each
                    </p>
                  </div>
                  <p className="text-sm font-semibold">
                    {formatMoney(it.price * it.quantity, order.currency)}
                  </p>
                </li>
              ))}
            </ul>
          </Card>

          {/* Totals */}
          <Card className="!p-4">
            <div className="space-y-1.5 text-sm">
              <Row label="Subtotal" value={formatMoney(order.subtotal, order.currency)} />
              {order.discounts > 0 && (
                <Row label="Discounts" value={`−${formatMoney(order.discounts, order.currency)}`} />
              )}
              <Row label="Shipping" value={formatMoney(order.shipping, order.currency)} />
              {order.tax > 0 && <Row label="Tax" value={formatMoney(order.tax, order.currency)} />}
              <div className="flex justify-between border-t border-[var(--card-border)] pt-2 text-base font-bold">
                <span>Total</span>
                <span className="text-[var(--accent)]">{formatMoney(order.total, order.currency)}</span>
              </div>
            </div>
          </Card>

          {/* Tracking */}
          {order.tracking.length > 0 && (
            <Card className="!p-4">
              <h2 className="mb-2 font-semibold">Tracking</h2>
              {order.tracking.map((t, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <span className="text-muted">{t.company || "Carrier"}</span>
                  {t.url ? (
                    <a href={t.url} target="_blank" rel="noreferrer" className="font-semibold text-[var(--accent)]">
                      {t.number} →
                    </a>
                  ) : (
                    <span className="font-mono font-semibold">{t.number}</span>
                  )}
                </div>
              ))}
            </Card>
          )}

          {/* Shipping address */}
          {order.shippingAddress && (
            <Card className="!p-4">
              <h2 className="mb-2 font-semibold">Shipping to</h2>
              <div className="text-sm text-muted">
                {order.shippingAddress.name && <p className="font-medium text-[var(--text)]">{order.shippingAddress.name}</p>}
                {order.shippingAddress.address1 && <p>{order.shippingAddress.address1}</p>}
                {order.shippingAddress.address2 && <p>{order.shippingAddress.address2}</p>}
                <p>
                  {[order.shippingAddress.city, order.shippingAddress.province, order.shippingAddress.zip]
                    .filter(Boolean)
                    .join(", ")}
                </p>
                {order.shippingAddress.country && <p>{order.shippingAddress.country}</p>}
                {order.shippingAddress.phone && <p className="mt-1">{order.shippingAddress.phone}</p>}
              </div>
            </Card>
          )}

          {/* Note */}
          {order.note && (
            <Card className="!p-4">
              <h2 className="mb-1 font-semibold">Order note</h2>
              <p className="text-sm text-muted">{order.note}</p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-muted">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
