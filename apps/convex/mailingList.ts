/**
 * THE MAILING LIST — the Marketing desk's other half.
 *
 * ── What this is, and what it deliberately is not ───────────────────────────
 * It is a VIEW over `people`. There is no `mailingSubscribers` table and there
 * must not be one. The org already had four places a contact could live (the
 * roster, the donor CRM, RSVPs, a Google Form) and consolidating them was a
 * whole project (`1-projects/backlog/contact-consolidation`); adding a fifth
 * because the marketing tab wanted its own list would undo that work in one
 * commit. A person here is the same row the People tab shows — edit them
 * there, see the edit here.
 *
 * What this module adds is the QUESTION the people table cannot answer: *are
 * we actually able to reach this person, and did they say we could?* That
 * question has an established answer in this codebase already — the eligibility
 * rules `mailchimpSync.ts#collectChapterMembers` applies before pushing an
 * audience — and this desk is those rules made visible to a human instead of
 * only to a sync job.
 *
 * ── The four ways someone is unreachable ────────────────────────────────────
 * `MAILING_EXCLUSIONS`, and the desk shows them separately on purpose:
 *
 *   `opted_out`   `people.marketingOptOut` — a person-level stop, set by
 *                 someone at the org (often from this desk). LIFTABLE here.
 *   `suppressed`  an `emailSuppressions` / `smsOptOuts` row — came from the
 *                 OUTSIDE WORLD: an unsubscribe click, a hard bounce, a spam
 *                 complaint, a texted STOP. NOT liftable here, ever. See
 *                 `addToList`'s doc for what happens when someone tries.
 *   `no_address`  nothing to send to (`resolveSendAddress` came back null, or
 *                 there is no usable phone).
 *   `inactive`    `people.status === "inactive"` — off the roster entirely.
 *
 * Collapsing `opted_out` and `suppressed` into one "unsubscribed" chip is how a
 * team ends up re-adding someone who filed a spam complaint, so they stay two
 * words all the way from the schema to the screen.
 *
 * ── Consent is recorded, never enforced ─────────────────────────────────────
 * `people.consentedAt` / `consentSource` are written by the public signup form
 * below. `schema/people.ts` is emphatic that consent must NEVER be wired into
 * send eligibility, and nothing here does: recording a "yes" cannot make a
 * suppressed address mailable again. The suppression ledgers always win.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * Chapter-scoped, like the giving CRM: a central holder reaches every chapter's
 * people, a chapter's Marketing Lead reaches their own. See
 * `lib/marketingAccess.ts`.
 */
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  MAILING_CHANNELS,
  MAILING_MANUAL_SOURCE,
  MAILING_SIGNUP_SOURCE,
  toCsv,
  type MailingChannel,
  type MailingExclusion,
  type MailingListRow,
} from "@events-os/shared";
import { normalizeEmail } from "./lib/access";
import { normalizePhone } from "./lib/twilio";
import { resolveSendAddress } from "./lib/personEmails";
import { requireChapterId, requireUserId } from "./lib/context";
import {
  canEditMailingList,
  canViewMailingList,
  requireMailingListEdit,
  requireMailingListExport,
  requireMailingListView,
  resolveMarketingAccess,
} from "./lib/marketingAccess";
import { matchIdentity, matchOrCreatePersonContact } from "./givingImport";
import { chapterRoster } from "./lib/org";
import { listActiveChapters } from "./lib/chapters";

const channelValidator = v.union(...MAILING_CHANNELS.map((c) => v.literal(c)));

/**
 * A shape check, not a deliverability check.
 *
 * `normalizeEmail` only lowercases and trims — it answers "what is the
 * canonical form of this string", not "is this an address". Both write paths
 * below need the second question asked, and for the same reason: an address
 * with no `@` in it creates a person nobody can ever reach and nothing ever
 * tells you about, whether it was typed by a stranger on the signup form or by
 * a marketer at an event. Same regex `volunteers.submitSignup` uses, so the
 * public forms agree on what they will accept.
 */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Normalize and shape-check in one step. Returns null for anything unusable —
 *  including a string the caller clearly meant as an address but got wrong,
 *  which the callers turn into a message rather than a silent drop. */
