import React from "react";
import "./App.css";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./lib/auth";
import { Toaster } from "./components/ui/sonner";
import ProtectedRoute from "./components/ProtectedRoute";

import LoginPage from "./pages/Login";
import AuthCallback from "./pages/AuthCallback";
import Overview from "./pages/Overview";
import BranchDeepDive from "./pages/BranchDeepDive";
import Trends from "./pages/Trends";
import Alerts from "./pages/Alerts";
import EmployeeProfile from "./pages/EmployeeProfile";
import EmployeeDirectory from "./pages/EmployeeDirectory";
import Training from "./pages/Training";
import MonthlyReport from "./pages/MonthlyReport";
import LeaveAndNotes from "./pages/LeaveAndNotes";
import DaysWorked from "./pages/DaysWorked";
import HoursLost from "./pages/HoursLost";
import Heatmap from "./pages/Heatmap";

// Router base — the app is mounted under /hr/ by the shared proxy.
const BASENAME = import.meta.env.BASE_URL.replace(/\/$/, "");

function App() {
  return (
    <div className="App">
      <BrowserRouter basename={BASENAME}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="/" element={<ProtectedRoute><Overview /></ProtectedRoute>} />
            <Route path="/branches" element={<ProtectedRoute><BranchDeepDive /></ProtectedRoute>} />
            <Route path="/trends" element={<ProtectedRoute><Trends /></ProtectedRoute>} />
            <Route path="/alerts" element={<ProtectedRoute><Alerts /></ProtectedRoute>} />
            <Route path="/employees" element={<ProtectedRoute><EmployeeProfile /></ProtectedRoute>} />
            <Route path="/directory" element={<ProtectedRoute><EmployeeDirectory /></ProtectedRoute>} />
            <Route path="/training" element={<ProtectedRoute><Training /></ProtectedRoute>} />
            <Route path="/reports" element={<ProtectedRoute><MonthlyReport /></ProtectedRoute>} />
            <Route path="/days-worked" element={<ProtectedRoute><DaysWorked /></ProtectedRoute>} />
            <Route path="/hours-lost" element={<ProtectedRoute><HoursLost /></ProtectedRoute>} />
            <Route path="/heatmap" element={<ProtectedRoute><Heatmap /></ProtectedRoute>} />
            <Route path="/leave" element={<ProtectedRoute roles={["executive", "hr_manager"]}><LeaveAndNotes /></ProtectedRoute>} />
          </Routes>
          <Toaster position="top-right" richColors />
        </AuthProvider>
      </BrowserRouter>
    </div>
  );
}

export default App;
