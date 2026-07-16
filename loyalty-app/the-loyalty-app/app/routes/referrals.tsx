import { useEffect, useState } from "react";
import { referrals as refApi, type ReferralOverview, ApiError } from "../lib/api";
import { formatPoints } from "../lib/format";
import { useToast } from "../components/toast";
import { Card, Button, Skeleton, Badge } from "../components/ui";
import { UsersIcon, CopyIcon, CheckIcon, MailIcon } from "../components/icons";

export function meta() {
  return [{ title: "Refer friends · Vivo Loyalty" }];
}

export default function ReferralsPage() {
  const toast = useToast();
  const [data, setData] = useState<ReferralOverview | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = () => {
    refApi.overview().then(setData).catch(() => {});
  };
  useEffect(load, []);

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.shareUrl);
      setCopied(true);
      toast("Referral link copied!", "success");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const share = async () => {
    if (!data) return;
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Vivo Loyalty",
          text: `Join Vivo Loyalty and get ${data.friendPoints} bonus points!`,
          url: data.shareUrl,
        });
      } catch {
        /* cancelled */
      }
    } else {
      copy();
    }
  };

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setBusy(true);
    try {
      await refApi.invite(email);
      toast(`Invitation sent to ${email} 🎉`, "success");
      setEmail("");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't send invite.", "error");
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <div className="space-y-4 pt-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="pt-2">
        <h1 className="text-2xl font-bold tracking-tight">Refer & earn</h1>
        <p className="text-sm text-muted">
          Give {formatPoints(data.friendPoints)} points, get {formatPoints(data.rewardPoints)}.
        </p>
      </div>

      {/* Hero */}
      <div className="relative overflow-hidden rounded-[1.75rem] bg-gradient-to-br from-brand-600 to-fuchsia-600 p-6 text-white">
        <div className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-white/15 blur-2xl" />
        <p className="text-sm opacity-90">Your referral code</p>
        <p className="mt-1 font-mono text-3xl font-black tracking-widest">{data.referralCode}</p>
        <div className="mt-5 flex gap-2">
          <Button variant="secondary" className="flex-1 !bg-white/15 !text-white !border-white/20" onClick={copy}>
            {copied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
            {copied ? "Copied" : "Copy link"}
          </Button>
          <Button variant="secondary" className="flex-1 !bg-white !text-brand-700" onClick={share}>
            Share
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Invited" value={data.stats.invited} />
        <Stat label="Joined" value={data.stats.completed} />
        <Stat label="Points earned" value={formatPoints(data.stats.pointsEarned)} />
      </div>

      {/* Invite by email */}
      <Card>
        <h2 className="mb-3 font-semibold">Invite by email</h2>
        <form onSubmit={invite} className="flex gap-2">
          <div className="flex flex-1 items-center gap-2 rounded-2xl border border-[var(--card-border)] bg-[var(--bg)] px-3">
            <MailIcon className="h-5 w-5 text-muted" />
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value.trim())}
              placeholder="friend@example.com"
              className="w-full bg-transparent py-3 text-sm outline-none"
            />
          </div>
          <Button type="submit" loading={busy} className="!px-4">
            Send
          </Button>
        </form>
      </Card>

      {/* History */}
      {data.referrals.length > 0 && (
        <div>
          <h2 className="mb-2 px-1 font-semibold">Your invites</h2>
          <Card className="!p-2">
            <ul>
              {data.referrals.map((r) => (
                <li key={r.id} className="flex items-center justify-between px-3 py-2.5">
                  <span className="truncate text-sm">{r.refereeEmail}</span>
                  <Badge color={r.status === "COMPLETED" ? "#16a34a" : "#f59e0b"}>
                    {r.status === "COMPLETED" ? "Joined" : "Pending"}
                  </Badge>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card flex flex-col items-center gap-1 !rounded-2xl !p-4 text-center">
      <span className="text-xl font-black">{value}</span>
      <span className="text-[11px] text-muted">{label}</span>
    </div>
  );
}
