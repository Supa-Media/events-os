/**
 * The contractor roster — what we remember about someone between payments, so
 * a returning contractor isn't asked to fill the whole form again (founder,
 * 2026-08-15: "so we don't have to ask recurring people to resubmit the W9s").
 *
 * A SATELLITE ON `people`, never a second roster — see the
 * `contractorProfiles` schema comment for why, and `schema/people.ts` for the
 * house position it would otherwise contradict.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT:
 *
 *  - **It never writes from the public path.** Profiles are staff-initiated
 *    only. A stranger completing a form must not be able to mint roster rows.
 *  - **It never returns a tax document's storage id.** Making a contractor
 *    easier to find must not make their W-9 easier to open;
 *    `requireContractorTaxDocView` is unchanged and still gates the file.
 *  - **It cannot delete evidence the org is required to keep.** `forget`
 *    refuses a document still inside the retention window of a payment that
 *    actually paid out.
 *  - **It never auto-merges on a weak signal.** Two candidate people means
 *    attach none and tell a human — a silent `.first()` is how one contractor's
 *    payment history ends up filed under another's name.
 */
import { query, mutation, internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import {
  CONTRACTOR_TAX_CLASSIFICATIONS,
  taxDocIsCurrent,
  taxDocReuseProblem,
  extendedTaxDocPurgeAfter,
  unpaidTaxDocPurgeAfter,
  type ContractorTaxClassification,
} from "@events-os/shared";
import { normalizeEmail } from "./lib/access";
import { requireChapterId, requireInChapter } from "./lib/context";
import { resolveCallerPersonId } from "./lib/finance";
import {
  requireContractorRosterView,
  requireContractorRosterManage,
  requireContractorForget,
  hasContractorRosterManage,
  hasContractorForget,
} from "./lib/contractorPaymentsAccess";

// ── Reads ───────────────────────────────────────────────────────────────────
/** The profile for one person in this chapter, or null. */
export async function profileFor(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  personId: Id<"people">,
): Promise<Doc<"contractorProfiles"> | null> {
  return await ctx.db
    .query("contractorProfiles")
    .withIndex("by_chapter_and_person", (q) =>
      q.eq("chapterId", chapterId).eq("personId", personId),
    )
    .unique();
}

/** The newest tax document on file for a person in this chapter. Documents are
 *  person-scoped now rather than payment-scoped, which is the whole mechanism
 *  behind not re-asking. */
export async function latestTaxDocFor(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  personId: Id<"people">,
): Promise<Doc<"contractorTaxDocuments"> | null> {
  const docs = await ctx.db
    .query("contractorTaxDocuments")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .order("desc")
    .take(20);
  return docs.find((d) => d.chapterId === chapterId) ?? null;
}

/**
 * The roster: everyone this chapter has paid before, with what is on file.
 *
 * METADATA ONLY about the tax document — kind, when it arrived, whether it is
 * still current. Never a storage id.
 */
export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireContractorRosterView(ctx, chapterId);
    const take = Math.min(Math.max(limit ?? 100, 1), 200);

    const profiles = await ctx.db
      .query("contractorProfiles")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .order("desc")
      .take(take);

    const rows = [];
    for (const p of profiles) {
      const person = await ctx.db.get(p.personId);
      if (!person) continue;
      const doc = await latestTaxDocFor(ctx, chapterId, p.personId);
      rows.push({
        _id: p._id,
        personId: p.personId,
        name: person.name,
        email: person.email,
        businessName: p.businessName,
        taxClassification: p.taxClassification ?? "unknown",
        hasBankOnFile: p.externalAccountId != null,
        bankAccountLast4: p.bankAccountLast4,
        bankConfirmedAt: p.bankConfirmedAt,
        lastPaidAt: p.lastPaidAt,
        // Tax-doc METADATA only.
        taxDocument: doc
          ? {
              kind: doc.kind,
              uploadedAt: doc.uploadedAt,
              signedAt: doc.signedAt,
              isCurrent: taxDocIsCurrent(doc),
              problem: taxDocReuseProblem(doc),
            }
          : null,
      });
    }
    // Two flags, honestly named and separately resolved. They share a body
    // today, but a screen that gated "forget" on "can manage" would start
    // offering a control the server refuses the moment the powers diverge —
    // and forget is the irreversible one.
    return {
      canManage: await hasContractorRosterManage(ctx, chapterId),
      canForget: await hasContractorForget(ctx, chapterId),
      contractors: rows,
    };
  },
});

