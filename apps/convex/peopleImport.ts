/**
 * PEOPLE-tab contacts import (founder ask, 2026-07-25: "the import should be
 * in people, not giving") — the roster-facing home for bulk CONTACT
 * onboarding (a pasted Givebutter contacts export, or plain name/email/phone
 * lines). Two-phase like every import in this app: `previewContactsImport`
 * (query, read-only dispositions) → `importContacts` (mutation, batched by
 * the CLIENT at ≤ `CONTACTS_IMPORT_BATCH_LIMIT` rows per call).
 *
 * This deliberately REUSES the giving import's person machinery rather than
 * growing a second matcher: `matchOrCreatePersonContact` (email → phone →
 * exact-name match against the chapter roster; contact-only insert with
 * structured name halves + the `personEmails` write-through; the
 * no-identifier owner rule) — so a contact created here is byte-identical to
 * one created by a `contact` row in the canonical giving import. What
 * DIFFERS is scope and access: this surface is chapter-roster work, so it's
 * gated exactly like the People grid's own add-row (`people.create`'s
 * chapter-membership check via `requireChapterId`), NOT by giving-manage
 * power — a person managing the mailing list shouldn't need access to the
 * money desk. Money row types (`gift`/`ticket`/`recurring`) are simply not
 * accepted here; the canonical giving import remains their home.
 *
 * Read budget per call: ONE `chapterRoster` read (the same bounded helper
 * every roster surface uses) shared across the whole batch via
 * `matchOrCreatePersonContact`'s prefetched-pool param, plus ≤ one insert +
 * one `personEmails` upsert per new row. New inserts are appended to the
 * in-call pool so duplicate rows WITHIN one paste match instead of
 * double-creating; across calls, match-or-create makes re-runs idempotent.
 *
 * Row shape (person-form-fields widening, founder ask 2026-07-27): beyond
 * bare identity, a row may also carry `serviceIds`/`location`/
 * `referralSource`/`consentedAt`+`consentSource`/`isVolunteer` —
 * `givingImport.ts#PersonContactFacts`. On CREATE these are written
 * straight through; on a MATCH they fill blanks ONLY (see
 * `matchOrCreatePersonContact`'s doc) — a re-import of an existing contact
 * can add newly-learned facts but never overwrite a value already on file.
 */
import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { requireChapterId, requireUserId } from "./lib/context";
import { chapterRoster } from "./lib/org";
import { matchIdentity, matchOrCreatePersonContact } from "./givingImport";
import { hasPersonIdentifier } from "./lib/givingDonors";

/** Client-side chunk size — a paste bigger than this arrives as sequential
 *  calls (the People import screen chunks; see its doc). Enforced, not
 *  advisory, so one call's read/write budget stays boringly bounded. */
export const CONTACTS_IMPORT_BATCH_LIMIT = 100;

const contactRowValidator = v.object({
  name: v.string(),
  // Pre-split halves when the source had them (Givebutter's First/Preferred/
  // Last columns) — same semantics as the canonical import's contact rows.
  firstName: v.optional(v.string()),
  lastName: v.optional(v.string()),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  // Service Catalog ids — same fields the roster's own `people.create`/
  // `update` accept (`schema/people.ts#serviceIds`).
  serviceIds: v.optional(v.array(v.id("serviceOptions"))),
  // Person-form-fields widening (founder ask, 2026-07-27): the 6 Google Form
  // exports carry these answers, and until this widening every one of them
  // was silently dropped on import — only name/email/phone survived. See
  // `schema/people.ts`'s doc on each field for what writes/reads it and,
  // for `consentedAt`/`consentSource`, the loud compliance warning about
  // suppression always winning.
  location: v.optional(v.string()),
  referralSource: v.optional(v.string()),
  consentedAt: v.optional(v.number()),
  consentSource: v.optional(v.string()),
  isVolunteer: v.optional(v.boolean()),
});

function assertBatchSize(rows: unknown[]): void {
  if (rows.length > CONTACTS_IMPORT_BATCH_LIMIT) {
    throw new ConvexError({
      code: "TOO_MANY_ROWS",
      message: `Import at most ${CONTACTS_IMPORT_BATCH_LIMIT} contacts per call.`,
    });
  }
}

/**
 * Read-only dispositions for one batch: `new` (will create), `matched`
 * (existing person — matched by email, phone, or exact name; nothing
 * written), `no-identifier` (no email AND no phone and no roster match —
 * reported, never created; the Attendance C owner rule). Same simulation
 * trick the canonical preview uses: rows earlier in THIS batch join an
 * in-memory pool so a duplicate later in the same paste previews as
 * `matched`, exactly what commit will do.
 */
export const previewContactsImport = query({
  args: { rows: v.array(contactRowValidator) },
  returns: v.object({
    rows: v.array(
      v.object({
        index: v.number(),
        disposition: v.union(v.literal("new"), v.literal("matched"), v.literal("no-identifier")),
        matchedName: v.optional(v.string()),
      }),
    ),
    newCount: v.number(),
    matchedCount: v.number(),
    noIdentifierCount: v.number(),
  }),
  handler: async (ctx, { rows }) => {
    assertBatchSize(rows);
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireUserId(ctx);

    const roster = await chapterRoster(ctx, chapterId);
    const pool: { name: string; email?: string; phone?: string }[] = roster.map((p) => ({
      name: p.name,
      email: p.email,
      phone: p.phone,
    }));

    const out: { index: number; disposition: "new" | "matched" | "no-identifier"; matchedName?: string }[] = [];
    let newCount = 0;
    let matchedCount = 0;
    let noIdentifierCount = 0;
    rows.forEach((row, index) => {
      const { match } = matchIdentity(pool, row);
      if (match) {
        matchedCount++;
        out.push({ index, disposition: "matched", matchedName: match.name });
        return;
      }
      if (!hasPersonIdentifier({ email: row.email, phone: row.phone })) {
        noIdentifierCount++;
        out.push({ index, disposition: "no-identifier" });
        return;
      }
      newCount++;
      out.push({ index, disposition: "new" });
      pool.push({ name: row.name, email: row.email, phone: row.phone });
    });
    return { rows: out, newCount, matchedCount, noIdentifierCount };
  },
});

export const importContacts = mutation({
  args: { rows: v.array(contactRowValidator) },
  returns: v.object({
    created: v.number(),
    matched: v.number(),
    skippedNoIdentifier: v.number(),
  }),
  handler: async (ctx, { rows }) => {
    assertBatchSize(rows);
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireUserId(ctx);

    // One roster read for the whole batch; every insert joins the pool so
    // same-paste duplicates match instead of double-creating.
    const roster: Doc<"people">[] = await chapterRoster(ctx, chapterId);

    let created = 0;
    let matched = 0;
    let skippedNoIdentifier = 0;
    for (const row of rows) {
      const res = await matchOrCreatePersonContact(ctx, chapterId, row, roster);
      if (res.skipped) {
        skippedNoIdentifier++;
        continue;
      }
      if (res.isNew) {
        created++;
        const inserted = await ctx.db.get(res.personId);
        if (inserted) roster.push(inserted);
      } else {
        matched++;
      }
    }
    return { created, matched, skippedNoIdentifier };
  },
});
