/**
 * Shared engagement row types for the event crew tables (CrewSections +
 * EngagementTable). The engagement shape mirrors `api.engagements.listForEvent`:
 * the base `engagements` Convex document plus a trimmed `person` projection the
 * query joins on (id/name/contact + the placeholder flag).
 */
import type { Doc } from "@events-os/convex/_generated/dataModel";

/** The person projection joined onto each engagement by `listForEvent`. */
export type EngagementPerson = {
  _id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  skills?: string[];
  isPlaceholder?: boolean;
} | null;

/** An engagement row as returned by `api.engagements.listForEvent`. */
export type Engagement = Doc<"engagements"> & { person: EngagementPerson };

export type TeamOption = { value: string; label: string; color?: string | null };

// ── Sorting (volunteers table) ────────────────────────────────────────────────
export type SortCol = "name" | "team" | "status";
export type Sort = { col: SortCol; dir: 1 | -1 };
