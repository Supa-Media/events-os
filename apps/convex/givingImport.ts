/**
 * Canonical import (Territories P6) — ONE row shape for every bulk
 * data-onboarding path into the Giving desk, two-phase (preview → commit).
 * Supersedes `givingPlatform.ts`'s Givebutter-only `importGivebutterCsv` and
 * `givingPledges.ts`'s `importGivebutterRecurring` — both deleted; see their
 * files' header comments.
 *
 * Why one shape: Givebutter (and most giving/ticketing platforms) consolidate
 * ticket sales AND mission donations into the same export, and the bank only
 * ever sees the lump payout — never the split. Importing that export naively
 * as "gifts" would inflate the donor CRM with everyone who ever bought a
 * ticket, when a ticket buyer got something of equal value back (a seat) and
 * never actually GAVE anything. So every row carries a `rowType` and is
 * CLASSIFIED before anything is created:
 *
 *   - `gift`      — match-or-create a donor + a `gifts` row. Only this row
 *                   type (and `recurring`) ever creates CRM money history.
 *   - `ticket`     — NEVER a donor/gift. Match-or-create a chapter `people`
 *                    contact (non-team, "Added from import") and best-effort
 *                    link their purchase history to a real event via
 *                    `eventHint` + email; central scope is a pure no-op (no
 *                    roster, no ticket history to attach to there).
 *   - `contact`    — match-or-create a chapter `people` contact only.
 *   - `recurring`  — match-or-create a donor + an `origin:"imported"`,
 *                    `status:"past_due"` pledge (the same "card can't be
 *                    ported" cutover shape `importGivebutterRecurring` used).
 *
 * `previewImport` (query, read-only) runs the SAME classification against a
 * per-call in-memory simulation (no writes are possible from a query), so a
 * misclassified export — a ticket-sales file about to be imported as gifts —
 * is caught by the gift/ticket split in its summary BEFORE `importCanonical`
 * (mutation) commits anything. `importCanonical` batches in groups of
 * `IMPORT_BATCH_SIZE` and self-reschedules the remainder (the house pattern
 * `givingPlatform.ts#importRows` established), and is idempotent on re-run:
 * `externalRef` dedup (global for gifts, per-donor for pledges), the
 * suspected-duplicate skip, and donor/people match-or-create together mean
 * running the same file twice imports nothing new the second time.
 *
 * Dedup rules:
 *   - `gift`:  `externalRef` is the hard dedup key when present (global,
 *              `by_externalRef`) — trusted as authoritative, since the
 *              source system already deduped at that id. Without one, a
 *              SUSPECTED-duplicate heuristic applies instead: the SAME donor
 *              + the SAME `amountCents` + a `receivedAt` within 24h of a gift
 *              already counted for that donor (DB history, bounded
 *              `by_donor` read, plus any gift already counted earlier in
 *              this same import call/batch). Suspected rows are SKIPPED on
 *              commit unless the caller passes `allowSuspected: true`.
 *   - `recurring`: `externalRef` dedup is scoped to the matched donor's OWN
 *              pledges (ported verbatim from `importGivebutterRecurring`).
 */
