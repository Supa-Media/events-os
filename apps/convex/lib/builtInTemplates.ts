/**
 * Seeding for the built-in campaign templates that ship in code
 * (`@events-os/shared`'s `BUILT_IN_CAMPAIGN_TEMPLATES` — today the Public
 * Worship monthly newsletter).
 *
 * ── Why this lives in `lib/` rather than in `campaignTemplates.ts` ──────────
 * Three callers need it and two of them would otherwise form an import cycle:
 *  - `migrations/0049_seed_builtin_campaign_templates.ts` (the deploy path),
 *  - `campaignTemplates.ts#ensureBuiltInTemplates` (the internalMutation),
 *  - `campaigns.ts#createCampaign` (the opportunistic guarantee).
 * `campaignTemplates.ts` already imports `applyThemeToDoc`/`docHasTheme` from
 * `campaigns.ts`, so having `campaigns.ts` import the seeder back from
 * `campaignTemplates.ts` would close a cycle. A dependency-free lib module
 * breaks it, and a migration can't `runMutation` anyway — it executes inside a
 * `MutationCtx` and needs a plain helper.
 *
 * Idempotent by construction: keyed on `isBuiltIn && name` per scope, patches
 * in place ONLY when the shipped content actually differs (so an unchanged
 * deploy doesn't churn `updatedAt`), and deliberately leaves an archived row
 * archived — a template someone deleted must not resurrect itself on the next
 * deploy.
 */

import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { BUILT_IN_CAMPAIGN_TEMPLATES, validateEmailDocument } from "@events-os/shared";

/** Bound on a single scope's templates — the same never-scan-unbounded
 *  discipline `listAudiences` uses, sized far above any plausible library. */
export const TEMPLATE_SCAN_LIMIT = 200;

/** Run a document through the shared write gate, raising this surface's
 *  `INVALID_DOC` (the same code `campaigns.ts` uses, so a client handles one
 *  shape). A template is a document that will eventually be SENT, so it goes
 *  through the same gate a campaign's own `doc` does. */
export function assertValidTemplateDoc(doc: unknown) {
  const validated = validateEmailDocument(doc);
  if (!validated.ok) {
    throw new ConvexError({ code: "INVALID_DOC", message: validated.error });
  }
  return validated.doc;
}

export async function seedBuiltInTemplates(
  ctx: MutationCtx,
  scope: Id<"chapters"> | "central",
  createdBy: Id<"users">,
): Promise<Id<"campaignTemplates">[]> {
  const existing = await ctx.db
    .query("campaignTemplates")
    .withIndex("by_scope", (q) => q.eq("scope", scope))
    .take(TEMPLATE_SCAN_LIMIT);

  const now = Date.now();
  const ids: Id<"campaignTemplates">[] = [];
  for (const template of BUILT_IN_CAMPAIGN_TEMPLATES) {
    const doc = assertValidTemplateDoc(template.doc);
    const match = existing.find((t) => t.isBuiltIn === true && t.name === template.name);
    if (match) {
      ids.push(match._id);
      if (match.archived === true) continue; // deliberately deleted — stay deleted
      const sameDoc = JSON.stringify(match.doc) === JSON.stringify(doc);
      if (sameDoc && match.description === template.description) continue;
      await ctx.db.patch(match._id, {
        doc,
        description: template.description,
        updatedAt: now,
      });
      continue;
    }
    ids.push(
      await ctx.db.insert("campaignTemplates", {
        scope,
        name: template.name,
        description: template.description,
        doc,
        isBuiltIn: true,
        createdBy,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  return ids;
}