function usableEmail(raw: string | undefined): string | null {
  const normalized = normalizeEmail(raw);
  if (!normalized || !EMAIL_SHAPE.test(normalized)) return null;
  return normalized;
}

/**
 * The per-chapter people bound. Matches `mailchimpSync.ts`'s own scan limit —
 * the two surfaces read the same set and a different bound here would mean the
 * desk and the sync disagree about who is on the list.
 */
const PEOPLE_PER_CHAPTER_LIMIT = 5000;

/** The org has a handful of chapters; this is generous headroom. */
const CHAPTER_SCAN_LIMIT = 200;

/**
 * The ceiling on how many people ONE read of this desk resolves, across every
 * chapter it covers.
 *
 * This exists because the desk's default is the CENTRAL lens, where no
 * `chapterId` is in hand and the answer to "the list" is every chapter's
 * people — and resolving a person on the email channel costs an extra indexed
 * read for their addresses plus one for the suppression ledger. Left unbounded,
 * a reactive query on a busy deployment would walk `chapters × 5000 × 3` reads
 * on every keystroke in the search box. `mailchimpSync.ts` faces the same
 * arithmetic and solves it by paging one chapter per action; a live query has
 * no such luxury, so it stops early and SAYS it stopped (`scanTruncated`),
 * which the desk surfaces as "narrow this down" rather than quietly showing a
 * short list as if it were the whole one.
 */
const TOTAL_PEOPLE_SCAN_LIMIT = 4000;

/** One person, resolved on one channel. Internal shape; `MailingListRow` is
 *  the wire shape the app renders. */
interface ResolvedPerson {
  person: Doc<"people">;
  destination: string | null;
  exclusions: MailingExclusion[];
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Whether this person can be reached on this channel, and why not.
 *
 * The EMAIL rules are `mailchimpSync.ts#collectChapterMembers`'s, restated
 * rather than imported — deliberately, and for the same reason that file
 * restates `audienceResolve.ts`'s: one of them differs (that one skips nobody
 * for being a contact; this one likewise includes contacts, because a donor or
 * an event guest is exactly who the newsletter is for) and a silent divergence
 * hidden inside a shared helper would be worse than an explicit one in two
 * places that each say why.
 *
 * The SMS rules are the same shape against `smsOptOuts` and `people.phone`.
 * `marketingOptOut` gates BOTH channels: it is a person-level "stop marketing
 * me", not an email preference, and a team that honors it in one medium and
 * not the other has not honored it.
 *
 * Placeholder rows are the caller's business to skip — they are not people and
 * never reach this function.
 */
async function resolvePerson(
  ctx: QueryCtx,
  person: Doc<"people">,
  channel: MailingChannel,
): Promise<ResolvedPerson> {
  const exclusions: MailingExclusion[] = [];
  if (person.status === "inactive") exclusions.push("inactive");
  if (person.marketingOptOut === true) exclusions.push("opted_out");

  let destination: string | null = null;
  if (channel === "email") {
    const rows = await ctx.db
      .query("personEmails")
      .withIndex("by_person", (q) => q.eq("personId", person._id))
      .collect();
    destination = normalizeEmail(resolveSendAddress(person, rows));
    if (!destination) {
      exclusions.push("no_address");
    } else {
      const hit = await ctx.db
        .query("emailSuppressions")
        .withIndex("by_email", (q) => q.eq("email", destination as string))
        .first();
      if (hit) exclusions.push("suppressed");
    }
  } else {
    destination = person.phone ? normalizePhone(person.phone) : null;
    if (!destination) {
      exclusions.push("no_address");
    } else {
      const hit = await ctx.db
        .query("smsOptOuts")
        .withIndex("by_phone", (q) => q.eq("phone", destination as string))
        .first();
      if (hit) exclusions.push("suppressed");
    }
  }
  return { person, destination, exclusions };
}

/**
 * Every non-placeholder person in one chapter, resolved on one channel, up to
 * `budget` people.
 *
 * `budget` is the shared allowance across the whole read (see
 * `TOTAL_PEOPLE_SCAN_LIMIT`), threaded through rather than applied per chapter
 * so ten small chapters cost what one big one does. Returns how much it spent
 * so the caller can stop.
 */
