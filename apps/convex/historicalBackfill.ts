/**
 * Historical backfill (Attendance D) — a ONE-TIME ops module that loads the
 * curated Partiful/Givebutter exports (embedded under `lib/seed/historical/`)
 * into the live donor CRM + event guest lists. Internal functions only: the
 * session owner invokes them from the CLI after deploy; nothing here is on the
 * public API and nothing runs on its own.
 *
 * Two runners, both DRY-RUN BY DEFAULT (`execute` omitted / false = a full
 * simulation that writes NOTHING and returns exactly the counts a real run
 * would produce). Pass `execute: true` to commit.
 *
 *   - `runGivingBackfill` — feeds the embedded giving rows through the SAME
 *     commit primitives the canonical import uses (`matchOrCreateDonor` /
 *     `recordGiftForDonor` + the shared dedup/lookup helpers exported from
 *     `givingImport.ts`), scoped to the NY chapter. gift → donor match-or-create
 *     (+ mailing address, fill-if-blank) + externalRef-deduped gift; recurring →
 *     donor + an `imported`/`past_due` pledge (per-donor externalRef dedup, the
 *     same "card can't be ported" cutover shape) PLUS the export row's own
 *     transaction as a globally-deduped gift (see RECURRING DECISION below);
 *     ticket → a GUARDED roster `people` contact + a purchase note + best-effort
 *     eventHint→ticket-order linking, NEVER a donor or gift.
 *
 *   - `runAttendanceBackfill` — feeds one embedded attendance dataset through
 *     `eventAttendanceImport`'s extracted commit core (`applyAttendanceRows`) /
 *     classify core (`classifyAttendanceRows`), onto ONE explicit event. It
 *     first verifies that event's name + date match the owner-confirmed
 *     `MAPPING` table (a `MAPPING_MISMATCH` safety net — the caller passes the
 *     eventId from `listEventsForMapping`, this is the guard) and requires an
 *     `eventPages` row (`NO_PAGE`).
 *
 * DISCOVERY: `listEventsForMapping` returns the NY chapter's events (+ whether
 * each has a public page) so the operator can pick the right `eventId` per
 * dataset before running the attendance backfill.
 *
 * IDEMPOTENCY: every path re-runs to zero net writes — gift/pledge externalRef
 * dedup, donor/person match-or-create, the attendance importer's own RSVP
 * dedup cascade, and the idempotent note-append together mean a second run
 * imports nothing new.
 *
 * BATCHING: `runGivingBackfill` processes all 252 giving rows in a single
 * transaction — the read/write budget (a handful of bounded index reads per row
 * against the NY chapter's small event/roster set) stays well within Convex's
 * per-transaction limits. `runAttendanceBackfill` PAGES with `offset` +
 * `nextOffset` (window = `ATTENDANCE_PAGE_SIZE`) because the largest dataset is
 * 712 rows; the caller loops offset 0 → `nextOffset` until it comes back null.
 *
 * RECURRING DECISION: the canonical import's `recurring` row creates ONLY a
 * pledge. The historical export is different — each recurring row IS a specific
 * monthly Givebutter CHARGE that also established the recurrence, so this
 * backfill records BOTH: the pledge (identical shape to the canonical import —
 * `imported`/`past_due`, per-donor externalRef dedup) AND the charge as a
 * `gifts` row (global externalRef dedup, exactly like a one-time gift). The two
 * share the row's externalRef but in DIFFERENT dedup namespaces (per-donor
 * pledge vs global gift), so there's no collision and both stay idempotent.
 */
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { normalizeEmail } from "./lib/access";
import { chapterRoster } from "./lib/org";
import type { GivingScope } from "./lib/givingAccess";
import {
  findDonorInScope,
  matchOrCreateDonor,
  recordGiftForDonor,
  hasPersonIdentifier,
} from "./lib/givingDonors";
import {
  matchIdentity,
  matchOrCreatePersonContact,
  findEventByHint,
  findPaidTicketOrder,
  appendPersonNote,
  fillDonorAddressIfBlank,
  withinSuspectedWindow,
  GIFT_HISTORY_SCAN_LIMIT,
  DONOR_PLEDGE_SCAN_LIMIT,
  type CanonicalImportRow,
  type IdentityLike,
} from "./givingImport";
import {
  applyAttendanceRows,
  classifyAttendanceRows,
  type AttendanceRow,
} from "./eventAttendanceImport";
import { PLEDGE_FLOOR_CENTS } from "./givingPledges";
import {
  NEW_YORK_CHAPTER_SLUG,
  ATTENDANCE_DATASETS,
  MAPPING,
  type AttendanceDataset,
  type EventMapping,
} from "./lib/seed/historical/mapping";
import { GIVING_ROWS } from "./lib/seed/historical/giving";
import {
  GENESIS_GIFTS,
  type GenesisGiftRow,
} from "./lib/seed/historical/genesis";
import { LTN_ROWS } from "./lib/seed/historical/ltn";
import { NYE_ROWS } from "./lib/seed/historical/nye";
import { EDEN_ROWS } from "./lib/seed/historical/eden";
import { PTB_ROWS } from "./lib/seed/historical/ptb";
import { PTB_GB_TICKETS_ROWS } from "./lib/seed/historical/ptbGbTickets";
import { FIELD_DAY_TICKETS_ROWS } from "./lib/seed/historical/fieldDayTickets";

