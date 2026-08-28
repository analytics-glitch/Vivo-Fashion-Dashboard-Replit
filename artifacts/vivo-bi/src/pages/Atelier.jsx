import React from "react";
import { Routes, Route, Navigate, useLocation, Link } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import AtelierBoard from "./atelier/AtelierBoard";
import AtelierJobDetail from "./atelier/AtelierJobDetail";
import AtelierReports from "./atelier/AtelierReports";
import AtelierSettings from "./atelier/AtelierSettings";
import { Scissors, FileBarChart, Settings as SettingsIcon } from "lucide-react";

export default function Atelier() {
  const { user } = useAuth();
  const location = useLocation();
  const isAdmin = user?.role === "admin";

  const isBoardActive = location.pathname === "/atelier" || location.pathname === "/atelier/" || location.pathname.startsWith("/atelier/jobs");
  const isReportsActive = location.pathname.startsWith("/atelier/reports");
  const isSettingsActive = location.pathname.startsWith("/atelier/settings");

  return (
    <div className="flex flex-col gap-6 h-full w-full fade-in">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-lg bg-[var(--accent)] text-white flex items-center justify-center shadow-md">
          <Scissors className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--text)] tracking-tight">Atelier</h1>
          <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wider">Junction Operations</p>
        </div>
      </div>

      <div className="border-b border-[var(--border)] flex gap-6 px-1 overflow-x-auto">
        <Link 
          to="/atelier" 
          data-testid="tab-board"
          className={`pb-3 font-semibold text-sm border-b-2 flex items-center gap-2 transition-colors ${isBoardActive ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"}`}
        >
          <Scissors className="h-4 w-4" /> Board & Intake
        </Link>
        <Link 
          to="/atelier/reports" 
          data-testid="tab-reports"
          className={`pb-3 font-semibold text-sm border-b-2 flex items-center gap-2 transition-colors ${isReportsActive ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"}`}
        >
          <FileBarChart className="h-4 w-4" /> Reports
        </Link>
        {isAdmin && (
          <Link 
            to="/atelier/settings" 
            data-testid="tab-settings"
            className={`pb-3 font-semibold text-sm border-b-2 flex items-center gap-2 transition-colors ${isSettingsActive ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"}`}
          >
            <SettingsIcon className="h-4 w-4" /> Settings
          </Link>
        )}
      </div>

      <div className="flex-1">
        <Routes>
          <Route path="/" element={<AtelierBoard />} />
          <Route path="/jobs/:id" element={<AtelierJobDetail />} />
          <Route path="/reports" element={<AtelierReports />} />
          {isAdmin && <Route path="/settings" element={<AtelierSettings />} />}
          <Route path="*" element={<Navigate to="/atelier" replace />} />
        </Routes>
      </div>
    </div>
  );
}