/**
 * What is on file for one person — the payload the composer uses to prefill.
 *
 * WHAT IT DELIBERATELY DOES NOT RETURN: an amount, a description, or a service
 * date. Those are THIS job's terms. An amount that arrives pre-filled is an
 * amount nobody decided, and a description that arrives pre-filled is a
 * sentence that publishes verbatim and permanently without anyone having
 * written it for this piece of work. `usualRateUsd` comes back as a labelled
 * HINT the composer can tap, which is a different thing from a filled field.
 */
export const onFileFor = query({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireContractorRosterView(ctx, chapterId);
    const person = await ctx.db.get(personId);
    await requireInChapter(ctx, chapterId, person, "Person");

    const profile = await profileFor(ctx, chapterId, personId);
    const doc = await latestTaxDocFor(ctx, chapterId, personId);

    return {
      personId,
      name: person!.name,
      email: person!.email,
      phone: person!.phone,
      businessName: profile?.businessName,
      taxClassification: profile?.taxClassification ?? "unknown",
      hasBankOnFile: profile?.externalAccountId != null,
      bankAccountLast4: profile?.bankAccountLast4,
      bankConfirmedAt: profile?.bankConfirmedAt,
      lastPaidAt: profile?.lastPaidAt,
      taxDocument: doc
        ? {
            kind: doc.kind,
            uploadedAt: doc.uploadedAt,
            signedAt: doc.signedAt,
            isCurrent: taxDocIsCurrent(doc),
            problem: taxDocReuseProblem(doc),
          }
        : null,
      // A HINT, not a prefill — see this function's doc.
      usualRateUsd: person!.usualRateUsd,
    };
  },
});

// ── Matching ────────────────────────────────────────────────────────────────
/**
 * Find the roster person an email belongs to — or decline.
 *
 * NEVER MATCHES ON NAME, and never picks when there is more than one candidate.
 * The failure this avoids is not theoretical: a silent `.first()` files one
 * contractor's payment under another's identity, and at year end their 1099
 * totals are both wrong with nothing on either record saying why.
 *
 * Searches `personEmails` (the table that knows a person's OTHER addresses)
 * as well as the primary, because people change email far more often than they
 * change accountants.
 *
 * Returns `{ personId }` on a confident single match, `{ ambiguous: true }`
 * when several people share the address, and `{}` when nobody does.
 */
export async function matchPersonByEmail(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  rawEmail: string | undefined,
): Promise<{ personId?: Id<"people">; ambiguous?: boolean }> {
  const email = normalizeEmail(rawEmail);
  if (!email) return {};

  const seen = new Map<string, Id<"people">>();

  const direct = await ctx.db
    .query("people")
    .withIndex("by_email", (q) => q.eq("email", email))
    .take(10);
  for (const p of direct) {
    if (p.chapterId === chapterId && p.isPlaceholder !== true) {
      seen.set(String(p._id), p._id);
    }
  }

  const alternates = await ctx.db
    .query("personEmails")
    .withIndex("by_email", (q) => q.eq("email", email))
    .take(10);
  for (const row of alternates) {
    const p = await ctx.db.get(row.personId);
    if (p && p.chapterId === chapterId && p.isPlaceholder !== true) {
      seen.set(String(p._id), p._id);
    }
  }

  const ids = [...seen.values()];
  if (ids.length === 1) return { personId: ids[0] };
  if (ids.length > 1) return { ambiguous: true };
  return {};
}

// ── Writes ──────────────────────────────────────────────────────────────────
/**
 * Create or update a contractor's profile. The ONE write path, so the
 * chapter-scoping and the "never from the public path" rule live in a single
 * place.
 */
