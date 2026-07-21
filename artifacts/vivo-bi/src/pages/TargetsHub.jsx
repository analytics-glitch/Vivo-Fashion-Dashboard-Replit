import React, { useState } from "react";
import { useAuth } from "@/lib/auth";
import { canAccessPage } from "@/lib/permissions";
import { Loading } from "@/components/common";

// Targets hub — merges the former standalone Targets and Q3 Targets pages as
// tabs (same pattern as the other hubs). Each tab keeps its ORIGINAL page id
// for permissions; the /targets route admits a user who can access ANY tab,
// and /quarter-scorecard redirects here with ?tab=quarter.
const TargetsTrackerTab = React.lazy(() => import("./TargetsTracker"));
const QuarterScorecardTab = React.lazy(() => import("./QuarterScorecard"));

const TGT_TABS = [
  { id: "targets", label: "Targets", pageId: "targets", el: TargetsTrackerTab },
  { id: "quarter", label: "Mission 420", pageId: "quarter-scorecard", el: QuarterScorecardTab },
];

const TargetsHubPage = () => {
  const { user } = useAuth();
  const visibleTabs = TGT_TABS.filter((t) => canAccessPage(user, t.pageId));
  const initialTab = (() => {
    const wanted = new URLSearchParams(window.location.search).get("tab");
    return visibleTabs.some((t) => t.id === wanted) ? wanted : (visibleTabs[0]?.id || "targets");
  })();
  const [tab, setTab] = useState(initialTab);
  const active = visibleTabs.find((t) => t.id === tab) || visibleTabs[0];
  const ActiveEl = active?.el;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5 border-b border-border overflow-x-auto" data-testid="tgt-tabs">
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            data-testid={`tgt-tab-${t.id}`}
            className={
              "px-3.5 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors whitespace-nowrap " +
              (t.id === active?.id
                ? "border-[#1a5c38] text-[#1a5c38]"
                : "border-transparent text-muted hover:text-foreground")
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      {ActiveEl ? (
        <React.Suspense fallback={<Loading label="Loading…" />}>
          <ActiveEl />
        </React.Suspense>
      ) : null}
    </div>
  );
};

export default TargetsHubPage;
