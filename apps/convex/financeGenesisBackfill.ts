/**
 * Finance genesis backfill — a ONE-TIME, ops-dispatch-only module that loads the
 * org's full financial history "from the genesis of things" into the native
 * finance layer (`transactions`), where the reconcile grid + dashboards read
 * from. Internal only: the orchestrator invokes it via the run-convex-function
 * workflow AFTER the owner reviews a dry run; nothing here is on the public API,
 * nothing runs on a cron, and there is no UI.
 *
 * DRY-RUN BY DEFAULT (`execute` omitted / false = a full simulation that writes
 * NOTHING and returns exactly the counts a real run would produce). Pass
 * `execute: true` to commit. Idempotent: a second execute run inserts nothing.
 *
 * TWO DATASETS, both embedded under `lib/seed/historical/`:
 *
 *  1. GENESIS BANK HISTORY (`GENESIS_BANK_ROWS`, 213 rows) — Kansi's complete,
 *     hand-categorized Relay bank export (Jun 2025 → Jun 2026). Each row lands
 *     as a `transactions` row on the NY chapter with:
 *       - `source: "relay_csv"` — the EXISTING transaction source literally
 *         meaning "imported from a Relay monthly-statement CSV (full history)"
 *         (see `TRANSACTION_SOURCES`). This is the distinguishable import marker
 *         the task asks for — no new source value invented. `txnMatchesMode`
 *         returns `true` for every non-Increase source, so these always show in
 *         the reconcile grid regardless of sandbox mode.
 *       - `flow` derived from the sign (deposit → `inflow`, withdrawal →
 *         `outflow`); `amountCents` stored NON-NEGATIVE (the house invariant —
 *         direction rides on `flow`, never a sign).
 *       - `status: "unreviewed"` — they land in the reconcile inbox for the
 *         owner to categorize against real budgets/funds in-app. The backfill
 *         does NOT assign a `categoryId`/`budgetId`: the app's `budgetCategories`
 *         is a structured, fund-nested, approval-gated taxonomy, and inventing a
 *         parallel one from Kansi's 16 free-form labels is exactly what the task
 *         forbids. Kansi's category is carried VERBATIM in the txn `note`
 *         instead (the bookkeeper's "who/why" field), so no context is lost.
 *       - `externalId: "genesis-bank:<index>"` — the idempotent self-dedup key
 *         (via `by_external_id`), so a re-run skips every row it already wrote.
 *
 *  2. OWNER-PAID LTN EXPENSES (`GENESIS_LTN_ROWS`, 3 rows) — three personal
 *     Zelle payments the owner made on the org's behalf for Love Thy Neighbor
 *     2025. They never touched the org bank, so they aren't in dataset 1, but
 *     they are real org expenses. Represented as `transactions` OUTFLOWS with
 *     `source: "manual"` (honest — hand-entered, not from the Relay feed) and a
 *     `note` carrying "paid personally by owner (Zelle conf …)". They are NOT
 *     modeled as `reimbursementRequests`/`personalRepayments`: those shapes mean
 *     "the org owes/pays a person back", but the owner is NOT being reimbursed —
 *     the giving side records these as in-kind gifts, so the org's side is only
 *     ever the expense leg. `externalId: "genesis-ltn:<conf>"` (the unique Zelle
 *     confirmation code) is the idempotency key.
 *
 * DEDUP — avoiding double-representation with a LIVE bank feed. If the
 * Relay/Increase feed is already ingesting into `transactions`, some of the 213
 * bank rows may already exist (Kansi's export has no bank transaction ids to
 * match on). So beyond the `externalId` self-dedup, each bank row also matches
 * against the chapter's EXISTING non-genesis transactions by (same `flow`, exact
 * `amountCents`, `postedAt` within ±2 days); a hit is skipped and counted
 * `alreadyPresent`. A matched real txn is CONSUMED (one-to-one), so two genuinely
 * distinct same-amount/same-day charges don't both collapse onto a single real
 * row. The LTN rows dedup by `externalId` ONLY (no date/amount heuristic) — they
 * are known-absent from the bank feed, so the heuristic could only ever produce
 * a false skip and wrongly drop a real expense.
 *
 * SCOPE — all of this is the org's NY-era operations, so every row is attributed
 * to the NY chapter (resolved by `NEW_YORK_CHAPTER_SLUG`), consistent with the
 * historical giving/attendance backfill and with what the chapter reconcile grid
 * (`finances.listReconcile`, `by_chapter_and_postedAt`) reads. Not `"central"`.
 *
 * BATCHING — 213 + 3 rows is one comfortable transaction (well under Convex's
 * per-transaction read/write budget; the existing giving backfill does 252 gifts
 * in one call). The existing-txn dedup read is bounded by `GENESIS_SCAN_LIMIT`.
 */
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { NEW_YORK_CHAPTER_SLUG } from "./lib/seed/historical/mapping";
import { GENESIS_BANK_ROWS } from "./lib/seed/historical/genesisBank";
import { GENESIS_LTN_ROWS } from "./lib/seed/historical/genesisLtn";
import type {
  GenesisBankRow,
  GenesisLtnRow,
} from "./lib/seed/historical/types";

