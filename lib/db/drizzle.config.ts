import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  // This database is shared with Python-managed ETL/app tables (all_sales,
  // footfall, app_users, crm_*, etc.) that are NOT defined in this Drizzle
  // schema. Without a filter, `drizzle-kit push` diffs the WHOLE database and
  // tries to DROP every table it doesn't know about (data loss / interactive
  // prompt that fails in post-merge). Restrict Drizzle to ONLY the tables it
  // actually owns so push can never touch the Python-managed tables.
  tablesFilter: ["sales_lines", "stores", "inventory"],
});
