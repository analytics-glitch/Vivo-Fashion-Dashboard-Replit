import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Loading } from "@/components/common";
import { useAuth } from "@/lib/auth";
import { canAccessPage } from "@/lib/permissions";

/**
 * Shared tab shell for the Production Pipeline and standalone Production
 * Workspace pages. The tab content remains in its existing components so
 * data fetching, scope propagation, privacy redaction and provenance contracts
 * are not duplicated between routes.
 */
export default function ProductionTabShell({
  tabs,
  tracker,
  defaultTab,
  legacyPath = "/production",
  legacyTabs = {},
}) {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const visibleTabs = useMemo(
    () => tabs.filter((tab) => canAccessPage(user, tab.pageId)),
    [tabs, user],
  );
  const fallbackTab = defaultTab || visibleTabs[0]?.id;
  const requestedTab = new URLSearchParams(location.search).get("tab");
  const [tab, setTab] = useState(
    visibleTabs.some((item) => item.id === requestedTab)
      ? requestedTab
      : fallbackTab,
  );

  useEffect(() => {
    const wanted = new URLSearchParams(location.search).get("tab");
    setTab(visibleTabs.some((item) => item.id === wanted) ? wanted : fallbackTab);
  }, [fallbackTab, location.search, visibleTabs]);

  const withContext = useCallback((nextTab, extra = {}) => {
    const search = new URLSearchParams(location.search);
    search.set("tab", nextTab);
    Object.entries(extra).forEach(([key, value]) => {
      if (value == null || value === "") return;
      if (key === "date_from" || key === "date_to") search.set(key, String(value));
      else search.set(key.startsWith("prod_") ? key : `prod_${key}`, String(value));
    });
    return search;
  }, [location.search]);

  const selectTab = useCallback((nextTab, extra = {}) => {
    navigate({ pathname: location.pathname, search: `?${withContext(nextTab, extra).toString()}` });
  }, [location.pathname, navigate, withContext]);

  const openLegacyTab = useCallback((nextTab, context = {}) => {
    const pageId = legacyTabs[nextTab];
    if (!pageId || !canAccessPage(user, pageId)) return;
    navigate({ pathname: legacyPath, search: `?${withContext(nextTab, context).toString()}` });
  }, [legacyPath, legacyTabs, navigate, user, withContext]);

  const canOpen = useCallback((nextTab) => (
    visibleTabs.some((item) => item.id === nextTab)
      || (legacyTabs[nextTab] && canAccessPage(user, legacyTabs[nextTab]))
  ), [legacyTabs, user, visibleTabs]);
  const active = visibleTabs.find((item) => item.id === tab) || visibleTabs[0];
  const ActiveEl = active?.el;

  return (
    <div className="space-y-4" data-testid="production-tab-shell">
      <div className="flex items-center gap-1.5 border-b border-border overflow-x-auto" data-testid="prod-tabs">
        {visibleTabs.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => selectTab(item.id)}
            data-testid={`prod-tab-${item.id}`}
            aria-current={item.id === active?.id ? "page" : undefined}
            className={
              "px-3.5 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors whitespace-nowrap " +
              (item.id === active?.id
                ? "border-[#1a5c38] text-[#1a5c38]"
                : "border-transparent text-muted hover:text-foreground")
            }
          >
            {item.label}
          </button>
        ))}
      </div>
      {active?.id === "tracker" && tracker ? (
        tracker
      ) : ActiveEl ? (
        <React.Suspense fallback={<Loading label="Loading…" />}>
          <ActiveEl
            onOpenReport={
              canOpen("report")
                ? (context) => visibleTabs.some((item) => item.id === "report")
                  ? selectTab("report", context)
                  : openLegacyTab("report", context)
                : null
            }
            onOpenWorkspace={
              canOpen("workspace")
                ? (plan, context = {}) => selectTab("workspace", {
                  ...context,
                  factory_id: plan?.factory_id,
                  line_id: plan?.line_id,
                  shift_id: plan?.shift_id,
                  plan: plan?.plan_version_id,
                })
                : null
            }
            onOpenCapture={
              canOpen("capture")
                ? (context) => selectTab("capture", context)
                : null
            }
            onOpenTracker={
              canOpen("tracker")
                ? (context) => visibleTabs.some((item) => item.id === "tracker")
                  ? selectTab("tracker", context)
                  : openLegacyTab("tracker", context)
                : null
            }
            onOpenInsights={
              canOpen("insights")
                ? (context) => selectTab("insights", context)
                : null
            }
          />
        </React.Suspense>
      ) : null}
    </div>
  );
}