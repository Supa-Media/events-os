import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  AMENDMENT_REASONS,
  CENTRAL,
  DOCUMENTATION_STATES,
  EXPENSE_TYPES,
  INCOME_STREAMS,
  PUBLICATION_STATUSES,
} from "@events-os/shared";

/**
 * The public ledger — publishing a month's books, and being held to them.
 *
 * See `@events-os/shared/publicLedger` for the vocabulary and the reasoning
 * behind the lifecycle. The short version, because it governs every table
 * below: THE PUBLIC PAGE DOES NOT READ THE LIVE BOOKS. A period is frozen
 * when it is published, and the frozen copy is what the world sees. A
 * correction is a new, dated, attributed revision published beside the old
 * one — never a silent edit to what was already said.
 *
 * Three tables, one job each:
 *
 *   `financePublications`         one row per (book, month). The lifecycle,
 *                                 and the pointer to what's currently live.
 *   `financePublicationRevisions` APPEND-ONLY. One row per published
 *                                 revision: the frozen totals + who published
 *                                 it and why.
 *   `financePublicationEntries`   APPEND-ONLY. One row per published LINE per
 *                                 revision: the frozen ledger itself.
 *
 * ── WHY THE ENTRIES STORE RENDERED TEXT, NOT IDS ─────────────────────────────
 * A published entry carries `categoryLabel: "Sundays & Worship"`, not
 * `categoryId`. Renaming a budget category next year must not retroactively
 * rewrite a statement the org already published and stood behind — and an id
 * would do exactly that, invisibly, on the next page load. Freezing the text
 * is not denormalization for speed (though it also means the public read
 * needs zero joins); it is the difference between a record and a view.
 *
 * The one id kept on a ledger entry is `sourceTransactionId`, and it exists
 * for the INTERNAL console ("this published row looks wrong — take me to it").
 * `publicLedger.ts`'s public projector drops it; nothing anonymous ever sees
 * it. Gift entries carry no source id at all — see that table's doc.
 *
 * ── WHY REVISIONS DUPLICATE THEIR ENTRIES ────────────────────────────────────
 * Republishing a month writes a fresh full set of entry rows rather than
 * diffing against the last one. Storage is cheap at this volume (a month is
 * hundreds of rows, capped at `MAX_PUBLISHED_ENTRIES`), and the property
 * bought is the one that matters: "what exactly did revision 1 say?" is
 * answerable forever by reading revision 1, with no replay of diffs and no
 * way for a reconstruction bug to quietly change history.
 */

const scopeValidator = v.union(v.id("chapters"), v.literal(CENTRAL));
const affiliationMix = v.record(v.string(), v.number());

// ── Publications: one per (book, month) ──────────────────────────────────────
/**
 * A book's statement for one month, and where it sits.
 *
 * `status` describes the WORKING copy; `liveRevision` describes what the
 * public can see. They are genuinely independent — an `amending` publication
 * is publicly visible at its last approved revision while a correction is
 * being prepared — which is why neither can be derived from the other.
 */
