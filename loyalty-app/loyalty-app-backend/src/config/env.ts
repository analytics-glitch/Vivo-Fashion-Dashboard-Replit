import "dotenv/config";
import { randomBytes } from "node:crypto";
import { z } from "zod";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null ? def : v === "true" || v === "1"));

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === "" ? def : Number(v)))
    .pipe(z.number());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: num(4000),
  HOST: z.string().default("0.0.0.0"),
  LOYALTY_APP_API_BASE_URL: z.string().url().default("http://localhost:4000"),
  // Public web origin. Empty = same-origin (redirects become relative paths).
  LOYALTY_APP_WEB_BASE_URL: z.string().default(""),
  // URL prefix this app is served under behind the workspace's shared proxy.
  LOYALTY_APP_BASE_PATH: z.string().default("/loyalty-app"),

  // Single-origin production hosting: when true, this server also serves the
  // built React Router frontend (SPA) from FRONTEND_DIST.
  LOYALTY_APP_SERVE_FRONTEND: bool(false),
  LOYALTY_APP_FRONTEND_DIST: z.string().default("../the-loyalty-app/build/client"),

  DATABASE_URL: z.string(),

  // Comma-separated emails that get ADMIN access to the dashboard.
  LOYALTY_APP_ADMIN_EMAILS: z
    .string()
    .optional()
    .default("")
    .transform((s) => s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)),

  LOYALTY_APP_JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 chars"),
  LOYALTY_APP_JWT_EXPIRES_IN: z.string().default("30d"),
  LOYALTY_APP_SESSION_COOKIE: z.string().default("zetu_session"),
  LOYALTY_APP_COOKIE_SECURE: bool(false),

  LOYALTY_APP_GOOGLE_CLIENT_ID: z.string().optional().default(""),
  LOYALTY_APP_GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  LOYALTY_APP_GOOGLE_REDIRECT_URI: z
    .string()
    .default("http://localhost:4000/api/auth/google/callback"),

  LOYALTY_APP_SMTP_HOST: z.string().optional().default(""),
  LOYALTY_APP_SMTP_PORT: num(587),
  LOYALTY_APP_SMTP_SECURE: bool(false),
  LOYALTY_APP_SMTP_USER: z.string().optional().default(""),
  LOYALTY_APP_SMTP_PASS: z.string().optional().default(""),
  LOYALTY_APP_MAIL_FROM: z.string().default("Vivo Loyalty <rewards@example.com>"),
  LOYALTY_APP_OTP_TTL_MINUTES: num(10),
  LOYALTY_APP_OTP_LENGTH: num(6),
  LOYALTY_APP_OTP_MAX_ATTEMPTS: num(5),

  LOYALTY_APP_SHOPIFY_STORE_DOMAIN: z.string().optional().default(""),
  LOYALTY_APP_SHOPIFY_ADMIN_TOKEN: z.string().optional().default(""),
  LOYALTY_APP_SHOPIFY_STOREFRONT_ACCESS_TOKEN: z.string().optional().default(""),
  LOYALTY_APP_SHOPIFY_API_VERSION: z.string().default("2025-01"),
  LOYALTY_APP_SHOPIFY_WEBHOOK_SECRET: z.string().optional().default(""),
  // Public storefront (for "buy"/product links shown in the Shop tab).
  LOYALTY_APP_STOREFRONT_BASE_URL: z.string().default("https://www.shopzetu.com"),
  // Curated, ordered list of collection handles shown in the Shop drawer.
  // Comma-separated. Empty = show all collections. Vivo-only by default.
  LOYALTY_APP_SHOP_COLLECTIONS: z
    .string()
    .optional()
    .default("vivo-collection,vivo-outerwear-1")
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),

  LOYALTY_APP_POINTS_PER_CURRENCY: num(10),
  LOYALTY_APP_SIGNUP_BONUS_POINTS: num(200),
  LOYALTY_APP_BIRTHDAY_BONUS_POINTS: num(500),
  LOYALTY_APP_REFERRAL_REFERRER_POINTS: num(500),
  LOYALTY_APP_REFERRAL_REFEREE_POINTS: num(250),
  LOYALTY_APP_POINTS_EXPIRY_MONTHS: num(12),
});

// This app lives in the dedicated "loyalty_app" Postgres schema of the shared
// workspace database — NEVER the "public" schema (that's the BI platform's).
if (!process.env.LOYALTY_APP_DATABASE_URL && process.env.DATABASE_URL) {
  const base = process.env.DATABASE_URL;
  process.env.LOYALTY_APP_DATABASE_URL =
    base + (base.includes("?") ? "&" : "?") + "schema=loyalty_app";
}

// Fail gracefully when JWT_SECRET is not configured yet: generate an ephemeral
// secret so the server still boots (sessions won't survive a restart) and log a
// clear warning instead of crash-looping the whole workspace.
if (!process.env.LOYALTY_APP_JWT_SECRET || process.env.LOYALTY_APP_JWT_SECRET.length < 16) {
  console.warn(
    "⚠️  LOYALTY_APP_JWT_SECRET is not set (or too short). Using an EPHEMERAL secret — " +
      "logins will not survive a server restart. Set the LOYALTY_APP_JWT_SECRET secret " +
      "(e.g. `openssl rand -hex 32`) to fix this.",
  );
  process.env.LOYALTY_APP_JWT_SECRET = randomBytes(32).toString("hex");
}

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const _raw = parsed.data as Record<string, unknown>;
const _stripped: Record<string, unknown> = {};
for (const [k, v] of Object.entries(_raw)) {
  _stripped[k.startsWith("LOYALTY_APP_") ? k.slice("LOYALTY_APP_".length) : k] = v;
}
export const env = _stripped as typeof parsed.data & Record<string, any>;
export type Env = typeof env;

export const isProd = env.NODE_ENV === "production";
export const googleEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
export const smtpEnabled = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
export const shopifyEnabled = Boolean(env.SHOPIFY_STORE_DOMAIN && env.SHOPIFY_ADMIN_TOKEN);
export const storefrontEnabled = Boolean(
  env.SHOPIFY_STORE_DOMAIN && env.SHOPIFY_STOREFRONT_ACCESS_TOKEN,
);

// When MAIL_FROM is the default placeholder but SMTP_USER is set, derive a
// sensible sender address from the SMTP username so emails don't come from
// the fictional rewards@example.com address.
if (
  smtpEnabled &&
  env.MAIL_FROM === "Vivo Loyalty <rewards@example.com>" &&
  env.SMTP_USER
) {
  (env as Record<string, unknown>).MAIL_FROM = `Vivo Loyalty <${env.SMTP_USER}>`;
}

if (env.ADMIN_EMAILS.length === 0) {
  console.warn(
    "⚠️  LOYALTY_APP_ADMIN_EMAILS is not set. No one will have admin access to the " +
      "loyalty dashboard. Set it to a comma-separated list of admin email addresses.",
  );
}
