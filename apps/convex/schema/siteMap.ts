import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Site-map marker — a labelled pin placed on a venue map at a normalized
 * position (x,y in 0..1 of the image), categorized (team area, station,
 * equipment drop, stage…). The visual layout of where things go.
 *
 * Scope: belongs EITHER to a live event (`eventId`) or to a TEMPLATE
 * (`eventTypeId`). Exactly one is set; template markers are cloned onto new
 * events at creation. The full map (image + shapes + markers) lives on the
 * template; placements (which reference per-event rows) stay event-only.
 */
export const siteMarkers = defineTable({
  chapterId: v.id("chapters"),
  eventId: v.optional(v.id("events")),
  eventTypeId: v.optional(v.id("eventTypes")),
  x: v.number(),
  y: v.number(),
  label: v.string(),
  // Free color name (e.g. "red"); markers aren't a fixed category set.
  color: v.optional(v.string()),
  createdAt: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_template", ["eventTypeId"])
  .index("by_chapter", ["chapterId"]);

/**
 * Site-map shape — a basic sketched element so you can rough out the venue
 * WITHOUT a background image. `rect`/`circle` use (x,y) top-left + (w,h);
 * `line` uses (x,y)→(x2,y2). All coords normalized 0..1.
 *
 * Scope: belongs EITHER to a live event (`eventId`) or to a TEMPLATE
 * (`eventTypeId`), exactly like `siteMarkers` — template shapes are cloned onto
 * new events at creation.
 */
export const siteShapes = defineTable({
  chapterId: v.id("chapters"),
  eventId: v.optional(v.id("events")),
  eventTypeId: v.optional(v.id("eventTypes")),
  type: v.union(v.literal("rect"), v.literal("circle"), v.literal("line")),
  x: v.number(),
  y: v.number(),
  w: v.optional(v.number()),
  h: v.optional(v.number()),
  x2: v.optional(v.number()),
  y2: v.optional(v.number()),
  color: v.optional(v.string()),
  label: v.optional(v.string()),
  createdAt: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_template", ["eventTypeId"])
  .index("by_chapter", ["chapterId"]);

/**
 * Site-map placement — overlays an existing SUPPLY or VOLUNTEER onto the venue
 * map as a positioned, draggable chip at a normalized position (x,y in 0..1).
 * `refId` is the source row's _id (kept as a string so one table can point at
 * either source); `kind` says which table it references.
 *
 * Scope: belongs EITHER to a live event (`eventId`) or to a TEMPLATE
 * (`eventTypeId`), exactly like `siteMarkers`/`siteShapes`. Exactly one is set.
 * What `refId` points at depends on scope (event vs template) × `kind`:
 *   - EVENT    + supply    → an `eventItems` _id     (module "supplies")
 *   - EVENT    + volunteer → an `engagements` _id    (type "volunteer")
 *   - TEMPLATE + supply    → a `templateItems` _id   (module "supplies")
 *   - TEMPLATE + volunteer → a `templatePeople` _id  (placeholder crew)
 * Template placements are cloned onto new events at creation, with `refId`
 * remapped to the cloned eventItem / materialized volunteer engagement.
 *
 * INTEGRITY WARNING: `refId` is an untyped `v.string()`, so there is NO
 * referential-integrity enforcement and NO automatic cascade. Deleting the
 * referenced supply / engagement / template row leaves a DANGLING placement
 * whose chip points at a now-missing target. Any mutation that deletes one of
 * the four referenced row types MUST also delete the matching placements
 * (query `by_event_kind` / `by_template_kind`, filter by `refId`) — readers
 * should also tolerate a missing target defensively.
 * TODO(integrity): add cross-table delete cleanup in the supply/engagement/
 * template-item/template-people delete mutations (those files are out of scope
 * for this change). Tracked as a follow-up.
 */
export const siteMapPlacements = defineTable({
  chapterId: v.id("chapters"),
  eventId: v.optional(v.id("events")),
  eventTypeId: v.optional(v.id("eventTypes")),
  kind: v.union(v.literal("supply"), v.literal("volunteer")),
  refId: v.string(),
  x: v.number(), // normalized 0..1
  y: v.number(),
  createdAt: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_event_kind", ["eventId", "kind"])
  .index("by_template", ["eventTypeId"])
  .index("by_template_kind", ["eventTypeId", "kind"])
  .index("by_chapter", ["chapterId"]);
