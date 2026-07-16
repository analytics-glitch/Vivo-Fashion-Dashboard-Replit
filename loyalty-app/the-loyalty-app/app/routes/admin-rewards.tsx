import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router";
import { useAuth } from "../lib/auth";
import { admin, type AdminReward, type RewardInput } from "../lib/api";
import { Card, Skeleton, Badge, EmptyState } from "../components/ui";
import { GiftIcon } from "../components/icons";
import { formatPoints } from "../lib/format";

export function meta() {
  return [{ title: "Rewards Management · Vivo Admin" }];
}

const REWARD_TYPES = [
  { value: "PERCENT_DISCOUNT", label: "% Discount" },
  { value: "FIXED_DISCOUNT", label: "Fixed Discount (KES)" },
  { value: "FREE_SHIPPING", label: "Free Shipping" },
  { value: "FREE_PRODUCT", label: "Free Product" },
] as const;

const TYPE_LABELS: Record<AdminReward["type"], string> = {
  PERCENT_DISCOUNT: "% Discount",
  FIXED_DISCOUNT: "Fixed (KES)",
  FREE_SHIPPING: "Free Shipping",
  FREE_PRODUCT: "Free Product",
};

const EMPTY_FORM: RewardInput = {
  title: "",
  description: "",
  pointsCost: 500,
  type: "PERCENT_DISCOUNT",
  value: 10,
  imageUrl: null,
  stock: null,
  minTierId: null,
  sortOrder: 0,
  active: true,
};

