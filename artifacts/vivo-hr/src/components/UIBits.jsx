import React from "react";
import { Loader2 } from "lucide-react";

export const PageHeader = ({ title, subtitle, actions, testId }) => (
  <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between" data-testid={testId}>
    <div>
      <h1 className="font-serif font-bold tracking-tight text-3xl sm:text-4xl text-brand-deep">
        {title}
      </h1>
      {subtitle && <p className="mt-1.5 text-[13px] text-muted-foreground max-w-2xl">{subtitle}</p>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
);

export const LoadingState = ({ label = "Loading…" }) => (
  <div className="flex items-center justify-center gap-3 py-16 text-muted-foreground" data-testid="loading-state">
    <Loader2 className="h-5 w-5 animate-spin text-brand" />
    <span className="text-sm">{label}</span>
  </div>
);

export const EmptyState = ({ title = "Nothing to show", description, icon: Icon }) => (
  <div className="flex flex-col items-center justify-center gap-2 py-16 text-center" data-testid="empty-state">
    {Icon && <Icon className="h-8 w-8 text-muted-foreground" />}
    <div className="text-base font-semibold">{title}</div>
    {description && <div className="text-sm text-muted-foreground max-w-md">{description}</div>}
  </div>
);

export const ErrorState = ({ message }) => (
  <div className="rounded-2xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger" data-testid="error-state">
    {message || "Something went wrong"}
  </div>
);

export const StatusDot = ({ color = "green", className = "" }) => {
  const map = {
    green: "bg-success",
    orange: "bg-warning",
    red: "bg-danger",
    offline: "bg-muted-foreground/60",
    gray: "bg-muted-foreground/60",
  };
  return (
    <span className={`inline-block h-2 w-2 rounded-full ${map[color] || map.gray} ${className}`} />
  );
};