async function resolveChapter(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  channel: MailingChannel,
  budget: number,
): Promise<{ people: ResolvedPerson[]; spent: number; truncated: boolean }> {
  if (budget <= 0) return { people: [], spent: 0, truncated: true };
  const rows = await ctx.db
    .query("people")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(Math.min(PEOPLE_PER_CHAPTER_LIMIT, budget));
  const people: ResolvedPerson[] = [];
  for (const person of rows) {
    if (person.isPlaceholder === true) continue;
    people.push(await resolvePerson(ctx, person, channel));
  }
  return {
    people,
    spent: rows.length,
    // A full take is the only signal we have that more exist beyond it.
    truncated: rows.length >= Math.min(PEOPLE_PER_CHAPTER_LIMIT, budget),
  };
}

function toRow(resolved: ResolvedPerson, chapterName: string | null): MailingListRow {
  const { person } = resolved;
  return {
    personId: String(person._id),
    name: person.name,
    destination: resolved.destination,
    exclusions: resolved.exclusions,
    chapterName,
    consentedAt: person.consentedAt ?? null,
    consentSource: person.consentSource ?? null,
    addedAt: person.createdAt,
  };
}

/**
 * The chapters this read covers.
 *
 * `chapterId` given → that one chapter, gated. Omitted → every chapter the
 * caller can see, which is what a central holder means by "the list". A
 * chapter-scoped holder with no `chapterId` gets exactly their own chapters
 * rather than an error, because "show me my list" is the same request whether
 * or not the caller happens to know they only have one.
 */
async function scopedChapters(
  ctx: QueryCtx,
  chapterId: Id<"chapters"> | undefined,
): Promise<Doc<"chapters">[]> {
  if (chapterId) {
    await requireMailingListView(ctx, chapterId);
    const chapter = await ctx.db.get(chapterId);
    return chapter ? [chapter] : [];
  }
  const access = await resolveMarketingAccess(ctx);
  const all = await ctx.db.query("chapters").take(CHAPTER_SCAN_LIMIT);
  const visible = all.filter((c) => canViewMailingList(access, c._id));
  if (visible.length === 0) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "You don't have access to the mailing list.",
    });
  }
  return visible;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * The list, one channel at a time.
 *
 * `view: "subscribed"` is the default and the one the desk opens on — the
 * people the org can actually reach right now, which is what "the mailing list"
 * means to a person planning a send. `view: "excluded"` is the other half, and
 * it exists because a list you cannot see the edges of is a list you will
 * accidentally re-add someone to.
 *
 * `search` matches name or destination, case-insensitively — the same
 * substring behavior every roster surface in this app has, so nobody has to
 * learn a second search.
 */