import {
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { normalizeEmail } from "./lib/access";
import { chapterRoster } from "./lib/org";
import { requireGivingManage, type GivingScope } from "./lib/givingAccess";
import { matchOrCreateDonor, recordGiftForDonor } from "./lib/givingDonors";
import { findDonorInScope, hasPersonIdentifier } from "./lib/givingDonors";
import {
  DONOR_KINDS,
  GIFT_METHODS,
  donorAddressValidator,
} from "./schema/givingPlatform";
import { PLEDGE_FLOOR_CENTS } from "./givingPledges";

// ── Constants ──────────────────────────────────────────────────────────────

/** Client pages preview + commit calls at this size (matches the mobile
 *  Import screen's paging). */
const MAX_IMPORT_ROWS = 500;

/** Rows processed per commit transaction before self-reschedule — the house
 *  pattern `givingPlatform.ts#importRows` established. */
const IMPORT_BATCH_SIZE = 100;

/** Bounded, newest-first scan of a chapter's events for `eventHint` matching
 *  — ticket history is almost always recent, and this stays well inside a
 *  single transaction's document-read budget. */
const EVENT_HINT_SCAN_LIMIT = 300;

/** Bounded scan of an event's ticket orders — mirrors
 *  `ticketing.ts#listOrdersAdmin`'s own `.take(500)` bound. */
const TICKET_ORDER_SCAN_LIMIT = 500;

/** Bounded `by_donor` read for the suspected-duplicate heuristic (a donor's
 *  gift count is far smaller than this in practice). */
export const GIFT_HISTORY_SCAN_LIMIT = 50;

/** Bounded `by_donor` read for a recurring row's externalRef dedup — mirrors
 *  `givingPledges.ts`'s own `DONOR_PLEDGE_LIMIT`. */
export const DONOR_PLEDGE_SCAN_LIMIT = 50;

/** The suspected-duplicate heuristic's "within 24h" window. */
const SUSPECTED_DUP_WINDOW_MS = 24 * 60 * 60 * 1000;

// ── Validators ─────────────────────────────────────────────────────────────

const scopeValidator = v.union(v.id("chapters"), v.literal("central"));
const donorKindValidator = v.union(...DONOR_KINDS.map((k) => v.literal(k)));
const giftMethodValidator = v.union(...GIFT_METHODS.map((m) => v.literal(m)));

const CANONICAL_ROW_TYPES = ["gift", "ticket", "contact", "recurring"] as const;

/** The one canonical row shape every import (paste/CSV, any source) parses
 *  into client-side before calling `previewImport`/`importCanonical`. */
export const canonicalImportRowValidator = v.object({
  rowType: v.union(...CANONICAL_ROW_TYPES.map((t) => v.literal(t))),
  name: v.string(),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  kind: v.optional(donorKindValidator), // gift/recurring donor kind, default individual
  amountCents: v.optional(v.number()), // gift rows
  receivedAt: v.optional(v.number()), // gift rows, default now
  source: v.optional(giftMethodValidator), // gift.method, default "givebutter"
  externalRef: v.optional(v.string()), // dedup key (gift: global, recurring: per-donor)
  note: v.optional(v.string()), // gift rows
  recurringMonthlyCents: v.optional(v.number()), // recurring rows
  eventHint: v.optional(v.string()), // ticket rows — event name/slug/date hint
  // Optional mailing address on a gift/recurring row — flows to the donor on
  // creation, and fills a matched donor's address only if it's still blank
  // (`fillDonorAddressIfBlank`, never overwrites). Ignored for ticket/contact
  // rows (those never touch `donors`).
  address: v.optional(donorAddressValidator),
});
export type CanonicalImportRow = Infer<typeof canonicalImportRowValidator>;

/** Reused across every row type: how the row's identity (email/phone/name)
 *  resolved against an existing donor/person, or "n/a" when no resolution was
 *  attempted (a central-scope `contact`/`ticket` row — no roster there). */
const donorMatchValidator = v.union(
  v.literal("new"),
  v.literal("email"),
  v.literal("phone"),
  v.literal("name"),
  v.literal("n/a"),
);
type DonorMatch = Infer<typeof donorMatchValidator>;

const previewRowValidator = v.union(
  v.object({
    index: v.number(),
    rowType: v.literal("gift"),
    donorMatch: donorMatchValidator,
    disposition: v.union(
      v.literal("new"),
      v.literal("duplicate"),
      v.literal("suspected-duplicate"),
      v.literal("invalid"),
    ),
    reason: v.optional(v.string()),
  }),
  v.object({
    index: v.number(),
    rowType: v.literal("ticket"),
    donorMatch: donorMatchValidator,
    // `no-identifier` (Attendance C owner rule): a ticket row with no email AND
    // no phone that matches no existing roster row creates no contact — nothing
    // to attach purchase history to, so it's honestly reported, not silently
    // dropped as history-only.
    disposition: v.union(
      v.literal("matched-order"),
      v.literal("history-only"),
      v.literal("no-identifier"),
    ),
    reason: v.optional(v.string()),
  }),
  v.object({
    index: v.number(),
    rowType: v.literal("contact"),
    donorMatch: donorMatchValidator,
    // `invalid` is a deliberate addition beyond the three literal dispositions
    // named in the design doc: a `contact` row at `"central"` scope has no
    // chapter roster to match-or-create into, so it's honestly reported
    // invalid rather than silently mislabeled "matched". See this file's
    // header + the PR description for the full list of such deviations.
    // `no-identifier` (Attendance C owner rule): a contact row with no email
    // AND no phone that doesn't match an existing roster row creates NOTHING —
    // a name-only contact stays a guest. Distinct from `invalid` (central-scope).
    disposition: v.union(
      v.literal("new"),
      v.literal("matched"),
      v.literal("invalid"),
      v.literal("no-identifier"),
    ),
    reason: v.optional(v.string()),
  }),
  v.object({
    index: v.number(),
    rowType: v.literal("recurring"),
    donorMatch: donorMatchValidator,
    // `invalid` added for the same reason as `contact` above — a malformed
    // `recurringMonthlyCents` (missing, non-integer, or under the $20 floor)
    // needs a disposition too.
    disposition: v.union(v.literal("new"), v.literal("duplicate"), v.literal("invalid")),
    reason: v.optional(v.string()),
  }),
);

const summaryValidator = v.object({
  totalRows: v.number(),
  giftRowCount: v.number(),
  ticketRowCount: v.number(),
  contactRowCount: v.number(),
  recurringRowCount: v.number(),
  // Sum of amountCents across every GIFT-type row with a valid positive
  // integer amount, regardless of its disposition — the number to eyeball
  // against the source export's own total giving figure.
  totalGiftCents: v.number(),
  // Counts keyed `"<rowType>:<disposition>"` (e.g. "gift:new",
  // "ticket:history-only") — the full disposition breakdown; the gift/ticket
  // ROW counts above are what catch a misclassified export at a glance.
  byDisposition: v.record(v.string(), v.number()),
});

const commitResultValidator = v.object({
  imported: v.object({
    gifts: v.number(),
    pledges: v.number(),
    people: v.number(),
  }),
  skippedDuplicates: v.number(),
  skippedSuspected: v.number(),
  skippedInvalid: v.number(),
  // Attendance C owner rule: contact/ticket rows skipped because they had no
  // email AND no phone and matched no existing roster row (no person created).
  skippedNoIdentifier: v.number(),
  ticketHistoryLinked: v.number(),
  scheduledRemaining: v.number(),
});

// ── Shared pure helpers ────────────────────────────────────────────────────

/** True iff two timestamps are within the suspected-duplicate window. */
export function withinSuspectedWindow(a: number, b: number): boolean {
  return Math.abs(a - b) <= SUSPECTED_DUP_WINDOW_MS;
}

/** A whole-dollar label for a suspected-duplicate reason string ("$50.00"). */
function centsToLabel(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Trim + lowercase + collapse whitespace, for loose event-hint matching. */
function normalizeHint(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export type IdentityLike = { name: string; email?: string; phone?: string };

/**
 * Match `opts` against `pool` in email → phone → name priority — the SAME
 * cascade `lib/givingDonors.ts#linkDonorToPerson` uses for donor↔people
 * linking (territories P5), reused here for every row type's identity
 * resolution (donor OR people, the shape is identical either way).
 */
export function matchIdentity<T extends IdentityLike>(
  pool: readonly T[],
  opts: { email?: string; phone?: string; name?: string },
): { match: T | null; via: Exclude<DonorMatch, "new" | "n/a"> | null } {
  const email = normalizeEmail(opts.email) ?? undefined;
  if (email) {
    const hit = pool.find((p) => normalizeEmail(p.email) === email);
    if (hit) return { match: hit, via: "email" };
  }
  const phone = opts.phone?.trim() || undefined;
  if (phone) {
    const hit = pool.find((p) => p.phone?.trim() === phone);
    if (hit) return { match: hit, via: "phone" };
  }
  const name = opts.name?.trim() || undefined;
  if (name) {
    const hit = pool.find((p) => p.name.trim() === name);
    if (hit) return { match: hit, via: "name" };
  }
  return { match: null, via: null };
}

// ── Event / ticket-order lookup (shared by preview + commit) ───────────────

/**
 * Resolve a `ticket` row's free-text `eventHint` to one of the chapter's
 * events: a bounded, newest-first `by_chapter_date` read (ticket history is
 * almost always recent), matched in memory — an exact normalized-name match
 * wins outright; otherwise the first event whose name contains the hint or
 * whose hint contains the event's name (handles "Worship Night 3/2" as well
 * as a bare "Worship Night"). Returns `null` on no match — the row simply
 * falls back to `history-only`, never a hard failure.
 */
export async function findEventByHint(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  eventHint: string,
): Promise<Doc<"events"> | null> {
  const hint = normalizeHint(eventHint);
  if (!hint) return null;
  const events = await ctx.db
    .query("events")
    .withIndex("by_chapter_date", (q) => q.eq("chapterId", chapterId))
    .order("desc")
    .take(EVENT_HINT_SCAN_LIMIT);
  let contains: Doc<"events"> | null = null;
  for (const event of events) {
    const name = normalizeHint(event.name);
    if (name === hint) return event;
    if (!contains && (name.includes(hint) || hint.includes(name))) {
      contains = event;
    }
  }
  return contains;
}

/**
 * Find a PAID ticket order for `email` at `eventId`. `ticketOrders` carries
 * no email index (only `by_event` / `by_stripe_session`), so this goes
 * through `rsvps`' indexed `by_event_email` lookup first (the SAME resolution
 * `ticketing.ts#createOrder` itself uses to attach an order to its buyer's
 * RSVP identity), then a bounded `by_event` scan of `ticketOrders` matched to
 * that RSVP id in memory.
 */
export async function findPaidTicketOrder(
  ctx: QueryCtx,
  eventId: Id<"events">,
  email: string,
): Promise<Doc<"ticketOrders"> | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const rsvp = await ctx.db
    .query("rsvps")
    .withIndex("by_event_email", (q) =>
      q.eq("eventId", eventId).eq("email", normalized),
    )
    .first();
  if (!rsvp) return null;
  const orders = await ctx.db
    .query("ticketOrders")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .order("desc")
    .take(TICKET_ORDER_SCAN_LIMIT);
  return orders.find((o) => o.rsvpId === rsvp._id && o.status === "paid") ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// PREVIEW — read-only classification, no writes possible (this is a query).
// ═══════════════════════════════════════════════════════════════════════════

/** A donor as simulated for one `previewImport` call: either a real donor
 *  (matched from the DB) or a synthetic "would be created" placeholder,
 *  carrying just enough accumulated state (gift amounts/dates, pledge
 *  externalRefs) to make in-batch dedup/suspected-dup checks agree with what
 *  `importCanonical` would actually do (its real DB reads see prior writes
 *  from earlier rows in the SAME transaction; a query can't write, so this
 *  simulates that read-your-writes effect in memory instead). */
type DonorSimEntry = {
  id: Id<"donors"> | string; // real id once matched, else a synthetic "pending:N" key
  isNew: boolean;
  name: string;
  email?: string;
  phone?: string;
  giftHistory: { amountCents: number; receivedAt: number }[];
  giftHistoryLoaded: boolean;
  pledgeExternalRefs: Set<string>;
  pledgeExternalRefsLoaded: boolean;
};

/** Resolve (or simulate the creation of) a donor for a `gift`/`recurring`
 *  preview row: check this call's own pool first (email → phone → name),
 *  then the real DB, else register a synthetic pending entry. */
async function resolveSimDonor(
  ctx: QueryCtx,
  scope: GivingScope,
  pool: DonorSimEntry[],
  opts: { email?: string; phone?: string; name: string },
): Promise<{ entry: DonorSimEntry; via: DonorMatch }> {
  const inPool = matchIdentity(pool, opts);
  if (inPool.match) return { entry: inPool.match, via: inPool.via ?? "name" };

  const existing = await findDonorInScope(ctx, scope, opts);
  if (existing) {
    const entry: DonorSimEntry = {
      id: existing._id,
      isNew: false,
      name: existing.name,
      email: existing.email,
      phone: existing.phone,
      giftHistory: [],
      giftHistoryLoaded: false,
      pledgeExternalRefs: new Set(),
      pledgeExternalRefsLoaded: false,
    };
    pool.push(entry);
    // Re-derive which key actually hit (email/phone/name) — see this
    // function's `via` note above `matchIdentity`'s call site for why this is
    // always safe: `findDonorInScope` checks in the exact same priority.
    const via = matchIdentity([entry], opts).via ?? "name";
    return { entry, via };
  }

  const entry: DonorSimEntry = {
    id: `pending:${pool.length}`,
    isNew: true,
    name: opts.name,
    email: opts.email,
    phone: opts.phone,
    giftHistory: [],
    giftHistoryLoaded: false,
    pledgeExternalRefs: new Set(),
    pledgeExternalRefsLoaded: false,
  };
  pool.push(entry);
  return { entry, via: "new" };
}

/** Lazily load a (real, existing) sim donor's gift history once — a bounded
 *  `by_donor` read. A brand-new donor has no history to load. */
async function ensureGiftHistoryLoaded(
  ctx: QueryCtx,
  entry: DonorSimEntry,
): Promise<void> {
  if (entry.isNew || entry.giftHistoryLoaded) {
    entry.giftHistoryLoaded = true;
    return;
  }
  const rows = await ctx.db
    .query("gifts")
    .withIndex("by_donor", (q) => q.eq("donorId", entry.id as Id<"donors">))
    .order("desc")
    .take(GIFT_HISTORY_SCAN_LIMIT);
  entry.giftHistory.push(
    ...rows.map((g) => ({ amountCents: g.amountCents, receivedAt: g.receivedAt })),
  );
  entry.giftHistoryLoaded = true;
}

/** Lazily load a (real, existing) sim donor's pledge externalRefs once — a
 *  bounded `by_donor` read. A brand-new donor has none. */
async function ensurePledgeRefsLoaded(
  ctx: QueryCtx,
  entry: DonorSimEntry,
): Promise<void> {
  if (entry.isNew || entry.pledgeExternalRefsLoaded) {
    entry.pledgeExternalRefsLoaded = true;
    return;
  }
  const rows = await ctx.db
    .query("pledges")
    .withIndex("by_donor", (q) => q.eq("donorId", entry.id as Id<"donors">))
    .take(DONOR_PLEDGE_SCAN_LIMIT);
  for (const p of rows) {
    if (p.externalRef) entry.pledgeExternalRefs.add(p.externalRef);
  }
  entry.pledgeExternalRefsLoaded = true;
}

type GiftPreview = {
  donorMatch: DonorMatch;
  disposition: "new" | "duplicate" | "suspected-duplicate" | "invalid";
  reason?: string;
};

async function previewGiftRow(
  ctx: QueryCtx,
  scope: GivingScope,
  row: CanonicalImportRow,
  donorPool: DonorSimEntry[],
  seenExternalRefs: Set<string>,
): Promise<GiftPreview> {
  const { entry, via } = await resolveSimDonor(ctx, scope, donorPool, {
    email: row.email,
    phone: row.phone,
    name: row.name,
  });

  if (!Number.isInteger(row.amountCents) || (row.amountCents ?? 0) <= 0) {
    return {
      donorMatch: via,
      disposition: "invalid",
      reason: "Amount must be a whole number of cents greater than zero.",
    };
  }
  const receivedAt = row.receivedAt ?? Date.now();

  // `externalRef`, when present, is the AUTHORITATIVE dedup key (the source
  // system already deduped at that id) — checked before, and instead of, the
  // suspected-duplicate heuristic.
  if (row.externalRef) {
    const dupInBatch = seenExternalRefs.has(row.externalRef);
    const dupInDb =
      !dupInBatch &&
      (await ctx.db
        .query("gifts")
        .withIndex("by_externalRef", (q) => q.eq("externalRef", row.externalRef!))
        .first()) !== null;
    if (dupInBatch || dupInDb) {
      return {
        donorMatch: via,
        disposition: "duplicate",
        reason: "A gift with this externalRef already exists.",
      };
    }
    seenExternalRefs.add(row.externalRef);
    entry.giftHistory.push({ amountCents: row.amountCents!, receivedAt });
    return { donorMatch: via, disposition: "new" };
  }

  // No externalRef to trust — the suspected-duplicate heuristic: same donor +
  // same amountCents + received within 24h of a gift already counted for
  // them (DB history, or a gift already counted earlier in THIS call).
  await ensureGiftHistoryLoaded(ctx, entry);
  const suspect = entry.giftHistory.find(
    (g) => g.amountCents === row.amountCents && withinSuspectedWindow(g.receivedAt, receivedAt),
  );
  if (suspect) {
    return {
      donorMatch: via,
      disposition: "suspected-duplicate",
      reason: `Matches a ${centsToLabel(suspect.amountCents)} gift from the same donor within 24h.`,
    };
  }
  entry.giftHistory.push({ amountCents: row.amountCents!, receivedAt });
  return { donorMatch: via, disposition: "new" };
}

type RecurringPreview = {
  donorMatch: DonorMatch;
  disposition: "new" | "duplicate" | "invalid";
  reason?: string;
};

async function previewRecurringRow(
  ctx: QueryCtx,
  scope: GivingScope,
  row: CanonicalImportRow,
  donorPool: DonorSimEntry[],
): Promise<RecurringPreview> {
  const { entry, via } = await resolveSimDonor(ctx, scope, donorPool, {
    email: row.email,
    phone: row.phone,
    name: row.name,
  });

  if (
    !Number.isInteger(row.recurringMonthlyCents) ||
    (row.recurringMonthlyCents ?? 0) < PLEDGE_FLOOR_CENTS
  ) {
    return {
      donorMatch: via,
      disposition: "invalid",
      reason: "Monthly amount must be a whole number of cents, at least $5.",
    };
  }

  if (row.externalRef) {
    await ensurePledgeRefsLoaded(ctx, entry);
    if (entry.pledgeExternalRefs.has(row.externalRef)) {
      return {
        donorMatch: via,
        disposition: "duplicate",
        reason: "A pledge with this externalRef already exists for this donor.",
      };
    }
    entry.pledgeExternalRefs.add(row.externalRef);
  }
  return { donorMatch: via, disposition: "new" };
}

/** Per-chapter roster pool for `contact`/`ticket` preview rows: the real
 *  roster (loaded once per chapter per call) PLUS any pending "would be
 *  created" contact registered by an earlier row in this same call. */
async function ensureRosterPool(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  cache: Map<string, IdentityLike[]>,
): Promise<IdentityLike[]> {
  const key = chapterId as unknown as string;
  const cached = cache.get(key);
  if (cached) return cached;
  // Identity matching, not roster UX — deliberately unfiltered (a prior
  // contact-only row must stay matchable). See `lib/org.ts#excludeContacts`.
  const roster = await chapterRoster(ctx, chapterId);
  const pool: IdentityLike[] = roster.map((p) => ({
    name: p.name,
    email: p.email,
    phone: p.phone,
  }));
  cache.set(key, pool);
  return pool;
}

type ContactPreview = {
  donorMatch: DonorMatch;
  disposition: "new" | "matched" | "invalid" | "no-identifier";
  reason?: string;
};

async function previewContactRow(
  ctx: QueryCtx,
  scope: GivingScope,
  row: CanonicalImportRow,
  rosterPool: Map<string, IdentityLike[]>,
): Promise<ContactPreview> {
  if (scope === "central") {
    return {
      donorMatch: "n/a",
      disposition: "invalid",
      reason: "Central scope has no chapter roster for a contact.",
    };
  }
  const pool = await ensureRosterPool(ctx, scope, rosterPool);
  const { match, via } = matchIdentity(pool, {
    email: row.email,
    phone: row.phone,
    name: row.name,
  });
  if (match) return { donorMatch: via ?? "name", disposition: "matched" };
  // OWNER RULE (Attendance C): a name-only contact (no email AND no phone) that
  // matches no existing roster row creates NOTHING — it stays a guest. Matching
  // by name above is still honored; only the create below is gated.
  if (!hasPersonIdentifier({ email: row.email, phone: row.phone })) {
    return {
      donorMatch: "n/a",
      disposition: "no-identifier",
      reason: "No email or phone — a name-only contact stays a guest.",
    };
  }
  pool.push({ name: row.name, email: row.email, phone: row.phone });
  return { donorMatch: "new", disposition: "new" };
}

type TicketPreview = {
  donorMatch: DonorMatch;
  disposition: "matched-order" | "history-only" | "no-identifier";
  reason?: string;
};

async function previewTicketRow(
  ctx: QueryCtx,
  scope: GivingScope,
  row: CanonicalImportRow,
  rosterPool: Map<string, IdentityLike[]>,
): Promise<TicketPreview> {
  if (scope === "central") {
    return {
      donorMatch: "n/a",
      disposition: "history-only",
      reason: "Central scope has no ticket history to attach to — no-op.",
    };
  }
  const pool = await ensureRosterPool(ctx, scope, rosterPool);
  const { match, via } = matchIdentity(pool, {
    email: row.email,
    phone: row.phone,
    name: row.name,
  });
  // OWNER RULE (Attendance C): a name-only ticket row (no email AND no phone)
  // matching no existing roster row creates no contact — there's nothing to
  // attach purchase history to, so report it rather than silently no-op.
  if (!match && !hasPersonIdentifier({ email: row.email, phone: row.phone })) {
    return {
      donorMatch: "n/a",
      disposition: "no-identifier",
      reason: "No email or phone — no contact created for this ticket row.",
    };
  }
  const donorMatch: DonorMatch = match ? (via ?? "name") : "new";
  if (!match) pool.push({ name: row.name, email: row.email, phone: row.phone });

  if (!row.eventHint) {
    return { donorMatch, disposition: "history-only", reason: "No eventHint given." };
  }
  const event = await findEventByHint(ctx, scope, row.eventHint);
  if (!event) {
    return {
      donorMatch,
      disposition: "history-only",
      reason: `No event matched the hint "${row.eventHint}".`,
    };
  }
  if (!row.email) {
    return {
      donorMatch,
      disposition: "history-only",
      reason: `Matched "${event.name}" but the row has no email to look up an order.`,
    };
  }
  const order = await findPaidTicketOrder(ctx, event._id, row.email);
  if (!order) {
    return {
      donorMatch,
      disposition: "history-only",
      reason: `No paid ticket order found for this email at "${event.name}".`,
    };
  }
  return {
    donorMatch,
    disposition: "matched-order",
    reason: `Matched a ticket order for "${event.name}".`,
  };
}

/**
 * Read-only preview of a batch of canonical import rows (≤ `MAX_IMPORT_ROWS`
 * — the client pages larger files into multiple calls): classifies every row
 * exactly as `importCanonical` would, WITHOUT writing anything, via an
 * in-memory per-call simulation (see `DonorSimEntry`/`ensureRosterPool`).
 * Manage-gated (bulk data-onboarding is a manage-level action, same as the
 * legacy importers were).
 */
export const previewImport = query({
  args: { scope: scopeValidator, rows: v.array(canonicalImportRowValidator) },
  returns: v.object({ rows: v.array(previewRowValidator), summary: summaryValidator }),
  handler: async (ctx, { scope, rows }) => {
    const typedScope = scope as GivingScope;
    await requireGivingManage(ctx, typedScope);
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: `At most ${MAX_IMPORT_ROWS} rows per call.`,
      });
    }

    const donorPool: DonorSimEntry[] = [];
    const seenGiftExternalRefs = new Set<string>();
    const rosterPool = new Map<string, IdentityLike[]>();

    const outRows: Infer<typeof previewRowValidator>[] = [];
    const byDisposition: Record<string, number> = {};
    let giftRowCount = 0;
    let ticketRowCount = 0;
    let contactRowCount = 0;
    let recurringRowCount = 0;
    let totalGiftCents = 0;

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (row.rowType === "gift") {
        giftRowCount++;
        if (Number.isInteger(row.amountCents) && (row.amountCents ?? 0) > 0) {
          totalGiftCents += row.amountCents!;
        }
        const r = await previewGiftRow(ctx, typedScope, row, donorPool, seenGiftExternalRefs);
        outRows.push({ index, rowType: "gift", ...r });
        bump(byDisposition, `gift:${r.disposition}`);
      } else if (row.rowType === "ticket") {
        ticketRowCount++;
        const r = await previewTicketRow(ctx, typedScope, row, rosterPool);
        outRows.push({ index, rowType: "ticket", ...r });
        bump(byDisposition, `ticket:${r.disposition}`);
      } else if (row.rowType === "contact") {
        contactRowCount++;
        const r = await previewContactRow(ctx, typedScope, row, rosterPool);
        outRows.push({ index, rowType: "contact", ...r });
        bump(byDisposition, `contact:${r.disposition}`);
      } else {
        recurringRowCount++;
        const r = await previewRecurringRow(ctx, typedScope, row, donorPool);
        outRows.push({ index, rowType: "recurring", ...r });
        bump(byDisposition, `recurring:${r.disposition}`);
      }
    }

    return {
      rows: outRows,
      summary: {
        totalRows: rows.length,
        giftRowCount,
        ticketRowCount,
        contactRowCount,
        recurringRowCount,
        totalGiftCents,
        byDisposition,
      },
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// COMMIT — real writes, batched + self-rescheduled.
// ═══════════════════════════════════════════════════════════════════════════

type CommitCounters = {
  gifts: number;
  pledges: number;
  people: number;
  skippedDuplicates: number;
  skippedSuspected: number;
  skippedInvalid: number;
  skippedNoIdentifier: number;
  ticketHistoryLinked: number;
};

/**
 * Match-or-create a chapter roster contact for a `contact`/`ticket` row —
 * reuses P5's `linkDonorToPerson` match order (email → phone → exact name)
 * directly against the roster, but writes "Added from import" (not "Added
 * from Giving") so the row reads as import-originated. Never touches
 * `donors` — a contact/ticket row creates no donor, ever.
 */
export async function matchOrCreatePersonContact(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  args: { name: string; email?: string; phone?: string },
): Promise<
  | { personId: Id<"people">; isNew: boolean; skipped?: undefined }
  | { personId: null; isNew: false; skipped: "no-identifier" }
> {
  // Identity matching, not roster UX — deliberately unfiltered. See
  // `lib/org.ts#excludeContacts`.
  const roster = await chapterRoster(ctx, chapterId);
  const { match } = matchIdentity(roster, args);
  if (match) return { personId: match._id, isNew: false };
  // OWNER RULE (Attendance C): a name-only contact/ticket row (no email AND no
  // phone) that matches no existing roster row creates NOTHING — a name-only
  // record is a guest, not a roster person. Matching above is still allowed;
  // only the insert below is gated. See `givingDonors.ts#hasPersonIdentifier`.
  if (!hasPersonIdentifier({ email: args.email, phone: args.phone })) {
    return { personId: null, isNew: false, skipped: "no-identifier" };
  }
  const personId = await ctx.db.insert("people", {
    chapterId,
    name: args.name.trim() || "Unknown",
    ...(args.email ? { email: args.email } : {}),
    ...(args.phone ? { phone: args.phone } : {}),
    isTeamMember: false,
    notes: "Added from import",
    createdAt: Date.now(),
  });
  return { personId, isNew: true };
}

/**
 * Append an import note to a person's free-text `notes` field, idempotently:
 * if this exact note is already present (a re-run of the same import file),
 * nothing is written, so re-committing never grows the field unboundedly.
 */
export async function appendPersonNote(
  ctx: MutationCtx,
  personId: Id<"people">,
  note: string,
): Promise<void> {
  const person = await ctx.db.get(personId);
  if (!person) return;
  const existing = person.notes?.trim();
  if (existing && existing.includes(note)) return;
  await ctx.db.patch(personId, { notes: existing ? `${existing}\n${note}` : note });
}

/**
 * Fill a donor's mailing `address` from an import row ONLY if the donor has
 * none yet — a matched donor's existing address is authoritative and never
 * overwritten (fill-if-blank). A no-op when the row carries no address. Shared
 * by the canonical import's gift/recurring commit and the historical backfill,
 * so both plumb address identically.
 */
export async function fillDonorAddressIfBlank(
  ctx: MutationCtx,
  donorId: Id<"donors">,
  address: CanonicalImportRow["address"],
): Promise<void> {
  if (!address) return;
  const donor = await ctx.db.get(donorId);
  if (donor && donor.address === undefined) {
    await ctx.db.patch(donorId, { address });
  }
}

async function commitGiftRow(
  ctx: MutationCtx,
  scope: GivingScope,
  row: CanonicalImportRow,
  allowSuspected: boolean,
  counters: CommitCounters,
): Promise<void> {
  if (!Number.isInteger(row.amountCents) || (row.amountCents ?? 0) <= 0) {
    counters.skippedInvalid++;
    return;
  }
  const receivedAt = row.receivedAt ?? Date.now();

  if (row.externalRef) {
    const existing = await ctx.db
      .query("gifts")
      .withIndex("by_externalRef", (q) => q.eq("externalRef", row.externalRef!))
      .first();
    if (existing) {
      counters.skippedDuplicates++;
      return;
    }
  }

  const donorId = await matchOrCreateDonor(ctx, {
    scope,
    name: row.name,
    email: row.email,
    phone: row.phone,
    kind: row.kind,
    source: "givebutter-import",
  });
  await fillDonorAddressIfBlank(ctx, donorId, row.address);

  if (!row.externalRef) {
    const history = await ctx.db
      .query("gifts")
      .withIndex("by_donor", (q) => q.eq("donorId", donorId))
      .order("desc")
      .take(GIFT_HISTORY_SCAN_LIMIT);
    const suspect = history.some(
      (g) => g.amountCents === row.amountCents && withinSuspectedWindow(g.receivedAt, receivedAt),
    );
    if (suspect && !allowSuspected) {
      counters.skippedSuspected++;
      return;
    }
  }

  await recordGiftForDonor(ctx, {
    donorId,
    amountCents: row.amountCents!,
    receivedAt,
    method: row.source ?? "givebutter",
    ...(row.externalRef ? { externalRef: row.externalRef } : {}),
    ...(row.note ? { note: row.note } : {}),
  });
  counters.gifts++;
}

async function commitRecurringRow(
  ctx: MutationCtx,
  scope: GivingScope,
  row: CanonicalImportRow,
  counters: CommitCounters,
): Promise<void> {
  if (
    !Number.isInteger(row.recurringMonthlyCents) ||
    (row.recurringMonthlyCents ?? 0) < PLEDGE_FLOOR_CENTS
  ) {
    counters.skippedInvalid++;
    return;
  }
  const donorId = await matchOrCreateDonor(ctx, {
    scope,
    name: row.name,
    email: row.email,
    phone: row.phone,
    kind: row.kind,
    source: "givebutter-import",
  });
  await fillDonorAddressIfBlank(ctx, donorId, row.address);
  if (row.externalRef) {
    const donorPledges = await ctx.db
      .query("pledges")
      .withIndex("by_donor", (q) => q.eq("donorId", donorId))
      .take(DONOR_PLEDGE_SCAN_LIMIT);
    if (donorPledges.some((p) => p.externalRef === row.externalRef)) {
      counters.skippedDuplicates++;
      return;
    }
  }
  await ctx.db.insert("pledges", {
    donorId,
    scope,
    amountCents: row.recurringMonthlyCents!,
    status: "past_due",
    origin: "imported",
    ...(row.externalRef ? { externalRef: row.externalRef } : {}),
    createdAt: Date.now(),
  });
  counters.pledges++;
}

async function commitContactRow(
  ctx: MutationCtx,
  scope: GivingScope,
  row: CanonicalImportRow,
  counters: CommitCounters,
): Promise<void> {
  if (scope === "central") {
    counters.skippedInvalid++; // no chapter roster at central — see previewContactRow
    return;
  }
  const res = await matchOrCreatePersonContact(ctx, scope, {
    name: row.name,
    email: row.email,
    phone: row.phone,
  });
  if (res.skipped) {
    counters.skippedNoIdentifier++; // owner rule — name-only, nothing created
    return;
  }
  if (res.isNew) counters.people++;
}

async function commitTicketRow(
  ctx: MutationCtx,
  scope: GivingScope,
  row: CanonicalImportRow,
  counters: CommitCounters,
): Promise<void> {
  if (scope === "central") return; // no roster/ticket history at central — pure no-op

  const res = await matchOrCreatePersonContact(ctx, scope, {
    name: row.name,
    email: row.email,
    phone: row.phone,
  });
  if (res.skipped) {
    counters.skippedNoIdentifier++; // owner rule — name-only, nothing created
    return;
  }
  const { personId, isNew } = res;
  if (isNew) counters.people++;

  if (row.eventHint && row.email) {
    const event = await findEventByHint(ctx, scope, row.eventHint);
    if (event) {
      const order = await findPaidTicketOrder(ctx, event._id, row.email);
      if (order) {
        await appendPersonNote(ctx, personId, `Ticket history matched — ${event.name} (imported)`);
        counters.ticketHistoryLinked++;
        return;
      }
    }
  }
  await appendPersonNote(
    ctx,
    personId,
    `Bought tickets — ${row.eventHint ?? "unknown event"} (imported)`,
  );
}

/**
 * Commit one batch (≤ `IMPORT_BATCH_SIZE`) of canonical rows, self-scheduling
 * the remainder as `importCanonicalRest` — the house pattern
 * `givingPlatform.ts#importRows` established. Shared by the public
 * `importCanonical` (gated) and the internal continuation.
 */
async function importCanonicalBatch(
  ctx: MutationCtx,
  scope: GivingScope,
  rows: CanonicalImportRow[],
  allowSuspected: boolean,
): Promise<Infer<typeof commitResultValidator>> {
  const slice = rows.slice(0, IMPORT_BATCH_SIZE);
  const counters: CommitCounters = {
    gifts: 0,
    pledges: 0,
    people: 0,
    skippedDuplicates: 0,
    skippedSuspected: 0,
    skippedInvalid: 0,
    skippedNoIdentifier: 0,
    ticketHistoryLinked: 0,
  };

  for (const row of slice) {
    if (row.rowType === "gift") {
      await commitGiftRow(ctx, scope, row, allowSuspected, counters);
    } else if (row.rowType === "recurring") {
      await commitRecurringRow(ctx, scope, row, counters);
    } else if (row.rowType === "contact") {
      await commitContactRow(ctx, scope, row, counters);
    } else {
      await commitTicketRow(ctx, scope, row, counters);
    }
  }

  const remaining = rows.slice(IMPORT_BATCH_SIZE);
  if (remaining.length > 0) {
    await ctx.scheduler.runAfter(0, internal.givingImport.importCanonicalRest, {
      scope,
      rows: remaining,
      allowSuspected,
    });
  }

  return {
    imported: { gifts: counters.gifts, pledges: counters.pledges, people: counters.people },
    skippedDuplicates: counters.skippedDuplicates,
    skippedSuspected: counters.skippedSuspected,
    skippedInvalid: counters.skippedInvalid,
    skippedNoIdentifier: counters.skippedNoIdentifier,
    ticketHistoryLinked: counters.ticketHistoryLinked,
    scheduledRemaining: remaining.length,
  };
}

/**
 * Commit a batch of canonical import rows (≤ `MAX_IMPORT_ROWS` — the client
 * pages a larger file into multiple calls). Manage-gated. Idempotent on
 * re-run: `externalRef` dedup (gifts: global; pledges: per-donor), the
 * suspected-duplicate skip, and donor/people match-or-create together mean a
 * second commit of the same rows imports nothing new. Returns only THIS
 * batch's counts (mirrors the legacy importer's own return shape) — the
 * remainder, if any, continues via `importCanonicalRest`.
 */
export const importCanonical = mutation({
  args: {
    scope: scopeValidator,
    rows: v.array(canonicalImportRowValidator),
    allowSuspected: v.optional(v.boolean()),
  },
  returns: commitResultValidator,
  handler: async (ctx, { scope, rows, allowSuspected }) => {
    const typedScope = scope as GivingScope;
    await requireGivingManage(ctx, typedScope);
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: `At most ${MAX_IMPORT_ROWS} rows per call.`,
      });
    }
    return await importCanonicalBatch(ctx, typedScope, rows, allowSuspected ?? false);
  },
});

/** Internal continuation of `importCanonical` (already gated when scheduled). */
export const importCanonicalRest = internalMutation({
  args: {
    scope: scopeValidator,
    rows: v.array(canonicalImportRowValidator),
    allowSuspected: v.boolean(),
  },
  handler: async (ctx, { scope, rows, allowSuspected }) => {
    await importCanonicalBatch(ctx, scope as GivingScope, rows, allowSuspected);
    return null;
  },
});
