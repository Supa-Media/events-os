/**
 * Service Catalog shared data: the canonical seed catalog + the legacy
 * free-text → catalog mapping, plus the small read/write helpers built on
 * top of them. Shared by `migrations/0046_seed_service_catalog.ts` (the
 * one-time backfill) and `seed.ts` (so newly-seeded demo/import data targets
 * `serviceIds` the same way prod data gets backfilled, never the deprecated
 * `people.services` string array — see `schema/people.ts`'s deprecation
 * comment).
 *
 * The 6 category names below (Music & Worship, Media & Design, …) are UI
 * grouping ONLY — they are never written to `serviceOptions` (no schema
 * field for them); only `name` + `parentId` are stored.
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export interface CanonicalServiceEntry {
  name: string;
  children?: string[];
}

/** The founder-specified canonical catalog. `Vocals`, `Instruments`, `Media`,
 *  and `Social Media` are seeded as selectable PARENT rows in their own right
 *  (a bare-parent tag means "yes, unspecified"). */
export const CANONICAL_SERVICE_CATALOG: CanonicalServiceEntry[] = [
  // Music & Worship
  { name: "Worship Leading" },
  { name: "Vocals", children: ["Soprano", "Alto", "Tenor", "Bass"] },
  {
    name: "Instruments",
    children: [
      "Keyboard",
      "Drums",
      "Bass",
      "Acoustic Guitar",
      "Electric Guitar",
      "Percussion",
    ],
  },
  { name: "Songwriting" },
  { name: "Music Production" },
  { name: "Dance" },
  // Media & Design
  {
    name: "Media",
    children: ["Photography", "Videography", "Video Editing", "Filmmaking"],
  },
  { name: "Graphic Design" },
  { name: "Audio Engineering" },
  // Marketing & Growth
  { name: "Social Media", children: ["Content", "Strategy"] },
  { name: "Brand & PR" },
  { name: "Artist Development" },
  // Events & Logistics
  { name: "Event Coordination" },
  { name: "Logistics & Venue" },
  { name: "Setup & Breakdown" },
  { name: "Guest Services" },
  { name: "Decor" },
  { name: "Floristry" },
  { name: "Driving & Transport" },
  // People & Ministry
  { name: "Evangelism" },
  { name: "Prayer & Intercession" },
  { name: "Pastoral Ministry" },
  { name: "Preaching" },
  { name: "Follow-up & Connections" },
  { name: "Children's Ministry" },
  // Business & Operations
  { name: "Project Management" },
  { name: "Development & Fundraising" },
  { name: "Hiring & Recruiting" },
  { name: "Finance & Budgeting" },
  { name: "Sales & Partnerships" },
  { name: "Operations" },
];

/**
 * Legacy `people.services` free-text string (normalized: trim + lowercase,
 * matched as the map key) → the canonical catalog label it maps onto ("Name"
 * for a bare/parent option, "Parent:Child" for a child). The 13 distinct
 * strings actually observed across prod's 21 tagged people at the time of
 * writing. Any OTHER string is deliberately left unmapped (see
 * `resolveLegacyServiceStrings` — reported, never guessed).
 */
export const LEGACY_SERVICE_STRING_MAP: Record<string, string> = {
  "worship leading": "Worship Leading",
  "prayer": "Prayer & Intercession",
  "instrumentalist": "Instruments",
  "sales": "Sales & Partnerships",
  "florist": "Floristry",
  "videography": "Media:Videography",
  "operations": "Operations",
  "decor": "Decor",
  "vocalist": "Vocals",
  "photography": "Media:Photography",
  "driving": "Driving & Transport",
  "preaching": "Preaching",
  "design": "Graphic Design",
};

/** Generous bound over the ~47-row canonical catalog — a chapter's own
 *  additions (renames/new options) still sit far below this. */
const CATALOG_SCAN_LIMIT = 1000;

function labelKey(name: string, parentName?: string): string {
  return (parentName ? `${parentName}:${name}` : name).trim().toLowerCase();
}

/**
 * Ensure the ORG-WIDE catalog (every `serviceOptions` row with NO `chapterId`
 * — shared by every chapter) has every canonical row, inserting only what's
 * missing (matched by name, case-insensitive, at the correct nesting level)
 * — idempotent, safe to call on every migration/seed run, from ANY chapter's
 * context (there's exactly one org-wide catalog, not one per chapter).
 * Returns a label→id lookup (`"name"` for a top-level option, `"parent:child"`
 * for a child, both lowercased) covering every org-wide row now present, so
 * callers can resolve a canonical label to an id without a second read.
 */