export const listMailingList = query({
  args: {
    chapterId: v.optional(v.id("chapters")),
    channel: channelValidator,
    view: v.optional(v.union(v.literal("subscribed"), v.literal("excluded"))),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const chapters = await scopedChapters(ctx, args.chapterId);
    const view = args.view ?? "subscribed";
    const needle = args.search?.trim().toLowerCase() ?? "";
    const limit = Math.max(1, Math.min(args.limit ?? 500, 2000));

    const rows: MailingListRow[] = [];
    let subscribed = 0;
    let excluded = 0;
    let budget = TOTAL_PEOPLE_SCAN_LIMIT;
    let scanTruncated = false;
    for (const chapter of chapters) {
      const slice = await resolveChapter(ctx, chapter._id, args.channel, budget);
      budget -= slice.spent;
      if (slice.truncated) scanTruncated = true;
      for (const resolved of slice.people) {
        const reachable = resolved.exclusions.length === 0;
        if (reachable) subscribed++;
        else excluded++;
        if (reachable !== (view === "subscribed")) continue;
        if (needle) {
          const haystack = `${resolved.person.name} ${resolved.destination ?? ""}`.toLowerCase();
          if (!haystack.includes(needle)) continue;
        }
        rows.push(toRow(resolved, chapters.length > 1 ? chapter.name : null));
      }
      if (budget <= 0) {
        scanTruncated = true;
        break;
      }
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));

    const access = await resolveMarketingAccess(ctx);
    return {
      rows: rows.slice(0, limit),
      // The COUNTS are over everything, not over the page — "500 of 812" is the
      // number a marketer is actually asking for.
      matched: rows.length,
      truncated: rows.length > limit,
      // A DIFFERENT truncation from `truncated` above, and the counts are the
      // reason it must be its own flag: `truncated` means "more rows matched
      // than we're showing you", while this means "we didn't finish counting" —
      // so `subscribed`/`excluded` are floors, not totals.
      scanTruncated,
      subscribed,
      excluded,
      canEdit: chapters.every((c) => canEditMailingList(access, c._id)),
    };
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Put someone on the list — the "someone just gave me their email at an event"
 * path, and the write behind the public signup form.
 *
 * Matches an existing person before creating one (`matchOrCreatePersonContact`,
 * the same matcher the contacts import and the giving import use), so adding
 * somebody who is already a donor or a volunteer updates that person rather
 * than forking them into a second row.
 *
 * ── What "add" can and cannot undo ──────────────────────────────────────────
 * It CLEARS `marketingOptOut`, because that flag means "somebody at the org
 * marked this person as not-to-be-marketed" and adding them back is the same
 * kind of act by the same kind of person.
 *
 * It does NOT touch `emailSuppressions` or `smsOptOuts`. Those record the
 * person's OWN decision — an unsubscribe click, a texted STOP — or a fact about
 * the address (it bounced, it complained). No amount of "but they told me in
 * person" makes it correct for a marketer to reach into that ledger from a
 * contact form, and the day someone does it for a complaint is the day the
 * domain's reputation starts costing everyone else their mail. So the add
 * succeeds, the person is on the list, and the result says `stillSuppressed`
 * with the reason — which the desk shows as "they'll need to re-subscribe
 * themselves."
 */
export const addToList = mutation({
  args: {
    /**
     * Which chapter's roster this person joins. Optional because the desk is
     * usually open on the CENTRAL lens, where the app has no chapter in hand —
     * and refusing to add anyone from the lens a central Marketing Director
     * works in all day would make the fastest path (someone hands you their
     * email at a gathering) the one that does not work. Omitted, it falls back
     * to the caller's own chapter, the same "where do I belong" answer every
     * other roster write in the app uses.
     */
    chapterId: v.optional(v.id("chapters")),
    name: v.string(),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    /** Where the "yes" came from, in the org's own words. Defaults to the
     *  desk. Stored verbatim on `people.consentSource`. */
    consentSource: v.optional(v.string()),
  },
  returns: v.object({
    personId: v.union(v.id("people"), v.null()),
    isNew: v.boolean(),
    stillSuppressed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const chapterId =
      args.chapterId ?? ((await requireChapterId(ctx)) as Id<"chapters">);
    await requireMailingListEdit(ctx, chapterId);
    return await addPersonToList(ctx, { ...args, chapterId, door: "desk" });
  },
});

/**
 * The shared body of `addToList` and the public `subscribe` below — one
 * matcher, one consent stamp, one suppression check, whichever door it came
 * through. Callers do the gating; this does the work.
 *
 * ── `door` is not a formality ───────────────────────────────────────────────
 * The two callers are a seated staff member and an anonymous stranger, and two
 * things must differ between them. Both were live bugs in the first cut of this
 * file, and both are the same mistake: sharing a helper is not the same as
 * sharing a trust level.
 *
 *  1. LIFTING AN OPT-OUT. A staff member re-adding someone is acting on a
 *     conversation they had. A stranger posting a form is not: because the
 *     matcher falls back to an exact NAME match, and staff names are public on
 *     `/team`, a public post of "<staff name> + any address" would otherwise
 *     silently clear that person's `marketingOptOut`.
 *  2. MATCHING BY NAME AT ALL. Same root cause, worse outcome: a name-only
 *     match lets a stranger blank-fill THEIR email and phone onto an existing
 *     roster person's record. The public door therefore matches on an
 *     identifier or not at all — see `identifierOnlyPool`.
 */
async function addPersonToList(
  ctx: MutationCtx,
  args: {
    chapterId: Id<"chapters">;
    name: string;
    email?: string;
    phone?: string;
    consentSource?: string;
    /** `"desk"` — a gated staff write. `"public"` — the signup form. */
    door: "desk" | "public";
  },
): Promise<{
  personId: Id<"people"> | null;
  isNew: boolean;
  stillSuppressed: boolean;
}> {
  const email = usableEmail(args.email) ?? undefined;
  const phone = args.phone ? (normalizePhone(args.phone) ?? undefined) : undefined;
  const name = args.name.trim();

  // A typo'd address is its own message: dropping to "we need an identifier"
  // when the caller plainly supplied one reads as a bug, not a correction.
  if (args.email?.trim() && !email) {
    throw new ConvexError({
      code: "INVALID_EMAIL",
      message: "That email address doesn't look right.",
    });
  }
  if (args.phone?.trim() && !phone) {
    throw new ConvexError({
      code: "INVALID_PHONE",
      message: "That phone number doesn't look right — include the area code.",
    });
  }
  if (!email && !phone) {
    throw new ConvexError({
      code: "NO_IDENTIFIER",
      message: "An email address or a phone number is needed to add someone.",
    });
  }
  if (!name) {
    throw new ConvexError({
      code: "NO_NAME",
      message: "A name is needed.",
    });
  }

  const now = Date.now();
  const result = await matchOrCreatePersonContact(
    ctx,
    args.chapterId,
    {
      name,
      email,
      phone,
      consentedAt: now,
      consentSource: args.consentSource?.trim() || MAILING_MANUAL_SOURCE,
    },
    // The pool the matcher is allowed to match against. A public signup gets a
    // pre-filtered one so its name fallback can never fire; the desk gets the
    // matcher's own default (undefined → the whole roster), because a staff
    // member typing a name they recognize is exactly the case that fallback is
    // for. See the `door` doc above.
    args.door === "public"
      ? await identifierOnlyPool(ctx, args.chapterId, { email, phone })
      : undefined,
  );
  if (result.personId === null) {
    // Unreachable given the identifier check above, but the matcher's contract
    // allows it and a silent null would be worse than a plain sentence.
    throw new ConvexError({
      code: "NO_IDENTIFIER",
      message: "An email address or a phone number is needed to add someone.",
    });
  }

  const person = await ctx.db.get(result.personId);
  // DESK ONLY. A stranger must not be able to lift a person-level stop — see
  // the `door` doc. The public door's own way back on is narrower and lives in
  // `clearSelfServiceUnsubscribe` below.
  if (args.door === "desk" && person?.marketingOptOut === true) {
    await ctx.db.patch(result.personId, { marketingOptOut: false });
  }
  // A matched person whose consent was never recorded gets this one stamped;
  // an earlier, already-recorded "yes" is left alone — the first yes is the
  // truer record, the same fill-if-blank rule the contacts import applies.
  if (person && person.consentedAt === undefined) {
    await ctx.db.patch(result.personId, {
      consentedAt: now,
      consentSource: args.consentSource?.trim() || MAILING_MANUAL_SOURCE,
    });
  }

  let stillSuppressed = false;
  if (email) {
    const hit = await ctx.db
      .query("emailSuppressions")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (hit) stillSuppressed = true;
  }
  if (!stillSuppressed && phone) {
    const hit = await ctx.db
      .query("smsOptOuts")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (hit) stillSuppressed = true;
  }

  return { personId: result.personId, isNew: result.isNew, stillSuppressed };
}

/**
 * Take someone off the list — the "please stop emailing me" path, which is the
 * whole reason this desk needed a write surface and not just a spreadsheet
 * export.
 *
 * Sets `people.marketingOptOut`, the person-level stop. That one flag covers
 * BOTH channels by design (see `resolvePerson`), so a request made over the
 * phone about email does not leave the org still texting them.
 *
 * For SMS it ALSO writes an `smsOptOuts` row (`source: "manual"` — the value
 * that table reserved for exactly this and nothing has written until now),
 * because that ledger is what `blasts.ts` checks and a person who asks to stop
 * being texted should stop being texted even if their `people` row is later
 * merged, re-imported, or edited by someone who does not know why the flag was
 * set. Twilio's Advanced Opt-Out remains the actual compliance enforcement;
 * this is the in-app mirror the composer can see.
 *
 * Deliberately does NOT write `emailSuppressions`. That ledger is
 * deployment-wide and permanent-by-convention (`unsuppressEmail` needs the
 * campaigns power and leaves an audit row); a marketing seat honoring a "take
 * me off the newsletter" should not be able to blacklist an address from
 * transactional mail — their RSVP confirmations and donation receipts are not
 * marketing and must keep arriving. `marketingOptOut` stops exactly the mail
 * they asked to stop, which is the whole point of it being a separate bit.
 */
export const removeFromList = mutation({
  args: {
    personId: v.id("people"),
    /** Free text the desk can record — "asked at the Aug 14 gathering". */
    note: v.optional(v.string()),
  },
  returns: v.object({ smsOptOutRecorded: v.boolean() }),
  handler: async (ctx, { personId, note }) => {
    const person = await ctx.db.get(personId);
    if (!person) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That person is no longer on the roster.",
      });
    }
    await requireMailingListEdit(ctx, person.chapterId);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    await ctx.db.patch(personId, { marketingOptOut: true });

    let smsOptOutRecorded = false;
    const phone = person.phone ? normalizePhone(person.phone) : null;
    if (phone) {
      const existing = await ctx.db
        .query("smsOptOuts")
        .withIndex("by_phone", (q) => q.eq("phone", phone))
        .first();
      if (!existing) {
        await ctx.db.insert("smsOptOuts", {
          phone,
          source: "manual",
          note: note?.trim() || "Asked to be removed from the mailing list",
          createdAt: Date.now(),
          createdBy: userId,
        });
        smsOptOutRecorded = true;
      }
    }
    return { smsOptOutRecorded };
  },
});

