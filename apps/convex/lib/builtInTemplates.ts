/**
 * Seeding for the built-in campaign templates that ship in code
 * (`@events-os/shared`'s `BUILT_IN_CAMPAIGN_TEMPLATES` — today the Public
 * Worship monthly newsletter).
 *
 * Since the templates merge (2026-07-29 — `schema/campaigns.ts`'s `kind` doc),
 * a "built-in template" is a `kind: "template"` row in the `campaigns` table,
 * not a row in the (now-frozen) `campaignTemplates` table.
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
 *
 * ── Artwork ────────────────────────────────────────────────────────────────
 * The shipped templates carry EMPTY image slots (a hardcoded CDN URL would
 * rot). This is where they get filled: one bounded read of `emailImages` for
 * the scope, keyed by `sourceKey`, handed to `fillTemplateArtwork`. That
 * happens BEFORE the content diff, so an import that lands after the template
 * was seeded still reaches it — the ordering hazard that made the images and
 * the template ship as two halves of a feature that never met.
 */

import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import {
  BUILT_IN_CAMPAIGN_TEMPLATES,
  fillTemplateArtwork,
  validateEmailDocument,
  type ResolvedArtwork,
} from "@events-os/shared";

/** Bound on a single scope's templates — the same never-scan-unbounded
 *  discipline `listAudiences` uses, sized far above any plausible library. */
export const TEMPLATE_SCAN_LIMIT = 200;

/** Bound on one scope's image library. Mirrors `emailImages.ts`'s own limit
 *  (kept local rather than imported so this dependency-free lib module doesn't
 *  start pulling in a function file — see the header). 500 comfortably covers
 *  the eleven imported newsletter assets plus anything hand-uploaded. */
export const IMAGE_SCAN_LIMIT = 500;

/**
 * Every imported library image for a scope, keyed by its stable `sourceKey`.
 *
 * ONE bounded read for the whole seed, hoisted out of the template loop: the
 * `by_scope` index hands back all eleven newsletter rows at once, which is
 * strictly cheaper than eleven point lookups (and cheaper than an index nobody
 * else would use).
 *
 * `alt` comes off the ROW, not off `NEWSLETTER_ASSETS`: the import writes every
 * row with empty alt on purpose, so taking it from the manifest would freeze it
 * empty forever. Reading the row means a human writing real alt text in the
 * image library has it carried into the template on the next seed.
 */
async function resolveArtwork(
  ctx: MutationCtx,
  scope: Id<"chapters"> | "central",
): Promise<Map<string, ResolvedArtwork>> {
  const images = await ctx.db
    .query("emailImages")
    .withIndex("by_scope", (q) => q.eq("scope", scope))
    .take(IMAGE_SCAN_LIMIT);

  const byKey = new Map<string, ResolvedArtwork>();
  for (const image of images) {
    const key = image.sourceKey;
    // Hand-uploaded images have no `sourceKey` and are not template artwork.
    if (typeof key !== "string" || key.length === 0) continue;
    // The import refuses to write a duplicate key, so this only matters if one
    // was created by hand: first row wins, deterministically.
    if (byKey.has(key)) continue;
    byKey.set(key, { url: image.url, alt: image.alt });
  }
  return byKey;
}

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

/**
 * JSON with object keys in a stable order, for comparing a document we just
 * built in memory against one that has been through the database.
 *
 * A plain `JSON.stringify` diff CANNOT work here: Convex normalizes object key
 * order on write, so a stored block comes back as `{alt, id, kind}` while the
 * shipped constant serializes as `{id, kind, alt}`. The two are the same
 * document and every plain-stringify comparison of them was false — meaning
 * the "patches ONLY when the shipped content actually differs" promise in this
 * module's header was not true: every seed, on every deploy and every
 * `createCampaign`, rewrote the row and bumped `updatedAt`. Sorting the keys on
 * both sides makes the comparison mean what it always claimed to.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

export async function seedBuiltInTemplates(
  ctx: MutationCtx,
  scope: Id<"chapters"> | "central",
  createdBy: Id<"users">,
): Promise<Id<"campaigns">[]> {
  // `campaigns` rows carrying `kind: "template"` — the templates merge
  // (2026-07-29) retargeted this from the (now-frozen) `campaignTemplates`
  // table onto `by_scope_kind`, an EXACT index for this read (every
  // template-kind row stamps `kind` explicitly — see `schema/campaigns.ts`'s
  // doc on `kind`).
  const existing = await ctx.db
    .query("campaigns")
    .withIndex("by_scope_kind", (q) => q.eq("scope", scope).eq("kind", "template"))
    .take(TEMPLATE_SCAN_LIMIT);

  // Read the image library ONCE, before the loop and before the diff below:
  // the artwork is part of the document being compared, so resolving it after
  // the `JSON.stringify` comparison would make every seed decide "unchanged"
  // and never fill a slot.
  const artwork = await resolveArtwork(ctx, scope);

  const now = Date.now();
  const ids: Id<"campaigns">[] = [];
  for (const template of BUILT_IN_CAMPAIGN_TEMPLATES) {
    // Place whatever artwork is on file. With an empty library this is a
    // no-op returning the shipped document byte-for-byte, so a deployment that
    // hasn't run the import doesn't churn `updatedAt` on every deploy.
    const doc = assertValidTemplateDoc(fillTemplateArtwork(template.doc, artwork));
    const match = existing.find((t) => t.isBuiltIn === true && t.name === template.name);
    if (match) {
      ids.push(match._id);
      // Deliberately deleted — stay deleted. Note the consequence: an archived
      // built-in never receives the artwork either, because it is never
      // patched again. That is correct — resurrecting content into a row
      // someone deleted would be worse — but it does mean "I deleted it and
      // the images never showed up" is expected, not a bug.
      if (match.archived === true) continue;
      const sameDoc = canonicalJson(match.doc) === canonicalJson(doc);
      if (sameDoc && match.description === template.description) continue;
      await ctx.db.patch(match._id, {
        doc,
        description: template.description,
        updatedAt: now,
      });
      continue;
    }
    ids.push(
      await ctx.db.insert("campaigns", {
        scope,
        name: template.name,
        description: template.description,
        doc,
        kind: "template",
        // Every campaigns row needs a status; a template-kind row never
        // transitions out of it — see `schema/campaigns.ts`'s `kind` doc.
        status: "draft",
        subject: "",
        isBuiltIn: true,
        createdBy,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  return ids;
}
