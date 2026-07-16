import { buildApp } from "./app.js";
import { env, smtpEnabled, googleEnabled } from "./config/env.js";
import { verifySmtp } from "./lib/email.js";

const app = await buildApp();

try {
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`🚀 Vivo Loyalty API on ${env.API_BASE_URL}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Log sign-in capability summary so it's easy to confirm from the workflow logs.
const smtpResult = await verifySmtp();
if (smtpResult.configured && smtpResult.ok) {
  app.log.info(
    `✉️  SMTP ready — ${env.SMTP_HOST}:${env.SMTP_PORT} (user: ${env.SMTP_USER}); ` +
      `sending as "${env.MAIL_FROM}"`,
  );
} else if (smtpResult.configured && !smtpResult.ok) {
  app.log.warn(
    `⚠️  SMTP configured but connection failed: ${smtpResult.error} — ` +
      "OTP codes will fall back to console logging",
  );
} else {
  app.log.warn(
    "⚠️  SMTP not configured (LOYALTY_APP_SMTP_HOST/USER/PASS unset) — " +
      "OTP codes will be logged to console only",
  );
}

app.log.info(
  `🔐 Sign-in methods: email-OTP=${smtpResult.ok} google=${googleEnabled} ` +
    `admin-emails=${env.ADMIN_EMAILS.length > 0 ? env.ADMIN_EMAILS.join(", ") : "(none set)"}`,
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig} received — shutting down`);
    await app.close();
    process.exit(0);
  });
}
