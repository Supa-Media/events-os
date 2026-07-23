import { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { type BudgetType, type BudgetRefKind } from "@events-os/shared";
import { ensureTag, linkBudgetTag, autoTagEventBudget } from "../budgetTags";
import { type BudgetLevel } from "../budgetCore";

/**
 * Backfill every legacy budget onto the v2 `type` + tag model. Shared body for
 * the superuser-gated public mutation and the no-auth CLI internal wrapper.
 * Idempotent: a budget that already has `type` set is skipped, so re-runs are
 * no-ops.
 *
 * Per-scope mapping:
 *  - event    → one_time, refKind=event; auto-tag the eventType template tag + an "events" tag
 *  - project  → one_time, refKind=project
 *  - team     → recurring; ensure/link a `team` tag (refId=teamId, name=financeTeams.name)
 *  - template → recurring; ensure/link a `template` tag when scopeRefId resolves to an eventType
 *  - bucket   → recurring (no tags)
 *  - chapter  → recurring (no tags)
 */
export async function runBudgetScopeMigration(
  ctx: MutationCtx,
): Promise<{ migrated: number; skipped: number; tagsLinked: number }> {
    let migrated = 0;
    let skipped = 0;
    let tagsLinked = 0;

    const all = await ctx.db.query("budgets").collect();
    for (const b of all) {
      // Idempotent: a budget already on the v2 model is left untouched.
      if (b.type != null) {
        skipped++;
        continue;
      }
      const level = b.chapterId as BudgetLevel;
      const seen = new Set<string>();
      let type: BudgetType = "recurring";
      let refKind: BudgetRefKind | undefined;

      switch (b.scope) {
        case "event": {
          type = "one_time";
          refKind = "event";
          break;
        }
        case "project": {
          type = "one_time";
          refKind = "project";
          break;
        }
        case "team": {
          type = "recurring";
          const teamId = (b.teamId ?? b.scopeRefId) as Id<"financeTeams"> | undefined;
          if (teamId) {
            const team = await ctx.db.get(teamId);
            if (team && "name" in team) {
              const tagId = await ensureTag(ctx, {
                chapterId: level,
                name: (team as Doc<"financeTeams">).name,
                kind: "team",
                refId: teamId,
              });
              await linkBudgetTag(ctx, b._id, level, tagId, seen);
              tagsLinked++;
            }
          }
          break;
        }
        case "template": {
          type = "recurring";
          if (b.scopeRefId) {
            const et = await ctx.db.get(b.scopeRefId as Id<"eventTypes">);
            if (et && "name" in et) {
              const tagId = await ensureTag(ctx, {
                chapterId: level,
                name: (et as Doc<"eventTypes">).name,
                kind: "template",
                refId: b.scopeRefId,
              });
              await linkBudgetTag(ctx, b._id, level, tagId, seen);
              tagsLinked++;
            }
          }
          break;
        }
        // bucket / chapter / undefined → recurring, no tags.
        default:
          type = "recurring";
          break;
      }

      await ctx.db.patch(b._id, { type, refKind });

      // Event budgets also get the auto template + events tags.
      if (type === "one_time" && refKind === "event") {
        const before = seen.size;
        await autoTagEventBudget(ctx, b._id, level, b.scopeRefId ?? undefined, seen);
        tagsLinked += seen.size - before;
      }
      migrated++;
    }

    return { migrated, skipped, tagsLinked };
}
