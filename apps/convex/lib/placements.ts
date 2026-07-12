/**
 * Site-map placement integrity helpers.
 *
 * `siteMapPlacements.refId` is an untyped `v.string()` pointing at a supply /
 * volunteer source row (see schema/siteMap.ts), so there is NO referential
 * integrity and NO automatic cascade. Any mutation that hard-deletes one of the
 * four referenced row types (event/template supply item, event volunteer
 * engagement, template placeholder crew) must call the matching helper here so
 * the chip pointing at the now-missing target is removed too.
 *
 * The read is scoped by the `by_event_kind` / `by_template_kind` index (so it
 * only ever touches placements for one event/template × kind — bounded by the
 * number of chips on a single map), then `refId` is matched in JS because it is
 * stored as a string, not a typed id.
 */

/**
 * Delete every placement in an EVENT scope whose `refId` is the deleted row.
 * `kind` is "supply" (refId = eventItems id) or "volunteer" (refId = engagements
 * id). Returns the number of placements removed.
 */
export async function deleteEventPlacementsForRef(
  ctx: any,
  eventId: string,
  kind: "supply" | "volunteer",
  refId: string,
): Promise<number> {
  const rows = await ctx.db
    .query("siteMapPlacements")
    .withIndex("by_event_kind", (q: any) =>
      q.eq("eventId", eventId).eq("kind", kind),
    )
    .collect();
  let deleted = 0;
  for (const p of rows) {
    if (p.refId === refId) {
      await ctx.db.delete(p._id);
      deleted++;
    }
  }
  return deleted;
}

/**
 * Delete every placement in a TEMPLATE scope whose `refId` is the deleted row.
 * `kind` is "supply" (refId = templateItems id) or "volunteer" (refId =
 * templatePeople id). Returns the number of placements removed.
 */
export async function deleteTemplatePlacementsForRef(
  ctx: any,
  eventTypeId: string,
  kind: "supply" | "volunteer",
  refId: string,
): Promise<number> {
  const rows = await ctx.db
    .query("siteMapPlacements")
    .withIndex("by_template_kind", (q: any) =>
      q.eq("eventTypeId", eventTypeId).eq("kind", kind),
    )
    .collect();
  let deleted = 0;
  for (const p of rows) {
    if (p.refId === refId) {
      await ctx.db.delete(p._id);
      deleted++;
    }
  }
  return deleted;
}
