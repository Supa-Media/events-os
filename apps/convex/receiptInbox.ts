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
 *        a. Resolves the SENDER to a `people` row (`resolvePersonByEmail`). An
 *           unknown sender → `ignored` (the endpoint is public; roster
 *           membership is the auth gate). This also fixes the chapter to match
 *           against.
 *        b. Gets the receipt content: prefers a real image/PDF ATTACHMENT
 *           (fetched via the Resend Attachments API), else falls back to the
 *           email BODY text (the "just an email" receipts).
 *        c. Extracts { amountCents, date, merchant }:
 *             - BODY receipts are parsed with a plain in-Convex heuristic
 *               (`parseReceiptFromText`) — ZERO LLM.
 *             - IMAGE/PDF receipts go to a cheap multimodal model via OpenRouter
 *               (`ocrReceiptImage`) — the only LLM call, and only for photos.
 *        d. Matches against the sender-chapter's UNRECEIPTED spend within a
 *           date window at the EXACT cent (`findReceiptMatches`).
 *        e. Exactly ONE candidate → `attachMatchedReceipt` (auto): attaches the
 *           file (counts as "receipt uploaded"), flips `reconciled` only if the
 *           txn was already `categorized`, and unlocks the card. 0 or >1, or an
 *           unreadable total → `needs_review`/`no_match` for a bookkeeper.
 *        f. Replies to the sender (best-effort) with the outcome.
 *
 * MONEY SAFETY: the model NEVER moves money and NEVER categorizes here — it
 * only reads a total off a receipt. The only write that touches a transaction
 * is `attachMatchedReceipt`, and it only ever attaches a receipt + (maybe)
 * flips an already-categorized txn to reconciled. Ambiguity always defers to a
 * human. This mirrors the AI-coding rule ("a human confirms; the model never
 * moves money", `aiCoding.ts`).
 */
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  internalAction,
} from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  INBOUND_RECEIPT_STATUSES,
  FINANCE_TIMEZONE,
  financeRoleAtLeast,
  FINANCE_ROLE_LABELS,
} from "@events-os/shared";
import { ROLLUP_SCAN_LIMIT, txnMatchesMode, isSpend } from "./finances";
import { readSandbox } from "./financeSettings";
import { normalizeEmail } from "./lib/access";
import { getChapterIdOrNull } from "./lib/context";
import { getFinanceRole, requireFinanceRole } from "./lib/finance";
import { unlockCardIfReceiptsResolved } from "./cards";
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
/** Abort a single OpenRouter OCR completion if it hangs longer than this. */
const OCR_TIMEOUT_MS = 60_000;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
/** The multimodal model receipt-image OCR calls. Config, not code: overridable
 *  via `RECEIPT_OCR_MODEL` so the owner can point it at a FREE/cheap vision
 *  model (the preference) or upgrade if scan quality is weak. Defaults to a
 *  low-cost vision-capable model. */
function ocrModel(): string {
  return process.env.RECEIPT_OCR_MODEL ?? "google/gemini-2.0-flash-001";
}