export const financePublications = defineTable({
  // The book this statement covers: a real chapter, or `"central"`. Publishing
  // is per-book because the books are separate operating entities; the public
  // page sums the published ones for a month and says which they were.
  scope: scopeValidator,
  // `YYYY-MM` in America/New_York (`periodKey`). A string rather than a
  // (year, month) pair because it is simultaneously the URL segment, the sort
  // key, and the dedup key — see the shared module's note.
  periodKey: v.string(),

  status: v.union(...PUBLICATION_STATUSES.map((s) => v.literal(s))),

  /** The revision the PUBLIC currently sees. Absent = never published, and
   *  the public page has nothing for this book/month at all. Bumped only by
   *  `publish`, and never decremented — unpublishing is deliberately not a
   *  feature (see `publicLedger.ts`). */
  liveRevision: v.optional(v.number()),
  /** DENORMALIZED `liveRevision != null`, single-writer (`publicLedger.ts`),
   *  existing solely so the anonymous "which months are public?" read is an
   *  index lookup instead of a scan-and-filter over every publication ever
   *  drafted. The same rendering-hint discipline as
   *  `transactions.merchantNameRenamedAt`. */
  isLive: v.boolean(),

  // ── The working copy ──────────────────────────────────────────────────────
  /** When the working snapshot was last rebuilt from the live books, and by
   *  whom. A submission carries this forward so a reviewer can see how stale
   *  the numbers they're approving are. */
  builtAt: v.optional(v.number()),
  builtByPersonId: v.optional(v.id("people")),
  submittedAt: v.optional(v.number()),
  submittedByPersonId: v.optional(v.id("people")),
  /** The reviewer's send-back note while `changes_requested`. Cleared on the
   *  preparer's next submission — the round-by-round history lives in
   *  `financeAuditLog`, matching `transactionCodings.reviewNote`. */
  reviewNote: v.optional(v.string()),

  /** Why the in-flight revision is being made, and the explanation that will
   *  publish with it. Set when an amendment is STARTED, copied onto the
   *  revision row at publish, and cleared afterwards. Absent while the first
   *  revision is being prepared (nothing has been corrected yet). */
  amendmentReason: v.optional(
    v.union(...AMENDMENT_REASONS.map((r) => v.literal(r))),
  ),
  amendmentNote: v.optional(v.string()),

  publishedAt: v.optional(v.number()),
  publishedByPersonId: v.optional(v.id("people")),

  /** ── DRIFT SINCE PUBLISH ───────────────────────────────────────────────
   *  When the live books first changed underneath an already-published month,
   *  and in one sentence what changed. Absent = the published statement still
   *  matches the books as far as anything has told us.
   *
   *  Founder, 2026-08-14, on settling a personal charge: "it should probably
   *  trigger — or it should ask to republish, you know, the public ledgers and
   *  statements and stuff like that if they're already published."
   *
   *  Deliberately a POSITIVE MARK stamped by the write that caused the drift
   *  (`lib/publicLedgerStale.ts`), never a comparison of the stored snapshot
   *  against a freshly-built one. A recompute-to-detect design would be a full
   *  snapshot build per console load, and — worse — would quietly redefine
   *  "stale" every time the builder changed. This says only what somebody
   *  actually did.
   *
   *  It is a PROMPT, never an action: republishing changes a public statement
   *  and stays a human decision with a human's sentence attached (see
   *  `publicLedger.republish`). `staleSince` keeps the FIRST drift's timestamp
   *  so the console can say how long the public page has been behind, while
   *  `staleReason` names the MOST RECENT cause — the one a publisher is most
   *  likely to recognize. Both clear on the next publish.
   */
  staleSince: v.optional(v.number()),
  staleReason: v.optional(v.string()),

  createdAt: v.number(),
  updatedAt: v.number(),
})
  // The uniqueness key. One publication per book per month — enforced in
  // `lib/publicLedgerPublish.ts#ensurePublication`, which is the only writer.
  .index("by_scope_and_period", ["scope", "periodKey"])
  // Every book's statement for one month — the public page's per-month read.
  .index("by_period", ["periodKey"])
  // "Which months are public?", answered without reading drafts. `periodKey`
  // sorts lexicographically, which for `YYYY-MM` is chronologically.
  .index("by_live_and_period", ["isLive", "periodKey"])
  // The internal console's queue: everything awaiting review on one book.
  .index("by_scope_and_status", ["scope", "status"]);

// ── Revisions: append-only, one per publication event ────────────────────────
/**
 * What was published, when, by whom, and — from revision 2 on — why it
 * changed. NEVER updated or deleted once written, including when the parent
 * publication is amended again: the previous revision staying readable beside
 * the new one is the entire mechanism by which a correction is a correction
 * rather than a rewrite.
 *
 * Holds only AGGREGATES; the lines live in `financePublicationEntries`. That
 * split is what lets the public page render a month's headline figures
 * without loading a thousand rows, and it is why the aggregates are stored
 * rather than summed on read — a stored total and a re-summed total can
 * disagree, and the stored one is the one that was approved.
 */