export default function AdminRewardsPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  const [rewards, setRewards] = useState<AdminReward[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<RewardInput>(EMPTY_FORM);

  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!loading && (!user || user.role !== "ADMIN")) navigate("/dashboard", { replace: true });
  }, [user, loading, navigate]);

  useEffect(() => {
    if (user?.role !== "ADMIN") return;
    load();
  }, [user?.role]);

  function load() {
    setError(null);
    admin.rewards
      .list()
      .then((d) => setRewards(d.rewards))
      .catch((e) => setError(e?.message ?? "Couldn't load rewards."));
  }

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setSaveError(null);
    setShowForm(true);
  }

  function openEdit(r: AdminReward) {
    setEditingId(r.id);
    setForm({
      title: r.title,
      description: r.description,
      pointsCost: r.pointsCost,
      type: r.type,
      value: r.value,
      imageUrl: r.imageUrl,
      stock: r.stock,
      minTierId: r.minTierId,
      sortOrder: r.sortOrder,
      active: r.active,
    });
    setSaveError(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setSaveError(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    try {
      if (editingId) {
        const { reward } = await admin.rewards.update(editingId, form);
        setRewards((prev) => prev?.map((r) => (r.id === editingId ? reward : r)) ?? null);
      } else {
        const { reward } = await admin.rewards.create(form);
        setRewards((prev) => (prev ? [...prev, reward] : [reward]));
      }
      closeForm();
    } catch (e: unknown) {
      const err = e as { message?: string };
      setSaveError(err?.message ?? "Save failed. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(r: AdminReward) {
    try {
      const { reward } = await admin.rewards.update(r.id, { active: !r.active });
      setRewards((prev) => prev?.map((x) => (x.id === r.id ? reward : x)) ?? null);
    } catch {
    }
  }

  async function handleDelete(id: string) {
    setDeleting(true);
    try {
      await admin.rewards.delete(id);
      setRewards((prev) => prev?.filter((r) => r.id !== id) ?? null);
      setConfirmDelete(null);
    } catch (e: unknown) {
      const err = e as { message?: string };
      setSaveError(err?.message ?? "Delete failed.");
      setConfirmDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  function set<K extends keyof RewardInput>(k: K, v: RewardInput[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  if (user?.role !== "ADMIN") return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between pt-2">
        <div>
          <div className="flex items-center gap-2">
            <Link to="/admin" className="text-sm text-muted hover:text-[var(--fg)]">
              Admin
            </Link>
            <span className="text-sm text-muted">/</span>
            <h1 className="text-2xl font-bold tracking-tight">Rewards</h1>
          </div>
          <p className="text-sm text-muted">Add, edit, or disable rewards in the catalog</p>
        </div>
        <button
          onClick={openCreate}
          className="tap rounded-2xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white shadow-[var(--shadow-accent)]"
        >
          + Add reward
        </button>
      </div>

      {error ? (
        <EmptyState icon={<GiftIcon />} title="Unavailable" subtitle={error} />
      ) : !rewards ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : rewards.length === 0 ? (
        <EmptyState
          icon={<GiftIcon />}
          title="No rewards yet"
          subtitle="Add your first reward to get started."
        />
      ) : (
        <div className="space-y-3">
          {rewards.map((r) => (
            <RewardCard
              key={r.id}
              reward={r}
              onEdit={() => openEdit(r)}
              onToggle={() => toggleActive(r)}
              onDelete={() => setConfirmDelete(r.id)}
            />
          ))}
        </div>
      )}

      {saveError && !showForm && (
        <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600">{saveError}</p>
      )}

      {showForm && (
        <RewardFormSheet
          form={form}
          isEdit={!!editingId}
          saving={saving}
          error={saveError}
          onChange={set}
          onSubmit={handleSave}
          onClose={closeForm}
        />
      )}

      {confirmDelete && (
        <ConfirmSheet
          message="This reward will be permanently deleted. This can't be undone. Disable it instead to hide it from the catalog."
          confirmLabel="Delete"
          busy={deleting}
          onConfirm={() => handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

function RewardCard({
  reward,
  onEdit,
  onToggle,
  onDelete,
}: {
  reward: AdminReward;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <Card className="!p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent)]/10 text-[var(--accent)]">
          <GiftIcon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold">{reward.title}</span>
            <Badge color={reward.active ? "#16a34a" : "#6b7280"}>
              {reward.active ? "Active" : "Inactive"}
            </Badge>
            <Badge color="#6366f1">{TYPE_LABELS[reward.type]}</Badge>
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted">{reward.description}</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span>
              <span className="font-medium text-[var(--fg)]">{formatPoints(reward.pointsCost)}</span> pts
            </span>
            <span>
              Value:{" "}
              <span className="font-medium text-[var(--fg)]">
                {reward.type === "PERCENT_DISCOUNT"
                  ? `${reward.value}%`
                  : reward.type === "FIXED_DISCOUNT"
                    ? `KES ${reward.value}`
                    : reward.type === "FREE_SHIPPING"
                      ? "Free shipping"
                      : "Free product"}
              </span>
            </span>
            {reward.stock !== null && (
              <span>
                Stock:{" "}
                <span className="font-medium text-[var(--fg)]">{reward.stock}</span>
              </span>
            )}
            <span>
              Order:{" "}
              <span className="font-medium text-[var(--fg)]">{reward.sortOrder}</span>
            </span>
          </div>
        </div>
      </div>
      <div className="mt-3 flex gap-2 border-t border-[var(--card-border)] pt-3">
        <button
          onClick={onEdit}
          className="tap flex-1 rounded-xl border border-[var(--card-border)] py-1.5 text-xs font-medium"
        >
          Edit
        </button>
        <button
          onClick={onToggle}
          className="tap flex-1 rounded-xl border border-[var(--card-border)] py-1.5 text-xs font-medium"
        >
          {reward.active ? "Disable" : "Enable"}
        </button>
        <button
          onClick={onDelete}
          className="tap rounded-xl border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600"
        >
          Delete
        </button>
      </div>
    </Card>
  );
}

function RewardFormSheet({
  form,
  isEdit,
  saving,
  error,
  onChange,
  onSubmit,
  onClose,
}: {
  form: RewardInput;
  isEdit: boolean;
  saving: boolean;
  error: string | null;
  onChange: <K extends keyof RewardInput>(k: K, v: RewardInput[K]) => void;
  onSubmit: (e: React.FormEvent) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40 backdrop-blur-sm">
      <div className="max-h-[92dvh] overflow-y-auto rounded-t-3xl bg-[var(--bg)] px-4 pb-8 pt-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{isEdit ? "Edit reward" : "New reward"}</h2>
          <button onClick={onClose} className="tap text-muted text-2xl leading-none">
            ×
          </button>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Title">
            <input
              required
              value={form.title}
              onChange={(e) => onChange("title", e.target.value)}
              className="input"
              placeholder="e.g. 10% Off Your Next Order"
            />
          </Field>

          <Field label="Description">
            <textarea
              required
              value={form.description}
              onChange={(e) => onChange("description", e.target.value)}
              rows={2}
              className="input resize-none"
              placeholder="Short description shown on the reward card"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Points cost">
              <input
                required
                type="number"
                min={1}
                value={form.pointsCost}
                onChange={(e) => onChange("pointsCost", parseInt(e.target.value, 10) || 0)}
                className="input"
              />
            </Field>
            <Field label="Sort order">
              <input
                type="number"
                min={0}
                value={form.sortOrder ?? 0}
                onChange={(e) => onChange("sortOrder", parseInt(e.target.value, 10) || 0)}
                className="input"
              />
            </Field>
          </div>

          <Field label="Type">
            <select
              value={form.type}
              onChange={(e) => onChange("type", e.target.value as RewardInput["type"])}
              className="input"
            >
              {REWARD_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>

          {(form.type === "PERCENT_DISCOUNT" || form.type === "FIXED_DISCOUNT") && (
            <Field
              label={
                form.type === "PERCENT_DISCOUNT"
                  ? "Discount value (%)"
                  : "Discount amount (KES)"
              }
            >
              <input
                required
                type="number"
                min={0}
                step={form.type === "PERCENT_DISCOUNT" ? 1 : 50}
                value={form.value}
                onChange={(e) => onChange("value", parseFloat(e.target.value) || 0)}
                className="input"
              />
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Stock limit" hint="Leave blank = unlimited">
              <input
                type="number"
                min={0}
                value={form.stock ?? ""}
                onChange={(e) =>
                  onChange("stock", e.target.value === "" ? null : parseInt(e.target.value, 10))
                }
                className="input"
                placeholder="Unlimited"
              />
            </Field>
            <Field label="Image URL" hint="Optional">
              <input
                type="url"
                value={form.imageUrl ?? ""}
                onChange={(e) =>
                  onChange("imageUrl", e.target.value === "" ? null : e.target.value)
                }
                className="input"
                placeholder="https://…"
              />
            </Field>
          </div>

          <div className="flex items-center gap-3 rounded-2xl border border-[var(--card-border)] px-4 py-3">
            <input
              id="reward-active"
              type="checkbox"
              checked={form.active ?? true}
              onChange={(e) => onChange("active", e.target.checked)}
              className="h-4 w-4 rounded accent-[var(--accent)]"
            />
            <label htmlFor="reward-active" className="cursor-pointer text-sm font-medium">
              Active — visible in the rewards catalog
            </label>
          </div>

          {error && (
            <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="tap flex-1 rounded-2xl border border-[var(--card-border)] py-3 text-sm font-semibold"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="tap flex-1 rounded-2xl bg-[var(--accent)] py-3 text-sm font-semibold text-white shadow-[var(--shadow-accent)] disabled:opacity-60"
            >
              {saving ? "Saving…" : isEdit ? "Save changes" : "Create reward"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ConfirmSheet({
  message,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  message: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40 backdrop-blur-sm">
      <div className="rounded-t-3xl bg-[var(--bg)] px-4 pb-8 pt-6">
        <p className="text-sm text-muted">{message}</p>
        <div className="mt-4 flex gap-3">
          <button
            onClick={onCancel}
            className="tap flex-1 rounded-2xl border border-[var(--card-border)] py-3 text-sm font-semibold"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="tap flex-1 rounded-2xl bg-red-500 py-3 text-sm font-semibold text-white disabled:opacity-60"
          >
            {busy ? "Deleting…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <label className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</label>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
