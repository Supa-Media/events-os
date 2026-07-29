/**
 * Templates merge (founder decision, 2026-07-29 — verbatim: "templates should
 * literally just be saved emails that we can edit in the future, like google
 * docs templates, so in the backend I don't think it should be a separate
 * table"). Copies every `campaignTemplates` row into `campaigns` as a
 * `kind: "template"` row — see `schema/campaigns.ts`'s doc on `kind` for the
 * full shape, and `campaignTemplates.ts`'s module doc for how every read/write
 * was retargeted onto these rows in the SAME PR.
 *
 * ── What's copied ───────────────────────────────────────────────────────────
 * `scope`/`name`/`description`/`doc`/`isBuiltIn`/`archived`/`createdBy`/
 * `createdAt`/`updatedAt` — every field a `campaignTemplates` row carries.
 * Fields that exist on `campaigns` but a template never had (`audienceId`,
 * `subject`, every approval field) are simply left unset; `status` is stamped
 * `"draft"`, the sentinel every template-kind row carries and never leaves
 * (see `kind`'s doc — nothing ever reads it for a template row).
 *
 * ── Idempotent, keyed on provenance ─────────────────────────────────────────
 * `mergedFromTemplateId` on the COPY points back at the source
 * `campaignTemplates` row — `by_merged_from_template` is an indexed point
 * lookup for "has this one already been copied?", so a re-run (a second
 * `runPending`, a retried deploy) skips every row it already migrated instead
 * of duplicating it. A template authored AFTER this migration has already run
 * has no `campaignTemplates` counterpart and is simply never touched by it —
 * expected, since every live write path (`campaignTemplates.ts`) writes
 * `campaigns` rows directly from day one.
 *
 * ── What this does NOT do ───────────────────────────────────────────────────
 * The source `campaignTemplates` table is left untouched — no delete, no
 * write. Its module (`campaignTemplates.ts`) stops writing to it as of this
 * same PR (see that file's module doc), so the table is effectively frozen
 * going forward; it stays around, unwritten, as a trivial rollback path for
 * ONE release, and a LATER PR drops it once that window has passed.
 *
 * ── Bound ────────────────────────────────────────────────────────────────
 * A single bounded `.take()` covers every realistic deployment: campaigns is
 * a CENTRAL-only surface (`lib/campaignsAccess.ts`), and every template
 * listing elsewhere in this codebase (`campaignTemplates.ts#listTemplates`,
 * `lib/builtInTemplates.ts`) already treats 200 rows PER SCOPE as the
 * generous ceiling for this exact table. `TEMPLATE_MERGE_LIMIT` here is set
 * well above that, across every scope combined, with no continuation
 * complexity needed for a table this small (contrast the receipts backfill,
 * `0035`, which walks a table that grows without bound).
 */
import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/** Generous relative to `TEMPLATE_SCAN_LIMIT` (200 per scope) — comfortably
 *  covers every template ever created across every scope on a real
 *  deployment. See this file's header for why a single bounded pass (no
 *  scheduler continuation) is the right shape for this table. */
const TEMPLATE_MERGE_LIMIT = 2000;

export async function runMergeCampaignTemplatesIntoCampaigns(
  ctx: MutationCtx,
): Promise<{ migrated: number; skipped: number }> {
  const templates = await ctx.db.query("campaignTemplates").take(TEMPLATE_MERGE_LIMIT);

  let migrated = 0;
  let skipped = 0;
  for (const template of templates) {
    const already = await ctx.db
      .query("campaigns")
      .withIndex("by_merged_from_template", (q) => q.eq("mergedFromTemplateId", template._id))
      .first();
    if (already) {
      skipped++;
      continue;
    }

    await ctx.db.insert("campaigns", {
      scope: template.scope,
      name: template.name,
      // Required on `campaigns`; a template never had one. See this file's
      // header — nothing reads `subject` for a template-kind row.
      subject: "",
      doc: template.doc,
      kind: "template",
      // Sentinel — never transitions for a template-kind row. See
      // `schema/campaigns.ts`'s doc on `kind`.
      status: "draft",
      description: template.description,
      isBuiltIn: template.isBuiltIn,
      archived: template.archived,
      mergedFromTemplateId: template._id,
      createdBy: template.createdBy,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    });
    migrated++;
  }

  return { migrated, skipped };
}

export const mergeCampaignTemplatesIntoCampaigns: Migration = {
  name: "0055_merge_campaign_templates_into_campaigns",
  run: runMergeCampaignTemplatesIntoCampaigns,
};
