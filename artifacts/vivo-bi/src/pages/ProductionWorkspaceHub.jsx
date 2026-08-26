import React from "react";
import { Factory } from "@phosphor-icons/react";
import ProductionTabShell from "./ProductionTabShell";

const ProductionCommandCentre = React.lazy(() => import("./ProductionCommandCentre"));
const PlanningWorkspace = React.lazy(() => import("./ProductionWorkspace"));
const ExecutionCapture = React.lazy(() => import("./ProductionExecution"));
const ProductivityRecovery = React.lazy(() => import("./ProductionInsights"));

const WORKSPACE_TABS = [
  { id: "dashboard", label: "Command Centre", pageId: "production-workspace", el: ProductionCommandCentre },
  { id: "workspace", label: "Planning Workspace", pageId: "production-workspace", el: PlanningWorkspace },
  { id: "capture", label: "Execution Capture", pageId: "production-workspace", el: ExecutionCapture },
  { id: "insights", label: "Productivity & Recovery", pageId: "production-workspace", el: ProductivityRecovery },
];

export default function ProductionWorkspaceHub() {
  return (
    <div className="space-y-4" data-testid="production-workspace-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Factory size={21} className="text-brand" aria-hidden="true" />
            <h1 className="text-xl font-extrabold text-[#0f3d24]">Production Workspace</h1>
          </div>
          <p className="mt-1 text-[12px] text-muted">
            Plan, capture and recover production work from one authorized operational workspace.
          </p>
        </div>
      </div>
      <ProductionTabShell
        tabs={WORKSPACE_TABS}
        defaultTab="dashboard"
        legacyTabs={{ tracker: "production", report: "production-report" }}
      />
    </div>
  );
}