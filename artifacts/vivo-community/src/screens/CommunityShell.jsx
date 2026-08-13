import React, { useState, useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import { Avatar } from "@/components/community/ui";
import TabHome from "@/components/community/TabHome";
import TabCommunity from "@/components/community/TabCommunity";
import TabShop from "@/components/community/TabShop";
import TabRewards from "@/components/community/TabRewards";
import TabProfile from "@/components/community/TabProfile";

const TABS = [
  { id: "home", label: "Home" },
  { id: "community", label: "Community" },
  { id: "shop", label: "Shop" },
  { id: "rewards", label: "Rewards" },
  { id: "profile", label: "Profile" },
];

export default function CommunityShell() {
  const { member, signOut } = useAuth();
  const initialTab = new URLSearchParams(window.location.search).get("tab") || "home";
  const [tab, setTab] = useState(TABS.some((t) => t.id === initialTab) ? initialTab : "home");

  // Sync tab state to URL
  useEffect(() => {
    const url = new URL(window.location);
    url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", url);
  }, [tab]);

  return (
    <>
      <style>{`
        @keyframes floatUp {
          0% { opacity: 1; transform: translate(-50%, 0) scale(1); }
          100% { opacity: 0; transform: translate(-50%, -40px) scale(1.2); }
        }
        .animate-float-up {
          animation: floatUp 0.8s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
        }
        .hide-scrollbar::-webkit-scrollbar {
          display: none;
        }
        .hide-scrollbar {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
      `}</style>
      <div className="min-h-[100dvh] bg-[#fbf9f6] text-[#2c2a29] font-sans selection:bg-[#d97706] selection:text-white" style={{ "--community-accent": "#c25e30" }}>

        {/* Sticky header + tab bar */}
        <div className="sticky top-0 z-40 bg-[#fbf9f6]/95 backdrop-blur-md border-b border-[#e8dfd5]">
          <div className="mx-auto max-w-[1200px] px-4 pt-3 flex items-center justify-between">
            <button onClick={() => setTab("home")} className="flex items-baseline gap-2">
              <span className="text-lg font-black tracking-[0.25em] text-[#2c2a29]">VIVO</span>
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#c25e30]">Community</span>
            </button>
            <div className="flex items-center gap-3">
              <button
                data-testid="header-points"
                onClick={() => setTab("rewards")}
                className="px-3 py-1.5 rounded-full bg-[#f5ece4] text-[#c25e30] text-xs font-bold hover:bg-[#eaddd1] transition-colors"
              >
                ⭐ {(member?.points ?? 0).toLocaleString()} pts
              </button>
              <button data-testid="header-avatar" onClick={() => setTab("profile")}>
                <Avatar initials={member?.initials || "V"} tier={member?.tier} size="sm" />
              </button>
            </div>
          </div>
          <div className="flex items-center justify-center px-4 overflow-x-auto hide-scrollbar">
            <div className="flex w-full max-w-[1200px] gap-6 sm:gap-8">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  data-testid={`tab-${t.id}`}
                  onClick={() => setTab(t.id)}
                  className={`py-3.5 text-sm sm:text-base font-semibold whitespace-nowrap transition-colors relative ${
                    tab === t.id ? "text-[#c25e30]" : "text-[#7a746e] hover:text-[#2c2a29]"
                  }`}
                >
                  {t.label}
                  {tab === t.id && (
                    <span className="absolute bottom-0 left-0 w-full h-[3px] bg-[#c25e30] rounded-t-full" />
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Main Content Area */}
        <main className="mx-auto max-w-[1200px] p-4 sm:p-6 lg:p-8 animate-in fade-in duration-500 pb-24">
          {tab === "home" && <TabHome onNavigate={setTab} member={member} />}
          {tab === "community" && <TabCommunity />}
          {tab === "shop" && <TabShop />}
          {tab === "rewards" && <TabRewards member={member} />}
          {tab === "profile" && <TabProfile member={member} onSignOut={signOut} />}
        </main>
      </div>
    </>
  );
}
