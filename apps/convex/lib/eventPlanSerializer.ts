/**
 * Pure serializer: an event's own planning workspace → one compact plain-text
 * "event plan" document for the RSVP-page autofill prompt.
 *
 * The whole page the organizer plans in IS the planning doc — the overview,
 * the task rows, the comms schedule, the run of show — so nothing is pasted:
 * `ai.eventPageAutofillContext` gathers the rows and this module flattens them
 * into the text the LLM reads. No ctx anywhere — unit-tested directly.
 */
import { splitMentionSegments } from "@events-os/shared";

/** Cap on the serialized plan document (keeps the LLM bill bounded). */
export const MAX_PLANNING_DOC_CHARS = 20_000;

export type PlanOverview = {
  name: string;
  eventDate: number;
  location: string | null;
  venueName: string | null;
  address: string | null;
  budgetUsd: number | null;
  tagline: string | null;
  description: string | null;
  givingPrompt: string | null;
};

export type PlanModule = { key: string; label: string };

export type PlanItem = {
  module: string;
  title: string;
  status: string | null;
  fields: Record<string, unknown>;
};

/**
 * `@[Label](mention:type:id)` tokens → their plain label text, so the LLM
 * sees "ask Jordan" instead of mention markup (and never sees raw ids).
 */
export function stripMentionTokens(text: string): string {
  return splitMentionSegments(text)
    .map((s) => (s.kind === "mention" ? s.token.label : s.text))
    .join("");
}

/**
 * The fields-bag keys worth showing the model, with their prompt labels, in
 * render order. Everything else in the bag (photos, storage ids, overrides)
 * is noise for a copywriting prompt and is skipped.
 */
const ITEM_FIELD_LABELS: ReadonlyArray<readonly [key: string, label: string]> = [
  ["details", "Details"],
  ["notes", "Notes"],
  ["channel", "Channel"],
  ["audience", "Audience"],
  ["team", "Team"],
  ["source", "Source"],
  ["qty", "Qty"],
  ["duration", "Length (min)"],
  ["jurisdiction", "Jurisdiction"],
  ["fallback", "If denied"],
];

/** A fields-bag value as prompt text (string/number/string-array), or null. */
function fieldText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const parts = value.filter((v): v is string => typeof v === "string");
    return parts.length ? parts.join(", ") : null;
  }
  return null;
}

function itemLines(item: PlanItem): string {
  const head =
    `- ${stripMentionTokens(item.title) || "Untitled"}` +
    (item.status ? ` [${item.status}]` : "");
  const parts: string[] = [head];
  for (const [key, label] of ITEM_FIELD_LABELS) {
    const text = fieldText(item.fields[key]);
    if (text) parts.push(`  ${label}: ${stripMentionTokens(text)}`);
  }
  return parts.join("\n");
}

function overviewSection(o: PlanOverview): string {
  const lines: string[] = ["## Event overview"];
  lines.push(`Event: ${o.name}`);
  lines.push(`Date: ${new Date(o.eventDate).toDateString()}`);
  if (o.location) lines.push(`Location: ${o.location}`);
  if (o.venueName) lines.push(`Venue: ${o.venueName}`);
  if (o.address) lines.push(`Address: ${o.address}`);
  if (o.budgetUsd != null) lines.push(`Budget: $${o.budgetUsd}`);
  lines.push(`Current tagline: ${o.tagline ?? "(none)"}`);
  lines.push(`Current description: ${o.description ?? "(none)"}`);
  lines.push(`Current giving prompt: ${o.givingPrompt ?? "(none)"}`);
  return lines.join("\n");
}

const TRUNCATION_MARK = "\n…(truncated)";

/**
 * Fair-share allocation ("water-fill"): sections that fit under an equal
 * share keep their full size; their surplus is redistributed equally among
 * the still-oversized ones, repeating until nothing more fits. So one huge
 * Tasks section can't starve a small Comms section — every section keeps at
 * least an equal split of the budget.
 */
function allocateFairly(sizes: number[], budget: number): number[] {
  const alloc = sizes.map(() => 0);
  let remaining = Math.max(0, budget);
  let pending = sizes.map((_, i) => i);
  while (pending.length > 0) {
    const share = Math.floor(remaining / pending.length);
    const fits = pending.filter((i) => sizes[i] <= share);
    if (fits.length === 0) {
      for (const i of pending) alloc[i] = share;
      break;
    }
    for (const i of fits) {
      alloc[i] = sizes[i];
      remaining -= sizes[i];
    }
    pending = pending.filter((i) => sizes[i] > share);
  }
  return alloc;
}

/**
 * Build the plan document: overview section first (always kept whole — it is
 * small and is the minimum valid context), then one section per module that
 * has rows, capped at `maxChars` total via fair per-section truncation.
 */
export function serializeEventPlan(input: {
  overview: PlanOverview;
  modules: PlanModule[];
  items: PlanItem[];
  maxChars?: number;
}): string {
  const maxChars = input.maxChars ?? MAX_PLANNING_DOC_CHARS;
  const overview = overviewSection(input.overview);

  const sections: string[] = [];
  for (const mod of input.modules) {
    const rows = input.items.filter((it) => it.module === mod.key);
    if (rows.length === 0) continue;
    sections.push([`## ${mod.label}`, ...rows.map(itemLines)].join("\n"));
  }

  const SEP = "\n\n";
  const joined = [overview, ...sections].join(SEP);
  if (joined.length <= maxChars) return joined;

  // Over budget: overview stays whole; module sections split the rest fairly.
  const budget = maxChars - overview.length - SEP.length * sections.length;
  const alloc = allocateFairly(
    sections.map((s) => s.length),
    budget,
  );
  const truncated = sections.map((s, i) =>
    s.length <= alloc[i]
      ? s
      : s.slice(0, Math.max(0, alloc[i] - TRUNCATION_MARK.length)) +
        TRUNCATION_MARK,
  );
  // Belt & braces: the marker math above keeps us at ≤ maxChars, but a final
  // hard slice guarantees the cap no matter what.
  return [overview, ...truncated].join(SEP).slice(0, maxChars);
}
