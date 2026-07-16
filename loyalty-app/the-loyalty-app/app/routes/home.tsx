import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../lib/auth";

export function meta() {
  return [{ title: "Vivo Loyalty" }];
}

export default function Home() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    navigate(user ? "/dashboard" : "/login", { replace: true });
  }, [user, loading, navigate]);

  return (
    <div className="grid min-h-[100dvh] place-items-center px-8">
      <img
        src="/loyalty-app/icons/vivo-icon.png"
        alt="Vivo Loyalty"
        className="w-40 max-w-[55%] animate-pulse rounded-3xl"
      />
    </div>
  );
}
