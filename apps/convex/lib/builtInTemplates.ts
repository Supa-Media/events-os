/**
 * Seeding for the built-in campaign templates that ship in code — today the
 * Public Worship monthly newsletter, as of this change shipped as the
 * TIPTAP document (`@events-os/shared`'s `PUBLIC_WORSHIP_NEWSLETTER_TIPTAP`,
 * the WS4 "acceptance artefact" — see that module's doc), no longer the
 * legacy blocks-format `PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE`.
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
 * in place ONLY when the shipped content (OR its `docFormat`) actually
 * differs (so an unchanged deploy doesn't churn `updatedAt`), and deliberately
 * leaves an archived row archived — a template someone deleted must not
 * resurrect itself on the next deploy.
 *
 * ── The blocks → tiptap flip is an UPDATE, not a new row ────────────────────
 * `BUILT_IN_TEMPLATE_SEEDS` below is keyed by `name`, same as before — the
 * "Monthly newsletter" built-in row is patched IN PLACE from the legacy
 * blocks document to the tiptap one. That is deliberately correct, not a
 * shortcut: templates carry no approval snapshot (they never enter the
 * approval state machine — `schema/campaigns.ts`'s `kind` doc), and any EMAIL
 * already created from the old template is a separate `campaigns` row,
 * unaffected by what the template row now contains. `docFormat` flips from
 * absent (blocks) to `"tiptap"` in the same patch as `doc` — see the
 * `formatChanged` branch in `seedBuiltInTemplates` below for how the
 * canonical-JSON no-churn diff was extended to trigger that flip exactly
 * once and never re-trigger once it has happened.
 *
 * ── Artwork ────────────────────────────────────────────────────────────────
 * The shipped templates carry EMPTY image slots (a hardcoded CDN URL would
 * rot). This is where they get filled: one bounded read of `emailImages` for
 * the scope, keyed by `sourceKey`, handed to `fillTemplateArtwork` (blocks) or
 * `fillTiptapArtwork` (tiptap) — both key off the SAME `sourceKey` library, so
 * the eleven imported newsletter assets land in tiptap's `pwSlot`-tagged nodes
 * exactly as they did in the blocks format's block ids. That happens BEFORE
 * the content diff, so an import that lands after the template was seeded
 * still reaches it — the ordering hazard that made the images and the
 * template ship as two halves of a feature that never met.
 */