// ── Constants ────────────────────────────────────────────────────────────────

/** Newest-first scan of the NY chapter's events for the discovery step. */
const EVENT_SCAN_LIMIT = 200;

/** Attendance rows committed/classified per `runAttendanceBackfill` call; the
 *  caller pages with `offset`/`nextOffset` through the larger datasets. Well
 *  within one transaction's read/write budget (each row is ≤ 1 indexed email
 *  lookup + the single per-call rsvp snapshot). */
const ATTENDANCE_PAGE_SIZE = 200;

/** Giving rows processed per `runGivingBackfill` call. Matches the canonical
 *  import's own `IMPORT_BATCH_SIZE` (100): each row can trigger a full-roster
 *  read (`chapterRoster` via `matchOrCreateDonor`/`matchOrCreatePersonContact`),
 *  so this is the same safe per-transaction unit the importer batches at. The
 *  operator pages with `offset` → `nextOffset`. */
const GIVING_PAGE_SIZE = 100;

/** Tolerance on the mapping date check — absorbs the timezone the event's
 *  `eventDate` happens to be stored in while still firmly rejecting a wrong
 *  event (the mapped events are weeks apart). */
const MAPPING_DATE_TOLERANCE_MS = 36 * 60 * 60 * 1000;

/** dataset literal → its embedded rows. */
const DATASET_ROWS: Record<AttendanceDataset, AttendanceBackfillRowArray> = {
  ltn: LTN_ROWS,
  nye: NYE_ROWS,
  eden: EDEN_ROWS,
  ptb: PTB_ROWS,
  ptb_gb_tickets: PTB_GB_TICKETS_ROWS,
  fieldday_tickets: FIELD_DAY_TICKETS_ROWS,
};
type AttendanceBackfillRowArray = AttendanceRow[];

// ── Validators ─────────────────────────────────────────────────────────────

const datasetValidator = v.union(
  ...ATTENDANCE_DATASETS.map((d) => v.literal(d)),
);

const givingCountsValidator = v.object({
  donorsCreated: v.number(),
  donorsMatched: v.number(),
  gifts: v.number(),
  giftsDuplicate: v.number(),
  pledges: v.number(),
  pledgesDuplicate: v.number(),
  contacts: v.number(),
  contactsSkippedNoIdentifier: v.number(),
  ticketHistoryLinked: v.number(),
  invalid: v.number(),
});
type GivingCounts = {
  donorsCreated: number;
  donorsMatched: number;
  gifts: number;
  giftsDuplicate: number;
  pledges: number;
  pledgesDuplicate: number;
  contacts: number;
  contactsSkippedNoIdentifier: number;
  ticketHistoryLinked: number;
  invalid: number;
};

const attendanceCountsValidator = v.object({
  inserted: v.number(),
  updated: v.number(),
  skippedDuplicates: v.number(),
  skippedInvalid: v.number(),
});

// ── Discovery ─────────────────────────────────────────────────────────────

/** Resolve the NY chapter by slug, or throw a typed `NO_CHAPTER`. */
async function requireNyChapter(ctx: QueryCtx): Promise<Doc<"chapters">> {
  const chapter = await ctx.db
    .query("chapters")
    .withIndex("by_slug", (q) => q.eq("slug", NEW_YORK_CHAPTER_SLUG))
    .first();
  if (!chapter) {
    throw new ConvexError({
      code: "NO_CHAPTER",
      message: `NY chapter (slug "${NEW_YORK_CHAPTER_SLUG}") not found — seed it before backfilling.`,
    });
  }
  return chapter;
}

/**
 * The NY chapter's events (newest first, bounded) + whether each has a public
 * `eventPages` row — the operator picks the right `eventId` per dataset from
 * this before calling `runAttendanceBackfill`.
 */
