import { useEffect } from "react";
import { Outlet, useNavigate } from "react-router";
import { useAuth } from "../lib/auth";
import { AppShell } from "../components/app-shell";
import { HydrateFallback } from "../root";

/**
 * Authenticated layout: guards nested routes and renders the app shell
 * (top bar + bottom nav). Redirects to /login when there's no session.
 */
export default function AppLayout() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !user) navigate("/login", { replace: true });
  }, [user, loading, navigate]);

  if (loading || !user) return <HydrateFallback />;

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
