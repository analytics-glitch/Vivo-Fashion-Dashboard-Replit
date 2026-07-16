import { useEffect, useState } from "react";
import { Link } from "react-router";
import { shopify, type Order, type ReturnItem } from "../lib/api";
import { formatMoney, formatDate } from "../lib/format";
import { Card, Skeleton, EmptyState, Badge } from "../components/ui";
import { BagIcon, ChevronRight } from "../components/icons";

export function meta() {
  return [{ title: "Orders · Vivo Loyalty" }];
}

type Tab = "orders" | "returns";

const statusColor = (s: string) => {
  const v = s?.toLowerCase();
  if (["paid", "fulfilled", "closed", "completed"].includes(v)) return "#16a34a";
  if (["pending", "open", "in_progress", "requested"].includes(v)) return "#f59e0b";
  if (["refunded", "cancelled", "voided", "declined"].includes(v)) return "#ef4444";
  return "#6b7280";
};

export default function OrdersPage() {
  const [tab, setTab] = useState<Tab>("orders");
  const [orders, setOrders] = useState<{ linked: boolean; orders: Order[] } | null>(null);
  const [returns, setReturns] = useState<{ linked: boolean; returns: ReturnItem[] } | null>(null);

  useEffect(() => {
    shopify.orders().then(setOrders).catch(() => setOrders({ linked: false, orders: [] }));
    shopify.returns().then(setReturns).catch(() => setReturns({ linked: false, returns: [] }));
  }, []);

  return (
    <div className="space-y-4">
      <div className="pt-2">
        <h1 className="text-2xl font-bold tracking-tight">Orders</h1>
        <p className="text-sm text-muted">Your purchases and returns from the store.</p>
      </div>

      <div className="flex gap-1 rounded-2xl bg-[var(--card-border)]/50 p-1">
        {(["orders", "returns"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`tap flex-1 rounded-xl py-2 text-sm font-semibold capitalize transition-all ${
              tab === t ? "bg-[var(--accent)] text-white shadow-sm" : "text-muted"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "orders" ? (
        orders === null ? (
          <Loading />
        ) : !orders.linked ? (
          <NotLinked />
        ) : orders.orders.length === 0 ? (
          <EmptyState icon={<BagIcon />} title="No orders yet" subtitle="Your purchases will appear here." />
        ) : (
          <div className="space-y-3">
            {orders.orders.map((o) => (
              <OrderCard key={o.id} order={o} />
            ))}
          </div>
        )
      ) : returns === null ? (
        <Loading />
      ) : !returns.linked ? (
        <NotLinked />
      ) : returns.returns.length === 0 ? (
        <EmptyState icon={<BagIcon />} title="No returns" subtitle="You have no returns on record." />
      ) : (
        <div className="space-y-3">
          {returns.returns.map((r) => (
            <Card key={r.id} className="flex items-center justify-between !p-4">
              <div>
                <p className="font-semibold">{r.name || "Return"}</p>
                <p className="text-xs text-muted">
                  Order {r.orderName} · {r.totalQuantity} item(s)
                </p>
              </div>
              <Badge color={statusColor(r.status)}>{r.status}</Badge>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function OrderCard({ order }: { order: Order }) {
  const [open, setOpen] = useState(false);
  const extra = Math.max(0, order.total - order.subtotal);

  return (
    <Card className={`overflow-hidden !p-0 transition-all ${open ? "ring-2 ring-[var(--accent)]" : ""}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`tap flex w-full items-center justify-between gap-3 p-4 text-left transition-colors ${
          open ? "text-white" : ""
        }`}
        style={open ? { background: "linear-gradient(135deg,#fe6a02,#e85f00)" } : undefined}
      >
        <div className="min-w-0">
          <p className="font-semibold">{order.name}</p>
          <p className={`text-xs ${open ? "text-white/85" : "text-muted"}`}>
            {formatDate(order.createdAt)} · {order.itemCount} item{order.itemCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-right">
            <p className="font-bold">{formatMoney(order.total, order.currency)}</p>
            {!open && <Badge color={statusColor(order.financialStatus)}>{order.financialStatus}</Badge>}
          </div>
          <ChevronRight
            className={`h-5 w-5 shrink-0 transition-transform ${open ? "rotate-90 text-white" : "text-muted"}`}
          />
        </div>
      </button>

      {open && (
        <div className="rise px-4 pb-4 pt-3" style={{ background: "var(--accent-soft)" }}>
          <ul className="space-y-3">
            {order.items.map((it) => (
              <li key={it.id} className="flex items-center gap-3">
                {it.image ? (
                  <img src={it.image} alt="" className="h-12 w-12 rounded-lg object-cover" />
                ) : (
                  <span className="grid h-12 w-12 place-items-center rounded-lg bg-[var(--bg)] text-lg">
                    🛍️
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{it.title}</p>
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

          <div className="mt-4 space-y-1.5 border-t border-[var(--card-border)] pt-3 text-sm">
            <div className="flex justify-between text-muted">
              <span>Subtotal</span>
              <span>{formatMoney(order.subtotal, order.currency)}</span>
            </div>
            {extra > 0 && (
              <div className="flex justify-between text-muted">
                <span>Shipping, tax &amp; fees</span>
                <span>{formatMoney(extra, order.currency)}</span>
              </div>
            )}
            <div className="flex justify-between pt-1 font-bold">
              <span>Total</span>
              <span>{formatMoney(order.total, order.currency)}</span>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Badge color={statusColor(order.financialStatus)}>Payment: {order.financialStatus}</Badge>
            <Badge color={statusColor(order.fulfillmentStatus ?? "unfulfilled")}>
              {order.fulfillmentStatus ? `Fulfilment: ${order.fulfillmentStatus}` : "Unfulfilled"}
            </Badge>
          </div>

          <Link
            to={`/orders/${order.id}`}
            className="tap mt-4 flex items-center justify-center gap-1.5 rounded-2xl bg-[var(--accent)] py-3 text-sm font-semibold text-white shadow-[var(--shadow-accent)]"
          >
            View full order details <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      )}
    </Card>
  );
}

function Loading() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-20 w-full" />
      ))}
    </div>
  );
}

function NotLinked() {
  return (
    <EmptyState
      icon={<BagIcon />}
      title="No store account linked"
      subtitle="We couldn't find a store account for your email yet. Place an order with this email and it'll appear here."
    />
  );
}
