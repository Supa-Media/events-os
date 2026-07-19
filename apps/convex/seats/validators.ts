import { v } from "convex/values";
import { SEAT_CHARTS, SEAT_CAPABILITIES } from "@events-os/shared";

export const seatChartValidator = v.union(...SEAT_CHARTS.map((c) => v.literal(c)));
export const seatCapabilityValidator = v.union(
  ...SEAT_CAPABILITIES.map((c) => v.literal(c)),
);

/** Bounded cap on how many seatDefs a chart read scans — well above the
 *  template's 27 rows, room for the later runtime editor to add more. */
export const MAX_CHART_SEATS = 300;

export const chartHolderValidator = v.object({
  personId: v.id("people"),
  name: v.string(),
  imageUrl: v.union(v.string(), v.null()),
});

export const seatNodeValidator = v.object({
  defId: v.id("seatDefs"),
  slug: v.string(),
  title: v.string(),
  parentSlug: v.string(),
  maxHolders: v.number(),
  derived: v.boolean(),
  sortOrder: v.number(),
  holders: v.array(chartHolderValidator),
  vacant: v.boolean(),
});

export const chapterSubtreeValidator = v.object({
  chapterId: v.id("chapters"),
  chapterName: v.string(),
  seats: v.array(seatNodeValidator),
});
