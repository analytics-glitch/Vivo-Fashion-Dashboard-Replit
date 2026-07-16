import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useAuth } from "../lib/auth";
import { loyalty, type PointsTxn, ApiError } from "../lib/api";
import { formatPoints, initials, formatDate } from "../lib/format";
import { useToast } from "../components/toast";
import { Card, Button, Skeleton } from "../components/ui";
import { LogoutIcon, SparkIcon, UsersIcon, ChevronRight } from "../components/icons";

export function meta() {
  return [{ title: "Profile · Vivo Loyalty" }];
}

export default function ProfilePage() {
  const { user, refresh, logout } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [birthday, setBirthday] = useState("");
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<PointsTxn[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!user) return;
    setFirstName(user.firstName ?? "");
    setLastName(user.lastName ?? "");
    setPhone(user.phone ?? "");
    setBirthday(user.birthday ? user.birthday.slice(0, 10) : "");
  }, [user]);

  useEffect(() => {
    loyalty.history().then((r) => {
      setHistory(r.items);
      setCursor(r.nextCursor);
    });
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await loyalty.updateProfile({
        firstName,
        lastName,
        phone,
        ...(birthday ? { birthday: new Date(birthday).toISOString() } : {}),
      });
      await refresh();
      toast("Profile saved", "success");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't save.", "error");
    } finally {
      setSaving(false);
    }
  };

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const r = await loyalty.history(cursor);
      setHistory((h) => [...(h ?? []), ...r.items]);
      setCursor(r.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  };

  const signOut = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  if (!user) return null;

  return (
    <div className="space-y-5">
      {/* Identity */}
      <div className="flex flex-col items-center gap-3 pt-4 text-center">
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="h-20 w-20 rounded-full object-cover ring-4 ring-brand-100 dark:ring-brand-900/40" />
        ) : (
          <div className="grid h-20 w-20 place-items-center rounded-full bg-[var(--accent)] text-2xl font-bold text-white">
            {initials(user.firstName, user.lastName, user.email)}
          </div>
        )}
        <div>
          <p className="text-lg font-bold">
            {user.firstName ? `${user.firstName} ${user.lastName ?? ""}`.trim() : user.email}
          </p>
          <p className="text-sm text-muted">{user.email}</p>
        </div>
        <div className="flex gap-2">
          <span className="flex items-center gap-1 rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
            {user.tier?.icon} {user.tier?.name}
          </span>
          <span className="flex items-center gap-1 rounded-full bg-[var(--card)] px-3 py-1 text-xs font-semibold ring-1 ring-[var(--card-border)]">
            <SparkIcon className="h-3.5 w-3.5 text-brand-500" /> {formatPoints(user.lifetimePoints)} lifetime
          </span>
        </div>
      </div>

      {/* Editable details */}
      <Card>
        <h2 className="mb-3 font-semibold">Your details</h2>
        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name" value={firstName} onChange={setFirstName} placeholder="Jane" />
            <Field label="Last name" value={lastName} onChange={setLastName} placeholder="Doe" />
          </div>
          <Field label="Phone" value={phone} onChange={setPhone} placeholder="+254…" type="tel" />
          <Field label="Birthday" value={birthday} onChange={setBirthday} type="date" />
          <Button full type="submit" loading={saving}>
            Save changes
          </Button>
        </form>
      </Card>

      {/* Refer & Earn */}
      <Link
        to="/referrals"
        className="tap relative flex items-center gap-3 overflow-hidden rounded-[1.5rem] p-5 text-white shadow-[var(--shadow-accent)]"
        style={{ background: "linear-gradient(135deg,#fe6a02,#ff8f3c 50%,#e0431f)" }}
      >
        <div className="pointer-events-none absolute -right-6 -top-8 h-28 w-28 rounded-full bg-white/20 blur-2xl" />
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-white/20 backdrop-blur">
          <UsersIcon className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-bold">Refer &amp; Earn</p>
          <p className="text-xs text-white/85">Invite friends — you both get bonus points.</p>
        </div>
        <ChevronRight className="h-5 w-5 shrink-0" />
      </Link>

      {/* Full points history */}
      <div>
        <h2 className="mb-2 px-1 font-semibold">Points history</h2>
        <Card className="!p-2">
          {history === null ? (
            <div className="space-y-2 p-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : history.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted">No points activity yet.</p>
          ) : (
            <>
              <ul>
                {history.map((t) => (
                  <li key={t.id} className="flex items-center justify-between px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{t.description}</p>
                      <p className="text-xs text-muted">{formatDate(t.createdAt)} · {t.type}</p>
                    </div>
                    <span
                      className="text-sm font-bold"
                      style={{ color: t.points >= 0 ? "#16a34a" : "#ef4444" }}
                    >
                      {t.points >= 0 ? "+" : ""}
                      {formatPoints(t.points)}
                    </span>
                  </li>
                ))}
              </ul>
              {cursor && (
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="tap w-full py-3 text-sm font-semibold text-brand-600"
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              )}
            </>
          )}
        </Card>
      </div>

      {user.role === "ADMIN" && (
        <Link
          to="/admin"
          className="tap flex items-center justify-center gap-2 rounded-2xl bg-brand-600 py-3 text-sm font-semibold text-white"
        >
          <UsersIcon className="h-5 w-5" /> Admin dashboard
        </Link>
      )}

      <Button variant="danger" full onClick={signOut} className="!bg-transparent !text-red-500 ring-1 ring-red-200 dark:ring-red-900/50">
        <LogoutIcon className="h-5 w-5" />
        Sign out
      </Button>

      <p className="pb-2 text-center text-xs text-muted">Member since {formatDate(user.createdAt)}</p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-xl border border-[var(--card-border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-brand-400"
      />
    </label>
  );
}
