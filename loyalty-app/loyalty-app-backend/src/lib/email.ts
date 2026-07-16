import nodemailer, { type Transporter } from "nodemailer";
import { env, smtpEnabled } from "../config/env.js";

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!smtpEnabled) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }
  return transporter;
}

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Sends an email. If SMTP is not configured (dev), logs the message instead
 * so the flow can still be exercised end-to-end.
 */
export async function sendMail({ to, subject, html, text }: SendArgs) {
  const tx = getTransporter();
  if (!tx) {
    console.log("\n📧 [DEV EMAIL — SMTP not configured]");
    console.log(`   To: ${to}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   ${text ?? html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}\n`);
    return { dev: true };
  }
  await tx.sendMail({ from: env.MAIL_FROM, to, subject, html, text });
  return { dev: false };
}

const brand = { name: "Vivo Loyalty", accent: "#fe6a02" };

function shell(inner: string) {
  return `
  <div style="background:#f5f5f7;padding:32px 0;font-family:Inter,-apple-system,Segoe UI,Roboto,sans-serif">
    <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.06)">
      <div style="background:${brand.accent};padding:28px 32px">
        <h1 style="margin:0;color:#fff;font-size:20px;letter-spacing:-.02em">${brand.name}</h1>
      </div>
      <div style="padding:32px">${inner}</div>
      <div style="padding:20px 32px;border-top:1px solid #eee;color:#9ca3af;font-size:12px">
        You’re receiving this because someone used this email to sign in to ${brand.name}.
        If that wasn’t you, you can safely ignore it.
      </div>
    </div>
  </div>`;
}

export function otpEmail(code: string, ttlMinutes: number, magicLink?: string) {
  // Render each digit in its own fixed-width cell using a table — this is the
  // most reliable way to keep the code centred and prevent overflow/clipping
  // across email clients (which have poor/inconsistent CSS support).
  const cells = code
    .split("")
    .map(
      (d) =>
        `<td style="padding:0 3px"><div style="width:38px;height:50px;line-height:50px;background:${brand.accent}14;border:1px solid ${brand.accent}55;border-radius:10px;font-size:24px;font-weight:700;color:#111;text-align:center">${d}</div></td>`,
    )
    .join("");
  // Outer 100%-width table with a centered cell — the most reliable way to
  // horizontally centre content in Gmail/Outlook (which ignore margin:auto).
  const button = magicLink
    ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:8px 0 4px">
      <a href="${magicLink}" style="display:inline-block;background:${brand.accent};color:#fff;padding:14px 32px;border-radius:12px;text-decoration:none;font-weight:600;font-size:15px">Tap to sign in&nbsp;→</a>
    </td></tr></table>
    <p style="margin:8px 0 22px;color:#9ca3af;font-size:12px;text-align:center">Opens the app and signs you in automatically.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="border-top:1px solid #eee"></td>
      <td style="width:60px;color:#9ca3af;font-size:12px;text-align:center">or</td>
      <td style="border-top:1px solid #eee"></td>
    </tr></table>`
    : "";
  return shell(`
    <p style="margin:0 0 8px;color:#111;font-size:16px;text-align:center">Your sign-in code</p>
    <p style="margin:0 0 20px;color:#6b7280;font-size:14px;text-align:center">${
      magicLink ? "Tap the button below, or enter" : "Enter"
    } this code to finish signing in. It expires in ${ttlMinutes} minutes.</p>
    ${button}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding-top:${
      magicLink ? "18px" : "0"
    }">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table>
    </td></tr></table>
    <p style="margin:20px 0 0;color:#9ca3af;font-size:13px;text-align:center">Never share this code with anyone.</p>
  `);
}

export function welcomeEmail(firstName: string | null, points: number) {
  return shell(`
    <p style="margin:0 0 8px;color:#111;font-size:18px">Welcome${firstName ? `, ${firstName}` : ""}! 🎉</p>
    <p style="margin:0 0 16px;color:#6b7280;font-size:14px">Your rewards account is ready. We’ve dropped
    <b style="color:#111">${points} points</b> in your account to get you started.</p>
    <p style="margin:0;color:#6b7280;font-size:14px">Earn points on every order, climb tiers, and redeem for exclusive rewards.</p>
  `);
}