export const financePublicationRevisions = defineTable({
  publicationId: v.id("financePublications"),
  /** 1-based. Revision 1 is the original publication; ≥2 is an amendment. */
  revision: v.number(),
  // Denormalized from the parent so a public read can go straight from a
  // (book, month) to its revisions without a second lookup.
  scope: scopeValidator,
  periodKey: v.string(),

  // ── Frozen totals ─────────────────────────────────────────────────────────
  /** Everything that came in, by the book-value revenue model (gifts, ticket
   *  orders, in-person sales, project registrations, plus ledger inflows that
   *  are not the bank arrival of any of those). */
  incomeCents: v.number(),
  /** Everything that went out, from the ledger. Non-negative — direction is
   *  carried by the field name, matching the money invariant. */
  expenseCents: v.number(),
  /** `incomeCents - expenseCents`. Stored rather than derived so a display
   *  bug can never make a published statement not add up. */
  netCents: v.number(),

  incomeByStream: v.array(
    v.object({
      stream: v.union(...INCOME_STREAMS.map((s) => v.literal(s))),
      cents: v.number(),
      count: v.number(),
    }),
  ),
  /** Spend grouped by the org's own budget-category chart, as LABELS frozen
   *  at publish time. `label` is `"Uncategorized"` for rows that carried no
   *  category — named plainly rather than hidden, because a transparency page
   *  that quietly drops what it can't classify is the wrong kind of tidy. */
  expenseByCategory: v.array(
    v.object({ label: v.string(), cents: v.number(), count: v.number() }),
  ),
  /** The same spend grouped by what it was FOR — the project or event it
   *  attached to. The owner's ask ("we have the different project budgets"):
   *  a giver wants to follow their money to a thing, not to an account code. */
  expenseByProject: v.array(
    v.object({ label: v.string(), cents: v.number(), count: v.number() }),
  ),

  entryCount: v.number(),
  giftCount: v.number(),

  /**
   * How many DISTINCT PEOPLE gave in this month, and how many of them gave
   * through a recurring pledge.
   *
   * A count, never a list — see `financePublicationGiverKeys` for where the
   * identities live and why they live somewhere else. `giftCount` above is a
   * different question (one person giving weekly is four gifts and one
   * giver), and a transparency page that showed only the larger of the two
   * would be flattering itself.
   *
   * OPTIONAL because a revision published before this shipped has neither;
   * every reader treats absent as 0 and the page omits the tile rather than
   * printing a zero it can't stand behind. Same grandfathering posture as
   * `budgets.approvalStatus`.
   */
  giverCount: v.optional(v.number()),
  backerCount: v.optional(v.number()),

  /**
   * SPEND AGAINST THE PLAN — what each budget was allowed and what it
   * actually used, frozen as labels.
   *
   * The one place this page shows ESTIMATED money beside ACTUAL money. The
   * schema-wide rule is that the two are never SUMMED (invariant #3 in
   * `schema/finances.ts`), and they are not summed here — they sit in two
   * columns of one row, which is the entire question a reader is asking
   * ("you said $2,000; what did you spend?").
   *
   * `allocatedCents` is `effectiveBudgetCapCents` at publish time — the cap
   * actually in force, not `amountCents`, so a budget mid-increase shows what
   * it was approved to spend rather than what someone has asked for. Absent
   * on the catch-all row for spend that carried no budget at all, which is
   * NOT the same as a budget of zero and must not render as one.
   */
  spendByBudget: v.optional(
    v.array(
      v.object({
        label: v.string(),
        allocatedCents: v.optional(v.number()),
        spentCents: v.number(),
        count: v.number(),
      }),
    ),
  ),

  // ── Disclosures published WITH the numbers ────────────────────────────────
  // Not caveats hidden in a footnote: these travel with the statement because
  // a ledger that presents reconstructed history and live-captured history as
  // the same claim is overclaiming, and overclaiming reads as less credible,
  // not more (the argument `publishability.ts` already makes).
  /** Rows rebuilt from spreadsheets rather than observed as they happened
   *  (`isReconstructedHistory`). Inside the totals, never invisible. */
  reconstructedCount: v.number(),
  reconstructedCents: v.number(),
  /** Rows published with neither a receipt nor an approved exception. */
  undocumentedCount: v.number(),
  undocumentedCents: v.number(),
  /** Spend published without an approved coding — i.e. without the written
   *  "what was this and why". Distinct from undocumented: a row can have the
   *  receipt and no explanation, or the explanation and no receipt. */
  uncodedCount: v.number(),
  uncodedCents: v.number(),
  /** Lines that publish with NO explanation at all — what a reader sees, as
   *  opposed to `uncodedCount` above, which is what our policy required. The
   *  two are wildly different on pre-policy history, where every row is
   *  grandfathered (uncoded 0) and unexplained (this, large). OPTIONAL for
   *  revisions published before the distinction existed. */
  unexplainedCount: v.optional(v.number()),
  unexplainedCents: v.optional(v.number()),

  /** A source scan hit `ROLLUP_SCAN_LIMIT` while this revision was built, so
   *  its figures may be incomplete. `publish` REFUSES to publish a truncated
   *  snapshot; the flag is stored anyway so a revision can never be read
   *  without knowing, and so the console can explain the refusal. */
  truncated: v.boolean(),

  // ── Provenance ────────────────────────────────────────────────────────────
  /** Absent on revision 1 (nothing was corrected). Required from 2 on. */
  amendmentReason: v.optional(
    v.union(...AMENDMENT_REASONS.map((r) => v.literal(r))),
  ),
  /** The public explanation of what changed. Required from revision 2 on
   *  (`MIN_AMENDMENT_NOTE_LENGTH`) — this is the sentence the amendment log
   *  prints, and a log of "fixed" explains nothing. */
  note: v.optional(v.string()),

  preparedByPersonId: v.optional(v.id("people")),
  preparedAt: v.optional(v.number()),
  publishedByPersonId: v.optional(v.id("people")),
  publishedAt: v.number(),
  /** Whether the publisher was a different person from the preparer.
   *  `"single"` records a superuser self-publish (the same temporary
   *  solo-operator relaxation `budgets.approvalParty` documents), `"two_party"`
   *  a normal separated decision. A durable, re-reviewable record for when the
   *  org grows past one person. */
  approvalParty: v.union(v.literal("single"), v.literal("two_party")),
})
  .index("by_publication", ["publicationId", "revision"])
  .index("by_scope_and_period", ["scope", "periodKey"]);

