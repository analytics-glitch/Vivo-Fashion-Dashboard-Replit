import { useEffect, useMemo, useState } from "react";
import { useNavigate, Link } from "react-router";
import { useAuth } from "../lib/auth";
import { admin, type AdminOverview, type AdminUser } from "../lib/api";
import { formatEAT, formatPoints, initials } from "../lib/format";
import { Card, Skeleton, Badge, EmptyState } from "../components/ui";
import { UsersIcon, GiftIcon } from "../components/icons";

export function meta() {
  return [{ title: "Admin · Vivo Loyalty" }];
}

export default function AdminPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  // Guard: admins only.
  useEffect(() => {
    if (!loading && (!user || user.role !== "ADMIN")) navigate("/dashboard", { replace: true });
  }, [user, loading, navigate]);

  useEffect(() => {
    if (user?.role !== "ADMIN") return;
    admin
      .overview()
      .then(setData)
      .catch((e) => setError(e?.message ?? "Couldn't load admin data."));
  }, [user?.role]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const term = q.trim().toLowerCase();
    if (!term) return data.users;
    return data.users.filter(
      (u) =>
        u.email.toLowerCase().includes(term) ||
        `${u.firstName ?? ""} ${u.lastName ?? ""}`.toLowerCase().includes(term),
    );
  }, [data, q]);

  if (user?.role !== "ADMIN") return null;

  return (
    <div className="space-y-4">
      <div className="pt-2">
        <h1 className="text-2xl font-bold tracking-tight">Admin</h1>
        <p className="text-sm text-muted">
          Users, activity & app installs{data?.build ? ` · build ${data.build.slice(0, 7)}` : ""}
        </p>
      </div>

      {/* Admin quick links */}
      <div className="grid grid-cols-2 gap-3">
        <Link
          to="/admin/rewards"
          className="tap flex items-center gap-3 rounded-2xl border border-[var(--card-border)] bg-[var(--card)] p-4"
        >
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--accent)]/10 text-[var(--accent)]">
            <GiftIcon className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-semibold">Rewards</p>
            <p className="text-xs text-muted">Manage catalog</p>
          </div>
        </Link>
      </div>

      {error ? (
        <EmptyState icon={<UsersIcon />} title="Unavailable" subtitle={error} />
      ) : !data ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Signups" value={formatPoints(data.stats.totalSignups)} />
            <Stat
              label={`Active now (${data.activeWindowMinutes}m)`}
              value={formatPoints(data.stats.activeNow)}
              dot
            />
            <Stat label="App installs" value={formatPoints(data.stats.installedCount)} />
            <Stat label="Total logins" value={formatPoints(data.stats.totalLogins)} />
          </div>

          {/* Search */}
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name or email…"
            className="w-full rounded-2xl border border-[var(--card-border)] bg-[var(--bg)] px-4 py-3 text-sm outline-none focus:border-brand-400"
          />

          {/* Users */}
          <p className="px-1 text-xs text-muted">
            {filtered.length} user{filtered.length === 1 ? "" : "s"} · sorted by last login
          </p>
          <div className="space-y-2.5">
            {filtered.map((u) => (
              <UserRow key={u.id} u={u} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, dot }: { label: string; value: string; dot?: boolean }) {
  return (
    <Card className="!p-4">
      <div className="flex items-center gap-1.5">
        {dot && <span className="h-2 w-2 rounded-full bg-green-500" />}
        <span className="text-2xl font-black">{value}</span>
      </div>
      <p className="mt-0.5 text-xs text-muted">{label}</p>
    </Card>
  );
}

function UserRow({ u }: { u: AdminUser }) {
  const name = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();
  const versionBadge =
    u.appUpToDate === true
      ? { text: "Latest", color: "#16a34a" }
      : u.appUpToDate === false
        ? { text: "Old app", color: "#f59e0b" }
        : { text: "No app data", color: "#6b7280" };

  return (
    <Card className="!p-3.5">
      <div className="flex items-center gap-3">
        <div className="relative">
          <div className="grid h-10 w-10 place-items-center rounded-full bg-[var(--accent)] text-sm font-bold text-white">
            {initials(u.firstName, u.lastName, u.email)}
          </div>
          {u.online && (
            <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[var(--card)] bg-green-500" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-semibold">{name || u.email.split("@")[0]}</p>
            {u.role === "ADMIN" && <Badge color="#6366f1">Admin</Badge>}
          </div>
          <p className="truncate text-xs text-muted">{u.email}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-bold">{u.loginCount}</p>
          <p className="text-[10px] text-muted">logins</p>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-[var(--card-border)] pt-2.5 text-xs">
        <Field label="Last login" value={formatEAT(u.lastLoginAt)} />
        <Field label="Last seen" value={formatEAT(u.lastSeenAt)} />
        <Field label="Signed up" value={formatEAT(u.createdAt)} />
        <div className="flex items-center gap-1.5">
          <Badge color={u.pwaInstalled ? "#16a34a" : "#6b7280"}>
            {u.pwaInstalled ? "Installed" : "Browser"}
          </Badge>
          <Badge color={versionBadge.color}>{versionBadge.text}</Badge>
        </div>
      </div>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="text-muted">{label}: </span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
