/**
 * Inbound-email → OCR → reconcile pipeline (the receipt-backfill keystone).
 *
 * FLOW (see `http.ts` `/resend/inbound` for the entry point):
 *   1. Resend delivers a signed `email.received` webhook when a message lands
 *      at `reply.publicworship.life`. The HTTP route verifies the Svix/Standard
 *      Webhooks signature, then calls `recordInboundReceipt` — which DEDUPES on
 *      the provider's `emailId` (the same first-sight guard `webhookEvents`
 *      gives the Stripe/Increase handlers) and inserts a `pending` row.
 *   2. The route schedules `processInboundReceipt` (an action) and returns 200
 *      fast — the webhook must ack quickly; all the slow work is async.
 *   3. `processInboundReceipt`:
 *        a. CLASSIFIES the sender (`classifySender`). The endpoint is public and
 *           the gate is OPEN (owner decision, 2026-07-23): EVERY email is
 *           processed end-to-end regardless of sender. The classification —
 *           team / roster / internal / external — is an AUTOMATION axis, never a
 *           permission: only a `team`/`roster` sender (resolved to a `people`
 *           row) may trigger an auto-attach; an `internal`/`external` email is
 *           always routed to human review (a `From:` header is spoofable, so a
 *           stranger's mail must never move money).
 *        b. Gets the receipt content: EVERY usable image/PDF ATTACHMENT (each
 *           processed independently), else the email BODY text.
 *        c. Extracts { amountCents, date, merchant } per receipt:
 *             - BODY receipts are parsed with a plain in-Convex heuristic
 *               (`parseReceiptFromText`) — ZERO LLM.
 *             - IMAGE/PDF receipts go to a cheap multimodal model via OpenRouter
 *               (`ocrReceiptImage`) — the only LLM call, and only for photos.
 *        d. Matches each against the sender-chapter's UNRECEIPTED spend within a
 *           date window at the EXACT cent (`findReceiptMatches`). No chapter (an
 *           unknown sender) → no candidates; the receipt routes to review.
 *        e. Creates ONE first-class `receipts` row PER extracted receipt (source
 *           `email`), stamped with the sender class + OCR provenance and its own
 *           match shortlist. A `team`/`roster` receipt with exactly ONE candidate
 *           auto-attaches (links + flips an already-`categorized` charge to
 *           `reconciled` + unlocks the card, all via `lib/receiptLinks.ts`).
 *           Everything else defers to a human.
 *        f. Replies to the sender (best-effort) — ONLY to team/roster senders.
 *
 * MONEY SAFETY: the model NEVER moves money and NEVER categorizes here — it only
 * reads a total off a receipt. The only write that touches a transaction is the
 * link layer (`lib/receiptLinks.ts`), and it only ever attaches a receipt +
 * (maybe) flips an already-categorized txn to reconciled. Ambiguity, an
 * untrusted sender, or an unreadable total always defer to a human. This mirrors
 * the AI-coding rule ("a human confirms; the model never moves money").
 */
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  internalAction,
} from "./_generated/server";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  INBOUND_RECEIPT_STATUSES,
  RECEIPT_SENDER_CLASSES,
  receiptSenderCanAutoAttach,
  FINANCE_TIMEZONE,
  financeRoleAtLeast,
  FINANCE_ROLE_LABELS,
  OLLAMA_DEFAULT_OCR_MODEL,
  type ReceiptSenderClass,
} from "@events-os/shared";
import {
  chatCompletion,
  type AiEngineConfig,
  type ChatErrorKind,
} from "./lib/aiEngine";
import { ROLLUP_SCAN_LIMIT, txnMatchesMode, isSpend } from "./finances";
import { readSandbox } from "./financeSettings";
import { normalizeEmail, isAllowedEmail } from "./lib/access";
import { getChapterIdOrNull } from "./lib/context";
import { getFinanceRole, requireFinanceRole } from "./lib/finance";
import {
  createReceipt,
  linkReceiptToTransaction,
  findDuplicateReceiptBySha256,
} from "./lib/receiptLinks";
import { sendEmail } from "./ticketingEmails";

// ── Tuning constants ─────────────────────────────────────────────────────────
/** How far apart the receipt DATE and a card charge's `postedAt` may be and
 *  still match. Card `postedAt` (settlement) commonly lags the receipt date by
 *  a few days, so the window is generous but bounded. ±14 days. */
const MATCH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** The date-bounded scan cap when hunting for candidate transactions — mirrors
 *  the reconcile grid's own `ROLLUP_SCAN_LIMIT` discipline (`finances.ts`). */
const CANDIDATE_SCAN_LIMIT = ROLLUP_SCAN_LIMIT;
/** How many candidate ids we persist onto a `needs_review` row for the UI. */
const MAX_CANDIDATES_SURFACED = 8;
/** How many attachments we ever process off one email (bounded — a receipt
 *  email carries a handful of photos, not hundreds). */
const MAX_ATTACHMENTS = 10;
/** Abort a single OCR completion if it hangs longer than this. */
const OCR_TIMEOUT_MS = 60_000;
/** The multimodal model receipt-image OCR calls WHEN the provider is OpenRouter.
 *  Config, not code: overridable via `RECEIPT_OCR_MODEL` so the owner can point
 *  it at a FREE/cheap vision model (the preference) or upgrade if scan quality
 *  is weak. Defaults to a low-cost vision-capable model. (For Ollama, the soft
 *  default is `gemma4` — confirmed cloud-hosted + vision-capable; see
 *  `resolveOcrModel` and `OLLAMA_DEFAULT_OCR_MODEL`'s doc for why `glm-ocr`,
 *  Ollama's dedicated OCR model, is NOT the default — it's local-only and
 *  404s on ollama.com's cloud service.) */
export function ocrModel(): string {
  return process.env.RECEIPT_OCR_MODEL ?? "google/gemini-2.0-flash-001";
}

/**
 * Resolve the OCR model for one call: per-call override > stored DEDICATED
 * `aiOcrModel` (fix 4 — NEVER the global `aiModel`, which is a general chat/
 * coding model that could silently degrade a receipt read if pointed at
 * something not vision-capable) > per-provider OCR default (OpenRouter's
 * `ocrModel()` env/hardcoded, or Ollama's `gemma4` — see
 * `OLLAMA_DEFAULT_OCR_MODEL`'s doc). The `override` is the retry-UI hook
 * (plumbed through `receipts.processUploadedReceipt`). Deliberately does NOT
 * call `resolveEngineModel` (which reads the global `model`) — OCR
 * resolution is its own precedence chain, kept apart on purpose.
 */
export function resolveOcrModel(
  config: Pick<AiEngineConfig, "provider" | "ocrModel">,
  override?: string | null,
): string {
  if (override && override.trim()) return override.trim();
  if (config.ocrModel && config.ocrModel.trim()) return config.ocrModel.trim();
  return config.provider === "ollama" ? OLLAMA_DEFAULT_OCR_MODEL : ocrModel();
}

// ── Validators ───────────────────────────────────────────────────────────────
const statusValidator = v.union(
  ...INBOUND_RECEIPT_STATUSES.map((s) => v.literal(s)),
);
const senderClassValidator = v.union(
  ...RECEIPT_SENDER_CLASSES.map((c) => v.literal(c)),
);

/** The envelope the HTTP route captures off the verified webhook and hands to
 *  the dedup mutation. */
export const inboundEnvelope = v.object({
  emailId: v.string(),
  fromEmail: v.string(),
  toEmail: v.optional(v.string()),
  subject: v.optional(v.string()),
});

// ── Dedup + insert (called by the HTTP route, first thing) ───────────────────
/**
 * Record an inbound email and report whether it is NEW. Deduped on `emailId`
 * (the provider's unique id) via `by_email_id`: a Resend redelivery finds the
 * existing row and returns `{ isNew: false }`, so the route skips re-scheduling
 * the pipeline. On first sight, inserts a `pending` row and returns its id.
 */
export const recordInboundReceipt = internalMutation({
  args: { envelope: inboundEnvelope },
  returns: v.object({
    isNew: v.boolean(),
    receiptId: v.id("inboundReceipts"),
  }),
  handler: async (ctx, { envelope }) => {
    const existing = await ctx.db
      .query("inboundReceipts")
      .withIndex("by_email_id", (q) => q.eq("emailId", envelope.emailId))
      .first();
    if (existing) return { isNew: false, receiptId: existing._id };
    const now = Date.now();
    const receiptId = await ctx.db.insert("inboundReceipts", {
      emailId: envelope.emailId,
      status: "pending",
      fromEmail: envelope.fromEmail,
      toEmail: envelope.toEmail,
      subject: envelope.subject,
      receivedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return { isNew: true, receiptId };
  },
});

// ── Addressing (which inbound emails are receipts at all) ────────────────────
/** Extract the bare address out of a possibly display-named recipient
 *  ("Jane Doe <jane@x.com>" → "jane@x.com"), normalized. Inbound `from`/`to`
 *  values may arrive either bare or in RFC-5322 display form. */
export function extractEmailAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const angled = raw.match(/<([^>]+)>/);
  return normalizeEmail(angled ? angled[1] : raw);
}

/** Free mail hosts carry no merchant identity of their own — never worth
 *  guessing a "merchant" off their domain label. */
const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com",
  "aol.com", "protonmail.com", "me.com", "live.com",
]);

/** Strips repeated leading "Fwd:"/"Fw:"/"Re:" reply/forward prefixes off a
 *  subject line ("Fwd: Your receipt from X" → "Your receipt from X",
 *  "Re: Fwd: ..." → "..."). A FORWARDED receipt is the common shape for this
 *  fallback's subject-fragment path — a human forwards the original
 *  merchant email to the receipts inbox — so the prefix must never block the
 *  "receipt from X" / "X receipt" match below. */