/**
 * Put someone back on after an opt-out — the correction path for "I clicked the
 * wrong row."
 *
 * Clears `marketingOptOut`, and clears an SMS opt-out ONLY if this desk was
 * what wrote it (`source: "manual"`). A `stop_webhook` row is a real human
 * texting STOP to a real carrier; it is not ours to undo, and Twilio would
 * refuse the send anyway. The result says which happened rather than reporting
 * a success that isn't one.
 */
export const restoreToList = mutation({
  args: { personId: v.id("people") },
  returns: v.object({
    smsStillOptedOut: v.boolean(),
    emailStillSuppressed: v.boolean(),
  }),
  handler: async (ctx, { personId }) => {
    const person = await ctx.db.get(personId);
    if (!person) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That person is no longer on the roster.",
      });
    }
    await requireMailingListEdit(ctx, person.chapterId);
    await ctx.db.patch(personId, { marketingOptOut: false });

    let smsStillOptedOut = false;
    const phone = person.phone ? normalizePhone(person.phone) : null;
    if (phone) {
      const existing = await ctx.db
        .query("smsOptOuts")
        .withIndex("by_phone", (q) => q.eq("phone", phone))
        .first();
      if (existing?.source === "manual") await ctx.db.delete(existing._id);
      else if (existing) smsStillOptedOut = true;
    }

    const rows = await ctx.db
      .query("personEmails")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .collect();
    const email = normalizeEmail(resolveSendAddress(person, rows));
    let emailStillSuppressed = false;
    if (email) {
      const hit = await ctx.db
        .query("emailSuppressions")
        .withIndex("by_email", (q) => q.eq("email", email))
        .first();
      emailStillSuppressed = !!hit;
    }
    return { smsStillOptedOut, emailStillSuppressed };
  },
});