export async function ensureOrgWideServiceCatalog(
  ctx: MutationCtx,
): Promise<{ labelToId: Map<string, Id<"serviceOptions">>; created: number }> {
  const rows: Doc<"serviceOptions">[] = await ctx.db
    .query("serviceOptions")
    .withIndex("by_chapter", (q) => q.eq("chapterId", undefined))
    .take(CATALOG_SCAN_LIMIT);

  const findExisting = (name: string, parentId?: Id<"serviceOptions">) =>
    rows.find(
      (r) =>
        r.parentId === parentId &&
        r.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );

  const labelToId = new Map<string, Id<"serviceOptions">>();
  let created = 0;
  let sortOrder = rows.length;
  const now = Date.now();

  for (const entry of CANONICAL_SERVICE_CATALOG) {
    let parentRow = findExisting(entry.name);
    let parentId: Id<"serviceOptions">;
    if (parentRow) {
      parentId = parentRow._id;
    } else {
      parentId = await ctx.db.insert("serviceOptions", {
        name: entry.name,
        sortOrder: sortOrder++,
        isActive: true,
        createdAt: now,
      });
      created++;
      const inserted = { _id: parentId, name: entry.name, isActive: true, createdAt: now } as Doc<"serviceOptions">;
      rows.push(inserted);
      parentRow = inserted;
    }
    labelToId.set(labelKey(entry.name), parentId);

    for (const childName of entry.children ?? []) {
      const existingChild = findExisting(childName, parentId);
      let childId: Id<"serviceOptions">;
      if (existingChild) {
        childId = existingChild._id;
      } else {
        childId = await ctx.db.insert("serviceOptions", {
          parentId,
          name: childName,
          sortOrder: sortOrder++,
          isActive: true,
          createdAt: now,
        });
        created++;
        rows.push({ _id: childId, parentId, name: childName, isActive: true, createdAt: now } as Doc<"serviceOptions">);
      }
      labelToId.set(labelKey(childName, entry.name), childId);
    }
  }

  return { labelToId, created };
}

/**
 * Map a person's legacy `services` free-text strings onto catalog ids via
 * `LEGACY_SERVICE_STRING_MAP`, against an already-resolved `labelToId` (from
 * `ensureOrgWideServiceCatalog`). Deduped. Any string with no map entry
 * (or whose mapped label isn't in `labelToId` — shouldn't happen once the
 * catalog is seeded, but defensive) is reported in `unmapped` rather than
 * silently dropped from the count — `migrations/0046_seed_service_catalog.ts`
 * surfaces these for human triage.
 */
export function resolveLegacyServiceStrings(
  labelToId: Map<string, Id<"serviceOptions">>,
  values: string[],
): { serviceIds: Id<"serviceOptions">[]; unmapped: string[] } {
  const ids = new Set<Id<"serviceOptions">>();
  const unmapped: string[] = [];
  for (const raw of values) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const canonicalLabel = LEGACY_SERVICE_STRING_MAP[key];
    const id = canonicalLabel ? labelToId.get(canonicalLabel.toLowerCase()) : undefined;
    if (id) ids.add(id);
    else unmapped.push(raw);
  }
  return { serviceIds: [...ids], unmapped };
}

/**
 * Best-effort string→id resolution for DEV/SEED tooling only (`seed.ts`'s
 * `importRoster`) — NOT used by migration 0045, which sticks strictly to
 * `LEGACY_SERVICE_STRING_MAP` because its 13 entries are the audited,
 * contract-specified mapping for real prod data. This tries a DIRECT
 * case-insensitive match against `labelToId` first (a seed string that
 * already IS a canonical name or "Parent:Child" label, e.g. "Vocals" or
 * "Operations"), then falls back to the same legacy map. Still reports
 * anything neither resolves, same "report, never guess" rule.
 */
export function resolveServiceStringsBestEffort(
  labelToId: Map<string, Id<"serviceOptions">>,
  values: string[],
): { serviceIds: Id<"serviceOptions">[]; unmapped: string[] } {
  const ids = new Set<Id<"serviceOptions">>();
  const unmapped: string[] = [];
  for (const raw of values) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const direct = labelToId.get(key);
    if (direct) {
      ids.add(direct);
      continue;
    }
    const canonicalLabel = LEGACY_SERVICE_STRING_MAP[key];
    const mapped = canonicalLabel ? labelToId.get(canonicalLabel.toLowerCase()) : undefined;
    if (mapped) ids.add(mapped);
    else unmapped.push(raw);
  }
  return { serviceIds: [...ids], unmapped };
}