// ── Constants ────────────────────────────────────────────────────────────────

/** Bounded scan of the chapter's existing transactions for the cross-source
 *  dedup pass — same ceiling the reconcile grid (`ROLLUP_SCAN_LIMIT`) uses. A
 *  chapter with more than this many txns would truncate the dedup candidate set;
 *  fine for the young NY chapter, and noted in the PR. */
const GENESIS_SCAN_LIMIT = 5000;

/** Cross-source dedup date window: a Relay-feed txn and Kansi's hand-dated row
 *  for the SAME movement can differ by a day or two (auth vs. post, timezone),
 *  so match within ±2 calendar days. */
const DEDUP_DATE_TOLERANCE_MS = 2 * 24 * 60 * 60 * 1000;

/** `externalId` prefixes — the idempotent self-dedup keys, and the marker that
 *  excludes our own prior inserts from the cross-source dedup candidate set. */
const BANK_REF_PREFIX = "genesis-bank:";
const LTN_REF_PREFIX = "genesis-ltn:";

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

// ── Date parsing ─────────────────────────────────────────────────────────────

/**
 * Parse a "Jun 9, 2025"-style date to a UTC-midnight epoch ms. Deterministic
 * (never touches the host timezone the way `Date.parse` of a bare date would),
 * so the same row always maps to the same `postedAt` — which the ±2d dedup
 * window depends on. Throws for an unparseable string (surfaces as a row
 * `invalid`, never a silent wrong date).
 */
export function parseGenesisDate(input: string): number {
  const m = input.trim().match(/^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s+(\d{4})$/);
  if (!m) throw new Error(`Unparseable genesis date: "${input}"`);
  const monthIdx = MONTHS[m[1].slice(0, 3)];
  if (monthIdx === undefined) throw new Error(`Unknown month in date: "${input}"`);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (day < 1 || day > 31) throw new Error(`Out-of-range day in date: "${input}"`);
  return Date.UTC(year, monthIdx, day);
}

// ── Counts ───────────────────────────────────────────────────────────────────

const datasetCountsValidator = v.object({
  inserted: v.number(),
  alreadyPresent: v.number(),
  invalid: v.number(),
  netCents: v.number(),
});
type DatasetCounts = {
  inserted: number;
  alreadyPresent: number;
  invalid: number;
  netCents: number;
};
const zeroCounts = (): DatasetCounts => ({
  inserted: 0,
  alreadyPresent: 0,
  invalid: 0,
  netCents: 0,
});

/** A consumable cross-source dedup candidate: a real (non-genesis) chapter txn
 *  the backfill might already be a duplicate of. `used` flips once a genesis row
 *  claims it, so a second identical row can't collapse onto the same real txn. */
type DedupCandidate = {
  flow: "inflow" | "outflow" | "transfer";
  amountCents: number;
  postedAt: number;
  used: boolean;
};

/** Find (and consume) an existing real txn this row duplicates, by flow + exact
 *  amount + date within ±2d. Returns true iff one was found. */