// ── Entries: append-only, the frozen lines ───────────────────────────────────
/**
 * ONE published line, frozen. Two kinds share the table because they share a
 * lifecycle (both are frozen at publish, both are dropped from no revision
 * ever) and because the public page renders them as two tabs of one
 * statement:
 *
 *  - `"ledger"` — a transaction. What the org spent or received, with the
 *    substantiation that was approved for publication.
 *  - `"gift"`   — an ANONYMOUS entry in the giving roll. The owner's ask: a
 *    giver should be able to find the minute they gave in the public record
 *    and see it counted, without any giver being named.
 *
 * ── WHAT A GIFT ENTRY DELIBERATELY DOES NOT CARRY ────────────────────────────
 * No donor id, no gift id, no name, no email, no external reference. Not
 * "omitted from the public projection" — genuinely NOT WRITTEN. A row in a
 * table that an anonymous HTTP route reads should not contain a field whose
 * safety depends on every present and future query remembering to drop it.
 * The audit trail from a published gift figure back to its donors runs
 * through `gifts` by date and scope, which is a private query.
 *
 * ── WHAT A LEDGER ENTRY DELIBERATELY DOES NOT CARRY ──────────────────────────
 * Attendee and traveler NAMES, ever (owner decision 2026-08-08 — members and
 * guests did not consent to a public financial record, and some are minors).
 * `headcount` + `affiliationMix` publish instead: "12 people — 5 team members,
 * 7 community members" answers "who was this for?" without publishing a
 * person. `purpose` is the APPROVER-facing `publicPurpose ?? businessPurpose`
 * resolution, already made by the time a row reaches here.
 */