export async function upsertProfile(
  ctx: MutationCtx,
  args: {
    chapterId: Id<"chapters">;
    personId: Id<"people">;
    externalAccountId?: string;
    bankAccountLast4?: string;
    bankConfirmedAt?: number;
    taxClassification?: ContractorTaxClassification;
    businessName?: string;
    taxAttestedAt?: number;
    lastPaidAt?: number;
    createdByPersonId?: Id<"people">;
  },
): Promise<Id<"contractorProfiles">> {
  const now = Date.now();
  const existing = await profileFor(ctx, args.chapterId, args.personId);
  const patch = {
    ...(args.externalAccountId !== undefined
      ? { externalAccountId: args.externalAccountId }
      : {}),
    ...(args.bankAccountLast4 !== undefined
      ? { bankAccountLast4: args.bankAccountLast4 }
      : {}),
    ...(args.bankConfirmedAt !== undefined
      ? { bankConfirmedAt: args.bankConfirmedAt }
      : {}),
    ...(args.taxClassification !== undefined
      ? { taxClassification: args.taxClassification }
      : {}),
    ...(args.businessName !== undefined
      ? { businessName: args.businessName }
      : {}),
    ...(args.taxAttestedAt !== undefined
      ? { taxAttestedAt: args.taxAttestedAt }
      : {}),
    ...(args.lastPaidAt !== undefined ? { lastPaidAt: args.lastPaidAt } : {}),
  };
  if (existing) {
    await ctx.db.patch(existing._id, { ...patch, updatedAt: now });
    return existing._id;
  }
  return await ctx.db.insert("contractorProfiles", {
    chapterId: args.chapterId,
    personId: args.personId,
    ...patch,
    ...(args.createdByPersonId
      ? { createdByPersonId: args.createdByPersonId }
      : {}),
    createdAt: now,
    updatedAt: now,
  });
}

/** Save someone as a returning contractor, or edit what we remember. */
export const save = mutation({
  args: {
    personId: v.id("people"),
    businessName: v.optional(v.string()),
    taxClassification: v.optional(
      v.union(...CONTRACTOR_TAX_CLASSIFICATIONS.map((c) => v.literal(c))),
    ),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, { personId, businessName, taxClassification, notes }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireContractorRosterManage(ctx, chapterId);
    const person = await ctx.db.get(personId);
    await requireInChapter(ctx, chapterId, person, "Person");
    const callerPersonId = await resolveCallerPersonId(ctx, chapterId);

    const id = await upsertProfile(ctx, {
      chapterId,
      personId,
      ...(businessName !== undefined
        ? { businessName: businessName.trim().slice(0, 200) }
        : {}),
      ...(taxClassification !== undefined ? { taxClassification } : {}),
      createdByPersonId: callerPersonId,
    });
    if (notes !== undefined) {
      await ctx.db.patch(id, { notes: notes.trim().slice(0, 2000) });
    }
    return { contractorProfileId: id };
  },
});

/**
 * FORGET a contractor: destroy the remembered bank reference and, where we are
 * allowed to, the tax document too.
 *
 * The request a contractor is entitled to make, and the only irreversible thing
 * on this surface — hence its own power.
 *
 * IT CANNOT DESTROY EVIDENCE WE ARE REQUIRED TO KEEP. A tax document still
 * inside the retention window of a payment that actually paid out is
 * substantiation for money that moved and a return that was filed; deleting it
 * on request would trade a real obligation for a preference. So the bank
 * details always go (nothing requires us to keep a routing reference), the
 * document goes only when its window has passed, and the caller is told plainly
 * which happened rather than being allowed to believe everything was erased.
 */
