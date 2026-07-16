import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";
import { rewards as rewardsApi, type Reward, type Redemption, ApiError } from "../lib/api";
import { formatPoints } from "../lib/format";
import { useToast } from "../components/toast";
import { Card, Button, Skeleton, EmptyState, Badge } from "../components/ui";
import { GiftIcon, SparkIcon, CopyIcon, CheckIcon } from "../components/icons";

export function meta() {
  return [{ title: "Rewards · Vivo Loyalty" }];
}

type Tab = "catalog" | "mine";

export default function RewardsPage() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("catalog");
  const [catalog, setCatalog] = useState<Reward[] | null>(null);
  const [mine, setMine] = useState<Redemption[] | null>(null);
  const [redeeming, setRedeeming] = useState<string | null>(null);

  const load = () => {
    rewardsApi.list().then((r) => setCatalog(r.rewards)).catch(() => setCatalog([]));
    rewardsApi.redemptions().then((r) => setMine(r.redemptions)).catch(() => setMine([]));
  };
  useEffect(load, []);

  const redeem = async (reward: Reward) => {
    setRedeeming(reward.id);
    try {
      await rewardsApi.redeem(reward.id);
      toast(`Redeemed ${reward.title}! Check "My rewards".`, "success");
      await refresh();
      load();
      setTab("mine");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Redemption failed.", "error");
    } finally {
      setRedeeming(null);
    }
  };

  const balance = user?.pointsBalance ?? 0;

  return (
    <div className="space-y-4">
      <div className="pt-2">
        <h1 className="text-2xl font-bold tracking-tight">Rewards</h1>
        <p className="flex items-center gap-1.5 text-sm text-muted">
          <SparkIcon className="h-4 w-4 text-[var(--accent)]" />
          {formatPoints(balance)} points available
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-2xl bg-[var(--card-border)]/50 p-1">
        {(["catalog", "mine"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`tap flex-1 rounded-xl py-2 text-sm font-semibold transition-all ${
              tab === t ? "bg-[var(--accent)] text-white shadow-sm" : "text-muted"
            }`}
          >
            {t === "catalog" ? "Catalog" : "My rewards"}
          </button>
        ))}
      </div>

      {tab === "catalog" ? (
        catalog === null ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : catalog.length === 0 ? (
          <EmptyState icon={<GiftIcon />} title="No rewards yet" subtitle="Check back soon for new rewards." />
        ) : (
          <div className="space-y-3">
            {catalog.map((r) => {
              const affordable = balance >= r.pointsCost;
              return (
                <Card key={r.id} className="flex items-center gap-4 !p-4">
                  <div
                    className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-2xl font-bold text-white"
                    style={{ background: "linear-gradient(135deg,#fe6a02,#c25000)" }}
                  >
                    {r.type === "FREE_SHIPPING" ? "🚚" : r.type === "PERCENT_DISCOUNT" ? "%" : r.type === "FREE_PRODUCT" ? "🎁" : "KES"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{r.title}</p>
                    <p className="mt-0.5 text-xs text-muted">{r.description}</p>
                    <p className="mt-1 flex items-center gap-1 text-sm font-bold text-[var(--accent)]">
                      <SparkIcon className="h-3.5 w-3.5" />
                      {formatPoints(r.pointsCost)}
                    </p>
                  </div>
                  <Button
                    className="!px-4 !py-2.5 text-xs"
                    variant={affordable ? "primary" : "secondary"}
                    disabled={!affordable}
                    loading={redeeming === r.id}
                    onClick={() => redeem(r)}
                  >
                    {affordable ? "Redeem" : "Locked"}
                  </Button>
                </Card>
              );
            })}
          </div>
        )
      ) : mine === null ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : mine.length === 0 ? (
        <EmptyState
          icon={<GiftIcon />}
          title="No redemptions yet"
          subtitle="Redeem points from the catalog to get discount codes."
        />
      ) : (
        <div className="space-y-3">
          {mine.map((r) => (
            <RedemptionCard key={r.id} redemption={r} onCopy={(c) => toast(`Copied ${c}`, "success")} />
          ))}
        </div>
      )}
    </div>
  );
}

function RedemptionCard({
  redemption,
  onCopy,
}: {
  redemption: Redemption;
  onCopy: (code: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const code = redemption.discountCode ?? "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      onCopy(code);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const used = redemption.status !== "ISSUED";

  return (
    <Card className="!p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-semibold">{redemption.reward.title}</p>
          <p className="text-xs text-muted">−{formatPoints(redemption.pointsSpent)} points</p>
        </div>
        <Badge color={used ? "#6b7280" : "#16a34a"}>{redemption.status}</Badge>
      </div>
      <button
        onClick={copy}
        disabled={!code || used}
        className="tap mt-3 flex w-full items-center justify-between rounded-2xl border border-dashed px-4 py-3 disabled:opacity-60"
        style={{ borderColor: "color-mix(in srgb, var(--accent) 45%, transparent)", background: "var(--accent-soft)" }}
      >
        <span className="font-mono text-base font-bold tracking-wider text-[var(--accent-700)] dark:text-[var(--accent)]">
          {code || "—"}
        </span>
        {copied ? (
          <CheckIcon className="h-5 w-5 text-green-600" />
        ) : (
          <CopyIcon className="h-5 w-5 text-[var(--accent)]" />
        )}
      </button>
    </Card>
  );
}
