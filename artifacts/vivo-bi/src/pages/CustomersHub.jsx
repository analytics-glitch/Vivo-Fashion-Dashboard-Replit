import React, { useState } from "react";
import { useAuth } from "@/lib/auth";
import { canAccessPage } from "@/lib/permissions";
import { Loading } from "@/components/common";
import { ArrowSquareOut } from "@phosphor-icons/react";

// Customers hub — merges the former standalone Customers, Customer Details and
// CRM nav entries as tabs (same pattern as the Inventory / Product Development
// hubs). Each tab keeps its ORIGINAL page id for permissions; the /customers
// route admits a user who can access ANY tab, and /customer-details redirects
// here with ?tab=details. The CRM is a SEPARATE app served by the proxy at
// /crm/ — its tab does a real browser navigation instead of rendering in-SPA.
const CustomersTab = React.lazy(() => import("./Customers"));
const CustomerDetailsTab = React.lazy(() => import("./CustomerDetails"));

const CUST_TABS = [
  { id: "customers", label: "Customers", pageId: "customers", el: CustomersTab },
  { id: "details", label: "Customer Details", pageId: "customer-details", el: CustomerDetailsTab },
  { id: "crm", label: "CRM", pageId: "crm", external: "/crm/" },
  { id: "crm-desk", label: "CRM Desk", pageId: "crm", external: "https://crm.vivofashionbrands.com" },
];

const CustomersHubPage = () => {
  const { user } = useAuth();
  const visibleTabs = CUST_TABS.filter((t) => canAccessPage(user, t.pageId));
  const initialTab = (() => {
    const wanted = new URLSearchParams(window.location.search).get("tab");
    const t = visibleTabs.find((x) => x.id === wanted);
    return t && !t.external ? t.id : (visibleTabs.find((x) => !x.external)?.id || "customers");
  })();
  const [tab, setTab] = useState(initialTab);
  const active = visibleTabs.find((t) => t.id === tab) || visibleTabs.find((t) => !t.external);
  const ActiveEl = active?.el;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5 border-b border-border overflow-x-auto" data-testid="cust-tabs">
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              if (t.external) window.location.assign(t.external);
              else setTab(t.id);
            }}
            data-testid={`cust-tab-${t.id}`}
            className={
              "px-3.5 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors whitespace-nowrap inline-flex items-center gap-1 " +
              (t.id === active?.id
                ? "border-[#1a5c38] text-[#1a5c38]"
                : "border-transparent text-muted hover:text-foreground")
            }
          >
            {t.label}
            {t.external && <ArrowSquareOut size={12} weight="bold" />}
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

export default CustomersHubPage;
