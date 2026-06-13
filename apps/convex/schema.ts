import { defineSchema } from "convex/server";
import { supaAuthTables, supaTenantTables, supaNotificationTables } from "@supa/convex/schema";

/**
 * Database schema for Events OS.
 *
 * Spreads the framework's base tables (auth, plus any enabled modules) and is
 * where you add your app-specific tables.
 */
const schema = defineSchema({
  ...supaAuthTables,
  ...supaTenantTables({ tenantName: "chapter" }),
  ...supaNotificationTables,

  // Add your app-specific tables here, e.g.:
  // myTable: defineTable({
  //   name: v.string(),
  //   userId: v.id("users"),
  // }).index("by_user", ["userId"]),
});

export default schema;