function stripReplyForwardPrefixes(subject: string): string {
  let s = subject;
  // Bounded loop (subjects don't chain more than a couple of these) — avoids
  // any risk of a pathological/backtracking replace on attacker-controlled
  // input.
  for (let i = 0; i < 5; i++) {
    const next = s.replace(/^\s*(?:fwd?|re)\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * Best-effort MERCHANT FALLBACK derived from the email envelope itself — used
 * only when extraction (body parse or vision OCR) found no merchant (see
 * `runPipeline`'s "when extraction yields no merchant" step). Tries, in
 * order:
 *   1. A real RFC-5322 DISPLAY NAME ("Givebutter" <receipts@givebutter.com>"
 *      → "Givebutter") — the highest-confidence signal, a sender chose it.
 *   2. The sending domain's second-level label, title-cased
 *      ("noreply@doordash.com" → "Doordash") — skipped for a generic mail
 *      host (`GENERIC_EMAIL_DOMAINS`), which carries no merchant identity.
 *   3. A "receipt from X" / "X receipt" fragment off the SUBJECT line — a
 *      leading "Fwd:"/"Re:" prefix (the common shape when a human forwards
 *      the original receipt email in) is stripped first
 *      (`stripReplyForwardPrefixes`), and a trailing "#..." order/invoice
 *      number is trimmed off the captured fragment (e.g. "Your receipt from
 *      Givebutter, Inc. #2383-5178" → "Givebutter, Inc.").
 * Returns `null` (never a guess) when none of these yield a confident
 * candidate. Exported for direct unit testing.
 */
export function deriveMerchantFromEmail(
  fromEmail: string,
  subject?: string | null,
): string | null {
  const displayMatch = fromEmail.match(/^\s*"?([^"<]{2,60}?)"?\s*<[^>]+>\s*$/);
  if (displayMatch) {
    const name = displayMatch[1].trim();
    if (name && !name.includes("@")) return name.slice(0, 200);
  }

  const addr = extractEmailAddress(fromEmail);
  const domain = addr?.split("@")[1];
  if (domain && !GENERIC_EMAIL_DOMAINS.has(domain)) {
    const label = domain.split(".").slice(0, -1).join(" ") || domain;
    const cleaned = label.replace(/[-_]/g, " ").trim();
    if (cleaned.length >= 2 && cleaned.length <= 40) {
      return cleaned
        .split(/\s+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
    }
  }

  if (subject) {
    const cleanedSubject = stripReplyForwardPrefixes(subject);
    const m =
      cleanedSubject.match(/receipt from ([a-z0-9 .,'&-]{2,40})/i) ??
      cleanedSubject.match(/^([a-z0-9 .,'&-]{2,40})\s+receipt\b/i);
    if (m) {
      // Trim a trailing "#..." order/invoice number the character class
      // above didn't already stop at (belt-and-suspenders — it usually does,
      // since '#' isn't in the allowed set, but a captured fragment could
      // still end in one after the class stops at a different boundary).
      const candidate = m[1].trim().replace(/\s*#\S*$/, "").trim();
      if (candidate) return candidate.slice(0, 200);
    }
  }

  return null;
}

/**
 * True iff ANY recipient of the inbound email is a dedicated receipt-inbox
 * address. The inbound domain (`reply.publicworship.life`) will carry other
 * addresses for other purposes, so the webhook must NOT treat every email to
 * the domain as a receipt — only mail addressed (To or Cc) to the receipts
 * inbox. Config, not code: `RECEIPT_INBOUND_ADDRESSES` is a comma-separated
 * allow-list, defaulting to `receipts@reply.publicworship.life`.
 */
export function isReceiptInboxAddress(
  recipients: readonly (string | null | undefined)[],
): boolean {
  const allowed = new Set(
    (process.env.RECEIPT_INBOUND_ADDRESSES ?? "receipts@reply.publicworship.life")
      .split(",")
      .map((a) => normalizeEmail(a))
      .filter((a): a is string => a != null),
  );
  return recipients.some((r) => {
    const addr = extractEmailAddress(r);
    return addr != null && allowed.has(addr);
  });
}

// ── Sender resolution + classification ───────────────────────────────────────
/**
 * Resolve a raw sender address to a roster `people` doc (or null). Matches
 * against both the personal `email` and the Public Worship `pwEmail` (core-team
 * cardholders commonly send from the latter).
 *
 * `people.email` is stored AS ENTERED (not normalized), so the `by_email` index
 * is only a fast path for the already-lowercase common case; a bounded scan
 * comparing NORMALIZED addresses is the correctness backstop (it also covers
 * the unindexed `pwEmail`). Volume here is low (a backfill webhook), so the
 * fallback scan is acceptable.
 */
async function lookupPersonByEmail(
  ctx: QueryCtx,
  email: string,
): Promise<Doc<"people"> | null> {
  const normalized = extractEmailAddress(email);
  if (!normalized) return null;
  // Fast path: an exactly-stored (lowercase) personal email.
  const byEmail = await ctx.db
    .query("people")
    .withIndex("by_email", (q) => q.eq("email", normalized))
    .first();
  if (byEmail) return byEmail;
  // Correctness backstop: bounded scan comparing normalized `email`/`pwEmail`
  // (catches mixed-case stored addresses and the secondary PW address).
  const scan = await ctx.db.query("people").take(ROLLUP_SCAN_LIMIT);
  return (
    scan.find(
      (p) =>
        (p.email && normalizeEmail(p.email) === normalized) ||
        (p.pwEmail && normalizeEmail(p.pwEmail) === normalized),
    ) ?? null
  );
}

/**
 * Resolve a sender to a person + chapter, or null. Kept as its own contract for
 * direct testing; the pipeline uses `classifySender` (which builds on the same
 * lookup) so an UNKNOWN sender still flows through instead of being dropped.
 */
export const resolvePersonByEmail = internalQuery({
  args: { email: v.string() },
  returns: v.union(
    v.object({ personId: v.id("people"), chapterId: v.id("chapters") }),
    v.null(),
  ),
  handler: async (ctx, { email }) => {
    const person = await lookupPersonByEmail(ctx, email);
    if (!person) return null;
    return { personId: person._id, chapterId: person.chapterId };
  },
});

/**
 * Classify an inbound sender into the AUTOMATION axis + resolve their person /
 * chapter when known. NEVER a permission — a public endpoint's `From:` is
 * spoofable, so the class only decides whether the pipeline may AUTO-ATTACH
 * (team/roster) or must route to human review (internal/external). See
 * `RECEIPT_SENDER_CLASSES`. An unresolved sender has no chapter, so its receipts
 * get no auto-match candidates (there's nothing to match against).
 */
export const classifySender = internalQuery({
  args: { email: v.string() },
  returns: v.object({
    senderClass: senderClassValidator,
    personId: v.union(v.id("people"), v.null()),
    chapterId: v.union(v.id("chapters"), v.null()),
  }),
  handler: async (ctx, { email }) => {
    const person = await lookupPersonByEmail(ctx, email);
    // A contact-only match (person-centric audiences Phase 1 — auto-created
    // from a donor gift, an import, or a public RSVP) is NOT a cardholder or
    // team member — treat it the same as no roster match at all, so an email
    // from a guest's/donor's address falls through to the domain check below
    // instead of silently auto-attaching via the "roster" trust class.
    if (person && person.isContactOnly !== true) {
      return {
        senderClass: person.isTeamMember ? "team" : "roster",
        personId: person._id,
        chapterId: person.chapterId,
      } as const;
    }
    // No roster match — trust falls to the address domain alone.
    const senderClass: ReceiptSenderClass = isAllowedEmail(
      extractEmailAddress(email),
    )
      ? "internal"
      : "external";
    return { senderClass, personId: null, chapterId: null };
  },
});

// ── The matcher ──────────────────────────────────────────────────────────────
/** One candidate transaction the matcher surfaces. Exported so `receipts.ts`
 *  (`suggestMatches`) can share this exact return shape instead of redefining
 *  it. */
export const candidateValidator = v.object({
  transactionId: v.id("transactions"),
  amountCents: v.number(),
  postedAt: v.number(),
  merchantName: v.optional(v.string()),
  description: v.optional(v.string()),
  status: v.string(),
  // Whether the OCR merchant string shares a normalized token with this txn —
  // a soft confidence signal used to break ties, never a hard filter.
  merchantOverlap: v.boolean(),
  // Whether this is the sender's OWN card charge (a confidence booster).
  isOwnCharge: v.boolean(),
});

const MERCHANT_STOPWORDS = new Set([
  "inc", "llc", "corp", "co", "the", "sq", "tst", "pos", "payment", "purchase",
  "store", "of", "and", "a", "an",
]);
function merchantTokens(...texts: (string | null | undefined)[]): Set<string> {
  const combined = texts.filter(Boolean).join(" ");
  return new Set(
    combined
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !MERCHANT_STOPWORDS.has(t)),
  );
}

/**
 * Find UNRECEIPTED spend transactions in `chapterId` whose amount EXACTLY
 * matches `amountCents` and whose `postedAt` is within ±`MATCH_WINDOW_MS` of
 * the receipt date. Exact-cent by design (the confident-auto-match bar); the
 * date window absorbs settlement lag. Ordered best-first: own-card charges and
 * merchant-token overlaps rank above bare amount matches, then nearest date.
 *
 * Bounded: scans `by_chapter_and_postedAt` newest-first up to
 * `CANDIDATE_SCAN_LIMIT` and filters in memory (there is no amount index; the
 * date+receipt+spend predicates are cheap). Sandbox-filtered + `isSpend` so it
 * only ever sees the same charges the reconcile grid does.
 */
export async function matchReceiptCandidates(
  ctx: QueryCtx,
  args: {
    chapterId: Id<"chapters">;
    amountCents: number;
    receiptDate: number;
    ocrMerchant?: string;
    senderPersonId?: Id<"people">;
  },
): Promise<
  {
    transactionId: Id<"transactions">;
    amountCents: number;
    postedAt: number;
    merchantName: string | undefined;
    description: string | undefined;
    status: string;
    merchantOverlap: boolean;
    isOwnCharge: boolean;
  }[]
> {
  const sandboxMode = await readSandbox(ctx);
  const rows = await ctx.db
    .query("transactions")
    .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", args.chapterId))
    .order("desc")
    .take(CANDIDATE_SCAN_LIMIT);

  const targetTokens = merchantTokens(args.ocrMerchant);
  const matches = rows
    .filter(
      (tr) =>
        tr.amountCents === args.amountCents &&
        tr.receiptStorageId == null &&
        isSpend(tr) &&
        txnMatchesMode(tr, sandboxMode) &&
        Math.abs(tr.postedAt - args.receiptDate) <= MATCH_WINDOW_MS,
    )
    .map((tr) => {
      const overlap =
        targetTokens.size > 0 &&
        [...merchantTokens(tr.merchantName, tr.description)].some((t) =>
          targetTokens.has(t),
        );
      return {
        transactionId: tr._id,
        amountCents: tr.amountCents,
        postedAt: tr.postedAt,
        merchantName: tr.merchantName,
        description: tr.description,
        status: tr.status,
        merchantOverlap: overlap,
        isOwnCharge:
          args.senderPersonId != null && tr.personId === args.senderPersonId,
      };
    });

  // Best-first: own charge, then merchant overlap, then nearest date.
  matches.sort((a, b) => {
    if (a.isOwnCharge !== b.isOwnCharge) return a.isOwnCharge ? -1 : 1;
    if (a.merchantOverlap !== b.merchantOverlap) return a.merchantOverlap ? -1 : 1;
    return (
      Math.abs(a.postedAt - args.receiptDate) -
      Math.abs(b.postedAt - args.receiptDate)
    );
  });
  return matches.slice(0, MAX_CANDIDATES_SURFACED);
}

export const findReceiptMatches = internalQuery({
  args: {
    chapterId: v.id("chapters"),
    amountCents: v.number(),
    receiptDate: v.number(),
    ocrMerchant: v.optional(v.string()),
    senderPersonId: v.optional(v.id("people")),
  },
  returns: v.array(candidateValidator),
  handler: async (ctx, args) => matchReceiptCandidates(ctx, args),
});

// ── Commit: create receipt documents + auto-attach + write the inbound row ───
/** One extracted receipt the action hands the commit mutation: a stored file,
 *  its OCR read, and its (already-computed) match shortlist. */
const extractedReceiptValidator = v.object({
  storageId: v.id("_storage"),
  sourceKind: v.union(v.literal("attachment"), v.literal("body")),
  filename: v.optional(v.string()),
  ocrAmountCents: v.optional(v.number()),
  ocrDate: v.optional(v.number()),
  ocrMerchant: v.optional(v.string()),
  ocrConfidence: v.optional(v.number()),
  ocrModel: v.optional(v.string()),
  ocrError: v.optional(v.string()),
  candidateTransactionIds: v.array(v.id("transactions")),
});

/**
 * Create the first-class `receipts` rows for one inbound email, auto-attach the
 * ones the policy allows, and write the aggregate outcome back onto the
 * `inboundReceipts` row — all in ONE transaction.
 *
 * AUTOMATION POLICY (money safety): a receipt auto-attaches ONLY when its sender
 * is `team`/`roster` (`receiptSenderCanAutoAttach`) AND it has exactly ONE
 * candidate. An `internal`/`external` sender, an ambiguous match, an unreadable
 * total, or an unknown chapter always routes to human review — never an
 * auto-attach, never a reconcile. The inbound row's status AGGREGATES: `matched`
 * only if EVERY extracted receipt auto-matched, else the most-actionable state
 * (`needs_review` > `no_match`).
 */
export const commitInboundReceipts = internalMutation({
  args: {
    receiptId: v.id("inboundReceipts"),
    personId: v.optional(v.id("people")),
    chapterId: v.optional(v.id("chapters")),
    senderClass: senderClassValidator,
    // Attachments the inline-asset filter dropped before extraction ever ran
    // (a logo, a signature, a tracking pixel) — appended to the row's
    // `detail` so they never just silently vanish. See `isLikelyInlineAsset`.
    skippedAttachmentNames: v.optional(v.array(v.string())),
    extracted: v.array(extractedReceiptValidator),
  },
  returns: v.object({
    status: statusValidator,
    totalCount: v.number(),
    matchedCount: v.number(),
    amountCents: v.union(v.number(), v.null()),
    matchedTransactionId: v.union(v.id("transactions"), v.null()),
    matchedMerchant: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const canAuto = receiptSenderCanAutoAttach(args.senderClass);
    const chapterKnown = args.chapterId != null;

    let matchedCount = 0;
    let firstMatchedTxn: Id<"transactions"> | null = null;
    let firstMatchedMerchant: string | null = null;
    let firstMatchedPostedAt: number | null = null;
    let anyReconciled = false;
    const reasons = new Set<string>();

    for (const ex of args.extracted) {
      // Exact-dupe check: the same file bytes landing twice (a forwarded
      // duplicate, a redelivered attachment) — caught via the `_storage`
      // system table's own `sha256`, chapter-scoped (see
      // `lib/receiptLinks.ts#findDuplicateReceiptBySha256`). Stamped either
      // way so an upload of these SAME bytes later is caught too (both
      // directions of the CRM PR's cross-source dedup).
      const meta = await ctx.db.system.get("_storage", ex.storageId);
      const fileSha256 = meta?.sha256;
      const duplicateOfReceiptId = fileSha256
        ? ((await findDuplicateReceiptBySha256(ctx, args.chapterId, fileSha256)) ??
          undefined)
        : undefined;

      const receiptId = await createReceipt(ctx, {
        chapterId: args.chapterId,
        storageId: ex.storageId,
        source: "email",
        inboundReceiptId: args.receiptId,
        senderClass: args.senderClass,
        filename: ex.filename,
        ocrAmountCents: ex.ocrAmountCents,
        ocrDate: ex.ocrDate,
        ocrMerchant: ex.ocrMerchant,
        ocrConfidence: ex.ocrConfidence,
        ocrModel: ex.ocrModel,
        ocrError: ex.ocrError,
        candidateTransactionIds: ex.candidateTransactionIds.length
          ? ex.candidateTransactionIds
          : undefined,
        fileSha256,
        duplicateOfReceiptId,
      });

      if (duplicateOfReceiptId) {
        // A likely duplicate submission — never auto-attach it, regardless of
        // how clean its OCR read or match would otherwise be. A human confirms.
        reasons.add("duplicate");
        continue;
      }
      if (ex.ocrAmountCents == null) {
        reasons.add("unreadable");
        continue;
      }
      if (!chapterKnown) {
        // No chapter to search against — a human must place it.
        reasons.add("unknown");
        continue;
      }
      const cands = ex.candidateTransactionIds;
      if (cands.length === 0) {
        // A clean total read but nothing matched — a pure no-match (no `reasons`
        // entry, so the aggregate lands on `no_match` unless another receipt in
        // the same email needs review).
        continue;
      }
      if (cands.length === 1 && canAuto) {
        const res = await linkReceiptToTransaction(ctx, {
          receiptId,
          transactionId: cands[0],
          source: "auto_email",
          reconcileIfCategorized: true,
        });
        matchedCount++;
        if (firstMatchedTxn == null) {
          firstMatchedTxn = cands[0];
          const txn = await ctx.db.get(cands[0]);
          firstMatchedMerchant = txn?.merchantName ?? txn?.description ?? null;
          firstMatchedPostedAt = txn?.postedAt ?? null;
        }
        if (res.reconciled) anyReconciled = true;
      } else {
        // Ambiguous (>1) OR an untrusted sender not allowed to auto-attach.
        reasons.add(cands.length > 1 ? "ambiguous" : "untrusted");
      }
    }

    const total = args.extracted.length;
    const firstAmount = args.extracted[0]?.ocrAmountCents ?? null;

    // Aggregate status: `matched` only if EVERY receipt auto-matched; else the
    // most-actionable state (needs_review > no_match).
    let status: (typeof INBOUND_RECEIPT_STATUSES)[number];
    let detail: string;
    if (total > 0 && matchedCount === total) {
      status = "matched";
      detail =
        total === 1 && firstMatchedTxn
          ? `Attached to ${firstMatchedMerchant ?? "a charge"} (${
              firstAmount != null ? fmtUsd(firstAmount) : "receipt"
            }${firstMatchedPostedAt != null ? `, ${shortDate(firstMatchedPostedAt)}` : ""})${
              anyReconciled ? " and reconciled" : ""
            }.`
          : `Attached ${matchedCount} receipt${matchedCount === 1 ? "" : "s"} to charges.`;
    } else if (reasons.size > 0) {
      status = "needs_review";
      if (reasons.has("duplicate")) {
        detail =
          "Looks like a duplicate of an already-submitted receipt — a bookkeeper should confirm.";
      } else if (reasons.has("unknown")) {
        detail = "Sender unknown — pick the transaction manually.";
      } else if (reasons.has("untrusted")) {
        detail = "Sender not verified — a bookkeeper must confirm the match.";
      } else if (reasons.has("ambiguous")) {
        detail =
          firstAmount != null
            ? `Multiple charges match ${fmtUsd(firstAmount)} — pick the right one.`
            : "Multiple charges match — pick the right one.";
      } else {
        detail =
          total === 1
            ? "Could not read a total off the receipt — needs a human."
            : "One or more receipts need a human to place.";
      }
    } else {
      status = "no_match";
      detail =
        total === 1 && firstAmount != null
          ? `No unreceipted charge for ${fmtUsd(firstAmount)} within ±14 days.`
          : "No matching charges found.";
    }

    // Write the aggregate back onto the inbound row. The first extracted
    // receipt's OCR read + file drive the (single-receipt-oriented) review queue
    // fields for now (the CRM PR reads the per-`receipts` rows directly).
    const first = args.extracted[0];
    await ctx.db.patch(args.receiptId, {
      ...(args.personId ? { personId: args.personId } : {}),
      ...(args.chapterId ? { chapterId: args.chapterId } : {}),
      senderClass: args.senderClass,
      ...(first
        ? {
            receiptStorageId: first.storageId,
            sourceKind: first.sourceKind,
            ...(first.ocrAmountCents != null
              ? { ocrAmountCents: first.ocrAmountCents }
              : {}),
            ...(first.ocrDate != null ? { ocrDate: first.ocrDate } : {}),
            ...(first.ocrMerchant ? { ocrMerchant: first.ocrMerchant } : {}),
            ...(first.ocrModel ? { ocrModel: first.ocrModel } : {}),
            ...(first.ocrConfidence != null
              ? { ocrConfidence: first.ocrConfidence }
              : {}),
            ...(first.candidateTransactionIds.length
              ? { candidateTransactionIds: first.candidateTransactionIds }
              : {}),
          }
        : {}),
      ...(firstMatchedTxn ? { matchedTransactionId: firstMatchedTxn } : {}),
      status,
      detail: appendSkippedNote(detail, args.skippedAttachmentNames ?? []),
      updatedAt: Date.now(),
    });

    return {
      status,
      totalCount: total,
      matchedCount,
      amountCents: firstAmount,
      matchedTransactionId: firstMatchedTxn,
      matchedMerchant: firstMatchedMerchant,
    };
  },
});

// ── Row lifecycle mutations (called by the action) ───────────────────────────
/** Load a receipt row for the action (internal). */
export const getInboundReceipt = internalQuery({
  args: { receiptId: v.id("inboundReceipts") },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, { receiptId }) => await ctx.db.get(receiptId),
});

/** Patch a receipt row's resolved sender / chapter / class / stored file / OCR
 *  result / status / detail. One narrow write for the state changes the commit
 *  mutation doesn't own (the `ignored`/`error` terminal branches). Always bumps
 *  `updatedAt`. */
export const updateInboundReceipt = internalMutation({
  args: {
    receiptId: v.id("inboundReceipts"),
    patch: v.object({
      status: v.optional(statusValidator),
      personId: v.optional(v.id("people")),
      chapterId: v.optional(v.id("chapters")),
      senderClass: v.optional(senderClassValidator),
      receiptStorageId: v.optional(v.id("_storage")),
      sourceKind: v.optional(v.union(v.literal("attachment"), v.literal("body"))),
      ocrAmountCents: v.optional(v.number()),
      ocrDate: v.optional(v.number()),
      ocrMerchant: v.optional(v.string()),
      ocrModel: v.optional(v.string()),
      ocrConfidence: v.optional(v.number()),
      matchedTransactionId: v.optional(v.id("transactions")),
      candidateTransactionIds: v.optional(v.array(v.id("transactions"))),
      detail: v.optional(v.string()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { receiptId, patch }) => {
    await ctx.db.patch(receiptId, { ...patch, updatedAt: Date.now() });
    return null;
  },
});

// ── Merchant heuristic (ZERO LLM — plain-text receipt bodies) ────────────────
/** Business-entity suffixes that strongly signal a merchant-name line (e.g.
 *  "Givebutter, Inc.", "Trader Joe's Market", "Blue Bottle Coffee"). A line
 *  carrying one of these is the highest-confidence candidate. */
const MERCHANT_SUFFIX_RE =
  /\b(Inc\.?|LLC|Co\.?|Ltd|Corp|Company|Restaurant|Store|Market|Coffee|Cafe|Grill)\b/i;
/** Lines that are almost certainly NOT a merchant name — a label, a bare
 *  number/date/total line, an order/invoice/reference id, a URL. Conservative
 *  on purpose: a line matching this is SKIPPED as a candidate rather than
 *  risked (a wrong merchant is worse than none). */
const MERCHANT_SKIP_LINE_RE =
  /^(order|invoice|receipt|ref(erence)?\s*#?|date|time|subtotal|tax|total|amount|balance|paid|charged|thank|thanks|#|http|www\.)/i;
/** A line that's ENTIRELY digits/currency punctuation (no letters at all). */
const MERCHANT_CURRENCY_ONLY_RE = /^\$?\s*[\d,.\s-]+$/;
/** A line carrying an email address, a URL fragment, or a phone number — an
 *  envelope/contact line, never a business name by itself. */
const MERCHANT_CONTACT_RE = /@|\.(com|org|net|io)\b|\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/i;
/** A line carrying a dollar sign or a price-shaped figure (e.g. "Coffee
 *  $4.50") — a LINE-ITEM, not a merchant name, even when it also contains
 *  letters. */
const MERCHANT_HAS_PRICE_RE = /\$|\d+\.\d{2}\b/;

/** True iff `line` is a PLAUSIBLE merchant-name candidate: 2–40 chars, mostly
 *  letters, not a label/number/date/currency/contact/price line. Deliberately
 *  narrow — false negatives (missing a real merchant) are fine; false
 *  positives (a wrong guess) are not. */
function looksLikeMerchantLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 2 || trimmed.length > 40) return false;
  if (MERCHANT_SKIP_LINE_RE.test(trimmed)) return false;
  if (MERCHANT_CURRENCY_ONLY_RE.test(trimmed)) return false;
  if (MERCHANT_CONTACT_RE.test(trimmed)) return false;
  if (MERCHANT_HAS_PRICE_RE.test(trimmed)) return false;
  const letters = (trimmed.match(/[a-zA-Z]/g) ?? []).length;
  return letters >= 2 && letters / trimmed.length >= 0.5;
}

/** A merchant-with-entity-suffix fragment ANYWHERE within a line, not just a
 *  clean whole line by itself — the fix for a PDF text layer where a text
 *  extractor (e.g. `unpdf`) glues positioned text runs together, so a real
 *  merchant name ("Givebutter, Inc.") ends up concatenated with the address
 *  or boilerplate that sits next to it on the page ("Givebutter, Inc.1345
 *  Some Ave Suite 200") — a line `looksLikeMerchantLine` would reject outright
 *  on length/price/contact grounds alone. Deliberately narrower than the
 *  whole-line suffix check: 1–4 Title-Case words immediately followed by a
 *  strict business-ENTITY suffix (Inc/LLC/Co/Ltd/Corp — not the softer
 *  Restaurant/Store/Market/Coffee/... words `MERCHANT_SUFFIX_RE` also allows,
 *  which are far more likely to false-positive mid-sentence), and not
 *  immediately preceded by another letter (so a concatenation with no word
 *  boundary at all before the merchant's capitalized name, e.g.
 *  "receiptGivebutter, Inc.", can never anchor mid-word and match). "Company"
 *  is DELIBERATELY excluded unless comma-preceded ("Foo, Company") — as a
 *  bare suffix it's an ordinary English word ("Some Random Company Name...")
 *  far too common in prose to trust without the stronger comma signal, unlike
 *  the abbreviations above which essentially never appear mid-sentence. */
const MID_LINE_MERCHANT_RE =
  /(?:^|[^A-Za-z])([A-Z][a-zA-Z'&-]{1,30}(?:\s[A-Z][a-zA-Z'&-]{1,30}){0,3}(?:,\s+Company\.?|,?\s+(?:Inc|LLC|L\.L\.C|Co|Ltd|Corp)\.?))(?=$|[^a-zA-Z])/;

/** Extract just the "<Name>, Inc./LLC/Co." fragment out of a (possibly much
 *  longer, glued-together) line via `MID_LINE_MERCHANT_RE`. Returns `null`
 *  when no confident fragment is found, or when the matched fragment itself
 *  still looks like a contact/URL line (belt-and-suspenders — the narrow
 *  character class above makes this rare). Exported for direct unit testing. */
export function extractMidLineMerchant(line: string): string | null {
  const m = line.match(MID_LINE_MERCHANT_RE);
  if (!m) return null;
  const candidate = m[1].replace(/\s+/g, " ").trim();
  if (candidate.length < 4 || candidate.length > 60) return null;
  if (MERCHANT_CONTACT_RE.test(candidate)) return null;
  return candidate;
}

/**
 * Best-effort merchant name off the first ~15 non-empty lines of a receipt
 * body, in priority order:
 *   1. A STRICT business-entity suffix (Inc/LLC/Co/Ltd/Corp/Company) found
 *      ANYWHERE in a line, extracted as just the "<Name>, Inc." fragment
 *      (`extractMidLineMerchant`) — checked FIRST and independent of the
 *      whole line's length/shape, because a PDF text layer routinely GLUES a
 *      real merchant name to the boilerplate sitting next to it on the page
 *      (an address, an invoice header) into one long line; anchoring on the
 *      suffix itself is the only way to pull the name out clean rather than
 *      grabbing the whole run (or missing it outright because the glued line
 *      fails every whole-line shape check below). This also correctly
 *      handles the simple case — a line that's ONLY "Givebutter, Inc." — so
 *      it fully supersedes the old "whole-line suffix" pass.
 *   2. A whole clean line carrying a SOFTER suffix (Restaurant/Store/Market/
 *      Coffee/Cafe/Grill — too common mid-sentence to safely extract as a
 *      fragment, so these only count on an otherwise-plausible whole line —
 *      `MERCHANT_SUFFIX_RE` + `looksLikeMerchantLine`).
 *   3. The first plausible non-label line near the top at all, no suffix
 *      required (`looksLikeMerchantLine`).
 * Returns `null` when nothing confident is found — deliberately conservative
 * (see module doc: a wrong merchant is worse than none). Exported for direct
 * unit testing.
 */
export function extractMerchantFromLines(lines: string[]): string | null {
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean).slice(0, 15);
  for (const line of nonEmpty) {
    const mid = extractMidLineMerchant(line);
    if (mid) return mid;
  }
  for (const line of nonEmpty) {
    if (MERCHANT_SUFFIX_RE.test(line) && looksLikeMerchantLine(line)) {
      return line.replace(/\s+/g, " ").trim().slice(0, 200);
    }
  }
  for (const line of nonEmpty) {
    if (looksLikeMerchantLine(line)) {
      return line.replace(/\s+/g, " ").trim().slice(0, 200);
    }
  }
  return null;
}

// ── Text-receipt parsing (ZERO LLM — the "just an email" receipts) ───────────
/**
 * Best-effort extraction of a { amountCents, date?, merchant? } from an email
 * BODY (plain text or stripped HTML). Deliberately conservative: it looks for a
 * labelled total ("total", "amount", "amount paid", "grand total", "charged")
 * and takes the LARGEST currency figure on such a line; if no labelled line is
 * found it falls back to the largest currency figure anywhere (receipts lead
 * with the total far more often than not). The merchant comes from
 * `extractMerchantFromLines` (a conservative heuristic — `null` when nothing
 * confident is found, never a guess). Returns `null` amount when it can't
 * find a currency figure at all — the caller then routes to `needs_review`.
 *
 * Exported for direct unit testing (no ctx needed).
 */
export function parseReceiptFromText(body: string): {
  amountCents: number | null;
  date: number | null;
  merchant: string | null;
} {
  const text = body
    .replace(/<[^>]+>/g, " ") // strip any HTML tags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
  const lines = text.split(/\r?\n/);

  // A currency figure: optional $, digits with optional thousands separators,
  // a decimal point + 2 digits. Captures the numeric part.
  const CURRENCY = /\$?\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})/g;
  const TOTAL_LINE = /\b(grand\s+total|total\s+(?:amount|paid|due|charged)?|amount\s+(?:paid|due|charged)?|balance|charged)\b/i;

  function figuresOn(s: string): number[] {
    const out: number[] = [];
    for (const m of s.matchAll(CURRENCY)) {
      const cents = Math.round(parseFloat(m[1].replace(/,/g, "")) * 100);
      if (Number.isFinite(cents) && cents > 0) out.push(cents);
    }
    return out;
  }

  let amountCents: number | null = null;
  // Prefer the largest figure on a "total"-labelled line.
  const totalFigures: number[] = [];
  for (const line of lines) {
    if (TOTAL_LINE.test(line)) totalFigures.push(...figuresOn(line));
  }
  if (totalFigures.length) {
    amountCents = Math.max(...totalFigures);
  } else {
    // Fallback: the largest currency figure anywhere in the body.
    const all = figuresOn(text);
    if (all.length) amountCents = Math.max(...all);
  }

  // Date: first parseable date-looking token (M/D/YYYY, YYYY-MM-DD, or "Mon D,
  // YYYY"). Noon-local by the `transactionDate` convention to dodge TZ edges.
  let date: number | null = null;
  const dateMatch =
    text.match(/\b(\d{4}-\d{2}-\d{2})\b/) ||
    text.match(/\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/) ||
    text.match(/\b([A-Z][a-z]{2,8}\.?\s+\d{1,2},?\s+\d{4})\b/);
  if (dateMatch) {
    const parsed = Date.parse(dateMatch[1]);
    if (Number.isFinite(parsed)) {
      const d = new Date(parsed);
      d.setHours(12, 0, 0, 0);
      date = d.getTime();
    }
  }

  return { amountCents, date, merchant: extractMerchantFromLines(lines) };
}

/** Provenance marker stored in `ocrModel` for a receipt whose fields came
 *  from a PDF's own text layer (`receiptPdf.ts`) rather than a model call —
 *  zero-LLM, so distinct from an actual vision-model slug. */
export const PDF_TEXT_LAYER_PROVENANCE = "pdf-text-layer";

/** True iff `contentType`/`filename` name a PDF. Checked both ways: Resend's
 *  `content_type` is usually reliable, but a mislabelled attachment's `.pdf`
 *  extension is a fallback signal (mirrors `isReceiptFile`'s own belt-and-
 *  suspenders check). */
export function isPdfContentType(contentType: string, filename?: string): boolean {
  return (
    contentType.toLowerCase() === "application/pdf" ||
    /\.pdf$/i.test((filename ?? "").toLowerCase())
  );
}

/**
 * True iff a PDF's extracted text layer looks like real receipt text rather
 * than emptiness/garbage — the signal that decides "digital PDF, parse it
 * with zero LLM" vs "scanned PDF, fall back to vision OCR". Deliberately
 * simple: a SCANNED pdf's text layer is either empty or a handful of stray
 * control/whitespace characters pdf.js can't resolve to real glyphs; a
 * genuine digital receipt (Givebutter, Stripe, Square…) always yields at
 * least a few dozen real characters of prose/numbers with a normal
 * letters+digits density. Exported for direct unit testing (no ctx needed).
 */
export function isMeaningfulPdfText(text: string): boolean {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length < 20) return false;
  const alnum = (collapsed.match(/[a-zA-Z0-9]/g) ?? []).length;
  return alnum / collapsed.length > 0.3;
}

/** Format cents as "$X.YZ" for reply copy / review detail. */
function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    timeZone: FINANCE_TIMEZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ── Attachment fetch + image OCR (the ONLY LLM call, images only) ────────────
interface ResendAttachment {
  id: string;
  filename?: string;
  content_type?: string;
  size?: number;
  download_url?: string;
}

// ── Inline-asset filter (the duplicate-receipt fix) ──────────────────────────
/** Attachments smaller than this are CANDIDATES for the inline-asset filter
 *  below — but size ALONE never disqualifies one (see `isLikelyInlineAsset`'s
 *  doc). ~15KB: comfortably above a typical embedded logo/signature/tracking
 *  pixel, comfortably below a real thermal-receipt or storefront photo — the
 *  floor stays deliberately conservative so a legit small receipt photo is
 *  never the one that gets dropped. */
const INLINE_ASSET_SIZE_FLOOR_BYTES = 15 * 1024;
/** Filename shapes common to embedded EMAIL assets — a company logo, an
 *  email-signature graphic, a social/nav icon, a banner, a spacer gif, a
 *  tracking pixel, or a generic `imageNNN` MIME part a mail client assigns an
 *  inline image with no real name. Anchored so a merchant whose name merely
 *  CONTAINS one of these words (rare, but possible) isn't punished by the
 *  substring match alone — it also needs to be under the size floor. */
const INLINE_ASSET_NAME_RE =
  /logo|signature|\bsig\b|icon|banner|spacer|track(?:ing)?[-_ ]?pixel|^image[-_]?\d{2,4}\b/i;

/**
 * True iff an attachment is almost certainly an embedded EMAIL ASSET (a
 * signature graphic, a company logo, a tracking pixel) rather than a photo or
 * scan of a receipt — the fix for the duplicate-receipt bug: a forwarded
 * receipt whose email signature carries a logo image must never mint a
 * SECOND "receipt" for that logo. PDFs always pass (a digital receipt PDF is
 * never an inline asset).
 *
 * Deliberately conservative — BOTH signals must agree:
 *  - a small size (under `INLINE_ASSET_SIZE_FLOOR_BYTES`) — size alone never
 *    disqualifies an attachment, since a legitimate small thermal-receipt
 *    photo can easily be under that floor too, and
 *  - an asset-shaped filename — a name alone never disqualifies one either
 *    (an unusually-named real receipt photo shouldn't be dropped for a
 *    coincidental substring match).
 * When in doubt (missing size, no filename match, or an ambiguous name), the
 * attachment is PROCESSED, never silently dropped.
 */
export function isLikelyInlineAsset(a: {
  contentType: string;
  filename: string;
  size?: number;
}): boolean {
  if (isPdfContentType(a.contentType, a.filename)) return false;
  if (a.size == null || a.size >= INLINE_ASSET_SIZE_FLOOR_BYTES) return false;
  return INLINE_ASSET_NAME_RE.test(a.filename.toLowerCase());
}

/** Append a note about attachments the inline-asset filter skipped — so a
 *  filtered-out logo/signature never just silently disappears (a bookkeeper
 *  can see it was seen and why it wasn't treated as a receipt). No-op when
 *  nothing was skipped. Bounded to the first 5 names inline, with a `+N more`
 *  tail for a noisier email. */
export function appendSkippedNote(detail: string, skippedNames: string[]): string {
  if (skippedNames.length === 0) return detail;
  const shown = skippedNames.slice(0, 5).join(", ");
  const rest = skippedNames.length > 5 ? `, +${skippedNames.length - 5} more` : "";
  return `${detail} (Skipped ${skippedNames.length} likely non-receipt attachment${
    skippedNames.length === 1 ? "" : "s"
  }: ${shown}${rest}.)`;
}

/**
 * List a received email's attachments via the Resend API
 * (`GET /emails/receiving/{emailId}/attachments`) and return EVERY one that
 * looks like a receipt image or PDF AND isn't almost-certainly an inline
 * email asset (`isLikelyInlineAsset`), downloaded as a Blob (bounded by
 * `MAX_ATTACHMENTS`). Each usable one is extracted + matched independently.
 * The `download_url` is a short-lived signed CloudFront URL (no auth header
 * needed for the download itself; the LIST call needs the API key). Returns
 * no attachments (and no skips) when there's no usable attachment or the API
 * key / network is unavailable.
 */
async function fetchAllReceiptAttachments(emailId: string): Promise<{
  attachments: { blob: Blob; contentType: string; filename: string }[];
  skippedNames: string[];
}> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log("[receiptInbox] RESEND_API_KEY unset — cannot fetch attachments.");
    return { attachments: [], skippedNames: [] };
  }
  let list: ResendAttachment[];
  try {
    const res = await fetch(
      `https://api.resend.com/emails/receiving/${emailId}/attachments`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!res.ok) {
      console.log(`[receiptInbox] attachment list failed (${res.status}).`);
      return { attachments: [], skippedNames: [] };
    }
    const json: any = await res.json();
    list = (Array.isArray(json) ? json : json?.data) ?? [];
  } catch (err) {
    console.log(`[receiptInbox] attachment list errored: ${String(err)}`);
    return { attachments: [], skippedNames: [] };
  }

  const isReceiptFile = (a: ResendAttachment) => {
    const ct = (a.content_type ?? "").toLowerCase();
    const name = (a.filename ?? "").toLowerCase();
    return (
      ct.startsWith("image/") ||
      ct === "application/pdf" ||
      /\.(jpe?g|png|webp|heic|gif|pdf)$/.test(name)
    );
  };

  const skippedNames: string[] = [];
  const targets: ResendAttachment[] = [];
  for (const a of list) {
    if (!a.download_url || !isReceiptFile(a)) continue;
    if (isLikelyInlineAsset({ contentType: a.content_type ?? "", filename: a.filename ?? "", size: a.size })) {
      skippedNames.push(a.filename ?? a.id);
      continue;
    }
    targets.push(a);
  }
  const bounded = targets.slice(0, MAX_ATTACHMENTS);

  const out: { blob: Blob; contentType: string; filename: string }[] = [];
  for (const target of bounded) {
    try {
      const dl = await fetch(target.download_url!);
      if (!dl.ok) {
        console.log(`[receiptInbox] attachment download failed (${dl.status}).`);
        continue;
      }
      const blob = await dl.blob();
      out.push({
        blob,
        contentType: target.content_type ?? blob.type ?? "application/octet-stream",
        filename: target.filename ?? "receipt",
      });
    } catch (err) {
      console.log(`[receiptInbox] attachment download errored: ${String(err)}`);
    }
  }
  return { attachments: out, skippedNames };
}

/** Base64-encode an ArrayBuffer for a data: URL (chunked to avoid arg limits).
 *  Exported so `receipts.ts`'s upload OCR path builds the same data URL shape
 *  `ocrReceiptImage` expects, instead of re-implementing the chunking. */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Why an `ocrReceiptImage` call yielded no usable read — either a transport-
 *  level `chatCompletion` failure (`ChatErrorKind` — no_key/http/network/
 *  timeout/parse, preserving OpenRouter/Ollama's `status`) or a `"no_total"`:
 *  the model replied fine but the JSON carried no clear total. Distinguishing
 *  these is the whole point of the fix — "out of credits" and "couldn't read
 *  the receipt" used to collapse into the same opaque null. */
export type OcrFailureKind = ChatErrorKind | "no_total";

/** A typed OCR failure reason — never thrown, always returned (mirrors
 *  `lib/aiEngine.ts`'s ChatCompletionError contract one layer up). */
export interface OcrImageFailure {
  kind: OcrFailureKind;
  status: number | null;
  message: string;
}

/** `ocrReceiptImage`'s result: a successful read, or `{ error }` carrying WHY
 *  it failed. Discriminate with `"error" in result` (no shared `ok` tag by
 *  design — mirrors the shape the task calls for). */
export type OcrImageResult =
  | {
      amountCents: number | null;
      date: number | null;
      merchant: string | null;
      confidence: number | null;
    }
  | { error: OcrImageFailure };

/**
 * OCR a receipt IMAGE with a multimodal model through the switchable AI engine
 * (`lib/aiEngine.chatCompletion` — OpenRouter or Ollama, per the global
 * setting). Returns `{ amountCents, date, merchant, confidence }` on a
 * successful read, or `{ error }` PRESERVING the failure reason — a transport
 * error (no key / rate-limited / out-of-credits / network / timeout) is never
 * collapsed together with "the model replied but found no total" (`no_total`)
 * — see `OcrImageFailure`. This is the ONLY LLM call in the pipeline, and it
 * only runs for image/PDF attachments — body receipts never reach it. PDF is
 * passed as an image_url data URL too (the cheap vision models accept
 * single-page receipt PDFs); multipage PDFs degrade to `no_total` →
 * `needs_review`, which is acceptable for receipts.
 *
 * `config` is resolved by the caller (via `readAiEngineConfig`) and `model` via
 * `resolveOcrModel`. On a typed engine error the human-readable reason is
 * logged (the owner's complaint was silent failures) AND returned — the
 * receipt still degrades to a recorded `ocrError`/`needs_review`, no throw
 * (the keyless-degrade contract).
 */
export async function ocrReceiptImage(
  config: AiEngineConfig,
  dataUrl: string,
  model: string,
): Promise<OcrImageResult> {
  const result = await chatCompletion(config, {
    model,
    messages: [
      {
        role: "system",
        content:
          "You extract the payment TOTAL and MERCHANT from a photo of a " +
          "receipt. Reply with a SINGLE JSON object and nothing else: " +
          '{"amount": <number, the grand total actually charged, in ' +
          'dollars, e.g. 42.10>, "date": "<YYYY-MM-DD or null>", ' +
          '"merchant": "<store/restaurant/business name or null>", ' +
          '"confidence": <0-1>}. ' +
          "The amount is the FINAL total paid (after tax/tip), not a " +
          "subtotal or a single line item. If you cannot read a clear " +
          "total, set amount to null and confidence to 0. Never guess. " +
          "For merchant, find the business name printed on the receipt — " +
          "usually the largest text or a logo at the very top, sometimes " +
          "repeated near the bottom or on the payment line. Make a BEST " +
          "EFFORT: if a plausible name is visible anywhere, even partial " +
          "or stylized, return it rather than null — do not require a " +
          "perfectly clean read. A DELIVERY-APP receipt (DoorDash, Uber " +
          "Eats, Grubhub, Instacart, etc.) usually names the restaurant " +
          "or store the order came from; use THAT name if it's legible, " +
          "and fall back to the delivery platform's own name only if no " +
          "restaurant/store name appears anywhere on the receipt. Only " +
          "return null for merchant if genuinely no business name is " +
          "visible on the receipt at all.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Extract the total and merchant name from this receipt.",
          },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    responseFormat: { type: "json_object" },
    maxTokens: 200,
    timeoutMs: OCR_TIMEOUT_MS,
  });
  if (!result.ok) {
    console.log(`[receiptInbox] OCR call failed: ${result.message}`);
    return {
      error: { kind: result.kind, status: result.status, message: result.message },
    };
  }
  const noTotal: OcrImageResult = {
    error: {
      kind: "no_total",
      status: null,
      message: "The model read the receipt but couldn't find a clear total.",
    },
  };
  let parsed: any;
  try {
    parsed = extractJson(result.content);
  } catch (err) {
    console.log(`[receiptInbox] OCR parse errored: ${String(err)}`);
    return noTotal;
  }
  if (!parsed) return noTotal;
  const amountCents =
    typeof parsed.amount === "number" && parsed.amount > 0
      ? Math.round(parsed.amount * 100)
      : null;
  if (amountCents == null) return noTotal;
  let date: number | null = null;
  if (typeof parsed.date === "string") {
    const t = Date.parse(parsed.date);
    if (Number.isFinite(t)) {
      const d = new Date(t);
      d.setHours(12, 0, 0, 0);
      date = d.getTime();
    }
  }
  const merchant =
    typeof parsed.merchant === "string" && parsed.merchant.trim()
      ? parsed.merchant.trim().slice(0, 200)
      : null;
  const confidence =
    typeof parsed.confidence === "number"
      ? Math.max(0, Math.min(1, parsed.confidence))
      : null;
  return { amountCents, date, merchant, confidence };
}

/**
 * Translate an `OcrImageFailure` into the SPECIFIC, actionable `ocrError`
 * string a bookkeeper sees on the receipt detail — the fix for "OCR read: —
 * · — · —" with no explanation (and, before this PR, every transport failure
 * ALSO collapsing into that same opaque message). `context` picks the
 * `no_total` wording: a scanned PDF that reached vision OCR keeps its
 * existing PDF-specific phrasing; a plain image gets the retry-oriented one.
 */
function ocrFailureMessage(
  failure: OcrImageFailure,
  provider: AiEngineConfig["provider"],
  context: "image" | "scanned_pdf",
): string {
  const label = provider === "ollama" ? "Ollama" : "OpenRouter";
  switch (failure.kind) {
    case "no_key":
      return "No AI engine key configured — set one in Settings → Integrations.";
    case "http":
      if (failure.status === 402) {
        return `AI request failed — ${label} returned HTTP 402 (out of credits). Switch the AI engine to Ollama in Settings, or add credits.`;
      }
      if (failure.status === 429) {
        return `AI request failed — ${label} returned HTTP 429 (rate limited) — try again shortly.`;
      }
      return `AI request failed — ${label} returned HTTP ${failure.status ?? "an error"}${
        failure.message ? `: ${failure.message}` : ""
      }`;
    case "timeout":
      return `AI request timed out contacting ${label} — try again shortly.`;
    case "network":
      return `AI request failed — couldn't reach ${label}. Check your connection and try again.`;
    case "parse":
      return `AI request failed — couldn't parse ${label}'s reply.`;
    case "no_total":
      return context === "scanned_pdf"
        ? "Scanned PDF — the vision model could not read a total off it."
        : "The model read the receipt but couldn't find a clear total — try Retry with a different model.";
    default:
      return `AI request failed — ${failure.message}`;
  }
}

/** Extract the first balanced JSON object from a model reply (mirrors
 *  `aiCoding.parseModelJson`, kept local to avoid a cross-module import). */
function extractJson(s: string): any | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ── Extraction routing (PDF text layer → vision OCR fallback) ────────────────
/** What one file's extraction attempt yielded — `ocrError` is always a
 *  human-readable reason when `ocrAmountCents` came back empty (the fix for
 *  "OCR read: — · — · —" with no explanation). */
export interface OcrRoutingResult {
  ocrAmountCents?: number;
  ocrDate?: number;
  ocrMerchant?: string;
  ocrConfidence?: number;
  ocrModel?: string;
  ocrError?: string;
}

/**
 * Route ONE stored file through extraction: a PDF tries its own TEXT LAYER
 * first (zero LLM — `receiptPdf.ts#extractPdfText`, an action→action call
 * across the Node boundary) and only falls back to the vision model
 * (`ocrReceiptImage`, untouched — see that function's own doc) when the PDF
 * has no usable text layer (a scanned/faxed receipt); anything else (an
 * image) goes straight to vision, exactly as before. Always resolves an
 * `ocrError` when extraction produced no total — the point of this PR: a
 * receipt detail that says WHY, not a silent "—".
 *
 * Shared by the email pipeline (`runPipeline`), the mass-upload pipeline
 * (`receipts.ts#runUploadPipeline`), and `receipts.ts#retryExtraction` — ONE
 * place decides "PDF text vs vision" so the three callers can't drift apart.
 */
export async function extractReceiptFields(
  ctx: ActionCtx,
  args: {
    storageId: Id<"_storage">;
    config: AiEngineConfig;
    blob: Blob;
    contentType: string;
    filename?: string;
    model: string;
  },
): Promise<OcrRoutingResult> {
  const { storageId, config, blob, contentType, filename, model } = args;

  if (isPdfContentType(contentType, filename)) {
    const { text } = await ctx.runAction(internal.receiptPdf.extractPdfText, {
      storageId,
    });
    if (isMeaningfulPdfText(text)) {
      const parsed = parseReceiptFromText(text);
      return {
        ocrAmountCents: parsed.amountCents ?? undefined,
        ocrDate: parsed.date ?? undefined,
        ocrMerchant: parsed.merchant ?? undefined,
        ocrConfidence: parsed.amountCents != null ? 0.7 : 0,
        ocrModel: PDF_TEXT_LAYER_PROVENANCE,
        ocrError:
          parsed.amountCents == null
            ? "Read the PDF's text but couldn't find a total on it."
            : undefined,
      };
    }
    // A SCANNED pdf — no usable text layer. Fall back to the vision model,
    // same as before this PR.
    const buf = await blob.arrayBuffer();
    const dataUrl = `data:${contentType};base64,${arrayBufferToBase64(buf)}`;
    const ocr = await ocrReceiptImage(config, dataUrl, model);
    if ("error" in ocr) {
      return {
        ocrModel: model,
        ocrError: ocrFailureMessage(ocr.error, config.provider, "scanned_pdf"),
      };
    }
    return {
      ocrAmountCents: ocr.amountCents ?? undefined,
      ocrDate: ocr.date ?? undefined,
      ocrMerchant: ocr.merchant ?? undefined,
      ocrConfidence: ocr.confidence ?? undefined,
      ocrModel: model,
    };
  }

  // An image (or anything else worth handing to the vision model).
  const buf = await blob.arrayBuffer();
  const dataUrl = `data:${contentType};base64,${arrayBufferToBase64(buf)}`;
  const ocr = await ocrReceiptImage(config, dataUrl, model);
  if ("error" in ocr) {
    return {
      ocrModel: model,
      ocrError: ocrFailureMessage(ocr.error, config.provider, "image"),
    };
  }
  return {
    ocrAmountCents: ocr.amountCents ?? undefined,
    ocrDate: ocr.date ?? undefined,
    ocrMerchant: ocr.merchant ?? undefined,
    ocrConfidence: ocr.confidence ?? undefined,
    ocrModel: model,
  };
}

// ── The pipeline action ──────────────────────────────────────────────────────
/** One extracted receipt (a stored file + its OCR read), before matching. */
interface ExtractedReceipt {
  storageId: Id<"_storage">;
  sourceKind: "attachment" | "body";
  filename?: string;
  ocrAmountCents?: number;
  ocrDate?: number;
  ocrMerchant?: string;
  ocrConfidence?: number;
  ocrModel?: string;
  ocrError?: string;
  candidateTransactionIds: Id<"transactions">[];
}

/**
 * Process ONE inbound receipt: classify sender → get content → OCR each →
 * match each → create documents + auto-attach-or-queue → reply. Scheduled by the
 * HTTP route right after `recordInboundReceipt` returns `isNew: true`. Every
 * terminal state is written back onto the row so the review queue is truthful.
 */
export const processInboundReceipt = internalAction({
  args: { receiptId: v.id("inboundReceipts") },
  returns: v.null(),
  handler: async (ctx, { receiptId }) => {
    const row = (await ctx.runQuery(internal.receiptInbox.getInboundReceipt, {
      receiptId,
    })) as Doc<"inboundReceipts"> | null;
    if (!row || row.status !== "pending") return null; // gone or already handled

    // CRASH SAFETY: any unexpected throw below would otherwise strand the row
    // in `pending` forever — invisible to every queue (nothing else ever sets
    // `error`). Terminal-status patches are the LAST write in every branch and
    // `replyToSender` swallows its own failures, so reaching this catch means
    // the row really is still unresolved.
    try {
      await runPipeline(ctx, receiptId, row);
    } catch (err) {
      console.error(`[receiptInbox] pipeline errored for ${receiptId}: ${String(err)}`);
      try {
        await ctx.runMutation(internal.receiptInbox.updateInboundReceipt, {
          receiptId,
          patch: {
            status: "error",
            detail: `Pipeline error: ${String(err).slice(0, 500)}`,
          },
        });
      } catch (patchErr) {
        console.error(`[receiptInbox] could not mark ${receiptId} errored: ${String(patchErr)}`);
      }
    }
    return null;
  },
});

/** The pipeline body — separated so `processInboundReceipt`'s catch can mark
 *  the row `error` on ANY throw (see the crash-safety comment there). */
async function runPipeline(
  ctx: ActionCtx,
  receiptId: Id<"inboundReceipts">,
  row: Doc<"inboundReceipts">,
): Promise<null> {
  // 1. Classify the sender. The gate is OPEN: every email is processed. The
  //    class only decides whether an auto-attach is permitted (team/roster) or
  //    the receipt must route to review (internal/external).
  const sender = await ctx.runQuery(internal.receiptInbox.classifySender, {
    email: row.fromEmail,
  });
  const isTrusted = receiptSenderCanAutoAttach(sender.senderClass);

  // 2. Get receipt content: EVERY usable image/PDF attachment (skipping
  //    almost-certainly-inline assets — logos, signatures, tracking pixels;
  //    see `isLikelyInlineAsset`), else the body. A PDF attachment tries its
  //    own text layer first (zero LLM) before ever reaching the vision model
  //    — see `extractReceiptFields`.
  const { attachments, skippedNames } = await fetchAllReceiptAttachments(row.emailId);
  const extracted: ExtractedReceipt[] = [];

  if (attachments.length > 0) {
    // Resolve the active AI engine (provider + key + global model) ONCE for the
    // whole email, then the OCR model for this provider.
    const config = await ctx.runQuery(
      internal.integrationSettings.readAiEngineConfig,
      {},
    );
    const model = resolveOcrModel(config);
    for (const att of attachments) {
      const storageId = await ctx.storage.store(att.blob);
      const result = await extractReceiptFields(ctx, {
        storageId,
        config,
        blob: att.blob,
        contentType: att.contentType,
        filename: att.filename,
        model,
      });
      extracted.push({
        storageId,
        sourceKind: "attachment",
        filename: att.filename,
        ocrAmountCents: result.ocrAmountCents,
        ocrDate: result.ocrDate,
        ocrMerchant: result.ocrMerchant,
        ocrConfidence: result.ocrConfidence,
        ocrModel: result.ocrModel,
        ocrError: result.ocrError,
        candidateTransactionIds: [],
      });
    }
  } else {
    // No usable attachment — the email BODY is the receipt (ZERO LLM). Stored
    // as a file too: an email receipt saved as a document IS the receipt, so a
    // unique match can auto-attach it exactly like a photo. HTML is stored as
    // text/html so the review UI renders it.
    const full = await fetchReceivedEmailBody(row.emailId);
    const text = full ?? row.subject ?? "";
    if (text.trim()) {
      const isHtml = /<[a-z][\s\S]*>/i.test(text);
      const storageId = await ctx.storage.store(
        new Blob([text], { type: isHtml ? "text/html" : "text/plain" }),
      );
      const parsed = parseReceiptFromText(text);
      extracted.push({
        storageId,
        sourceKind: "body",
        filename: "email body",
        ocrAmountCents: parsed.amountCents ?? undefined,
        ocrDate: parsed.date ?? undefined,
        ocrMerchant: parsed.merchant ?? undefined,
        ocrConfidence: parsed.amountCents != null ? 0.5 : 0,
        ocrError:
          parsed.amountCents == null
            ? "Couldn't find a total in the email body text."
            : undefined,
        candidateTransactionIds: [],
      });
    }
  }

  // 3. Nothing to OCR at all — non-receipt mail. Mark ignored (reserved now for
  //    dismissal + non-receipt mail) without inventing a receipt document.
  if (extracted.length === 0) {
    await ctx.runMutation(internal.receiptInbox.updateInboundReceipt, {
      receiptId,
      patch: {
        status: "ignored",
        senderClass: sender.senderClass,
        ...(sender.personId ? { personId: sender.personId } : {}),
        ...(sender.chapterId ? { chapterId: sender.chapterId } : {}),
        detail: appendSkippedNote(
          "No receipt image or readable body found in the email.",
          skippedNames,
        ),
      },
    });
    return null;
  }

  // 3b. Merchant FALLBACK: when extraction (body parse or vision OCR) found no
  //     merchant, derive one from the email envelope (`deriveMerchantFromEmail`
  //     — display name > sending domain > subject fragment) so `ocrMerchant`
  //     isn't left blank when the receipt itself carried no readable business
  //     name (e.g. a bare Givebutter donation confirmation). NEVER overwrites a
  //     real extracted merchant — only fills a gap.
  for (const ex of extracted) {
    if (!ex.ocrMerchant) {
      const fallback = deriveMerchantFromEmail(row.fromEmail, row.subject);
      if (fallback) ex.ocrMerchant = fallback;
    }
  }

  // 4. Match each extracted receipt against the sender-chapter's unreceipted
  //    spend. No chapter (unknown sender) → no candidates (nothing to match).
  if (sender.chapterId) {
    for (const ex of extracted) {
      if (ex.ocrAmountCents != null) {
        const candidates = await ctx.runQuery(
          internal.receiptInbox.findReceiptMatches,
          {
            chapterId: sender.chapterId,
            amountCents: ex.ocrAmountCents,
            receiptDate: ex.ocrDate ?? row.receivedAt,
            ocrMerchant: ex.ocrMerchant,
            senderPersonId: sender.personId ?? undefined,
          },
        );
        ex.candidateTransactionIds = candidates.map((c) => c.transactionId);
      }
    }
  }

  // 5. Create the receipt documents, auto-attach the ones the policy allows,
  //    and write the aggregate outcome onto the inbound row (one transaction).
  const result = await ctx.runMutation(
    internal.receiptInbox.commitInboundReceipts,
    {
      receiptId,
      personId: sender.personId ?? undefined,
      chapterId: sender.chapterId ?? undefined,
      senderClass: sender.senderClass,
      skippedAttachmentNames: skippedNames,
      extracted: extracted.map((ex) => ({
        storageId: ex.storageId,
        sourceKind: ex.sourceKind,
        filename: ex.filename,
        ocrAmountCents: ex.ocrAmountCents,
        ocrDate: ex.ocrDate,
        ocrMerchant: ex.ocrMerchant,
        ocrConfidence: ex.ocrConfidence,
        ocrModel: ex.ocrModel,
        ocrError: ex.ocrError,
        candidateTransactionIds: ex.candidateTransactionIds,
      })),
    },
  );

  // 6. Courtesy reply — ONLY to trusted (team/roster) senders. We never
  //    confirm-or-deny anything to a stranger (a spoofable From:).
  if (isTrusted) {
    const outcome =
      result.status === "matched"
        ? "matched"
        : result.status === "no_match"
          ? "no_match"
          : "needs_review";
    await replyToSender(ctx, row.fromEmail, outcome, {
      amountCents: result.amountCents,
      merchant: result.matchedMerchant ?? undefined,
    });
  }
  return null;
}

/**
 * Fetch the full received email's BODY text via the Resend API
 * (`GET /emails/receiving/{emailId}`). The webhook already carries text/html
 * but the body-parse path wants the fullest text available; falls back to null
 * (the caller then uses the subject). Best-effort.
 */
async function fetchReceivedEmailBody(emailId: string): Promise<string | null> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    return json?.text ?? json?.html ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort confirmation/needs-help reply to the sender (degrades to a no-op
 * without `RESEND_API_KEY`, same as every other outbound in this repo). Kept
 * plain-text-simple; the point is a human ack, not a designed email. Only ever
 * called for team/roster senders (never a stranger).
 */
async function replyToSender(
  ctx: Pick<ActionCtx, "runQuery">,
  to: string,
  outcome: "matched" | "no_match" | "needs_review",
  info: { amountCents: number | null; merchant?: string },
): Promise<void> {
  const amt = info.amountCents != null ? fmtUsd(info.amountCents) : "your receipt";
  let subject: string;
  let line: string;
  if (outcome === "matched") {
    subject = "Receipt matched ✓";
    line = `We matched ${amt}${info.merchant ? ` from ${info.merchant}` : ""} to a card charge and attached your receipt. Nothing else to do.`;
  } else if (outcome === "no_match") {
    subject = "Receipt received — no matching charge yet";
    line = `Thanks — we read ${amt}, but couldn't find a card charge for it yet. We've filed it for a bookkeeper to place. If the charge posts later, they'll attach it.`;
  } else {
    subject = "Receipt received — needs a quick look";
    line = `Thanks — we've received your receipt${info.amountCents != null ? ` for ${amt}` : ""} and filed it for a bookkeeper to attach to the right charge.`;
  }
  try {
    await sendEmail(ctx, {
      to,
      subject,
      html: `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#2b2320"><p>${line}</p><p style="color:#8a7d78;font-size:13px">— Public Worship finance</p></div>`,
    });
  } catch (err) {
    // Best-effort by contract: `sendEmail` can still throw on a NETWORK error
    // (its own catch only covers non-2xx). A failed courtesy reply must never
    // fail the pipeline — the terminal status is already written by now.
    console.log(`[receiptInbox] reply to sender failed: ${String(err)}`);
  }
}

// ── Review-queue surface (in-app, bookkeeper+) ───────────────────────────────
const reviewRow = v.object({
  _id: v.id("inboundReceipts"),
  status: statusValidator,
  fromEmail: v.string(),
  subject: v.optional(v.string()),
  receivedAt: v.number(),
  senderClass: v.optional(senderClassValidator),
  sourceKind: v.optional(v.union(v.literal("attachment"), v.literal("body"))),
  ocrAmountCents: v.optional(v.number()),
  ocrDate: v.optional(v.number()),
  ocrMerchant: v.optional(v.string()),
  ocrConfidence: v.optional(v.number()),
  detail: v.optional(v.string()),
  receiptUrl: v.union(v.string(), v.null()),
  candidateTransactionIds: v.optional(v.array(v.id("transactions"))),
  matchedTransactionId: v.optional(v.id("transactions")),
});

/**
 * The inbound-receipt review queue for a chapter (bookkeeper+). Lists the rows
 * a human needs to act on — `needs_review` and `no_match` by default — newest
 * first, with a servable URL for the stored receipt so the reviewer can eyeball
 * it. Scoped to the caller's chapter via the resolved `chapterId` on each row.
 * (Unknown-sender rows have no chapter and surface only in the org-wide view the
 * CRM PR adds; they are never stranded — `by_status` reads them without a chapter.)
 */
export const listInboundReceipts = query({
  args: {
    status: v.optional(statusValidator),
  },
  returns: v.array(reviewRow),
  handler: async (ctx, args) => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "bookkeeper");

    // Scan this chapter's rows (bounded) newest-first, filtered to the states a
    // human still needs to act on (or a specific requested status).
    const rows = await ctx.db
      .query("inboundReceipts")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .order("desc")
      .take(200);
    const wanted = args.status
      ? (r: Doc<"inboundReceipts">) => r.status === args.status
      : (r: Doc<"inboundReceipts">) =>
          r.status === "needs_review" || r.status === "no_match";
    const selected = rows.filter(wanted);

    return await Promise.all(
      selected.map(async (r) => ({
        _id: r._id,
        status: r.status,
        fromEmail: r.fromEmail,
        subject: r.subject,
        receivedAt: r.receivedAt,
        senderClass: r.senderClass,
        sourceKind: r.sourceKind,
        ocrAmountCents: r.ocrAmountCents,
        ocrDate: r.ocrDate,
        ocrMerchant: r.ocrMerchant,
        ocrConfidence: r.ocrConfidence,
        detail: r.detail,
        receiptUrl: r.receiptStorageId
          ? await ctx.storage.getUrl(r.receiptStorageId)
          : null,
        candidateTransactionIds: r.candidateTransactionIds,
        matchedTransactionId: r.matchedTransactionId,
      })),
    );
  },
});

/**
 * A bookkeeper manually attaches a `needs_review`/`no_match` inbound receipt to
 * a chosen transaction — the human resolution for everything the auto-matcher
 * declined (an ambiguous match, an untrusted sender, an unknown chapter).
 * Requires bookkeeper+ in the row's chapter, the row to still be open, a stored
 * receipt file, and the target txn to be in the same chapter. Routes through the
 * receipts layer: it reuses the `receipts` document the pipeline created (found
 * via `by_inbound`), or creates one from the inbound row when none exists (a
 * legacy row), then links it (`manual`) — so the money-adjacent effect (attach +
 * maybe-reconcile + card unlock) is identical to the auto path.
 */
export const manualMatchInboundReceipt = mutation({
  args: {
    receiptId: v.id("inboundReceipts"),
    transactionId: v.id("transactions"),
  },
  returns: v.object({ reconciled: v.boolean() }),
  handler: async (ctx, args) => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) {
      throw new ConvexError({ code: "FORBIDDEN", message: "No chapter in context." });
    }
    const access = await getFinanceRole(ctx, chapterId);
    if (!financeRoleAtLeast(access.role, "bookkeeper")) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: `Attaching an inbound receipt needs at least the ${FINANCE_ROLE_LABELS.bookkeeper} finance role.`,
      });
    }
    const row = await ctx.db.get(args.receiptId);
    if (!row) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Inbound receipt not found." });
    }
    if (row.chapterId !== chapterId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Inbound receipt not found in your chapter." });
    }
    if (row.status === "matched") {
      throw new ConvexError({ code: "CONFLICT", message: "This receipt is already attached." });
    }
    if (!row.receiptStorageId) {
      throw new ConvexError({
        code: "UNSUPPORTED",
        message: "This inbound email had no receipt file to attach.",
      });
    }
    const txn = await ctx.db.get(args.transactionId);
    if (!txn || txn.chapterId !== chapterId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Transaction not found in your chapter." });
    }

    // Reuse the receipt document the pipeline created for this email (matched by
    // its stored file), or mint one from the inbound row (legacy rows predating
    // the receipts layer, or a test-seeded row). Canonical fields seed from the
    // inbound OCR read.
    const existing = await ctx.db
      .query("receipts")
      .withIndex("by_inbound", (q) => q.eq("inboundReceiptId", args.receiptId))
      .take(50);
    let receiptDocId =
      existing.find((r) => r.storageId === row.receiptStorageId)?._id ??
      existing[0]?._id;
    if (!receiptDocId) {
      receiptDocId = await createReceipt(ctx, {
        chapterId: row.chapterId,
        storageId: row.receiptStorageId,
        source: "email",
        inboundReceiptId: args.receiptId,
        senderClass: row.senderClass,
        ocrAmountCents: row.ocrAmountCents,
        ocrDate: row.ocrDate,
        ocrMerchant: row.ocrMerchant,
        ocrConfidence: row.ocrConfidence,
        ocrModel: row.ocrModel,
      });
    }

    const person = access.personId ?? undefined;
    const result = await linkReceiptToTransaction(ctx, {
      receiptId: receiptDocId,
      transactionId: args.transactionId,
      source: "manual",
      linkedByPersonId: person,
      reconcileIfCategorized: true,
    });

    await ctx.db.patch(args.receiptId, {
      status: "matched",
      matchedTransactionId: args.transactionId,
      resolvedByPersonId: person,
      resolvedAt: Date.now(),
      updatedAt: Date.now(),
      detail: `Attached to a charge by a bookkeeper${result.reconciled ? " and reconciled" : ""}.`,
    });
    return { reconciled: result.reconciled };
  },
});