export const financePublicationEntries = defineTable({
  publicationId: v.id("financePublications"),
  revision: v.number(),
  // Denormalized for the public read (see the module doc).
  scope: scopeValidator,
  periodKey: v.string(),

  kind: v.union(v.literal("ledger"), v.literal("gift")),

  /** When it happened, in ms. `postedAt` for a transaction, `receivedAt` for
   *  a gift. */
  occurredAt: v.number(),
  /** Non-negative integer cents — the money invariant holds here too. */
  amountCents: v.number(),
  /** Which way the money moved. `"out"` never appears on a gift entry.
   *
   *  `"internal"` is the third value and it earns its place: money moving
   *  between two accounts the org already owns, and the bank arrival of
   *  revenue that was already counted when the gift or ticket was received,
   *  are neither income nor spending. Forcing them into `in`/`out` would
   *  either double-count the org's revenue or hide real rows from the ledger.
   *  They publish, marked, and count toward nothing — see `countsInTotals`. */
  direction: v.union(v.literal("in"), v.literal("out"), v.literal("internal")),
  /**
   * Whether this line contributed to the revision's published totals.
   *
   * The owner's ask was "literally all the transactions," and a page that
   * quietly drops the rows it can't add up is not that. So every non-excluded
   * transaction publishes — and the ones that must not be summed (internal
   * transfers, processor payout deposits) say so on their own row instead of
   * being omitted. `sum(amountCents where countsInTotals and direction="out")`
   * equals the revision's `expenseCents`, exactly, and a reader can verify it
   * from the CSV.
   */
  countsInTotals: v.boolean(),
  /** The book's display name, frozen ("New York", "Central"). A chapter that
   *  is renamed or deactivated later must not change what a published
   *  statement says it was. */
  bookLabel: v.string(),

  // ── Ledger-only ───────────────────────────────────────────────────────────
  /** Who was paid, or who the money came from — `displayMerchantName`'s
   *  resolution frozen at publish. */
  counterparty: v.optional(v.string()),
  /** `publicPurpose ?? businessPurpose`. Absent when the row carried no
   *  approved coding, which the page renders as an explicit gap rather than
   *  as blank space. */
  purpose: v.optional(v.string()),
  categoryLabel: v.optional(v.string()),
  fundLabel: v.optional(v.string()),
  budgetLabel: v.optional(v.string()),
  projectLabel: v.optional(v.string()),
  eventLabel: v.optional(v.string()),
  expenseType: v.optional(v.union(...EXPENSE_TYPES.map((t) => v.literal(t)))),
  travelFrom: v.optional(v.string()),
  travelTo: v.optional(v.string()),
  headcount: v.optional(v.number()),
  /** `{team: 5, community_member: 7}` — counts only. Keys are
   *  `ATTENDEE_AFFILIATIONS`; the validator is a loose record because a
   *  frozen row must keep validating if that tuple is ever edited, exactly
   *  like `processorFeeEntries.type` refuses to be a union. */
  affiliationMix: v.optional(affiliationMix),
  /** How a group too large to enumerate was described ("the Sunday setup
   *  team"). Above `mealAttendeeNamesMaxHeadcount`, this is what exists
   *  instead of attendees. */
  groupDescription: v.optional(v.string()),
  documentation: v.optional(
    v.union(...DOCUMENTATION_STATES.map((d) => v.literal(d))),
  ),
  /** WHY THIS ROW OWED NO DOCUMENT, when it owed none — a processor fee, a
   *  payout, an internal transfer, a payer's fee coverage, a personal charge,
   *  or a deposit already recorded as giving.
   *
   *  A LOOSE STRING, not a union, for the same reason `documentation` above is
   *  a union of a frozen tuple but `method` is not: a published revision is
   *  immutable evidence and must keep validating years later, so a key retired
   *  from `DOCUMENTATION_EXEMPTIONS` cannot be allowed to invalidate the
   *  months that were published while it existed. The page resolves the label
   *  through the shared list and falls back to printing nothing for a key it
   *  no longer knows. */
  documentationExempt: v.optional(v.string()),
  /** Rebuilt from a spreadsheet rather than watched as it happened. */
  reconstructed: v.optional(v.boolean()),
  /** A processor/bank fee that was charged, not chosen (`feeOrigin`). Flagged
   *  because a reader is entitled to know which outflows the org had no say
   *  in — they are real spend, and they are not decisions. */
  nonDiscretionaryFee: v.optional(v.boolean()),
  /** INTERNAL ONLY — the console's "take me to this row" link. Never returned
   *  by any public query; see the module doc. */
  sourceTransactionId: v.optional(v.id("transactions")),

  // ── Gift-only ─────────────────────────────────────────────────────────────
  /** `GIFT_METHODS` as a frozen label ("Card", "In-kind"). A string, not a
   *  union, for the same freeze-must-keep-validating reason as
   *  `affiliationMix`. */
  method: v.optional(v.string()),
  /** What the gift was toward, when it was toward something in particular. */
  designation: v.optional(v.string()),
})
  // The public read: one revision's lines, in time order, paginated.
  .index("by_revision", ["publicationId", "revision", "occurredAt"])
  // The kind-filtered read (the ledger tab vs the giving roll tab).
  .index("by_revision_and_kind", ["publicationId", "revision", "kind"]);

