import React, { useRef, useState } from "react";
import html2canvas from "html2canvas";
import { fmtKESMobile } from "@/lib/api";
import { X, DownloadSimple, CircleNotch, Clock, Ticket, Sparkle, Target, RocketLaunch, WarningCircle, CheckCircle } from "@phosphor-icons/react";
import { toast } from "sonner";

export default function OnlineSeptemberSnapshot({ campaign, onClose }) {
  const captureRef = useRef(null);
  const [saving, setSaving] = useState(false);

  const onSaveImage = async () => {
    if (!captureRef.current || saving) return;
    setSaving(true);
    try {
      const canvas = await html2canvas(captureRef.current, {
        scale: 2,
        useCORS: true,
        backgroundColor: null,
        logging: false,
      });
      const link = document.createElement("a");
      const cleanLabel = (campaign?.label || "campaign").toLowerCase().replace(/[^a-z0-9]+/g, "-");
      link.download = `vivo-${cleanLabel}-snapshot.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
      toast.success("Online September snapshot saved — ready to share", { duration: 3000 });
    } catch (e) {
      toast.error("Couldn't save snapshot — " + (e?.message || "unknown error"));
    } finally {
      setSaving(false);
    }
  };

  if (!campaign) return null;

  const pct = Math.min(100, Math.max(0, campaign.progress_pct || 0));
  const isWinner = campaign.status === "won" || pct >= 100;

  return (
    <div className="fixed inset-0 z-[60] overflow-y-auto bg-black/40 backdrop-blur-sm flex items-start justify-center" data-testid="online-september-snapshot">
      <div className="w-full max-w-[420px] px-3 pt-6 pb-12">
        {/* Toolbar */}
        <div className="flex items-center justify-end gap-2 mb-3" data-html2canvas-ignore="true">
          <button
            type="button"
            onClick={onSaveImage}
            disabled={saving}
            data-testid="snapshot-save"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-bold border border-[#1a5c38] bg-[#1a5c38] text-white hover:bg-[#0f3d24] transition-colors disabled:opacity-60 disabled:cursor-wait shadow-sm"
          >
            {saving ? <CircleNotch size={14} className="animate-spin" /> : <DownloadSimple size={14} weight="bold" />}
            {saving ? "Saving…" : "Save Image"}
          </button>
          <button
            type="button"
            onClick={onClose}
            data-testid="snapshot-close"
            className="p-1.5 rounded-full border border-gray-300 bg-white text-gray-800 hover:bg-gray-100 transition-colors shadow-sm"
            aria-label="Exit snapshot"
          >
            <X size={16} weight="bold" />
          </button>
        </div>

        {/* Capture Area */}
        <div
          ref={captureRef}
          data-snapshot-capture
          className="relative rounded-3xl bg-[#FFFBF4] p-5 shadow-2xl overflow-hidden border border-[#E5E7EB]"
        >
          {/* Subtle Celebration Background Elements (Radial gradients instead of blur filters for html2canvas safety) */}
          <div 
            className="absolute -top-16 -right-16 w-64 h-64 pointer-events-none" 
            style={{ background: 'radial-gradient(circle, rgba(254,243,199,0.8) 0%, rgba(254,243,199,0) 70%)' }} 
          />
          <div 
            className="absolute -bottom-16 -left-16 w-72 h-72 pointer-events-none" 
            style={{ background: 'radial-gradient(circle, rgba(209,250,229,0.7) 0%, rgba(209,250,229,0) 70%)' }} 
          />
          
          {/* Sparkle Shapes (CSS/SVG only) */}
          <div className="absolute top-6 left-6 text-amber-300/80 rotate-12 pointer-events-none">
            <Sparkle size={24} weight="fill" />
          </div>
          <div className="absolute top-12 right-8 text-emerald-300/80 -rotate-12 pointer-events-none">
            <Sparkle size={18} weight="fill" />
          </div>
          <div className="absolute bottom-32 left-8 text-orange-300/60 rotate-45 pointer-events-none">
            <Sparkle size={20} weight="fill" />
          </div>

          <div className="relative z-10 flex flex-col items-center text-center mt-2">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#FFEDD5] text-[#92400E] text-[10px] font-black uppercase tracking-widest mb-3 border border-[#FDBA74] shadow-sm">
              <Sparkle size={12} weight="fill" className="text-orange-500" />
              {campaign.channel || "Online"} Challenge
              <Sparkle size={12} weight="fill" className="text-orange-500" />
            </div>
            <h1 className="font-serif font-extrabold text-[32px] leading-[1.05] tracking-tight text-[#7C2D12] px-2">
              {campaign.label}
            </h1>
            <div className="text-[13px] font-bold text-[#B45309] mt-2 tracking-wide uppercase">
              {campaign.month_label}
            </div>
          </div>

          {/* Core Metrics & Progress */}
          <div className="relative z-10 mt-6 rounded-[20px] bg-gradient-to-b from-[#1A5C38] to-[#0F3D24] p-5 text-white shadow-xl border border-[#0F3D24] ring-1 ring-white/10 ring-inset">
            <div className="flex justify-between items-end mb-5">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-emerald-300/90 mb-1">
                  Target
                </div>
                <div className="font-extrabold text-[18px] text-emerald-50 tabular-nums">
                  {fmtKESMobile(campaign.goal_kes || 0)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] font-bold uppercase tracking-widest text-emerald-300/90 mb-1">
                  Achieved
                </div>
                <div className="font-extrabold text-[28px] leading-none text-white tabular-nums drop-shadow-md">
                  {fmtKESMobile(campaign.achieved_kes || 0)}
                </div>
              </div>
            </div>

            {/* Progress Meter */}
            <div className="relative h-7 bg-[#062614] rounded-full overflow-hidden shadow-inner border border-black/20">
              <div 
                className="absolute top-0 left-0 h-full bg-gradient-to-r from-[#10B981] to-[#34D399] rounded-full flex items-center justify-end pr-2"
                style={{ width: `${pct}%` }}
              >
                {/* Glossy highlight */}
                <div className="absolute inset-0 bg-gradient-to-b from-white/25 to-transparent pointer-events-none" />
                {pct >= 15 && (
                  <span className="text-[11px] font-black text-[#062614] tabular-nums z-10 drop-shadow-[0_1px_1px_rgba(255,255,255,0.4)]">
                    {pct.toFixed(1)}%
                  </span>
                )}
              </div>
              {pct < 15 && (
                <div className="absolute inset-0 flex items-center pl-3">
                  <span className="text-[11px] font-black text-emerald-50 tabular-nums z-10">
                    {pct.toFixed(1)}%
                  </span>
                </div>
              )}
            </div>

            {/* Remaining / Projection Context */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-[11px]">
              <div className="flex items-center gap-1.5 bg-black/20 px-2.5 py-1 rounded-lg border border-white/5">
                <Target size={14} weight="fill" className="text-emerald-400" />
                <span className="text-emerald-100 font-medium">
                  <strong className="text-white tabular-nums tracking-wide">{fmtKESMobile(campaign.remaining_kes || 0)}</strong> to go
                </span>
              </div>
              {campaign.projection_meaningful && campaign.projected_landing_kes != null && (
                <div className="flex items-center gap-1.5 bg-black/20 px-2.5 py-1 rounded-lg border border-white/5">
                  <RocketLaunch size={14} weight="fill" className="text-amber-400" />
                  <span className="text-emerald-100 font-medium">
                    Projected landing: <strong className="text-amber-400 tabular-nums tracking-wide">{fmtKESMobile(campaign.projected_landing_kes)}</strong>
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Reward Ticket */}
          <div className="relative z-10 mt-5">
            <div className="relative rounded-[14px] bg-gradient-to-br from-[#F59E0B] to-[#D97706] p-[2px] shadow-lg">
              {/* Inner dashed ticket */}
              <div className="relative h-full w-full rounded-[12px] bg-gradient-to-br from-[#FEF3C7] to-[#FDE68A] border border-dashed border-[#B45309]/30 p-4 flex items-center gap-3.5 overflow-hidden">
                
                {/* Left Hole (matching outer bg) */}
                <div className="absolute left-[-2px] top-1/2 -translate-y-1/2 w-3.5 h-6 bg-[#FFFBF4] rounded-r-full border-r border-y border-dashed border-[#B45309]/30" />
                
                {/* Right Hole (matching outer bg) */}
                <div className="absolute right-[-2px] top-1/2 -translate-y-1/2 w-3.5 h-6 bg-[#FFFBF4] rounded-l-full border-l border-y border-dashed border-[#B45309]/30" />

                <div className="shrink-0 ml-3 bg-gradient-to-b from-[#D97706] to-[#B45309] text-white p-2.5 rounded-full shadow-inner ring-2 ring-white/40">
                  <Ticket size={22} weight="fill" />
                </div>
                
                <div className="flex-1 min-w-0 pr-3 z-10">
                  <div className="text-[9px] font-black uppercase tracking-widest text-[#B45309] mb-1">
                    The Reward
                  </div>
                  <div className="text-[19px] font-extrabold text-[#7C2D12] leading-none mb-1.5 drop-shadow-sm">
                    KES {Number(campaign.reward_kes || 5000).toLocaleString()} Voucher
                  </div>
                  <div className="text-[11px] font-bold text-[#92400E]">
                    per employee if target is hit!
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Status Message */}
          {campaign.status_message && (
            <div className={`relative z-10 mt-5 px-4 py-3.5 rounded-xl flex items-start gap-3 text-[12px] font-bold leading-relaxed border shadow-sm ${
              isWinner 
                ? "bg-emerald-50 text-emerald-900 border-emerald-200 ring-1 ring-inset ring-emerald-100" 
                : "bg-orange-50 text-orange-950 border-orange-200 ring-1 ring-inset ring-orange-100"
            }`}>
              {isWinner ? (
                <CheckCircle size={18} weight="fill" className="text-emerald-500 shrink-0 mt-0.5 drop-shadow-sm" />
              ) : (
                <WarningCircle size={18} weight="fill" className="text-orange-500 shrink-0 mt-0.5 drop-shadow-sm" />
              )}
              <div>{campaign.status_message}</div>
            </div>
          )}

          {/* Footer Info */}
          <div className="relative z-10 mt-6 pt-4 border-t border-orange-900/10 flex items-center justify-between text-[10.5px] font-bold text-orange-900/50 uppercase tracking-wide">
            <div className="flex items-center gap-1.5">
              <Clock size={13} weight="bold" />
              {campaign.days_remaining > 0 
                ? `${campaign.days_remaining} days left` 
                : "Challenge ended"}
            </div>
            <div>
              As of {campaign.as_of ? new Date(campaign.as_of).toLocaleDateString("en-GB", { day: 'numeric', month: 'short' }) : "today"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