/**
 * Every `serviceOptions` row VISIBLE to `chapterId` — every org-wide row
 * (`chapterId` absent) UNION that chapter's own local rows — indexed by
 * lowercased bare `name` → every row id sharing that name (a parent and a
 * child can share a name — e.g. `Vocals:Bass`/`Instruments:Bass` — so
 * callers must treat more than one hit as AMBIGUOUS, never guess). Omit
 * `chapterId` for a CENTRAL-scoped lookup (org-wide rows only — there's no
 * single chapter's local rows to union in). Used by
 * `migrations/0047_service_conditions_to_ids.ts` to convert a legacy free-text
 * `has_service` condition string, which was never structured as
 * "Parent:Child", into an id by plain-name match.
 */
export async function buildServiceNameIndex(
  ctx: QueryCtx,
  chapterId?: Id<"chapters">,
): Promise<Map<string, Id<"serviceOptions">[]>> {
  const orgWide = await ctx.db
    .query("serviceOptions")
    .withIndex("by_chapter", (q) => q.eq("chapterId", undefined))
    .take(CATALOG_SCAN_LIMIT);
  const local = chapterId
    ? await ctx.db
        .query("serviceOptions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .take(CATALOG_SCAN_LIMIT)
    : [];
  const index = new Map<string, Id<"serviceOptions">[]>();
  for (const row of [...orgWide, ...local]) {
    const key = row.name.trim().toLowerCase();
    const list = index.get(key);
    if (list) list.push(row._id);
    else index.set(key, [row._id]);
  }
  return index;
}

/** Assert every id in `serviceIds` is a real `serviceOptions` row USABLE by
 *  `chapterId` — either org-wide (`chapterId` absent on the row) or local to
 *  THIS chapter — the write-side guard `people.ts#create`/`update` run before
 *  trusting a client-supplied `serviceIds` array (a person's services must
 *  come from a catalog their chapter can actually see, never a stray/
 *  another-chapter's-local id). */
export async function assertServiceIdsInChapter(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  serviceIds: Id<"serviceOptions">[],
): Promise<void> {
  for (const id of serviceIds) {
    const row = await ctx.db.get(id);
    if (!row || (row.chapterId !== undefined && row.chapterId !== chapterId)) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "One of the selected services isn't available in your chapter's catalog.",
      });
    }
  }
}

/**
 * Resolve a person's `serviceIds` to their display labels (`parent ?
 * "Parent:Child" : "Name"`), skipping any id that no longer resolves (a
 * dangling reference should never happen — options are soft-deleted, never
 * hard-deleted while referenced — but a display helper degrades gracefully
 * rather than throwing). Bounded by the caller's own `serviceIds` array
 * length, which is always small (a handful of tags per person).
 */
export async function resolveServiceLabels(
  ctx: QueryCtx,
  serviceIds: Id<"serviceOptions">[] | undefined,
): Promise<string[]> {
  if (!serviceIds || serviceIds.length === 0) return [];
  const labels: string[] = [];
  for (const id of serviceIds) {
    const row = await ctx.db.get(id);
    if (!row) continue;
    if (row.parentId) {
      const parent = await ctx.db.get(row.parentId);
      labels.push(parent ? `${parent.name}:${row.name}` : row.name);
    } else {
      labels.push(row.name);
    }
  }
  return labels;
}

/** Bound on the `by_parent` scan `expandServiceIdsWithChildren` runs per
 *  selected id — mirrors `lib/audienceTargeting.ts#SERVICE_CHILDREN_LIMIT`
 *  (same table, same one-level-of-nesting reasoning). */
const SERVICE_FILTER_CHILDREN_LIMIT = 500;

/**
 * People-CRM overhaul (2026-07-27) — the People grid's "Services" filter is
 * multi-select with OR semantics: picking a PARENT must match everyone
 * tagged with it OR any of its children, exactly like a `has_service`
 * audience condition (`lib/audienceTargeting.ts#buildServiceIndex`) — the
 * grid and targeting must never disagree about what selecting a service
 * means. Expands the caller's selected ids into the UNION of every id that
 * should count as a match (each id, plus its direct children, if any — one
 * level of nesting only, mirrors `schema/services.ts`), so a person matches
 * the filter iff `person.serviceIds` intersects this set.
 */
export async function expandServiceIdsWithChildren(
  ctx: QueryCtx,
  serviceIds: Id<"serviceOptions">[],
): Promise<Set<Id<"serviceOptions">>> {
  const out = new Set<Id<"serviceOptions">>();
  for (const id of serviceIds) {
    out.add(id);
    const children = await ctx.db
      .query("serviceOptions")
      .withIndex("by_parent", (q) => q.eq("parentId", id))
      .take(SERVICE_FILTER_CHILDREN_LIMIT);
    for (const c of children) out.add(c._id);
  }
  return out;
}