// ── Giver keys: INTERNAL ONLY, never served ──────────────────────────────────
/**
 * ⚠ THIS TABLE IS NEVER RETURNED BY ANY PUBLIC QUERY, IN WHOLE OR IN PART. ⚠
 *
 * One row per (revision, distinct giver). It exists for exactly one reason:
 * so a YEAR can report how many distinct people gave, rather than adding up
 * twelve monthly giver counts and reporting a person who gave every month as
 * twelve people.
 *
 * ── WHY A TABLE AND NOT A NUMBER ─────────────────────────────────────────────
 * `financePublicationRevisions.giverCount` already answers the question for
 * ONE month. Distinct counts do not add: unioning is the only correct way to
 * roll them up, and unioning needs identities. So the identities are stored —
 * frozen at publish time alongside everything else, so a year total is as
 * stable as the months under it — and only ever counted.
 *
 * ── WHY IT IS SEPARATE FROM `financePublicationEntries` ──────────────────────
 * Because that table IS served to anonymous callers, and this data must never
 * be one forgotten projection away from going out. `financePublicationEntries`
 * carries `sourceTransactionId` under exactly that discipline and it is a
 * transaction id — this is a person. The rule the giving roll follows (see
 * that table's doc: a donor field is never WRITTEN, not merely omitted) can't
 * apply here because the identity is the point, so the next-best structural
 * protection is used instead: a different table, in no public query's reach.
 *
 * `key` is the `donorIdentities` id where the donor has one, else the
 * `donors` id — the same grouping rule `listOrgDonorsByIdentity` uses, so one
 * human giving to two books counts once. A plain string rather than a union
 * of two id types because it is only ever compared for equality and counted;
 * nothing dereferences it, and nothing should start.
 */
export const financePublicationGiverKeys = defineTable({
  publicationId: v.id("financePublications"),
  revision: v.number(),
  /** The `YYYY` of the parent period, denormalized so a year rollup can find
   *  every relevant row without first loading twelve publications. */
  year: v.string(),
  key: v.string(),
  /** Whether this person gave through a recurring pledge in the period —
   *  what the public "backers" figure counts. */
  isBacker: v.boolean(),
})
  .index("by_revision", ["publicationId", "revision"])
  .index("by_year", ["year"]);

// ── Preview tokens: short-lived, single-scope+period, console-only ───────────
/**
 * Lets the publish console show EXACTLY what publishing right now would
 * produce — the full public page, built from the LIVE books — before a human
 * commits to freezing it.
 *
 * Modelled on `eventPages.previewToken` (the RSVP admin draft-preview token,
 * `ticketing.ts#ensurePreviewToken`), with one deliberate difference: an RSVP
 * token is a permanent secret stamped once on the page and reused forever. A
 * finance preview token is minted fresh on every tap of "Preview the page"
 * (`publicLedger.ts#mintLedgerPreviewToken`), so there is no reuse to
 * protect, and `expiresAt` (~1 hour, `LEDGER_PREVIEW_TOKEN_TTL_MS`) shrinks
 * what a copied/forwarded preview link is worth.
 *
 * `requireLedgerConsole` gates minting — nothing here is reachable without
 * console access to the book being previewed. The row carries no draft data
 * itself, only the coordinates (`scope`, `periodKey`) the HTTP route needs to
 * rebuild the SAME live snapshot `buildSnapshot` would freeze at publish
 * time. Resolving one never touches `financePublicationEntries` — a preview
 * is read-only and writes nothing, anywhere.
 *
 * An expired row is left in place rather than swept — the route treats
 * "expired" and "never existed" identically (404, no information leak about
 * which), so there is nothing an eager cleanup would buy, and the table is
 * as cheap to leave as `eventPages.previewToken` already is.
 */
export const financePublicationPreviewTokens = defineTable({
  /** Crypto-random, unguessable (`newGuestToken`, `ticketing.ts`). The only
   *  thing the HTTP route looks up by — see `by_token`. */
  token: v.string(),
  scope: scopeValidator,
  periodKey: v.string(),
  expiresAt: v.number(),
  createdAt: v.number(),
  createdByPersonId: v.optional(v.id("people")),
}).index("by_token", ["token"]);
