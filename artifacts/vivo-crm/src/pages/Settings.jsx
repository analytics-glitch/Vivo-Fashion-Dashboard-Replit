import React from "react";
import { Link } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, ExternalLink, ShieldCheck, Smartphone, Box } from "lucide-react";
import { API_BASE } from "@/lib/api";
import CustomerSyncCard from "@/components/CustomerSyncCard";

/**
 * Settings hub — one page that gathers everything a non-technical
 * manager needs to deploy & monitor the Vivo CRM in the real world.
 *
 * Today: Odoo zip download + setup checklist + mobile app status.
 * Tomorrow: SMS provider key entry, WhatsApp BSP key, Firebase JSON.
 */
export default function Settings() {
  const downloadOdoo = () => {
    // The API endpoint is auth-gated; the browser's existing cookie carries
    // the manager session so the file streams straight back.
    window.location.href = `${API_BASE}/downloads/vivo-loyalty-odoo.zip`;
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-10" data-testid="settings-page">
      <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--vivo-muted)]">System</div>
      <h1 className="font-display text-3xl md:text-4xl text-[var(--vivo-navy)] mt-1">Settings &amp; integrations</h1>
      <p className="text-sm text-[var(--vivo-muted)] mt-2 max-w-2xl">
        Everything you can manage without IT. Each card has step-by-step
        instructions written for a non-technical operator.
      </p>

      {/* Customer database sync */}
      <CustomerSyncCard />

      {/* Odoo */}
      <Card className="vivo-card p-6 mt-8 rounded-sm" data-testid="settings-odoo-card">        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div className="flex items-start gap-4 max-w-xl">
            <div className="h-10 w-10 rounded-sm bg-[var(--vivo-bg-soft)] flex items-center justify-center"><Box className="h-5 w-5 text-[var(--vivo-navy)]"/></div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--vivo-muted)]">Odoo 18 connector</div>
              <h2 className="font-display text-2xl mt-1">Sync every till sale to loyalty</h2>
              <p className="text-sm text-[var(--vivo-muted)] mt-2">
                A ready-to-install Odoo module. Once enabled, every paid invoice and POS order is pushed to the loyalty engine — tiers recalculate automatically, vouchers can be redeemed at the till. No coding needed.
              </p>
            </div>
          </div>
          <Button onClick={downloadOdoo} className="rounded-sm bg-[var(--vivo-navy)] text-white" data-testid="settings-download-odoo">
            <Download className="h-4 w-4 mr-2"/> Download module (.zip)
          </Button>
        </div>

        <div className="vivo-divider my-5"/>

        <ol className="space-y-3 text-sm">
          <li className="flex gap-3">
            <span className="font-mono text-xs h-6 w-6 rounded-sm bg-[var(--vivo-bg)] flex items-center justify-center shrink-0">1</span>
            <span>Tap <strong>Download module</strong> above to save <code className="text-xs bg-[var(--vivo-bg)] px-1.5 py-0.5 rounded-sm">vivo_loyalty.zip</code>.</span>
          </li>
          <li className="flex gap-3">
            <span className="font-mono text-xs h-6 w-6 rounded-sm bg-[var(--vivo-bg)] flex items-center justify-center shrink-0">2</span>
            <span>In Odoo, open <strong>Apps</strong> → menu (⋯) → <strong>Import Module</strong> → upload the zip.</span>
          </li>
          <li className="flex gap-3">
            <span className="font-mono text-xs h-6 w-6 rounded-sm bg-[var(--vivo-bg)] flex items-center justify-center shrink-0">3</span>
            <span>Search the Apps list for <em>"Vivo Loyalty CRM Connector"</em> and click <strong>Install</strong>.</span>
          </li>
          <li className="flex gap-3">
            <span className="font-mono text-xs h-6 w-6 rounded-sm bg-[var(--vivo-bg)] flex items-center justify-center shrink-0">4</span>
            <span>
              Go to <strong>Settings → General Settings → Vivo Loyalty</strong>. Paste:
              <ul className="list-disc ml-5 mt-1 text-xs">
                <li>CRM base URL: <code className="bg-[var(--vivo-bg)] px-1 rounded-sm">{window.location.origin}</code></li>
                <li>Shared secret: ask the CRM admin for <code className="bg-[var(--vivo-bg)] px-1 rounded-sm">VIVO_POS_SECRET</code> (one-time setup).</li>
              </ul>
            </span>
          </li>
          <li className="flex gap-3">
            <span className="font-mono text-xs h-6 w-6 rounded-sm bg-[var(--vivo-bg)] flex items-center justify-center shrink-0">5</span>
            <span>Ring a test sale. Check <strong>Vivo Loyalty → Sync Log</strong> in Odoo — a row with <code className="bg-[var(--vivo-bg)] px-1 rounded-sm">status: sent</code> means it's working.</span>
          </li>
        </ol>
      </Card>

      {/* Mobile app */}
      <Card className="vivo-card p-6 mt-6 rounded-sm" data-testid="settings-mobile-card">
        <div className="flex items-start gap-4 max-w-2xl">
          <div className="h-10 w-10 rounded-sm bg-[var(--vivo-bg-soft)] flex items-center justify-center"><Smartphone className="h-5 w-5 text-[var(--vivo-navy)]"/></div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--vivo-muted)]">Mobile app · LIVE</div>
            <h2 className="font-display text-2xl mt-1">Member app — on your phone in 90 seconds</h2>
            <p className="text-sm text-[var(--vivo-muted)] mt-2">
              Published to your Expo account · branch <code className="bg-[var(--vivo-bg)] px-1 rounded-sm">preview</code>. Tap the magic code <code className="bg-[var(--vivo-bg)] px-1 rounded-sm">000000</code> on the OTP screen to bypass SMS during testing.
            </p>
          </div>
        </div>

        <div className="vivo-divider my-5"/>

        <ol className="space-y-3 text-sm">
          <li className="flex gap-3">
            <span className="font-mono text-xs h-6 w-6 rounded-sm bg-[var(--vivo-bg)] flex items-center justify-center shrink-0">1</span>
            <span>Install <strong>Expo Go</strong> on your phone — <a href="https://apps.apple.com/app/expo-go/id982107779" target="_blank" rel="noreferrer" className="underline">iPhone</a> · <a href="https://play.google.com/store/apps/details?id=host.exp.exponent" target="_blank" rel="noreferrer" className="underline">Android</a></span>
          </li>
          <li className="flex gap-3">
            <span className="font-mono text-xs h-6 w-6 rounded-sm bg-[var(--vivo-bg)] flex items-center justify-center shrink-0">2</span>
            <span>Open the <a href="https://expo.dev/preview/update?message=Vivo+Loyalty+preview+v1&updateRuntimeVersion=exposdk%3A51.0.0&createdAt=2026-02-19T00%3A00%3A00.000Z&slug=vivo-loyalty&projectId=852df9e2-5d82-4ae9-816b-a32987758c15&group=2b6d75d7-c789-4e09-bf86-7686cfa1bb31" target="_blank" rel="noreferrer" className="font-semibold text-[var(--vivo-navy)] underline">QR code page</a>{" "}— it shows a QR code, scan it from inside Expo Go (Android) or your camera (iOS).</span>
          </li>
          <li className="flex gap-3">
            <span className="font-mono text-xs h-6 w-6 rounded-sm bg-[var(--vivo-bg)] flex items-center justify-center shrink-0">3</span>
            <span>The Vivo Loyalty app loads. Enter any Kenyan/Ugandan/Rwandan phone number → on the OTP screen, tap the dev-magic-code chip to auto-fill <code>000000</code>.</span>
          </li>
          <li className="flex gap-3">
            <span className="font-mono text-xs h-6 w-6 rounded-sm bg-[var(--vivo-bg)] flex items-center justify-center shrink-0">4</span>
            <span>Every time the CRM ships an update, the app refreshes automatically on next open — no re-install.</span>
          </li>
        </ol>

        <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Link to="/loyalty/app-preview" className="vivo-card p-4 rounded-sm hover:shadow-md transition-shadow">
            <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--vivo-muted)]">Without your phone?</div>
            <div className="text-sm mt-1 font-medium text-[var(--vivo-navy)] inline-flex items-center gap-1">View web preview <ExternalLink className="h-3 w-3"/></div>
          </Link>
          <a href="https://expo.dev/accounts/vivomobile88/projects/vivo-loyalty" target="_blank" rel="noreferrer" className="vivo-card p-4 rounded-sm hover:shadow-md transition-shadow">
            <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--vivo-muted)]">Manage builds</div>
            <div className="text-sm mt-1 font-medium text-[var(--vivo-navy)] inline-flex items-center gap-1">Open Expo dashboard <ExternalLink className="h-3 w-3"/></div>
          </a>
        </div>
      </Card>

      {/* Security */}
      <Card className="vivo-card p-6 mt-6 rounded-sm" data-testid="settings-security-card">
        <div className="flex items-start gap-4">
          <div className="h-10 w-10 rounded-sm bg-[var(--vivo-bg-soft)] flex items-center justify-center"><ShieldCheck className="h-5 w-5 text-[var(--vivo-navy)]"/></div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--vivo-muted)]">Security &amp; compliance</div>
            <h2 className="font-display text-2xl mt-1">Data governance</h2>
            <p className="text-sm text-[var(--vivo-muted)] mt-2 max-w-xl">
              The CRM honours Kenya's Data Protection Act. Members can request deletion of their loyalty record from the mobile app; managers process those requests below.
            </p>
            <Link to="/data-requests" className="text-sm mt-3 inline-flex items-center gap-1 text-[var(--vivo-navy)] hover:underline font-medium">
              Open data-deletion queue <ExternalLink className="h-3 w-3"/>
            </Link>
          </div>
        </div>
      </Card>
    </div>
  );
}
