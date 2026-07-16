import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "../lib/auth";
import { loyalty, type PointsTxn } from "../lib/api";
import { formatPoints } from "../lib/format";
import { useToast } from "../components/toast";
import { Card, Skeleton, Button, Badge } from "../components/ui";
import { GiftIcon, UsersIcon, BagIcon, SparkIcon, ChevronRight, StarIcon } from "../components/icons";

export function meta() {
  return [{ title: "Home · Vivo Loyalty" }];
}

const txnMeta: Record<string, { icon: string; tone: string }> = {
  EARN: { icon: "🛍️", tone: "#16a34a" },
  SIGNUP: { icon: "🎉", tone: "#6366f1" },
  BIRTHDAY: { icon: "🎂", tone: "#db2777" },
  REFERRAL: { icon: "🤝", tone: "#0ea5e9" },
  REDEEM: { icon: "🎁", tone: "#f59e0b" },
  REFUND: { icon: "↩️", tone: "#ef4444" },
  ADJUST: { icon: "⚙️", tone: "#6b7280" },
  STREAK: { icon: "🔥", tone: "#f97316" },
  EXPIRE: { icon: "⌛", tone: "#6b7280" },
};

export default function Dashboard() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [activity, setActivity] = useState<PointsTxn[] | null>(null);

  useEffect(() => {
    loyalty.history().then((r) => setActivity(r.items)).catch(() => setActivity([]));
  }, []);

  if (!user) return null;
  const tier = user.tier;
  const pct = Math.round(user.tierProgress * 100);
  const firstName = user.firstName ?? user.email.split("@")[0];

  const claimBirthday = async () => {
    try {
      const { awarded } = await loyalty.claimBirthday();
      toast(`🎂 Happy birthday! +${awarded} points`, "success");
      await refresh();
    } catch (e: any) {
      toast(e?.message ?? "Not available yet.", "error");
    }
  };

  return (
    <div className="space-y-5">
      <div className="pt-2">
        <p className="text-sm text-muted">Welcome back,</p>
        <h1 className="text-2xl font-bold tracking-tight">{firstName} 👋</h1>
      </div>

      {/* Points hero card */}
      <div
        className="relative overflow-hidden rounded-[1.75rem] p-6 text-white shadow-[var(--shadow-glow)]"
        style={{
          background: `linear-gradient(135deg, ${tier?.color ?? "#6366f1"} 0%, #4f46e5 55%, #7c3aed 100%)`,
        }}
      >
        <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/15 blur-2xl" />
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm/none opacity-80">Points balance</p>
            <p className="mt-2 text-5xl font-black tracking-tight">{formatPoints(user.pointsBalance)}</p>
          </div>
          <span className="flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1.5 text-sm font-semibold backdrop-blur">
            <span>{tier?.icon}</span> {tier?.name ?? "Member"}
          </span>
        </div>

        {/* Tier progress */}
        <div className="mt-6">
          {user.nextTier ? (
            <>
              <div className="flex justify-between text-xs opacity-90">
                <span>{formatPoints(user.pointsToNext)} pts to {user.nextTier.name}</span>
                <span>{pct}%</span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/25">
                <div className="h-full rounded-full bg-white transition-all" style={{ width: `${pct}%` }} />
              </div>
            </>
          ) : (
            <p className="text-xs opacity-90">🏆 You've reached the top tier — enjoy the perks!</p>
          )}
        </div>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-3 gap-3">
        <QuickAction to="/rewards" icon={<GiftIcon className="h-6 w-6" />} label="Redeem" />
        <QuickAction to="/referrals" icon={<UsersIcon className="h-6 w-6" />} label="Refer" />
        <QuickAction to="/orders" icon={<BagIcon className="h-6 w-6" />} label="Orders" />
      </div>

      {/* Birthday CTA */}
      {user.birthday && (
        <Card className="flex items-center justify-between !p-4">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🎂</span>
            <div>
              <p className="text-sm font-semibold">Birthday bonus</p>
              <p className="text-xs text-muted">Claim your gift during your birthday week.</p>
            </div>
          </div>
          <Button className="!px-4 !py-2 text-xs" onClick={claimBirthday}>
            Claim
          </Button>
        </Card>
      )}

      {/* Tier perks */}
      {tier && Array.isArray(tier.perks) && tier.perks.length > 0 && (
        <Card>
          <div className="mb-3 flex items-center gap-2">
            <StarIcon className="h-5 w-5 text-brand-500" />
            <h2 className="font-semibold">Your {tier.name} perks</h2>
          </div>
          <ul className="space-y-2">
            {tier.perks.map((p) => (
              <li key={p} className="flex items-center gap-2 text-sm text-muted">
                <span className="text-brand-500">✓</span> {p}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Recent activity */}
      <div>
        <div className="mb-2 flex items-center justify-between px-1">
          <h2 className="font-semibold">Recent activity</h2>
          <Link to="/profile" className="flex items-center text-xs font-medium text-brand-600">
            View all <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
        <Card className="!p-2">
          {activity === null ? (
            <div className="space-y-2 p-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : activity.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted">
              No activity yet. Make a purchase to start earning!
            </p>
          ) : (
            <ul>
              {activity.slice(0, 5).map((t) => {
                const m = txnMeta[t.type] ?? txnMeta.ADJUST;
                return (
                  <li key={t.id} className="flex items-center gap-3 rounded-2xl px-3 py-2.5">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--bg)] text-lg">
                      {m.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{t.description}</p>
                      <p className="text-xs text-muted">
                        {new Date(t.createdAt).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                        })}
                      </p>
                    </div>
                    <span
                      className="text-sm font-bold"
                      style={{ color: t.points >= 0 ? "#16a34a" : "#ef4444" }}
                    >
                      {t.points >= 0 ? "+" : ""}
                      {formatPoints(t.points)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function QuickAction({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <Link
      to={to}
      className="tap card flex flex-col items-center gap-2 !rounded-2xl !p-4 transition-transform active:scale-95"
    >
      <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-900/40 dark:text-brand-300">
        {icon}
      </span>
      <span className="text-xs font-semibold">{label}</span>
    </Link>
  );
}