function claimExisting(
  candidates: DedupCandidate[],
  flow: "inflow" | "outflow",
  amountCents: number,
  postedAt: number,
): boolean {
  for (const c of candidates) {
    if (c.used) continue;
    if (c.flow !== flow) continue;
    if (c.amountCents !== amountCents) continue;
    if (Math.abs(c.postedAt - postedAt) > DEDUP_DATE_TOLERANCE_MS) continue;
    c.used = true;
    return true;
  }
  return false;
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function resolveNyChapter(ctx: MutationCtx): Promise<Doc<"chapters">> {
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
 * Load the chapter's existing transactions once (bounded), returning:
 *  - `externalIds`: every present `externalId` (self-dedup / idempotency), and
 *  - `candidates`: the NON-genesis txns as consumable cross-source dedup rows
 *    (our own prior inserts, prefixed `genesis-`, are excluded so a re-run
 *    dedups on `externalId` alone and never mistakes itself for the live feed).
 */
async function loadExisting(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
): Promise<{ externalIds: Set<string>; candidates: DedupCandidate[] }> {
  const rows = await ctx.db
    .query("transactions")
    .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", chapterId))
    .order("desc")
    .take(GENESIS_SCAN_LIMIT);
  const externalIds = new Set<string>();
  const candidates: DedupCandidate[] = [];
  for (const tr of rows) {
    if (tr.externalId) externalIds.add(tr.externalId);
    const isGenesis =
      tr.externalId?.startsWith(BANK_REF_PREFIX) ||
      tr.externalId?.startsWith(LTN_REF_PREFIX);
    if (isGenesis) continue;
    if (tr.flow === "transfer") continue; // transfers aren't category spend/income
    candidates.push({
      flow: tr.flow,
      amountCents: tr.amountCents,
      postedAt: tr.postedAt,
      used: false,
    });
  }
  return { externalIds, candidates };
}

async function applyBankRow(
  ctx: MutationCtx,
  opts: {
    write: boolean;
    chapterId: Id<"chapters">;
    externalIds: Set<string>;
    candidates: DedupCandidate[];
  },
  row: GenesisBankRow,
  index: number,
  counts: DatasetCounts,
): Promise<void> {
  // Validate: a non-zero integer signed amount + a parseable date.
  if (!Number.isInteger(row.amountCents) || row.amountCents === 0) {
    counts.invalid++;
    return;
  }
  let postedAt: number;
  try {
    postedAt = parseGenesisDate(row.date);
  } catch {
    counts.invalid++;
    return;
  }
  const flow: "inflow" | "outflow" = row.amountCents > 0 ? "inflow" : "outflow";
  const amountCents = Math.abs(row.amountCents);
  const externalId = `${BANK_REF_PREFIX}${index}`;

  // Self-dedup (idempotent re-run), then cross-source dedup vs. the live feed.
  if (opts.externalIds.has(externalId)) {
    counts.alreadyPresent++;
    return;
  }
  if (claimExisting(opts.candidates, flow, amountCents, postedAt)) {
    counts.alreadyPresent++;
    return;
  }

  const note =
    `${row.category}${row.method ? ` · ${row.method}` : ""} · ${row.month} (genesis import)`;
  if (opts.write) {
    await ctx.db.insert("transactions", {
      chapterId: opts.chapterId,
      source: "relay_csv",
      flow,
      amountCents,
      currency: "usd",
      postedAt,
      description: row.description,
      note,
      status: "unreviewed",
      externalId,
      createdAt: Date.now(),
    });
  }
  opts.externalIds.add(externalId);
  counts.inserted++;
  counts.netCents += flow === "inflow" ? amountCents : -amountCents;
}

async function applyLtnRow(
  ctx: MutationCtx,
  opts: { write: boolean; chapterId: Id<"chapters">; externalIds: Set<string> },
  row: GenesisLtnRow,
  counts: DatasetCounts,
): Promise<void> {
  if (!Number.isInteger(row.amountCents) || row.amountCents <= 0) {
    counts.invalid++;
    return;
  }
  let postedAt: number;
  try {
    postedAt = parseGenesisDate(row.date);
  } catch {
    counts.invalid++;
    return;
  }
  const externalId = `${LTN_REF_PREFIX}${row.conf}`;
  // LTN payments never touched the bank feed, so dedup on `externalId` ONLY (a
  // date/amount heuristic could only ever falsely drop one of these expenses).
  if (opts.externalIds.has(externalId)) {
    counts.alreadyPresent++;
    return;
  }

  const note =
    `Paid personally by owner via Zelle (conf ${row.conf}); recorded as an ` +
    `in-kind gift on the giving side — this is the org's expense leg. (genesis import)`;
  if (opts.write) {
    await ctx.db.insert("transactions", {
      chapterId: opts.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: row.amountCents,
      currency: "usd",
      postedAt,
      description: row.description,
      note,
      status: "unreviewed",
      externalId,
      createdAt: Date.now(),
    });
  }
  opts.externalIds.add(externalId);
  counts.inserted++;
  counts.netCents -= row.amountCents; // an outflow
}

/**
 * Load the org's full financial history into `transactions` on the NY chapter.
 * `execute` omitted / false = a zero-write dry run reporting the exact counts a
 * real run would produce; `true` commits. Idempotent (self-dedup on `externalId`
 * + cross-source date/amount dedup vs. the live feed). Per-dataset counts +
 * overall signed net cents (inflows positive, outflows negative).
 */
export const runFinanceGenesisBackfill = internalMutation({
  args: { execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    chapterId: v.id("chapters"),
    bank: datasetCountsValidator,
    ltn: datasetCountsValidator,
    netCents: v.number(),
  }),
  handler: async (ctx, { execute }) => {
    const write = execute ?? false;
    const chapter = await resolveNyChapter(ctx);
    const { externalIds, candidates } = await loadExisting(ctx, chapter._id);

    const bank = zeroCounts();
    for (let i = 0; i < GENESIS_BANK_ROWS.length; i++) {
      await applyBankRow(
        ctx,
        { write, chapterId: chapter._id, externalIds, candidates },
        GENESIS_BANK_ROWS[i],
        i,
        bank,
      );
    }

    const ltn = zeroCounts();
    for (const row of GENESIS_LTN_ROWS) {
      await applyLtnRow(
        ctx,
        { write, chapterId: chapter._id, externalIds },
        row,
        ltn,
      );
    }

    return {
      dryRun: !write,
      chapterId: chapter._id,
      bank,
      ltn,
      netCents: bank.netCents + ltn.netCents,
    };
  },
});