// ── Export ───────────────────────────────────────────────────────────────────

/**
 * The list as a CSV, for a Mailchimp import or a Twilio upload.
 *
 * Needs `data.export` on top of list access — see
 * `lib/marketingAccess.ts#requireMailingListExport` for why that is a
 * composition and not a fourth power.
 *
 * Only REACHABLE people are exported, always. An export is a file that gets
 * pasted into a sending tool, and the one thing a marketer must not be able to
 * do by accident is carry an opt-out or a spam complaint across a system
 * boundary into a tool that will happily mail them. The excluded view stays on
 * screen, where it is a record rather than a payload.
 *
 * Escaped through `toCsv`, which is the repo's one CSV writer and the only
 * thing standing between a contact named `=cmd|...` and a spreadsheet that runs
 * it (`@events-os/shared`'s `isFormulaInjection`).
 */
export const exportMailingList = query({
  args: {
    chapterId: v.optional(v.id("chapters")),
    channel: channelValidator,
  },
  returns: v.object({
    csv: v.string(),
    rows: v.number(),
    scanTruncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const chapters = await scopedChapters(ctx, args.chapterId);
    for (const chapter of chapters) {
      await requireMailingListExport(ctx, chapter._id);
    }

    const header =
      args.channel === "email"
        ? ["Name", "Email", "Chapter", "Consented", "Consent source"]
        : ["Name", "Phone", "Chapter", "Consented", "Consent source"];
    const body: string[][] = [];
    let budget = TOTAL_PEOPLE_SCAN_LIMIT;
    let scanTruncated = false;
    for (const chapter of chapters) {
      const slice = await resolveChapter(ctx, chapter._id, args.channel, budget);
      budget -= slice.spent;
      if (slice.truncated) scanTruncated = true;
      for (const resolved of slice.people) {
        if (resolved.exclusions.length > 0) continue;
        body.push([
          resolved.person.name,
          resolved.destination ?? "",
          chapter.name,
          resolved.person.consentedAt
            ? new Date(resolved.person.consentedAt).toISOString().slice(0, 10)
            : "",
          resolved.person.consentSource ?? "",
        ]);
      }
      if (budget <= 0) {
        scanTruncated = true;
        break;
      }
    }
    body.sort((a, b) => a[0].localeCompare(b[0]));
    // A partial export is worse than an obvious one: pasted into Mailchimp, a
    // silently short file looks like a complete audience.
    return { csv: toCsv(header, body), rows: body.length, scanTruncated };
  },
});

// ── The public signup form ───────────────────────────────────────────────────

/**
 * The roster, narrowed to rows that match on an EMAIL or PHONE.
 *
 * Handed to `matchOrCreatePersonContact` as its `prefetchedRoster` so its
 * name-match fallback has nothing to reach: every row in the pool already
 * matches on an identifier, so the matcher either finds one of them or creates
 * a fresh contact. Uses the same normalization the matcher itself does
 * (`matchIdentity`), so a pool member is never one this matcher would then
 * disagree about.
 *
 * An empty pool is the common case (a genuinely new subscriber) and is exactly
 * right: the matcher creates.
 */
async function identifierOnlyPool(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  ids: { email?: string; phone?: string },
): Promise<Doc<"people">[]> {
  const roster = await chapterRoster(ctx, chapterId);
  return roster.filter((p) => {
    const { via } = matchIdentity([p], { email: ids.email, phone: ids.phone });
    return via === "email" || via === "phone";
  });
}

/**
 * Clear a suppression the person is REVERSING THEMSELVES through the public
 * signup form — and only that one.
 *
 * This is the narrow door the Academy lesson and the operating manual both
 * point at, and it has to be narrow or it is the hole every rule in this file
 * exists to close:
 *
 *  - `unsubscribe` — CLEARED. The person clicked "unsubscribe" and has now
 *    filled in a signup form with the same address. That is the same human
 *    reversing the same decision, which is exactly what a preference is. Every
 *    mailing tool works this way, and refusing would mean an address could
 *    never come back at all.
 *  - `bounce` — kept. That is a fact about the mailbox, not a decision. If the
 *    address really works now, the next successful send proves it; nothing
 *    typed into a form does.
 *  - `complaint` — kept, permanently. Someone reported us as spam. Mailing them
 *    again on the strength of a web form is how a sending domain's reputation
 *    dies, and it takes every other recipient's mail down with it.
 *  - `manual` — kept. Somebody at the org suppressed this address deliberately
 *    and a stranger's form submission is not the review that should undo it.
 *
 * SMS is deliberately not touched at all. A texted STOP is enforced by the
 * carrier through Twilio's Advanced Opt-Out; clearing our mirror would not make
 * the message send, it would only make our screen lie about it.
 *
 * Returns whether the person is STILL unreachable by email afterwards.
 */
async function clearSelfServiceUnsubscribe(
  ctx: MutationCtx,
  email: string,
): Promise<boolean> {
  const hit = await ctx.db
    .query("emailSuppressions")
    .withIndex("by_email", (q) => q.eq("email", email))
    .first();
  if (!hit) return false;
  if (hit.reason !== "unsubscribe") return true;
  await ctx.db.delete(hit._id);
  return false;
}

/**
 * Which chapter a public signup lands in.
 *
 * A named slug wins — that is what makes a per-chapter signup link
 * (`/subscribe?c=new-york`) work, which is how a chapter gets its own list
 * without the form asking a stranger to answer a question about our org chart.
 * An unknown or inactive slug falls back rather than failing: the person
 * filling in the form did not make the typo and should not be the one who
 * pays for it.
 *
 * The fallback is the OLDEST ACTIVE chapter — the org's home chapter. Active
 * specifically: `chapters.isActive === false` marks a shadow row that a
 * prospect territory pre-created for a city that has not launched, and dropping
 * a real person's signup into one would file them under a chapter with nobody
 * in it to read the list.
 */
async function signupChapter(
  ctx: MutationCtx,
  slug: string | undefined,
): Promise<Doc<"chapters">> {
  const active = await listActiveChapters(ctx);
  if (active.length === 0) {
    throw new ConvexError({
      code: "NOT_READY",
      message: "Sign-ups aren't set up yet. Please try again later.",
    });
  }
  const wanted = slug?.trim().toLowerCase();
  if (wanted) {
    const match = active.find((c) => c.slug?.toLowerCase() === wanted);
    if (match) return match;
  }
  // `_creationTime` ascending — the first chapter the org ever created.
  return active.reduce((oldest, c) =>
    c._creationTime < oldest._creationTime ? c : oldest,
  );
}

/**
 * PUBLIC, unauthenticated — the write behind `POST /api/subscribe`, which the
 * `/subscribe` page posts to.
 *
 * This replaces a Google Form. That is worth stating plainly, because it is the
 * whole justification: the form the team was using collected names into a
 * spreadsheet that nothing else in the org could see, so every signup was a
 * manual re-entry away from being reachable, and nobody could answer "did this
 * person ever say yes?" This writes the person, the consent, and the timestamp
 * into the same row the rest of the OS already uses.
 *
 * Same trust model as `givingInterest.submitInterest` and
 * `hiring.submitApplication`: no auth, tight validation, a friendly
 * `ConvexError` for anything malformed, and NO read surface — a caller can add
 * themselves and learn nothing about anyone else. In particular the return
 * value is deliberately uniform: it never says whether an address was already
 * on the list, because that would turn this endpoint into an oracle for "is
 * this person in your database."
 *
 * ── The one thing this can undo ─────────────────────────────────────────────
 * A person who previously clicked "unsubscribe" and now fills in this form is
 * reversing their own decision, and this is the only path in the whole app that
 * honors that — the desk deliberately cannot. It reaches an `unsubscribe`
 * suppression and nothing else: a bounce, a spam complaint, and a
 * staff-entered suppression all survive it, as does every SMS opt-out. That is
 * the whole of `clearSelfServiceUnsubscribe`, which has the reasoning per
 * reason.
 */
export const subscribe = mutation({
  args: {
    name: v.string(),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    /** Which chapter's list this signup joins, from the `?c=` on the link the
     *  desk copied. Absent (the plain `/subscribe` link) → the home chapter. */
    chapterSlug: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const name = args.name.trim();
    if (name.length === 0 || name.length > 120) {
      throw new ConvexError({
        code: "INVALID_NAME",
        message: "Please tell us your name.",
      });
    }
    const email = usableEmail(args.email);
    const phone = args.phone?.trim() ? normalizePhone(args.phone) : null;
    // The typo'd-field messages come FIRST: someone who mistyped their address
    // should be told that, not told to supply one they can see they supplied.
    if (args.email?.trim() && !email) {
      throw new ConvexError({
        code: "INVALID_EMAIL",
        message: "That email address doesn't look right.",
      });
    }
    if (args.phone?.trim() && !phone) {
      throw new ConvexError({
        code: "INVALID_PHONE",
        message: "That phone number doesn't look right — include the area code.",
      });
    }
    if (!email && !phone) {
      throw new ConvexError({
        code: "INVALID_SUBMISSION",
        message: "Please give us an email address or a phone number.",
      });
    }

    const chapter = await signupChapter(ctx, args.chapterSlug);

    await addPersonToList(ctx, {
      chapterId: chapter._id,
      name,
      email: email ?? undefined,
      phone: phone ?? undefined,
      consentSource: MAILING_SIGNUP_SOURCE,
      door: "public",
    });

    // Their own "yes", undoing their own "no" — and nothing else's. See
    // `clearSelfServiceUnsubscribe` for exactly which suppressions this
    // reaches and, more importantly, which it never will.
    if (email) await clearSelfServiceUnsubscribe(ctx, email);
    return null;
  },
});
