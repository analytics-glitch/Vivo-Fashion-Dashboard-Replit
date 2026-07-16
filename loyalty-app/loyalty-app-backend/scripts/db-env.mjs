#!/usr/bin/env node
// Derives LOYALTY_APP_DATABASE_URL from the workspace's DATABASE_URL, pinned to
// the dedicated "loyalty_app" Postgres schema so Prisma never touches the BI
// tables living in "public". Then execs the given command.
import { spawn } from "node:child_process";
import "dotenv/config";

if (!process.env.LOYALTY_APP_DATABASE_URL) {
  const base = process.env.DATABASE_URL;
  if (!base) {
    console.error("❌ DATABASE_URL is not set — cannot derive LOYALTY_APP_DATABASE_URL.");
    process.exit(1);
  }
  process.env.LOYALTY_APP_DATABASE_URL = base + (base.includes("?") ? "&" : "?") + "schema=loyalty_app";
}

const [cmd, ...args] = process.argv.slice(2);
const child = spawn(cmd, args, { stdio: "inherit", env: process.env, shell: false });
child.on("exit", (code) => process.exit(code ?? 1));