/** Dismiss an inbound receipt row a bookkeeper has decided needs no action
 *  (spam, a duplicate, a non-receipt). Marks it `ignored` and — routing through
 *  the new layer — deletes any UNLINKED receipt documents the pipeline created
 *  from it (a linked one means a human already matched it, so the row wouldn't
 *  be dismissable). Bookkeeper+. */
export const dismissInboundReceipt = mutation({
  args: { receiptId: v.id("inboundReceipts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) {
      throw new ConvexError({ code: "FORBIDDEN", message: "No chapter in context." });
    }
    const access = await getFinanceRole(ctx, chapterId);
    if (!financeRoleAtLeast(access.role, "bookkeeper")) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: `Dismissing an inbound receipt needs at least the ${FINANCE_ROLE_LABELS.bookkeeper} finance role.`,
      });
    }
    const row = await ctx.db.get(args.receiptId);
    if (!row || row.chapterId !== chapterId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Inbound receipt not found in your chapter." });
    }
    if (row.status === "matched") {
      throw new ConvexError({ code: "CONFLICT", message: "This receipt is attached; it can't be dismissed." });
    }
    // Clean up the unmatched receipt documents this email produced — a dismissed
    // email must not leave orphan receipts in the "unmatched" view. Never touch
    // a LINKED receipt (linkCount > 0): that's a human-made attachment.
    const receiptDocs = await ctx.db
      .query("receipts")
      .withIndex("by_inbound", (q) => q.eq("inboundReceiptId", args.receiptId))
      .take(50);
    for (const doc of receiptDocs) {
      if (doc.linkCount === 0) await ctx.db.delete(doc._id);
    }
    await ctx.db.patch(args.receiptId, {
      status: "ignored",
      resolvedByPersonId: access.personId ?? undefined,
      resolvedAt: Date.now(),
      updatedAt: Date.now(),
      detail: "Dismissed by a bookkeeper.",
    });
    return null;
  },
});
