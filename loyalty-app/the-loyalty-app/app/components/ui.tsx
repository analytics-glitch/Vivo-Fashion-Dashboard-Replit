import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const variants: Record<Variant, string> = {
  primary:
    "bg-[var(--accent)] text-white hover:bg-[var(--accent-600)] active:scale-[.98] shadow-[var(--shadow-accent)]",
  secondary:
    "bg-[var(--card)] text-[var(--text)] border border-[var(--card-border)] hover:border-brand-300 active:scale-[.98]",
  ghost: "text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-black/5 dark:hover:bg-white/5",
  danger: "bg-red-500 text-white hover:bg-red-600 active:scale-[.98]",
};

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
  full?: boolean;
}

export function Button({
  variant = "primary",
  loading,
  full,
  className = "",
  children,
  disabled,
  ...rest
}: BtnProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`tap inline-flex items-center justify-center gap-2 rounded-2xl px-5 py-3 text-sm font-semibold transition-all disabled:opacity-50 disabled:pointer-events-none ${
        variants[variant]
      } ${full ? "w-full" : ""} ${className}`}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
}

export function Spinner({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-90" d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card p-5 ${className}`}>{children}</div>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`shimmer rounded-xl ${className}`} />;
}

export function Badge({
  children,
  color = "#6366f1",
}: {
  children: ReactNode;
  color?: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold"
      style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  subtitle,
  action,
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-14 text-center fade-in">
      {icon && (
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-brand-50 text-brand-500 dark:bg-brand-900/30">
          {icon}
        </div>
      )}
      <div>
        <p className="font-semibold">{title}</p>
        {subtitle && <p className="mt-1 max-w-xs text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
