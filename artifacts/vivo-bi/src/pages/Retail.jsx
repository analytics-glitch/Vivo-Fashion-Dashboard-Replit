import React, { useState } from "react";
import { useAuth } from "@/lib/auth";
import { canAccessPage } from "@/lib/permissions";
import { Loading } from "@/components/common";

// Retail hub — merges the former standalone Locations, Warehouse Returns,
// Excess Inventory and IBT pages as tabs (same pattern as the other hubs).
// Each tab keeps its ORIGINAL page id for permissions; the /retail route
// admits a user who can access ANY tab, and the old standalone routes
// redirect here with ?tab=.
const LocationsTab = React.lazy(() => import("./Locations"));
const WarehouseReturnsTab = React.lazy(() => import("./WarehouseReturns"));
const ExcessInventoryTab = React.lazy(() => import("./ExcessInventory"));
const IBTTab = React.lazy(() => import("./IBT"));
const RebalancingTab = React.lazy(() => import("./Rebalancing"));

const RETAIL_TABS = [
  { id: "locations", label: "Locations", pageId: "locations", el: LocationsTab },
  { id: "warehouse-returns", label: "Warehouse Returns", pageId: "warehouse-returns", el: WarehouseReturnsTab },
  { id: "excess-inventory", label: "Excess Inventory", pageId: "excess-inventory", el: ExcessInventoryTab },
  { id: "ibt", label: "IBT", pageId: "ibt", el: IBTTab },
  { id: "rebalancing", label: "Rebalancing", pageId: "rebalancing", el: RebalancingTab },
];

const RetailPage = () => {
  const { user } = useAuth();
  const visibleTabs = RETAIL_TABS.filter((t) => canAccessPage(user, t.pageId));
  const initialTab = (() => {
    const wanted = new URLSearchParams(window.location.search).get("tab");
    return visibleTabs.some((t) => t.id === wanted) ? wanted : (visibleTabs[0]?.id || "locations");
  })();
  const [tab, setTab] = useState(initialTab);
  const active = visibleTabs.find((t) => t.id === tab) || visibleTabs[0];
  const ActiveEl = active?.el;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5 border-b border-border overflow-x-auto" data-testid="retail-tabs">
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            data-testid={`retail-tab-${t.id}`}
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

export default RetailPage;