export const forget = mutation({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireContractorForget(ctx, chapterId);
    const person = await ctx.db.get(personId);
    await requireInChapter(ctx, chapterId, person, "Person");

    const profile = await profileFor(ctx, chapterId, personId);
    const now = Date.now();

    if (profile) {
      await ctx.db.patch(profile._id, {
        externalAccountId: undefined,
        bankAccountLast4: undefined,
        bankConfirmedAt: undefined,
        updatedAt: now,
      });
    }

    const docs = await ctx.db
      .query("contractorTaxDocuments")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .take(50);

    let documentsDeleted = 0;
    let documentsKept = 0;
    for (const doc of docs) {
      if (doc.chapterId !== chapterId) continue;
      if (doc.purgeAfter > now) {
        // Still inside its retention window — we are required to hold it.
        documentsKept += 1;
        continue;
      }
      try {
        await ctx.storage.delete(doc.storageId);
      } catch {
        // Already gone; the row still goes.
      }
      await ctx.db.delete(doc._id);
      documentsDeleted += 1;
    }

    return {
      bankDetailsCleared: profile != null,
      documentsDeleted,
      documentsKept,
    };
  },
});

/**
 * Record a paid contractor payment against its profile — the hook that makes a
 * one-off payee a "returning contractor".
 *
 * Internal, and called only from the settle path, because "we have paid this
 * person" should become true when money actually moved and not a moment
 * earlier. A profile minted at compose time would fill the roster with people
 * whose payments were never approved.
 */
export const rememberPaidContractor = internalMutation({
  args: { contractorPaymentId: v.id("contractorPayments") },
  handler: async (ctx, { contractorPaymentId }) => {
    const row = await ctx.db.get(contractorPaymentId);
    if (!row?.personId) return null;
    await upsertProfile(ctx, {
      chapterId: row.chapterId,
      personId: row.personId,
      ...(row.externalAccountId
        ? { externalAccountId: row.externalAccountId }
        : {}),
      ...(row.bankAccountLast4
        ? { bankAccountLast4: row.bankAccountLast4 }
        : {}),
      ...(row.payeeBusinessName
        ? { businessName: row.payeeBusinessName }
        : {}),
      lastPaidAt: row.paidAt ?? Date.now(),
    });
    // HAND THE DOCUMENT FROM THE SHORT WINDOW TO THE FOUR-YEAR RULE.
    //
    // A freshly collected form gets the 180-day unpaid window, because a form
    // collected for a job that fell through is the one we have least right to
    // keep. The moment a payment citing it actually PAYS, that stops being
    // true: it now substantiates money that moved and a return that will be
    // filed, and the retention window is four years from the year it covers.
    //
    // Writing only `lastUsedAt` here — as this did until 2026-08-15 — left a
    // PAID contractor's W-9 on the short clock, so the sweep destroyed it about
    // six months after upload. That is the same retention failure this feature
    // was built to prevent, pointing the other way.
    if (row.taxDocumentId) {
      const doc = await ctx.db.get(row.taxDocumentId);
      if (doc) {
        const taxYear = new Date(
          row.serviceDate ?? row.paidAt ?? Date.now(),
        ).getUTCFullYear();
        await ctx.db.patch(doc._id, {
          lastTaxYear: Math.max(doc.lastTaxYear ?? doc.taxYear, taxYear),
          purgeAfter: extendedTaxDocPurgeAfter(doc.purgeAfter, taxYear),
          lastUsedAt: Date.now(),
        });
      }
    }
    return null;
  },
});

/** Slide the short unpaid-retention window forward for a document that is
 *  still waiting on a decision, so it isn't purged out from under a live
 *  payment. Called by the payment flow, not by a human. */
export async function touchUnpaidTaxDoc(
  ctx: MutationCtx,
  docId: Id<"contractorTaxDocuments">,
): Promise<void> {
  const doc = await ctx.db.get(docId);
  if (!doc) return;
  const now = Date.now();
  // Only extend an UNPAID document's window. Once a payment pays out, the
  // four-year rule owns `purgeAfter` and this must not shorten it.
  if (doc.lastTaxYear != null) return;
  await ctx.db.patch(docId, {
    lastUsedAt: now,
    purgeAfter: Math.max(doc.purgeAfter, unpaidTaxDocPurgeAfter(now)),
  });
}