// ── Validators ───────────────────────────────────────────────────────────────
const statusValidator = v.union(
  ...INBOUND_RECEIPT_STATUSES.map((s) => v.literal(s)),
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

// ── Sender resolution (the auth gate) ────────────────────────────────────────
/**
 * Resolve a raw sender address to a roster `people` row. Matches against both
 * the personal `email` and the Public Worship `pwEmail` (core-team cardholders
 * commonly send from the latter).
 *
 * `people.email` is stored AS ENTERED (not normalized), so the `by_email` index
 * is only a fast path for the already-lowercase common case; a bounded scan
 * comparing NORMALIZED addresses is the correctness backstop (it also covers
 * the unindexed `pwEmail`). Volume here is low (a backfill webhook), so the
 * fallback scan is acceptable. Returns the first match with its chapter, or
 * null (→ the email is `ignored`).
 */
export const resolvePersonByEmail = internalQuery({
  args: { email: v.string() },
  returns: v.union(
    v.object({ personId: v.id("people"), chapterId: v.id("chapters") }),
    v.null(),
  ),
  handler: async (ctx, { email }) => {
    // `from` may arrive in display form ("Jane Doe <jane@x.com>") — strip to
    // the bare normalized address before matching.
    const normalized = extractEmailAddress(email);
    if (!normalized) return null;
    // Fast path: an exactly-stored (lowercase) personal email.
    const byEmail = await ctx.db
      .query("people")
      .withIndex("by_email", (q) => q.eq("email", normalized))
      .first();
    if (byEmail) {
      return { personId: byEmail._id, chapterId: byEmail.chapterId };
    }
    // Correctness backstop: bounded scan comparing normalized `email`/`pwEmail`
    // (catches mixed-case stored addresses and the secondary PW address).
    const scan = await ctx.db.query("people").take(ROLLUP_SCAN_LIMIT);
    const match = scan.find(
      (p) =>
        (p.email && normalizeEmail(p.email) === normalized) ||
        (p.pwEmail && normalizeEmail(p.pwEmail) === normalized),
    );
    if (match) return { personId: match._id, chapterId: match.chapterId };
    return null;
  },
});

// ── The matcher ──────────────────────────────────────────────────────────────
/** One candidate transaction the matcher surfaces. */
const candidateValidator = v.object({
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
export const findReceiptMatches = internalQuery({
  args: {
    chapterId: v.id("chapters"),
    amountCents: v.number(),
    receiptDate: v.number(),
    ocrMerchant: v.optional(v.string()),
    senderPersonId: v.optional(v.id("people")),
  },
  returns: v.array(candidateValidator),
  handler: async (ctx, args) => {
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
  },
});

// ── Attach the matched receipt (the ONE money-adjacent write) ────────────────
/**
 * Attach a stored receipt to a transaction, internally (no user in scope — the
 * pipeline runs as a scheduled action). Mirrors `finances.attachReceipt`'s
 * effect: sets `receiptStorageId`, clears the reminder timeline, and re-checks
 * the card's receipt-lock — PLUS flips `categorized` → `reconciled` (a receipt
 * on an already-coded charge is a fully reconciled charge). An `unreviewed`
 * charge is left for the AI coder / human to categorize; we never invent a
 * categorization. Idempotent-ish: refuses to clobber a receipt that already
 * landed (a human or a race got there first) — returns `attached: false`.
 */
/**
 * The shared attach effect, so the AUTO path (`attachMatchedReceipt`) and the
 * MANUAL path (`manualMatchInboundReceipt`) are byte-identical in what they do
 * to a transaction. Mirrors `finances.attachReceipt`'s core: sets
 * `receiptStorageId`, clears the reminder timeline, flips `categorized` →
 * `reconciled`, and re-checks the card's receipt-lock. Refuses to clobber a
 * receipt that already landed (`attached: false`).
 */
async function applyReceiptAttachment(
  ctx: MutationCtx,
  transactionId: Id<"transactions">,
  storageId: Id<"_storage">,
): Promise<{ attached: boolean; reconciled: boolean }> {
  const txn = await ctx.db.get(transactionId);
  if (!txn) return { attached: false, reconciled: false };
  if (txn.receiptStorageId != null) {
    // Someone (or another inbound email) already attached one — don't stomp.
    return { attached: false, reconciled: false };
  }
  const reconcile = txn.status === "categorized";
  await ctx.db.patch(transactionId, {
    receiptStorageId: storageId,
    receiptReminderStage: undefined,
    lastReminderSentAt: undefined,
    ...(reconcile ? { status: "reconciled" as const } : {}),
  });
  if (txn.cardId) {
    // Re-check the card's receipt-lock right away (same as `attachReceipt`).
    await unlockCardIfReceiptsResolved(ctx, txn.cardId);
  }
  return { attached: true, reconciled: reconcile };
}

/** The AUTO path's attach — an internal mutation the pipeline action invokes
 *  via `ctx.runMutation`. Thin wrapper over `applyReceiptAttachment`. */
export const attachMatchedReceipt = internalMutation({
  args: {
    transactionId: v.id("transactions"),
    storageId: v.id("_storage"),
  },
  returns: v.object({ attached: v.boolean(), reconciled: v.boolean() }),
  handler: async (ctx, args) =>
    await applyReceiptAttachment(ctx, args.transactionId, args.storageId),
});

// ── Row lifecycle mutations (called by the action) ───────────────────────────
/** Load a receipt row for the action (internal). */
export const getInboundReceipt = internalQuery({
  args: { receiptId: v.id("inboundReceipts") },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, { receiptId }) => await ctx.db.get(receiptId),
});

/** Patch a receipt row's resolved sender / chapter / stored file / OCR result /
 *  status / detail. One narrow write the action funnels every state change
 *  through, always bumping `updatedAt`. */
export const updateInboundReceipt = internalMutation({
  args: {
    receiptId: v.id("inboundReceipts"),
    patch: v.object({
      status: v.optional(statusValidator),
      personId: v.optional(v.id("people")),
      chapterId: v.optional(v.id("chapters")),
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

// ── Text-receipt parsing (ZERO LLM — the "just an email" receipts) ───────────
/**
 * Best-effort extraction of a { amountCents, date?, merchant? } from an email
 * BODY (plain text or stripped HTML). Deliberately conservative: it looks for a
 * labelled total ("total", "amount", "amount paid", "grand total", "charged")
 * and takes the LARGEST currency figure on such a line; if no labelled line is
 * found it falls back to the largest currency figure anywhere (receipts lead
 * with the total far more often than not). Returns `null` amount when it can't
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

  return { amountCents, date, merchant: null };
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

/**
 * List a received email's attachments via the Resend API
 * (`GET /emails/receiving/{emailId}/attachments`) and return the first one that
 * looks like a receipt image or PDF, downloaded as a Blob. The `download_url`
 * is a short-lived signed CloudFront URL (no auth header needed for the
 * download itself; the LIST call needs the API key). Returns null when there's
 * no usable attachment or the API key / network is unavailable.
 */
async function fetchFirstReceiptAttachment(
  emailId: string,
): Promise<{ blob: Blob; contentType: string; filename: string } | null> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log("[receiptInbox] RESEND_API_KEY unset — cannot fetch attachments.");
    return null;
  }
  let list: ResendAttachment[];
  try {
    const res = await fetch(
      `https://api.resend.com/emails/receiving/${emailId}/attachments`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!res.ok) {
      console.log(`[receiptInbox] attachment list failed (${res.status}).`);
      return null;
    }
    const json: any = await res.json();
    list = (Array.isArray(json) ? json : json?.data) ?? [];
  } catch (err) {
    console.log(`[receiptInbox] attachment list errored: ${String(err)}`);
    return null;
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
  const target = list.find((a) => isReceiptFile(a) && a.download_url);
  if (!target?.download_url) return null;

  try {
    const dl = await fetch(target.download_url);
    if (!dl.ok) {
      console.log(`[receiptInbox] attachment download failed (${dl.status}).`);
      return null;
    }
    const blob = await dl.blob();
    return {
      blob,
      contentType: target.content_type ?? blob.type ?? "application/octet-stream",
      filename: target.filename ?? "receipt",
    };
  } catch (err) {
    console.log(`[receiptInbox] attachment download errored: ${String(err)}`);
    return null;
  }
}

/** Base64-encode an ArrayBuffer for a data: URL (chunked to avoid arg limits). */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * OCR a receipt IMAGE with a multimodal model via OpenRouter (raw fetch, the
 * `aiActions.ts` convention). Returns { amountCents, date, merchant, confidence }
 * or null on any failure (no key, network, unparseable). This is the ONLY LLM
 * call in the pipeline, and it only runs for image/PDF attachments — body
 * receipts never reach it. PDF is passed as an image_url data URL too (the
 * cheap vision models accept single-page receipt PDFs); multipage PDFs degrade
 * to "couldn't read" → `needs_review`, which is acceptable for receipts.
 */
async function ocrReceiptImage(
  dataUrl: string,
  model: string,
): Promise<{
  amountCents: number | null;
  date: number | null;
  merchant: string | null;
  confidence: number | null;
} | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.log("[receiptInbox] OPENROUTER_API_KEY unset — skipping image OCR.");
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://events-os.app",
        "X-OpenRouter-Title": "Chapter OS",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You extract the payment TOTAL from a photo of a receipt. Reply " +
              "with a SINGLE JSON object and nothing else: " +
              '{"amount": <number, the grand total actually charged, in ' +
              'dollars, e.g. 42.10>, "date": "<YYYY-MM-DD or null>", ' +
              '"merchant": "<store name or null>", "confidence": <0-1>}. ' +
              "The amount is the FINAL total paid (after tax/tip), not a " +
              "subtotal or a single line item. If you cannot read a clear " +
              "total, set amount to null and confidence to 0. Never guess.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Extract the total from this receipt." },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        response_format: { type: "json_object" },
        max_tokens: 200,
        usage: { include: true },
      }),
    });
    if (!res.ok) {
      console.log(`[receiptInbox] OCR call failed (${res.status}).`);
      return null;
    }
    const json: any = await res.json();
    const content: string = json?.choices?.[0]?.message?.content ?? "";
    const parsed = extractJson(content);
    if (!parsed) return null;
    const amountCents =
      typeof parsed.amount === "number" && parsed.amount > 0
        ? Math.round(parsed.amount * 100)
        : null;
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
  } catch (err) {
    console.log(`[receiptInbox] OCR request errored: ${String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
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

// ── The pipeline action ──────────────────────────────────────────────────────
/**
 * Process ONE inbound receipt: resolve sender → get content → OCR → match →
 * attach-or-queue → reply. Scheduled by the HTTP route right after
 * `recordInboundReceipt` returns `isNew: true`. Every terminal state is written
 * back onto the row (`updateInboundReceipt`) so the review queue is truthful.
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
    // 1. Sender must be on the roster (auth gate for a public endpoint).
    const sender = await ctx.runQuery(internal.receiptInbox.resolvePersonByEmail, {
      email: row.fromEmail,
    });
    if (!sender) {
      await ctx.runMutation(internal.receiptInbox.updateInboundReceipt, {
        receiptId,
        patch: {
          status: "ignored",
          detail: `Sender ${row.fromEmail} is not on the roster — ignored.`,
        },
      });
      return null;
    }

    // 2. Get receipt content: prefer an image/PDF attachment, else the body.
    const attachment = await fetchFirstReceiptAttachment(row.emailId);
    let storageId: Id<"_storage"> | undefined;
    let sourceKind: "attachment" | "body";
    let ocr: {
      amountCents: number | null;
      date: number | null;
      merchant: string | null;
      confidence: number | null;
    } | null;
    let usedModel: string | undefined;

    if (attachment) {
      sourceKind = "attachment";
      storageId = await ctx.storage.store(attachment.blob);
      const buf = await attachment.blob.arrayBuffer();
      const dataUrl = `data:${attachment.contentType};base64,${arrayBufferToBase64(buf)}`;
      usedModel = ocrModel();
      ocr = await ocrReceiptImage(dataUrl, usedModel);
    } else {
      // No usable attachment — the email BODY is the receipt (ZERO LLM). The
      // body is STORED as a file too: an email receipt saved as a document IS
      // the receipt ("some of the receipts are just emails" — the whole point
      // of the backfill), so a unique match can auto-attach it exactly like a
      // photo. HTML is stored as text/html so the review UI renders it.
      sourceKind = "body";
      const full = await fetchReceivedEmailBody(row.emailId);
      const text = full ?? row.subject ?? "";
      if (text.trim()) {
        const isHtml = /<[a-z][\s\S]*>/i.test(text);
        storageId = await ctx.storage.store(
          new Blob([text], { type: isHtml ? "text/html" : "text/plain" }),
        );
      }
      const parsed = parseReceiptFromText(text);
      ocr = { ...parsed, confidence: parsed.amountCents != null ? 0.5 : 0 };
    }

    const amountCents = ocr?.amountCents ?? null;
    const receiptDate = ocr?.date ?? row.receivedAt;
    const merchant = ocr?.merchant ?? undefined;

    // Persist the resolved sender + stored file + OCR read regardless of match.
    const basePatch = {
      personId: sender.personId,
      chapterId: sender.chapterId,
      ...(storageId ? { receiptStorageId: storageId } : {}),
      sourceKind,
      ...(amountCents != null ? { ocrAmountCents: amountCents } : {}),
      ...(ocr?.date != null ? { ocrDate: ocr.date } : {}),
      ...(merchant ? { ocrMerchant: merchant } : {}),
      ...(usedModel ? { ocrModel: usedModel } : {}),
      ...(ocr?.confidence != null ? { ocrConfidence: ocr.confidence } : {}),
    };

    // 3. Unreadable total → needs_review (a human can eyeball the stored file).
    if (amountCents == null) {
      await ctx.runMutation(internal.receiptInbox.updateInboundReceipt, {
        receiptId,
        patch: {
          ...basePatch,
          status: "needs_review",
          detail:
            sourceKind === "attachment"
              ? "Could not read a total off the receipt image — needs a human."
              : "No total found in the email body — needs a human.",
        },
      });
      await replyToSender(row.fromEmail, "needs_review", { amountCents: null });
      return null;
    }

    // 4. Match against the sender-chapter's unreceipted spend.
    const candidates = await ctx.runQuery(internal.receiptInbox.findReceiptMatches, {
      chapterId: sender.chapterId,
      amountCents,
      receiptDate,
      ocrMerchant: merchant,
      senderPersonId: sender.personId,
    });

    if (candidates.length === 0) {
      await ctx.runMutation(internal.receiptInbox.updateInboundReceipt, {
        receiptId,
        patch: {
          ...basePatch,
          status: "no_match",
          detail: `No unreceipted charge for ${fmtUsd(amountCents)} within ±14 days of ${shortDate(receiptDate)}.`,
        },
      });
      await replyToSender(row.fromEmail, "no_match", { amountCents });
      return null;
    }

    if (candidates.length > 1) {
      await ctx.runMutation(internal.receiptInbox.updateInboundReceipt, {
        receiptId,
        patch: {
          ...basePatch,
          status: "needs_review",
          candidateTransactionIds: candidates.map((c) => c.transactionId),
          detail: `${candidates.length} charges match ${fmtUsd(amountCents)} — pick the right one.`,
        },
      });
      await replyToSender(row.fromEmail, "needs_review", { amountCents });
      return null;
    }

    // 5. Exactly one candidate → auto-attach (only if we have a stored file).
    const only = candidates[0];
    if (!storageId) {
      // A body-only receipt with a unique amount match: we matched but have no
      // file to attach. Surface for review rather than silently dropping it.
      await ctx.runMutation(internal.receiptInbox.updateInboundReceipt, {
        receiptId,
        patch: {
          ...basePatch,
          status: "needs_review",
          candidateTransactionIds: [only.transactionId],
          detail: `Matched ${fmtUsd(amountCents)} to one charge, but the email had no receipt file to attach.`,
        },
      });
      await replyToSender(row.fromEmail, "needs_review", { amountCents });
      return null;
    }

    const result = await ctx.runMutation(internal.receiptInbox.attachMatchedReceipt, {
      transactionId: only.transactionId,
      storageId,
    });
    if (!result.attached) {
      await ctx.runMutation(internal.receiptInbox.updateInboundReceipt, {
        receiptId,
        patch: {
          ...basePatch,
          status: "needs_review",
          candidateTransactionIds: [only.transactionId],
          detail: "The matched charge already had a receipt — needs a human.",
        },
      });
      await replyToSender(row.fromEmail, "needs_review", { amountCents });
      return null;
    }

    await ctx.runMutation(internal.receiptInbox.updateInboundReceipt, {
      receiptId,
      patch: {
        ...basePatch,
        status: "matched",
        matchedTransactionId: only.transactionId,
        detail: `Attached to ${only.merchantName ?? only.description ?? "a charge"} (${fmtUsd(amountCents)}, ${shortDate(only.postedAt)})${result.reconciled ? " and reconciled" : ""}.`,
      },
    });
    await replyToSender(row.fromEmail, "matched", {
      amountCents,
      merchant: only.merchantName ?? only.description ?? undefined,
    });
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
 * plain-text-simple; the point is a human ack, not a designed email.
 */
async function replyToSender(
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
    await sendEmail(
      to,
      subject,
      `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#2b2320"><p>${line}</p><p style="color:#8a7d78;font-size:13px">— Public Worship finance</p></div>`,
    );
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
 * declined. Requires bookkeeper+ in the row's chapter, the row to still be
 * open, a stored receipt file, and the target txn to be in the same chapter and
 * receipt-free. Reuses `attachMatchedReceipt` so the money-adjacent effect is
 * IDENTICAL to the auto path (attach + maybe-reconcile + card unlock).
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
    const result = await applyReceiptAttachment(
      ctx,
      args.transactionId,
      row.receiptStorageId,
    );
    if (!result.attached) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "That transaction already has a receipt.",
      });
    }
    const person = access.personId ?? undefined;
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
 *  (spam, a duplicate, a non-receipt). Marks it `ignored`. Bookkeeper+. */
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
