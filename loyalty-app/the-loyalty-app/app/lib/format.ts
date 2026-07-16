export function formatPoints(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

export function formatMoney(amount: number, currency = "KES"): string {
  try {
    return new Intl.NumberFormat("en-KE", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// East Africa Time (UTC+3) — for the admin dashboard.
export function formatEAT(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return (
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Nairobi",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(iso)) + " EAT"
    );
  } catch {
    return "—";
  }
}

export function relativeTime(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(iso);
}

export function initials(first?: string | null, last?: string | null, email?: string): string {
  const f = first?.trim()?.[0] ?? "";
  const l = last?.trim()?.[0] ?? "";
  if (f || l) return (f + l).toUpperCase();
  return (email?.[0] ?? "?").toUpperCase();
}

export function rewardLabel(type: string, value: number): string {
  switch (type) {
    case "PERCENT_DISCOUNT":
      return `${value}% off`;
    case "FIXED_DISCOUNT":
      return `${formatMoney(value)} off`;
    case "FREE_SHIPPING":
      return "Free shipping";
    case "FREE_PRODUCT":
      return "Free product";
    default:
      return "Reward";
  }
}