export const listEventsForMapping = internalQuery({
  args: {},
  returns: v.object({
    chapterId: v.id("chapters"),
    events: v.array(
      v.object({
        eventId: v.id("events"),
        name: v.string(),
        eventDate: v.number(),
        hasPage: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx) => {
    const chapter = await requireNyChapter(ctx);
    const events = await ctx.db
      .query("events")
      .withIndex("by_chapter_date", (q) => q.eq("chapterId", chapter._id))
      .order("desc")
      .take(EVENT_SCAN_LIMIT);
    const out: {
      eventId: Id<"events">;
      name: string;
      eventDate: number;
      hasPage: boolean;
    }[] = [];
    for (const event of events) {
      const page = await ctx.db
        .query("eventPages")
        .withIndex("by_event", (q) => q.eq("eventId", event._id))
        .unique();
      out.push({
        eventId: event._id,
        name: event.name,
        eventDate: event.eventDate,
        hasPage: page !== null,
      });
    }
    return { chapterId: chapter._id, events: out };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// GIVING BACKFILL — donors / gifts / pledges / ticket-buyer contacts.
// ═══════════════════════════════════════════════════════════════════════════

/** A donor as tracked across ONE giving-backfill run: either a real matched DB
 *  donor (`realId` set) or a would-be-created one (materialized lazily only in
 *  execute mode). Carries just enough state to keep dedup + created/matched
 *  accounting identical between the dry run and the real run. */
type SimDonor = {
  realId?: Id<"donors">;
  isNew: boolean;
  name: string;
  email?: string;
  phone?: string;
  giftHistory: { amountCents: number; receivedAt: number }[];
  giftHistoryLoaded: boolean;
  pledgeRefs: Set<string>;
  pledgeRefsLoaded: boolean;
};

/** All in-run state for one giving backfill PAGE (per-call, never persisted).
 *  Cross-page dedup rides on read-your-writes / DB lookups instead (donors by
 *  scope, gifts by externalRef, roster by fresh reads), so per-page state is
 *  enough and re-runs stay idempotent. */
type GivingState = {
  now: number;
  write: boolean;
  scope: GivingScope;
  chapterId: Id<"chapters">;
  donorPool: SimDonor[];
  seenGiftRefs: Set<string>; // global gift externalRef dedup within this page
  // Dry-run only: identities a ticket/contact row WOULD create this page, so a
  // second occurrence isn't double-counted (execute dedups via fresh reads).
  pendingContacts: IdentityLike[];
  // Provenance stamped on donors this run MATERIALIZES (see `materializeDonor`).
  // The Givebutter export runner leaves it unset → "givebutter-import"; the
  // genesis runner sets "manual" (these predate Givebutter). Existing behavior
  // is unchanged when omitted.
  donorSource?: Doc<"donors">["source"];
};

/** Resolve (or register a would-be-created) donor for a gift/recurring row —
 *  this run's pool first (email → phone → name), then the DB, else a new
 *  synthetic entry. Returns whether it was newly created THIS run. */
async function resolveDonor(
  ctx: QueryCtx,
  state: GivingState,
  opts: { email?: string; phone?: string; name: string },
): Promise<{ entry: SimDonor; wasCreated: boolean }> {
  const inPool = matchIdentity(state.donorPool, opts);
  if (inPool.match) return { entry: inPool.match, wasCreated: false };

  const existing = await findDonorInScope(ctx, state.scope, opts);
  if (existing) {
    const entry: SimDonor = {
      realId: existing._id,
      isNew: false,
      name: existing.name,
      email: existing.email,
      phone: existing.phone,
      giftHistory: [],
      giftHistoryLoaded: false,
      pledgeRefs: new Set(),
      pledgeRefsLoaded: false,
    };
    state.donorPool.push(entry);
    return { entry, wasCreated: false };
  }

  const entry: SimDonor = {
    isNew: true,
    name: opts.name,
    email: opts.email,
    phone: opts.phone,
    giftHistory: [],
    giftHistoryLoaded: true, // a brand-new donor has no DB history to load
    pledgeRefs: new Set(),
    pledgeRefsLoaded: true,
  };
  state.donorPool.push(entry);
  return { entry, wasCreated: true };
}

/** In execute mode, materialize the donor's real id (once) + fill its mailing
 *  address if still blank. A no-op in dry-run. */
async function materializeDonor(
  ctx: MutationCtx,
  state: GivingState,
  entry: SimDonor,
  row: CanonicalImportRow,
): Promise<void> {
  if (!state.write) return;
  if (entry.realId === undefined) {
    entry.realId = await matchOrCreateDonor(ctx, {
      scope: state.scope,
      name: entry.name,
      email: entry.email,
      phone: entry.phone,
      kind: row.kind,
      source: state.donorSource ?? "givebutter-import",
    });
  }
  await fillDonorAddressIfBlank(ctx, entry.realId, row.address);
}

async function ensureGiftHistoryLoaded(
  ctx: QueryCtx,
  entry: SimDonor,
): Promise<void> {
  if (entry.giftHistoryLoaded) return;
  if (entry.realId) {
    const rows = await ctx.db
      .query("gifts")
      .withIndex("by_donor", (q) => q.eq("donorId", entry.realId as Id<"donors">))
      .order("desc")
      .take(GIFT_HISTORY_SCAN_LIMIT);
    entry.giftHistory.push(
      ...rows.map((g) => ({ amountCents: g.amountCents, receivedAt: g.receivedAt })),
    );
  }
  entry.giftHistoryLoaded = true;
}

async function ensurePledgeRefsLoaded(
  ctx: QueryCtx,
  entry: SimDonor,
): Promise<void> {
  if (entry.pledgeRefsLoaded) return;
  if (entry.realId) {
    const rows = await ctx.db
      .query("pledges")
      .withIndex("by_donor", (q) => q.eq("donorId", entry.realId as Id<"donors">))
      .take(DONOR_PLEDGE_SCAN_LIMIT);
    for (const p of rows) if (p.externalRef) entry.pledgeRefs.add(p.externalRef);
  }
  entry.pledgeRefsLoaded = true;
}

/**
 * Apply the row's own transaction as a `gifts` row for an ALREADY-resolved
 * donor: global externalRef dedup (run set + `by_externalRef`), then the
 * suspected-duplicate heuristic when there's no externalRef, then record.
 * Never resolves/counts a donor (the caller did). A present-but-invalid amount
 * is silently skipped (the caller decides whether that's a whole-row invalid).
 */
async function applyTransactionGift(
  ctx: MutationCtx,
  state: GivingState,
  row: CanonicalImportRow,
  entry: SimDonor,
  counts: GivingCounts,
): Promise<void> {
  const amount = row.amountCents;
  if (!Number.isInteger(amount) || (amount ?? 0) <= 0) return;
  const receivedAt = row.receivedAt ?? state.now;

  if (row.externalRef) {
    const dupInRun = state.seenGiftRefs.has(row.externalRef);
    const dupInDb =
      !dupInRun &&
      (await ctx.db
        .query("gifts")
        .withIndex("by_externalRef", (q) => q.eq("externalRef", row.externalRef!))
        .first()) !== null;
    if (dupInRun || dupInDb) {
      counts.giftsDuplicate++;
      return;
    }
  } else {
    await ensureGiftHistoryLoaded(ctx, entry);
    const suspect = entry.giftHistory.some(
      (g) => g.amountCents === amount && withinSuspectedWindow(g.receivedAt, receivedAt),
    );
    if (suspect) {
      counts.giftsDuplicate++;
      return;
    }
  }

  if (state.write) {
    await recordGiftForDonor(ctx, {
      donorId: entry.realId as Id<"donors">,
      amountCents: amount as number,
      receivedAt,
      method: row.source ?? "givebutter",
      ...(row.externalRef ? { externalRef: row.externalRef } : {}),
      ...(row.note ? { note: row.note } : {}),
    });
  }
  if (row.externalRef) state.seenGiftRefs.add(row.externalRef);
  entry.giftHistory.push({ amountCents: amount as number, receivedAt });
  counts.gifts++;
}

async function handleGiftRow(
  ctx: MutationCtx,
  state: GivingState,
  row: CanonicalImportRow,
  counts: GivingCounts,
): Promise<void> {
  // A gift row with a bad amount is a whole-row invalid — no donor, no gift.
  if (!Number.isInteger(row.amountCents) || (row.amountCents ?? 0) <= 0) {
    counts.invalid++;
    return;
  }
  const { entry, wasCreated } = await resolveDonor(ctx, state, {
    email: row.email,
    phone: row.phone,
    name: row.name,
  });
  if (wasCreated) counts.donorsCreated++;
  else counts.donorsMatched++;
  await materializeDonor(ctx, state, entry, row);
  await applyTransactionGift(ctx, state, row, entry, counts);
}

async function handleRecurringRow(
  ctx: MutationCtx,
  state: GivingState,
  row: CanonicalImportRow,
  counts: GivingCounts,
): Promise<void> {
  if (
    !Number.isInteger(row.recurringMonthlyCents) ||
    (row.recurringMonthlyCents ?? 0) < PLEDGE_FLOOR_CENTS
  ) {
    counts.invalid++;
    return;
  }
  const { entry, wasCreated } = await resolveDonor(ctx, state, {
    email: row.email,
    phone: row.phone,
    name: row.name,
  });
  if (wasCreated) counts.donorsCreated++;
  else counts.donorsMatched++;
  await materializeDonor(ctx, state, entry, row);

  // Pledge (per-donor externalRef dedup) — the "card can't be ported" cutover.
  let pledgeDup = false;
  if (row.externalRef) {
    await ensurePledgeRefsLoaded(ctx, entry);
    if (entry.pledgeRefs.has(row.externalRef)) pledgeDup = true;
  }
  if (pledgeDup) {
    counts.pledgesDuplicate++;
  } else {
    if (state.write) {
      await ctx.db.insert("pledges", {
        donorId: entry.realId as Id<"donors">,
        scope: state.scope,
        amountCents: row.recurringMonthlyCents as number,
        status: "past_due",
        origin: "imported",
        ...(row.externalRef ? { externalRef: row.externalRef } : {}),
        createdAt: state.now,
      });
    }
    if (row.externalRef) entry.pledgeRefs.add(row.externalRef);
    counts.pledges++;
  }

  // The export row's own monthly charge, recorded as a gift (see RECURRING
  // DECISION in the file header). Skipped when the row carries no amount.
  if (row.amountCents !== undefined) {
    await applyTransactionGift(ctx, state, row, entry, counts);
  }
}

/**
 * Resolve a roster contact for a ticket/contact row, never touching `donors`.
 * EXECUTE reuses the canonical `matchOrCreatePersonContact` verbatim (a fresh
 * read-your-writes roster read + "Added from import" insert), so a ticket buyer
 * who is ALSO a gift donor this run dedups against the donor's linked person
 * instead of spawning a duplicate. DRY RUN simulates it against the current DB
 * roster + this page's pending contacts.
 *
 * Both honor the Attendance C OWNER RULE: a name-only row (no email AND no
 * phone) that matches no existing roster person creates NOTHING — it's reported
 * `skipped: "no-identifier"` (my ticket rows rely on that guard). The dry run's
 * contact ESTIMATE can only over-count when an identity also appears on a
 * gift/recurring row — the same preview/commit imprecision the canonical
 * importer carries.
 */
async function resolvePersonContact(
  ctx: MutationCtx,
  state: GivingState,
  opts: { name: string; email?: string; phone?: string },
): Promise<{
  isNew: boolean;
  personId?: Id<"people">;
  skipped?: "no-identifier";
}> {
  if (state.write) {
    const res = await matchOrCreatePersonContact(ctx, state.chapterId, opts);
    if (res.skipped) return { isNew: false, skipped: "no-identifier" };
    return { isNew: res.isNew, personId: res.personId };
  }
  // Identity matching, not roster UX — deliberately unfiltered. See
  // `lib/org.ts#excludeContacts`.
  const roster = await chapterRoster(ctx, state.chapterId);
  if (matchIdentity(roster, opts).match) return { isNew: false };
  if (matchIdentity(state.pendingContacts, opts).match) return { isNew: false };
  if (!hasPersonIdentifier({ email: opts.email, phone: opts.phone })) {
    return { isNew: false, skipped: "no-identifier" };
  }
  state.pendingContacts.push({
    name: opts.name,
    email: opts.email,
    phone: opts.phone,
  });
  return { isNew: true };
}

async function handleTicketRow(
  ctx: MutationCtx,
  state: GivingState,
  row: CanonicalImportRow,
  counts: GivingCounts,
): Promise<void> {
  const email = normalizeEmail(row.email) ?? undefined;
  const { isNew, personId, skipped } = await resolvePersonContact(ctx, state, {
    name: row.name,
    email,
    phone: row.phone,
  });
  if (skipped) {
    counts.contactsSkippedNoIdentifier++;
    return; // name-only, no person created — nothing to attach history to
  }
  if (isNew) counts.contacts++;

  // Best-effort: link this buyer's ticket history to a real event + order.
  if (row.eventHint) {
    const event = await findEventByHint(ctx, state.chapterId, row.eventHint);
    if (event && email) {
      const order = await findPaidTicketOrder(ctx, event._id, email);
      if (order) {
        if (state.write && personId) {
          await appendPersonNote(
            ctx,
            personId,
            `Ticket history matched — ${event.name} (imported)`,
          );
        }
        counts.ticketHistoryLinked++;
        return;
      }
    }
  }
  if (state.write && personId) {
    await appendPersonNote(
      ctx,
      personId,
      `Bought tickets — ${row.eventHint ?? "unknown event"} (imported)`,
    );
  }
}

async function handleContactRow(
  ctx: MutationCtx,
  state: GivingState,
  row: CanonicalImportRow,
  counts: GivingCounts,
): Promise<void> {
  const { isNew, skipped } = await resolvePersonContact(ctx, state, {
    name: row.name,
    email: normalizeEmail(row.email) ?? undefined,
    phone: row.phone,
  });
  if (skipped) {
    counts.contactsSkippedNoIdentifier++;
    return;
  }
  if (isNew) counts.contacts++;
}

/**
 * Run ONE page of the giving backfill against the NY chapter. `execute` omitted
 * / false is a DRY RUN (zero writes, full simulation); `true` commits. Pages via
 * `offset` (window = `GIVING_PAGE_SIZE`) — the operator follows the returned
 * `nextOffset` (null when done). Idempotent on re-run: cross-page dedup rides on
 * DB reads (donors by scope, gifts by externalRef, fresh roster reads), so
 * paging never double-imports. Per-page counts (the operator sums them).
 */
export const runGivingBackfill = internalMutation({
  args: { execute: v.optional(v.boolean()), offset: v.optional(v.number()) },
  returns: v.object({
    dryRun: v.boolean(),
    offset: v.number(),
    processed: v.number(),
    nextOffset: v.union(v.number(), v.null()),
    counts: givingCountsValidator,
  }),
  handler: async (ctx, { execute, offset }) => {
    const chapter = await requireNyChapter(ctx);
    const start = Math.max(0, offset ?? 0);
    const state: GivingState = {
      now: Date.now(),
      write: execute ?? false,
      scope: chapter._id,
      chapterId: chapter._id,
      donorPool: [],
      seenGiftRefs: new Set(),
      pendingContacts: [],
    };
    const counts: GivingCounts = {
      donorsCreated: 0,
      donorsMatched: 0,
      gifts: 0,
      giftsDuplicate: 0,
      pledges: 0,
      pledgesDuplicate: 0,
      contacts: 0,
      contactsSkippedNoIdentifier: 0,
      ticketHistoryLinked: 0,
      invalid: 0,
    };

    const window = GIVING_ROWS.slice(start, start + GIVING_PAGE_SIZE);
    for (const row of window) {
      if (row.rowType === "gift") {
        await handleGiftRow(ctx, state, row, counts);
      } else if (row.rowType === "recurring") {
        await handleRecurringRow(ctx, state, row, counts);
      } else if (row.rowType === "ticket") {
        await handleTicketRow(ctx, state, row, counts);
      } else {
        await handleContactRow(ctx, state, row, counts);
      }
    }

    const next = start + GIVING_PAGE_SIZE;
    return {
      dryRun: !state.write,
      offset: start,
      processed: window.length,
      nextOffset: next < GIVING_ROWS.length ? next : null,
      counts,
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// ATTENDANCE BACKFILL — one dataset onto one event's guest list.
// ═══════════════════════════════════════════════════════════════════════════

/** Verify an event matches the owner-confirmed mapping for a dataset, or throw
 *  `MAPPING_MISMATCH` (the safety net against a mis-picked eventId). */
function verifyMapping(
  dataset: AttendanceDataset,
  event: Doc<"events">,
  map: EventMapping,
): void {
  const nameOk =
    event.name.trim().toLowerCase() === map.eventName.trim().toLowerCase();
  const expectedMs = Date.parse(`${map.eventDate}T00:00:00Z`);
  const dateOk = Math.abs(event.eventDate - expectedMs) <= MAPPING_DATE_TOLERANCE_MS;
  if (!nameOk || !dateOk) {
    throw new ConvexError({
      code: "MAPPING_MISMATCH",
      message:
        `Event "${event.name}" (${new Date(event.eventDate).toISOString().slice(0, 10)}) ` +
        `does not match the "${dataset}" mapping — expected "${map.eventName}" on ${map.eventDate}.`,
    });
  }
}

/** Lowercase-alnum-dash slug for backfill-created pages (local copy — the
 *  ticketing.ts original is module-private, and importing would couple this
 *  ops module to the public surface). */
function backfillSlugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "event"
  );
}

/**
 * Load the event's page, or (execute mode only) create a minimal UNPUBLISHED
 * one so historical guests have a counters home. Past events imported from
 * Partiful never had a page — refusing (the importer UI's NO_PAGE behavior)
 * would force an admin to hand-create four pages before the backfill.
 * The created page is `published: false` with every toggle at the
 * `ticketing.createPage` defaults, so nothing becomes publicly reachable.
 * `createdBy` uses the first user (the `seed.ensureChapters` precedent —
 * this internal runner has no authenticated actor).
 */
async function ensurePageForBackfill(
  ctx: MutationCtx,
  event: Doc<"events">,
): Promise<{ page: Doc<"eventPages">; created: boolean }> {
  const existing = await ctx.db
    .query("eventPages")
    .withIndex("by_event", (q) => q.eq("eventId", event._id))
    .unique();
  if (existing) return { page: existing, created: false };

  const firstUser = await ctx.db.query("users").first();
  if (!firstUser) {
    throw new ConvexError({
      code: "NO_USERS",
      message: "Cannot create a page: no users exist in this deployment.",
    });
  }
  let slug = backfillSlugify(event.name);
  const clash = await ctx.db
    .query("eventPages")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
  if (clash) slug = `${slug}-${event._id.slice(-4)}`;

  const now = Date.now();
  const pageId = await ctx.db.insert("eventPages", {
    eventId: event._id,
    chapterId: event.chapterId,
    slug,
    published: false,
    hostName: "Public Worship",
    addressVisibility: "public",
    rsvpEnabled: true,
    ticketsEnabled: false,
    showGuestList: true,
    activityRestricted: true,
    goingCount: 0,
    maybeCount: 0,
    notGoingCount: 0,
    ticketsSoldCount: 0,
    revenueCents: 0,
    createdBy: firstUser._id as Id<"users">,
    createdAt: now,
    updatedAt: now,
  });
  const page = await ctx.db.get(pageId);
  return { page: page!, created: true };
}

/**
 * Backfill ONE attendance dataset onto ONE event's guest list. Verifies the
 * event↔mapping match (`MAPPING_MISMATCH`); a missing page is auto-created
 * UNPUBLISHED in execute mode (dry run reports `pageWillBeCreated`), then runs
 * a window of the dataset's rows through the attendance importer's own
 * commit/classify core. `execute` omitted / false = a zero-write dry run
 * (classification counts); `true` commits. Pages via `offset` — follow
 * the returned `nextOffset` (null when done). Idempotent on re-run.
 */
export const runAttendanceBackfill = internalMutation({
  args: {
    dataset: datasetValidator,
    eventId: v.id("events"),
    execute: v.optional(v.boolean()),
    offset: v.optional(v.number()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    dataset: datasetValidator,
    offset: v.number(),
    processed: v.number(),
    nextOffset: v.union(v.number(), v.null()),
    counts: attendanceCountsValidator,
    pageCreated: v.optional(v.boolean()),
    pageWillBeCreated: v.optional(v.boolean()),
  }),
  handler: async (ctx, { dataset, eventId, execute, offset }) => {
    const write = execute ?? false;
    const start = Math.max(0, offset ?? 0);

    const event = await ctx.db.get(eventId);
    if (!event) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Event not found." });
    }
    verifyMapping(dataset, event, MAPPING[dataset]);

    let page: Doc<"eventPages"> | null = null;
    let pageCreated = false;
    let pageWillBeCreated = false;
    if (write) {
      const ensured = await ensurePageForBackfill(ctx, event);
      page = ensured.page;
      pageCreated = ensured.created;
    } else {
      page = await ctx.db
        .query("eventPages")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .unique();
      pageWillBeCreated = page === null;
    }

    const rows = DATASET_ROWS[dataset];
    const window = rows.slice(start, start + ATTENDANCE_PAGE_SIZE);

    let counts: {
      inserted: number;
      updated: number;
      skippedDuplicates: number;
      skippedInvalid: number;
    };
    if (write) {
      counts = await applyAttendanceRows(ctx, eventId, page!, window);
    } else {
      const { summary } = await classifyAttendanceRows(ctx, eventId, window);
      counts = {
        inserted: summary.newCount,
        updated: summary.updateCount,
        skippedDuplicates: summary.duplicateCount,
        skippedInvalid: summary.invalidCount,
      };
    }

    const next = start + ATTENDANCE_PAGE_SIZE;
    return {
      dryRun: !write,
      dataset,
      offset: start,
      processed: window.length,
      nextOffset: next < rows.length ? next : null,
      counts,
      ...(pageCreated ? { pageCreated } : {}),
      ...(pageWillBeCreated ? { pageWillBeCreated } : {}),
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// FULL RUN — one dispatch drives every dataset window (ops ergonomics: the
// run-convex-function workflow's concurrency group cancels bulk-queued runs,
// so per-window dispatches can't be parallelized from outside).
// ═══════════════════════════════════════════════════════════════════════════

const MAPPING_DATE_TOLERANCE_FULL_MS = 36 * 60 * 60 * 1000;

/**
 * Run the ENTIRE historical backfill (giving + all six attendance datasets) in
 * one call: resolves each dataset's event by the mapping table (exact name,
 * date within 36h — MAPPING_MISMATCH listing candidates otherwise), then loops
 * every window of every runner via `ctx.runMutation`, aggregating counts.
 * `execute` omitted / false = full zero-write dry run. Idempotent overall
 * (each underlying runner is). Attendance order follows ATTENDANCE_DATASETS
 * (`ptb` before `ptb_gb_tickets`, per the mapping's ordering note).
 */
export const runFullBackfill = internalAction({
  args: { execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    giving: givingCountsValidator,
    attendance: v.array(
      v.object({
        dataset: datasetValidator,
        eventId: v.id("events"),
        eventName: v.string(),
        counts: attendanceCountsValidator,
        pageCreated: v.optional(v.boolean()),
        pageWillBeCreated: v.optional(v.boolean()),
      }),
    ),
  }),
  handler: async (ctx, { execute }) => {
    const write = execute ?? false;

    // ── Resolve every dataset's event up front (fail before any work). ──
    const discovery: {
      chapterId: Id<"chapters">;
      events: {
        eventId: Id<"events">;
        name: string;
        eventDate: number;
        hasPage: boolean;
      }[];
    } = await ctx.runQuery(internal.historicalBackfill.listEventsForMapping, {});
    const resolved: {
      dataset: AttendanceDataset;
      eventId: Id<"events">;
      eventName: string;
    }[] = [];
    for (const dataset of ATTENDANCE_DATASETS) {
      const map = MAPPING[dataset];
      const expectedMs = Date.parse(`${map.eventDate}T00:00:00Z`);
      const hits = discovery.events.filter(
        (e) =>
          e.name.trim().toLowerCase() === map.eventName.trim().toLowerCase() &&
          Math.abs(e.eventDate - expectedMs) <= MAPPING_DATE_TOLERANCE_FULL_MS,
      );
      if (hits.length !== 1) {
        throw new ConvexError({
          code: "MAPPING_MISMATCH",
          message:
            `Dataset "${dataset}" resolved ${hits.length} events for ` +
            `"${map.eventName}" on ${map.eventDate} — need exactly 1. ` +
            `Chapter events: ${discovery.events.map((e) => e.name).join(", ")}`,
        });
      }
      resolved.push({
        dataset,
        eventId: hits[0].eventId,
        eventName: hits[0].name,
      });
    }

    // ── Giving: every window. ──
    const giving = {
      donorsCreated: 0,
      donorsMatched: 0,
      gifts: 0,
      giftsDuplicate: 0,
      pledges: 0,
      pledgesDuplicate: 0,
      contacts: 0,
      contactsSkippedNoIdentifier: 0,
      ticketHistoryLinked: 0,
      invalid: 0,
    };
    let gOffset: number | null = 0;
    while (gOffset !== null) {
      const res: {
        nextOffset: number | null;
        counts: typeof giving;
      } = await ctx.runMutation(internal.historicalBackfill.runGivingBackfill, {
        execute: write,
        offset: gOffset,
      });
      for (const k of Object.keys(giving) as (keyof typeof giving)[]) {
        giving[k] += res.counts[k];
      }
      gOffset = res.nextOffset;
    }

    // ── Attendance: every dataset, every window. ──
    const attendance = [];
    for (const { dataset, eventId, eventName } of resolved) {
      const counts = {
        inserted: 0,
        updated: 0,
        skippedDuplicates: 0,
        skippedInvalid: 0,
      };
      let pageCreated = false;
      let pageWillBeCreated = false;
      let offset: number | null = 0;
      while (offset !== null) {
        const res: {
          nextOffset: number | null;
          counts: typeof counts;
          pageCreated?: boolean;
          pageWillBeCreated?: boolean;
        } = await ctx.runMutation(
          internal.historicalBackfill.runAttendanceBackfill,
          { dataset, eventId, execute: write, offset },
        );
        for (const k of Object.keys(counts) as (keyof typeof counts)[]) {
          counts[k] += res.counts[k];
        }
        pageCreated = pageCreated || res.pageCreated === true;
        pageWillBeCreated = pageWillBeCreated || res.pageWillBeCreated === true;
        offset = res.nextOffset;
      }
      attendance.push({
        dataset,
        eventId,
        eventName,
        counts,
        ...(pageCreated ? { pageCreated } : {}),
        ...(pageWillBeCreated ? { pageWillBeCreated } : {}),
      });
    }

    return { dryRun: !write, giving, attendance };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// GENESIS GIVING BACKFILL — the org's PRE-PLATFORM giving history (2024–2026:
// founder wires/transfers, paid-on-behalf & in-kind gifts, Notion-era
// donations), owner-curated + APPROVED for production. Distinct from the
// Givebutter-era `runGivingBackfill` above: a separate curated dataset
// (`genesis.ts`), its own `genesis:`-prefixed externalRef namespace, and donors
// stamped `source: "manual"` (these predate Givebutter). It reuses the SAME
// commit path (`handleGiftRow` → `matchOrCreateDonor`/`recordGiftForDonor`) so
// donor dedup, gift externalRef idempotency, and rollup integrity are identical.
// ═══════════════════════════════════════════════════════════════════════════

/** Genesis rows processed per `runGenesisBackfill` call. The dataset is small
 *  (48 rows, one window), but the `offset`/`nextOffset` arg is kept for parity
 *  with `runGivingBackfill` and headroom if the curated set ever grows. */
const GENESIS_PAGE_SIZE = 100;

/** Build a zeroed giving-counts accumulator (the genesis runner only ever
 *  touches donor/gift fields; pledge/contact/ticket counts stay 0). */
function emptyGivingCounts(): GivingCounts {
  return {
    donorsCreated: 0,
    donorsMatched: 0,
    gifts: 0,
    giftsDuplicate: 0,
    pledges: 0,
    pledgesDuplicate: 0,
    contacts: 0,
    contactsSkippedNoIdentifier: 0,
    ticketHistoryLinked: 0,
    invalid: 0,
  };
}

/**
 * Map a genesis row's `method` + `inKind` onto the existing `gifts.method`
 * union — NEVER a new literal. An in-kind / paid-on-behalf gift commits as
 * `"in_kind"` (the schema's own in-kind marker), a founder wire as `"wire"`,
 * and everything else (Notion-era external donations, Truist→Relay transfers)
 * as `"other"` — the specific channel is preserved in the row's note.
 */
function genesisGiftMethod(row: GenesisGiftRow): Doc<"gifts">["method"] {
  if (row.inKind) return "in_kind";
  if (row.method === "wire") return "wire";
  return "other";
}

/**
 * Adapt a curated genesis row into the canonical gift-row shape the shared
 * commit path (`handleGiftRow`) consumes. Genesis records carry no mailing
 * address, so none is plumbed. The note is kept VERBATIM: the schema's
 * `"in_kind"` method IS the in-kind marker, so a row's existing "In-kind — "
 * note text is neither required nor re-prefixed (no double-prefixing).
 */
function genesisToGiftRow(row: GenesisGiftRow): CanonicalImportRow {
  return {
    rowType: "gift",
    name: row.donorName,
    ...(row.donorEmail ? { email: row.donorEmail } : {}),
    amountCents: row.amountCents,
    receivedAt: row.giftDateMs,
    source: genesisGiftMethod(row),
    externalRef: row.externalRef,
    note: row.note,
  };
}

/**
 * Run ONE page of the genesis giving backfill against the NY chapter. `execute`
 * omitted / false is a DRY RUN (zero writes, full simulation); `true` commits.
 * Donors match-or-create per identity (email when the curated row has one, else
 * exact name) and are stamped `source: "manual"`; gifts are idempotent by their
 * `genesis:` externalRef (re-run = every row a duplicate, zero writes). Returns
 * per-page counts (same shape as `runGivingBackfill`) PLUS `totalCents` — the
 * sum of amounts NEWLY recorded this page (0 on an idempotent re-run). Pages via
 * `offset` (window = `GENESIS_PAGE_SIZE`); follow `nextOffset` (null when done).
 */
export const runGenesisBackfill = internalMutation({
  args: { execute: v.optional(v.boolean()), offset: v.optional(v.number()) },
  returns: v.object({
    dryRun: v.boolean(),
    offset: v.number(),
    processed: v.number(),
    nextOffset: v.union(v.number(), v.null()),
    counts: givingCountsValidator,
    totalCents: v.number(),
  }),
  handler: async (ctx, { execute, offset }) => {
    const chapter = await requireNyChapter(ctx);
    const start = Math.max(0, offset ?? 0);
    const state: GivingState = {
      now: Date.now(),
      write: execute ?? false,
      scope: chapter._id,
      chapterId: chapter._id,
      donorPool: [],
      seenGiftRefs: new Set(),
      pendingContacts: [],
      donorSource: "manual",
    };
    const counts = emptyGivingCounts();
    let totalCents = 0;

    const window = GENESIS_GIFTS.slice(start, start + GENESIS_PAGE_SIZE);
    for (const genesisRow of window) {
      const before = counts.gifts;
      await handleGiftRow(ctx, state, genesisToGiftRow(genesisRow), counts);
      // A newly-recorded gift (not a dup/invalid) contributes to the run total.
      if (counts.gifts > before) totalCents += genesisRow.amountCents;
    }

    const next = start + GENESIS_PAGE_SIZE;
    return {
      dryRun: !state.write,
      offset: start,
      processed: window.length,
      nextOffset: next < GENESIS_GIFTS.length ? next : null,
      counts,
      totalCents,
    };
  },
});

/**
 * Drive the ENTIRE genesis giving backfill in one call: loops every window of
 * `runGenesisBackfill` via `ctx.runMutation`, aggregating counts + `totalCents`.
 * `execute` omitted / false = a full zero-write dry run; `true` commits.
 * Idempotent overall (the underlying runner is). Mirrors `runFullBackfill`'s
 * dispatch shape so the operator invokes it the same way after deploy.
 */
export const runGenesisGivingBackfill = internalAction({
  args: { execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    counts: givingCountsValidator,
    totalCents: v.number(),
  }),
  handler: async (ctx, { execute }) => {
    const write = execute ?? false;
    const counts = emptyGivingCounts();
    let totalCents = 0;
    let offset: number | null = 0;
    while (offset !== null) {
      const res: {
        nextOffset: number | null;
        counts: GivingCounts;
        totalCents: number;
      } = await ctx.runMutation(
        internal.historicalBackfill.runGenesisBackfill,
        { execute: write, offset },
      );
      for (const k of Object.keys(counts) as (keyof GivingCounts)[]) {
        counts[k] += res.counts[k];
      }
      totalCents += res.totalCents;
      offset = res.nextOffset;
    }
    return { dryRun: !write, counts, totalCents };
  },
});
