import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X, ChevronRight, HelpCircle, UserPlus, Target, Sparkles, MapPin, Truck, RotateCcw, HeartHandshake, ShieldCheck } from "lucide-react";

/**
 * The mobile overflow menu.
 *
 * The nav row only has space for four tabs on a phone. Rather than let the
 * rest scroll off the edge — where nothing signals they exist and a member has
 * to discover them by swiping a strip that does not look swipeable — the
 * remainder moves in here, behind a hamburger with a visible affordance.
 *
 * Which is also why this drawer carries MORE than the leftover tabs. A drawer
 * holding one item is worse than no drawer; these destinations already exist
 * in the app (?page= routes) and were previously reachable on a phone only by
 * digging through the Account tab.
 */
const MORE_LINKS = [
  { id: "refer", label: "Refer a friend", icon: UserPlus },
  { id: "missions", label: "Weekly missions", icon: Target },
  { id: "edits", label: "Vivo Edits", icon: Sparkles },
  { id: "stores", label: "Find a store", icon: MapPin },
  { id: "delivery", label: "Delivery", icon: Truck },
  { id: "returns", label: "Returns", icon: RotateCcw },
  { id: "givingback", label: "Giving back", icon: HeartHandshake },
  { id: "help", label: "Help & contact", icon: HelpCircle },
  { id: "mydata", label: "My data", icon: ShieldCheck },
];

function Row({ icon: Icon, label, active, onClick, testid }) {
  return (
    <button
      data-testid={testid}
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-5 min-h-[48px] text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset ${
        active ? "text-primary-ink bg-secondary/60" : "text-foreground hover:bg-secondary/50"
      }`}
    >
      <Icon size={18} strokeWidth={1.5} className={active ? "text-primary-ink" : "text-muted-foreground"} />
      <span className="flex-1 text-[14px] font-medium">{label}</span>
      <ChevronRight size={16} className="text-muted-foreground/60 shrink-0" />
    </button>
  );
}

export default function MobileMenu({ open, onClose, tabs = [], activeTab, onTab, onPage, activePage }) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = setTimeout(() => {
      const first = panelRef.current?.querySelector("[data-autofocus]") || panelRef.current;
      first?.focus?.();
    }, 0);
    const onKey = (e) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab" || !panelRef.current) return;
      const list = Array.from(
        panelRef.current.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])')
      ).filter((el) => !el.disabled);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!panelRef.current.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[95] sm:hidden" role="dialog" aria-modal="true" aria-label="Menu" data-testid="mobile-menu">
      <div className="absolute inset-0 bg-foreground/50" onClick={onClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="absolute inset-y-0 right-0 w-[82%] max-w-xs bg-background shadow-xl flex flex-col outline-none animate-in slide-in-from-right duration-300"
      >
        <div className="flex items-center justify-between pl-5 pr-2 h-14 border-b border-border shrink-0">
          <div className="font-serif text-lg text-foreground">Menu</div>
          <button
            data-testid="mobile-menu-close"
            data-autofocus
            onClick={onClose}
            aria-label="Close menu"
            className="w-11 h-11 rounded-full flex items-center justify-center hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto flex-grow py-2">
          {tabs.map((t) => (
            <Row
              key={t.id}
              testid={`tab-${t.id}-menu`}
              icon={t.icon}
              label={t.label}
              active={activeTab === t.id}
              onClick={() => { onClose(); onTab(t.id); }}
            />
          ))}

          <div className="px-5 pt-5 pb-2 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
            More
          </div>
          {MORE_LINKS.map((l) => (
            <Row
              key={l.id}
              testid={`menu-page-${l.id}`}
              icon={l.icon}
              label={l.label}
              active={activePage === l.id}
              onClick={() => { onClose(); onPage(l.id); }}
            />
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
