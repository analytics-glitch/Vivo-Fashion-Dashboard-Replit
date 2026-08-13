import React, { useState, useEffect } from "react";
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

export default function CommunityApp() {
  const initialTab = new URLSearchParams(window.location.search).get("tab") || "home";
  const [tab, setTab] = useState(TABS.some(t => t.id === initialTab) ? initialTab : "home");

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
      <div className="min-h-[100dvh] bg-[#fbf9f6] text-[#2c2a29] font-sans selection:bg-[#d97706] selection:text-white" style={{ '--community-accent': '#c25e30' }}>
        {/* Sticky Tab Bar */}
        <div 
          className="sticky border-b border-[#e8dfd5] bg-[#fbf9f6]/95 backdrop-blur-md z-30 flex items-center justify-center px-4 overflow-x-auto hide-scrollbar"
          style={{ top: "var(--app-navbar-h)" }}
        >
          <div className="flex w-full max-w-[1200px] gap-6 sm:gap-8">
            {TABS.map((t) => (
              <button
                key={t.id}
                data-testid={`tab-${t.id}`}
                onClick={() => setTab(t.id)}
                className={`py-4 text-sm sm:text-base font-semibold whitespace-nowrap transition-colors relative ${
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

        {/* Main Content Area */}
        <main className="mx-auto max-w-[1200px] p-4 sm:p-6 lg:p-8 animate-in fade-in duration-500 pb-24">
          {tab === "home" && <TabHome onNavigate={setTab} />}
          {tab === "community" && <TabCommunity />}
          {tab === "shop" && <TabShop />}
          {tab === "rewards" && <TabRewards />}
          {tab === "profile" && <TabProfile />}
        </main>
      </div>
    </>
  );
}
