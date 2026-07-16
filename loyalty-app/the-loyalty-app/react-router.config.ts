import type { Config } from "@react-router/dev/config";

export default {
  // SPA mode: ideal for an installable, offline-capable PWA served as static assets.
  ssr: false,
  // Served under /loyalty-app/ behind the workspace's shared proxy.
  basename: "/loyalty-app/",
} satisfies Config;
