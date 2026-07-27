import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { buildServiceNameIndex } from "../lib/serviceCatalog";

/**
 * Convert saved `has_service` audience conditions from the pre-catalog
 * `{ service: string }` shape to the Service Catalog `{ serviceId }` shape
 * (`schema/campaigns.ts`'s `audienceConditionValidator`). Read via `any`
 * throughout this file (same technique migration 0009 uses for a retired
 * field) since the CURRENT schema/generated types only know the new
 * `serviceId` shape — a stored pre-migration row's `has_service` condition
 * doesn't conform to it.
 *
 * ── Matching rule ───────────────────────────────────────────────────────────
 * The legacy string was NEVER structured as "Parent:Child" (it was matched
 * as a flat case-insensitive string against `people.services`), so this
 * matches it against catalog rows' bare `name` ONLY (parent or child, either
 * can win) — `lib/serviceCatalog.ts#buildServiceNameIndex`. A string that
 * resolves to EXACTLY ONE row converts; anything else is left UNTOUCHED and
 * reported in `unresolved`, never guessed or dropped:
 *  - "no_match" — no catalog row shares that name.
 *  - "ambiguous" — MORE than one row shares that name (the canonical catalog
 *    itself has this: `Vocals:Bass` and `Instruments:Bass` both end in
 *    "Bass") — picking one would silently narrow or widen the audience in a
 *    way nobody asked for, so this is treated exactly like no match.
 *  - "no_chapter_anchor" — the condition belongs to a `scope: "central"`
 *    audience. `serviceOptions` is chapter-scoped (`schema/services.ts`), so
 *    there is no single chapter whose catalog is "the" catalog to resolve a
 *    central audience's condition against — converting it would mean
 *    arbitrarily picking one chapter's row id, which would only ever match
 *    THAT chapter's people even though the audience spans every chapter.
 *    Left untouched deliberately (this is a real gap inherited from the
 *    contract's single-`serviceId`-per-condition shape, not something this
 *    migration can resolve on its own) rather than silently narrowing a
 *    central audience to one chapter's roster.
 *
 * A condition left unconverted keeps evaluating under the OLD shape, which no
 * longer type-checks against `AudienceCondition` but still round-trips
 * through Convex (schema validators aren't enforced on documents already
 * stored, only on new writes) — `lib/audienceTargeting.ts`'s evaluator will
 * simply never match `field: "has_service"` there (no `serviceId` to read),
 * i.e. it silently reads as "no one has this" rather than "everyone" or a
 * crash. That's a live behavior change for an unresolved condition (not
 * fully faithful to its old string-matched membership), but it is NEVER
 * "matches everyone" — the one behavior explicitly ruled out by the task.
 *
 * IDEMPOTENT: a condition that already carries `serviceId` is left alone
 * (`skippedAlreadyIds`); a condition already converted by a prior run is
 * simply skipped on the next.
 */

const AUDIENCE_SCAN_LIMIT = 2000;

type UnresolvedReason = "no_match" | "ambiguous" | "no_chapter_anchor";

export type ServiceConditionsToIdsResult = {
  scanned: number;
  audiencesConverted: number;
  conditionsConverted: number;
  skippedAlreadyIds: number;
  unresolved: {
    audienceId: Id<"audiences">;
    audienceName: string;
    value: string;
    reason: UnresolvedReason;
  }[];
};

/** Convert one condition (raw/untyped) in place if it's a legacy
 *  `has_service` string condition resolvable to exactly one row. Returns the
 *  (possibly unchanged) condition plus whether it changed. */
async function convertCondition(
  ctx: MutationCtx,
  c: any,
  scope: unknown,
  nameIndexByChapter: Map<Id<"chapters">, Map<string, Id<"serviceOptions">[]>>,
  onUnresolved: (value: string, reason: UnresolvedReason) => void,
): Promise<{ condition: any; changed: boolean }> {
  if (!c || c.field !== "has_service" || c.serviceId !== undefined) {
    return { condition: c, changed: false };
  }
  const raw = typeof c.service === "string" ? c.service : "";
  const key = raw.trim().toLowerCase();

  if (scope === "central") {
    onUnresolved(raw, "no_chapter_anchor");
    return { condition: c, changed: false };
  }

  const chapterId = scope as Id<"chapters">;
  let nameIndex = nameIndexByChapter.get(chapterId);
  if (!nameIndex) {
    nameIndex = await buildServiceNameIndex(ctx, chapterId);
    nameIndexByChapter.set(chapterId, nameIndex);
  }
  const matches = nameIndex.get(key) ?? [];
  if (matches.length !== 1) {
    onUnresolved(raw, matches.length === 0 ? "no_match" : "ambiguous");
    return { condition: c, changed: false };
  }
  return {
    condition: { field: "has_service", op: c.op, serviceId: matches[0] },
    changed: true,
  };
}

export async function runServiceConditionsToIds(
  ctx: MutationCtx,
): Promise<ServiceConditionsToIdsResult> {
  const result: ServiceConditionsToIdsResult = {
    scanned: 0,
    audiencesConverted: 0,
    conditionsConverted: 0,
    skippedAlreadyIds: 0,
    unresolved: [],
  };
  const nameIndexByChapter = new Map<Id<"chapters">, Map<string, Id<"serviceOptions">[]>>();

  const audiences = await ctx.db.query("audiences").take(AUDIENCE_SCAN_LIMIT);
  for (const audience of audiences) {
    result.scanned++;
    const targeting = (audience as any).targeting;
    if (!targeting) continue;

    let changedAny = false;
    const convertGroup = async (group: any) => {
      let groupChanged = false;
      const conditions = await Promise.all(
        (group.conditions as any[]).map(async (c) => {
          if (c?.field === "has_service" && c.serviceId !== undefined) {
            result.skippedAlreadyIds++;
            return c;
          }
          const { condition, changed } = await convertCondition(
            ctx,
            c,
            audience.scope,
            nameIndexByChapter,
            (value, reason) => {
              result.unresolved.push({
                audienceId: audience._id,
                audienceName: audience.name,
                value,
                reason,
              });
            },
          );
          if (changed) {
            groupChanged = true;
            result.conditionsConverted++;
          }
          return condition;
        }),
      );
      if (groupChanged) changedAny = true;
      return groupChanged ? { ...group, conditions } : group;
    };

    const groups = await Promise.all((targeting.groups as any[]).map(convertGroup));
    const excludeGroups = targeting.excludeGroups
      ? await Promise.all((targeting.excludeGroups as any[]).map(convertGroup))
      : undefined;

    if (changedAny) {
      await ctx.db.patch(audience._id, {
        targeting: {
          ...targeting,
          groups,
          ...(excludeGroups ? { excludeGroups } : {}),
        },
      });
      result.audiencesConverted++;
    }
  }

  return result;
}

export const serviceConditionsToIds: Migration = {
  name: "0046_service_conditions_to_ids",
  run: runServiceConditionsToIds,
};
