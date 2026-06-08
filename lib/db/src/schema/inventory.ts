import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const inventoryTable = pgTable("inventory", {
  id: serial("id").primaryKey(),
  category: text("category").notNull(),
  stockUnits: integer("stock_units").notNull(),
  stockValue: doublePrecision("stock_value").notNull(),
  weeksOfCover: doublePrecision("weeks_of_cover").notNull(),
  sellThroughPct: doublePrecision("sell_through_pct").notNull(),
});

export const insertInventorySchema = createInsertSchema(inventoryTable).omit({
  id: true,
});
export type InsertInventory = z.infer<typeof insertInventorySchema>;
export type Inventory = typeof inventoryTable.$inferSelect;