import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import {
  PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE,
  PUBLIC_WORSHIP_NEWSLETTER_TIPTAP,
  emailDocFormatOf,
  fillTemplateArtwork,
  fillTiptapArtwork,
  validateEmailDocument,
  validateTiptapEmailDoc,
  type EmailDocFormat,
  type EmailDocument,
  type NewsletterTiptapDoc,
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

/**
 * Run a document through the write gate ITS OWN `docFormat` names, raising
 * this surface's `INVALID_DOC` (the same code `campaigns.ts`/
 * `campaignTemplates.ts` use, so a client handles one shape). A template is a
 * document that will eventually be SENT, so it goes through the same gate a
 * campaign's own `doc` does — the tiptap analogue of `validateEmailDocument`
 * is `validateTiptapEmailDoc` (`tiptapEmail.ts`), dispatched on here exactly
 * like `campaigns.ts#validateDocForFormat` / `campaignTemplates.ts`'s own
 * (private) `assertValidDoc` do for every other write path.
 */
export function assertValidTemplateDoc(docFormat: EmailDocFormat, doc: unknown) {
  if (docFormat === "tiptap") {
    const validated = validateTiptapEmailDoc(doc);
    if (!validated.ok) {
      throw new ConvexError({ code: "INVALID_DOC", message: validated.error });
    }
    return doc;
  }
  const validated = validateEmailDocument(doc);
  if (!validated.ok) {
    throw new ConvexError({ code: "INVALID_DOC", message: validated.error });
  }
  return validated.doc;
}

/**
 * One shipped built-in, tagged with the format its `doc` is written in. Today
 * a single entry — the Public Worship monthly newsletter, shipped as the
 * TIPTAP document (`PUBLIC_WORSHIP_NEWSLETTER_TIPTAP`, the WS4 acceptance
 * artefact) — but keeping `docFormat` per-entry (rather than assuming every
 * built-in is tiptap) means a future built-in can still ship blocks-format
 * without this module changing shape again.
 *
 * `name`/`description` are pulled from the legacy blocks `CampaignTemplate`
 * (`PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE`) rather than re-typed here: the two
 * formats describe the SAME newsletter to a human picking a starting point,
 * so the copy stays one source, not two that can drift apart.
 */
type BuiltInTemplateSeed = {
  name: string;
  description: string;
  docFormat: EmailDocFormat;
  doc: EmailDocument | NewsletterTiptapDoc;
};

const BUILT_IN_TEMPLATE_SEEDS: readonly BuiltInTemplateSeed[] = [
  {
    name: PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE.name,
    description: PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE.description,
    docFormat: "tiptap",
    doc: PUBLIC_WORSHIP_NEWSLETTER_TIPTAP,
  },
];

/** Place whatever artwork is on file into a seed's empty slots, dispatched on
 *  its `docFormat` — `fillTemplateArtwork` (blocks) and `fillTiptapArtwork`
 *  (tiptap) both key off the SAME `sourceKey` library (see this module's
 *  header), so one `resolveArtwork` read serves either format. */
function fillArtwork(
  seed: BuiltInTemplateSeed,
  artwork: ReadonlyMap<string, ResolvedArtwork>,
): unknown {
  return seed.docFormat === "tiptap"
    ? fillTiptapArtwork(seed.doc as NewsletterTiptapDoc, artwork)
    : fillTemplateArtwork(seed.doc as EmailDocument, artwork);
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
  for (const seed of BUILT_IN_TEMPLATE_SEEDS) {
    // Place whatever artwork is on file. With an empty library this is a
    // no-op returning the shipped document byte-for-byte, so a deployment that
    // hasn't run the import doesn't churn `updatedAt` on every deploy.
    const doc = assertValidTemplateDoc(seed.docFormat, fillArtwork(seed, artwork));
    const match = existing.find((t) => t.isBuiltIn === true && t.name === seed.name);
    if (match) {
      ids.push(match._id);
      // Deliberately deleted — stay deleted. Note the consequence: an archived
      // built-in never receives the artwork either, because it is never
      // patched again. That is correct — resurrecting content into a row
      // someone deleted would be worse — but it does mean "I deleted it and
      // the images never showed up" is expected, not a bug.
      if (match.archived === true) continue;
      // The format flip (blocks → tiptap) is itself a content change the
      // canonical-JSON diff below must catch even in the (structurally
      // impossible in practice, but not asserted) case that a blocks doc and
      // a tiptap doc happened to canonicalize identically. Checked here,
      // explicitly, rather than trusted to the JSON diff alone — this is what
      // makes the flip fire EXACTLY ONCE: the row's `docFormat` becomes
      // `"tiptap"` on the first patch, so `formatChanged` is false on every
      // re-seed after that and the ordinary no-churn diff takes back over.
      const formatChanged = emailDocFormatOf(match) !== seed.docFormat;
      const sameDoc = !formatChanged && canonicalJson(match.doc) === canonicalJson(doc);
      if (sameDoc && match.description === seed.description) continue;
      await ctx.db.patch(match._id, {
        doc,
        // Absent-means-"blocks" — only stamp the column when it's actually
        // "tiptap", matching every other write path's rule (`createCampaign`,
        // `createTemplate`, `duplicateCampaignRow`).
        docFormat: seed.docFormat === "tiptap" ? "tiptap" : undefined,
        description: seed.description,
        updatedAt: now,
      });
      continue;
    }
    ids.push(
      await ctx.db.insert("campaigns", {
        scope,
        name: seed.name,
        description: seed.description,
        doc,
        docFormat: seed.docFormat === "tiptap" ? "tiptap" : undefined,
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
