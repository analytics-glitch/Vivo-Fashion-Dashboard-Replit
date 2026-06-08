import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  date,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const salesLinesTable = pgTable("sales_lines", {
  id: serial("id").primaryKey(),
  orderId: text("order_id").notNull(),
  saleDate: date("sale_date", { mode: "string" }).notNull(),
  brand: text("brand").notNull(),
  category: text("category").notNull(),
  region: text("region").notNull(),
  channel: text("channel").notNull(),
  store: text("store").notNull(),
  sku: text("sku").notNull(),
  productName: text("product_name").notNull(),
  units: integer("units").notNull(),
  revenue: doublePrecision("revenue").notNull(),
  cost: doublePrecision("cost").notNull(),
  returnedUnits: integer("returned_units").notNull().default(0),
});

export const insertSalesLineSchema = createInsertSchema(salesLinesTable).omit({
  id: true,
});
export type InsertSalesLine = z.infer<typeof insertSalesLineSchema>;
export type SalesLine = typeof salesLinesTable.$inferSelect;
