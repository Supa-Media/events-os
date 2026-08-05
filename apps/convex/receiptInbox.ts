/**
 * Inbound-email → OCR → reconcile pipeline (the receipt-backfill keystone).
 *
 * FLOW (see `http.ts` `/resend/inbound` for the entry point):
 *   1. Resend delivers a signed `email.received` webhook when a message lands
 *      at `reply.publicworship.life` — either sent straight there, or RELAYED
 *      by the `receipts@publicworship.life` Google Group, which our inbound
 *      address is a member of (the shape humans actually use). The route
 *      matches on To + Cc + `received_for` because a relayed post names the
 *      GROUP in `To:` and only names us on the envelope. The HTTP route
 *      verifies the Svix/Standard
 *      Webhooks signature, then calls `recordInboundReceipt` — which DEDUPES on
 *      the provider's `emailId` (the same first-sight guard `webhookEvents`
 *      gives the Stripe/Increase handlers) and inserts a `pending` row.
 *   2. The route schedules `processInboundReceipt` (an action) and returns 200
 *      fast — the webhook must ack quickly; all the slow work is async.
 *   3. `processInboundReceipt`:
 *        a0. RECOVERS the true sender behind a list relay (`resolveListSender`)
 *           — the Google Group rewrites `From:` for DMARC-strict posters, so
 *           the poster is read back off `X-Original-Sender` before classifying.
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
  OLLAMA_FALLBACK_OCR_MODEL,
  type ReceiptSenderClass,
} from "@events-os/shared";
import {
  chatCompletion,
  type AiEngineConfig,
  type ChatErrorKind,
} from "./lib/aiEngine";
import { ROLLUP_SCAN_LIMIT, txnMatchesMode, isSpend } from "./finances";
import { scheduleAutoRetryExtraction } from "./lib/receiptRetry";
import { readSandbox } from "./financeSettings";
import { normalizeEmail, isAllowedEmail, ALLOWED_EMAIL_DOMAIN } from "./lib/access";
import { getChapterIdOrNull } from "./lib/context";
import { getFinanceRole, requireFinanceRole } from "./lib/finance";
import {
  createReceipt,
  linkReceiptToTransaction,
  findDuplicateReceiptBySha256,
} from "./lib/receiptLinks";
import { sendEmail } from "./ticketingEmails";
import {
  isEmailMessageAttachment,
  parseEmlMessage,
  type ParsedEmlMessage,
} from "./lib/emlMessage";

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
/** How many receipt sources one email may yield AFTER forwarded-message
 *  expansion. A single `.eml` attachment can itself carry several receipts,
 *  and a "forward as attachment" batch can carry several `.eml`s (the shape
 *  that motivated this — a whole month of invoices forwarded at once), so the
 *  post-expansion ceiling is deliberately higher than `MAX_ATTACHMENTS`.
 *  Anything past it is reported in the row's detail, never silently dropped. */
const MAX_RECEIPT_SOURCES = 25;
/** Abort a single OCR completion if it hangs longer than this. */
const OCR_TIMEOUT_MS = 60_000;
/** How many pages of a SCANNED pdf `extractReceiptFields` will render and
 *  hand to vision in one call. A receipt is almost always a single page;
 *  bounding it keeps a stray multi-page fax/statement from ballooning the
 *  vision payload (and the render cost) unboundedly. */
export const SCANNED_PDF_RENDER_MAX_PAGES = 3;
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

/** The OpenRouter model the LAST automatic retry falls back to — a different
 *  vendor's vision model, so a provider-side fault with the primary isn't
 *  simply re-asked. Overridable via `RECEIPT_OCR_FALLBACK_MODEL`. */
export function fallbackOcrModel(): string {
  return process.env.RECEIPT_OCR_FALLBACK_MODEL ?? "openai/gpt-4o-mini";
}

/**
 * The SECOND vision model to try when the resolved OCR model keeps failing
 * for transport reasons (see `lib/receiptRetry.ts`). Returns `null` when
 * there's no meaningfully different model to try — a fallback identical to
 * what just failed is a wasted call, and the honest outcome is the engine's
 * own error on the card.
 *
 * Deliberately ignores a stored/overridden `aiOcrModel` when picking the
 * fallback: the point is to escape the model that is failing, whatever put it
 * in place. The model that actually produced the read is recorded on the
 * receipt, so a fallback read is never mistaken for the configured one.
 */
export function resolveFallbackOcrModel(
  config: Pick<AiEngineConfig, "provider" | "ocrModel">,
  primary: string,
): string | null {
  const fallback =
    config.provider === "ollama" ? OLLAMA_FALLBACK_OCR_MODEL : fallbackOcrModel();
  return fallback.trim() && fallback.trim() !== primary.trim() ? fallback.trim() : null;
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

/**
 * True iff an address's domain carries NO merchant identity — neither its
 * domain label NOR its display name is worth reading as a business name:
 *  - a free mail host (`GENERIC_EMAIL_DOMAINS`) — the display name there is a
 *    HUMAN's name ("Charisma S."), which is exactly what a forwarded receipt
 *    puts in the outer envelope, and
 *  - our OWN domain, including the inbound/list subdomains
 *    (`publicworship.life`, `reply.publicworship.life`) — a receipt is never
 *    "from" us, and a Google-Group-relayed post whose `From:` the list
 *    rewrote ("Charisma S. via receipts <receipts@publicworship.life>") would
 *    otherwise derive "Publicworship" (or the list's own display name) as the
 *    merchant.
 */
function isMerchantlessDomain(domain: string): boolean {
  return (
    GENERIC_EMAIL_DOMAINS.has(domain) ||
    domain === ALLOWED_EMAIL_DOMAIN ||
    domain.endsWith(`.${ALLOWED_EMAIL_DOMAIN}`)
  );
}

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
 * when extraction (body parse or vision OCR) found no merchant, or only a
 * weak line-shape guess (see `runPipeline`'s merchant-fallback step). Tries,
 * in order:
 *   1. A real RFC-5322 DISPLAY NAME ("Givebutter" <receipts@givebutter.com>"
 *      → "Givebutter") — the highest-confidence signal, a sender chose it.
 *      SKIPPED for a merchantless domain (`isMerchantlessDomain`), where the
 *      display name is a person's or a mailing list's, never a business's.
 *   2. The sending domain's second-level label, title-cased
 *      ("noreply@doordash.com" → "Doordash") — likewise skipped for a
 *      merchantless domain.
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
  const addr = extractEmailAddress(fromEmail);
  const domain = addr?.split("@")[1];
  const merchantless = domain != null && isMerchantlessDomain(domain);

  if (!merchantless) {
    const displayMatch = fromEmail.match(/^\s*"?([^"<]{2,60}?)"?\s*<[^>]+>\s*$/);
    if (displayMatch) {
      const name = displayMatch[1].trim();
      if (name && !name.includes("@")) return name.slice(0, 200);
    }

    if (domain) {
      const label = domain.split(".").slice(0, -1).join(" ") || domain;
      const cleaned = label.replace(/[-_]/g, " ").trim();
      if (cleaned.length >= 2 && cleaned.length <= 40) {
        return cleaned
          .split(/\s+/)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");
      }
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
 * The addresses that mean "this is a receipt".
 *
 * TWO of them, because there are two ways to reach the inbox:
 *  - `receipts@reply.publicworship.life` — the Resend inbound address itself
 *    (mail sent straight here), and
 *  - `receipts@publicworship.life` — the GOOGLE GROUP humans actually know.
 *    The Resend address is a MEMBER of that group, so Google relays every post
 *    to us. A relayed post keeps the GROUP address in its `To:` header (the
 *    member address appears only on the SMTP envelope — Resend surfaces that
 *    separately as `received_for`, which `http.ts` now unions in), so the
 *    filter has to recognize the group address too or every group-forwarded
 *    receipt is ack'd and silently dropped.
 */
const DEFAULT_RECEIPT_INBOUND_ADDRESSES =
  "receipts@reply.publicworship.life,receipts@publicworship.life";

/** The configured receipt-inbox addresses, normalized. Config, not code:
 *  `RECEIPT_INBOUND_ADDRESSES` is a comma-separated allow-list overriding
 *  `DEFAULT_RECEIPT_INBOUND_ADDRESSES`. */
function receiptInboxAddresses(): Set<string> {
  return new Set(
    (process.env.RECEIPT_INBOUND_ADDRESSES ?? DEFAULT_RECEIPT_INBOUND_ADDRESSES)
      .split(",")
      .map((a) => normalizeEmail(a))
      .filter((a): a is string => a != null),
  );
}

/**
 * True iff ANY recipient of the inbound email is a dedicated receipt-inbox
 * address. The inbound domain (`reply.publicworship.life`) will carry other
 * addresses for other purposes, so the webhook must NOT treat every email to
 * the domain as a receipt — only mail addressed to the receipts inbox. The
 * caller passes To + Cc + `received_for` (the envelope recipient — the ONLY
 * place the member address shows up on group-relayed mail).
 */
export function isReceiptInboxAddress(
  recipients: readonly (string | null | undefined)[],
): boolean {
  const allowed = receiptInboxAddresses();
  return recipients.some((r) => {
    const addr = extractEmailAddress(r);
    return addr != null && allowed.has(addr);
  });
}

/**
 * True iff `raw` IS one of our own receipt-inbox addresses. The LOOP GUARD:
 * a courtesy reply must never be sent to the inbox (or to the Google Group
 * fronting it, which would fan a robot reply out to every member and land
 * straight back here as a new inbound receipt).
 */
export function isReceiptInboxSelf(raw: string | null | undefined): boolean {
  const addr = extractEmailAddress(raw);
  return addr != null && receiptInboxAddresses().has(addr);
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
  // Whether this transaction already has at least one receipt attached
  // (`receiptStorageId` set). Optional: only `receipts.ts#searchUnreceiptedTransactions`
  // populates it (a transaction can legitimately need a SECOND receipt — see
  // that query's doc); `matchReceiptCandidates`/`suggestMatches` leave it
  // unset since their callers already scope to unreceipted charges.
  hasReceipt: v.optional(v.boolean()),
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
 * matches `amountCents`. Exact-cent by design (the confident-auto-match bar).
 *
 * `receiptDate` is OPTIONAL. When present, candidates are additionally kept to
 * ±`MATCH_WINDOW_MS` of it (the window absorbs settlement lag) and ranked
 * nearest-date-first. When ABSENT — the receipt genuinely has no date, e.g.
 * OCR read a total but no date off a backfilled receipt — the date window is
 * skipped entirely and matching is on exact amount ALONE, ranked most-recent-
 * first. Inventing a date (upload/receive time) here was the bug behind "the
 * only $16.36 charge didn't auto-match": a dateless receipt was matched as if
 * dated the moment it was uploaded, so an older same-amount charge fell outside
 * ±14 days and was dropped. Uniqueness still guards auto-attach downstream, so
 * amount-alone only auto-attaches when exactly one unreceipted charge matches.
 *
 * Ordered best-first either way: own-card charges and merchant-token overlaps
 * rank above bare amount matches, then (date present) nearest date / (absent)
 * most recent.
 *
 * Bounded: scans `by_chapter_and_postedAt` newest-first up to
 * `CANDIDATE_SCAN_LIMIT` and filters in memory (there is no amount index; the
 * amount+receipt+spend predicates are cheap). Sandbox-filtered + `isSpend` so
 * it only ever sees the same charges the reconcile grid does.
 */
export async function matchReceiptCandidates(
  ctx: QueryCtx,
  args: {
    // A real chapter, or the `"central"` sentinel for CENTRAL-owned charges.
    // Central was unreachable here before (founder bug, 2026-07-24): a receipt
    // for a central purchase could never surface its own transaction, so the
    // panel just said "No candidate transactions found".
    chapterId: Id<"chapters"> | "central";
    amountCents: number;
    receiptDate?: number;
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
  const { receiptDate } = args;
  const matches = rows
    .filter(
      (tr) =>
        tr.amountCents === args.amountCents &&
        tr.receiptStorageId == null &&
        isSpend(tr) &&
        txnMatchesMode(tr, sandboxMode) &&
        // No receipt date → match on exact amount alone (skip the window).
        (receiptDate == null ||
          Math.abs(tr.postedAt - receiptDate) <= MATCH_WINDOW_MS),
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

  // Best-first: own charge, then merchant overlap, then — date present —
  // nearest date, or — date absent — most recent charge.
  matches.sort((a, b) => {
    if (a.isOwnCharge !== b.isOwnCharge) return a.isOwnCharge ? -1 : 1;
    if (a.merchantOverlap !== b.merchantOverlap) return a.merchantOverlap ? -1 : 1;
    if (receiptDate == null) return b.postedAt - a.postedAt;
    return (
      Math.abs(a.postedAt - receiptDate) - Math.abs(b.postedAt - receiptDate)
    );
  });
  return matches.slice(0, MAX_CANDIDATES_SURFACED);
}

export const findReceiptMatches = internalQuery({
  args: {
    chapterId: v.union(v.id("chapters"), v.literal("central")),
    amountCents: v.number(),
    // Optional: absent → match on exact amount alone (no date window). See
    // `matchReceiptCandidates` for why a fabricated date was the auto-match bug.
    receiptDate: v.optional(v.number()),
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
    /** The created `receipts` rows, in the SAME order as `extracted` — so the
     *  caller can pair each one back to the read that produced it (which is
     *  how a transport failure gets an automatic re-extraction scheduled
     *  against the right receipt; see `lib/receiptRetry.ts`). */
    receiptIds: v.array(v.id("receipts")),
  }),
  handler: async (ctx, args) => {
    const canAuto = receiptSenderCanAutoAttach(args.senderClass);
    const chapterKnown = args.chapterId != null;
    const receiptIds: Id<"receipts">[] = [];

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
      receiptIds.push(receiptId);

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
    const firstHadDate = args.extracted[0]?.ocrDate != null;

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
          ? `No unreceipted charge for ${fmtUsd(firstAmount)}${
              firstHadDate ? " within ±14 days" : ""
            }.`
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
      receiptIds,
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
      originalSenderEmail: v.optional(v.string()),
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
  return extractMerchantGuess(lines)?.name ?? null;
}

/** A merchant read off receipt text, WITH how much the reader trusts it.
 *  `strong` marks tiers 1–2 (anchored on a real business-entity suffix);
 *  a tier-3 guess is `strong: false` — see `extractMerchantGuess`. */
export interface MerchantGuess {
  name: string;
  strong: boolean;
}

/**
 * `extractMerchantFromLines` plus a CONFIDENCE flag, because the three tiers
 * are not equally trustworthy and one caller needs to know which it got.
 * Tiers 1–2 anchor on a real business-entity suffix ("Givebutter, Inc.") —
 * `strong`. Tier 3 is "the first plausible-looking line near the top", which
 * on a forwarded MARKETING receipt lands on whatever chrome happens to sit
 * there ("Payments", "Tip") — `strong: false`, so `runPipeline`'s merchant
 * fallback may override it with the forwarded message's own envelope
 * ("Uber Receipts"), a far better signal than a line-shape guess.
 */
export function extractMerchantGuess(lines: string[]): MerchantGuess | null {
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean).slice(0, 15);
  for (const line of nonEmpty) {
    const mid = extractMidLineMerchant(line);
    if (mid) return { name: mid, strong: true };
  }
  for (const line of nonEmpty) {
    if (MERCHANT_SUFFIX_RE.test(line) && looksLikeMerchantLine(line)) {
      return { name: line.replace(/\s+/g, " ").trim().slice(0, 200), strong: true };
    }
  }
  for (const line of nonEmpty) {
    if (looksLikeMerchantLine(line)) {
      return { name: line.replace(/\s+/g, " ").trim().slice(0, 200), strong: false };
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
  /** Whether `merchant` came from a business-entity-anchored tier (see
   *  `extractMerchantGuess`). `false` for a weak line-shape guess — the
   *  merchant fallback may replace it with a forwarded envelope's. */
  merchantStrong: boolean;
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

  const merchant = extractMerchantGuess(lines);
  return {
    amountCents,
    date,
    merchant: merchant?.name ?? null,
    merchantStrong: merchant?.strong ?? false,
  };
}

// ── Inline-forward envelope (the ordinary "Forward") ─────────────────────────
/** The banner mail clients insert above an INLINE forward — Gmail's
 *  "---------- Forwarded message ---------", Apple Mail's "Begin forwarded
 *  message:", Outlook's "-----Original Message-----". (A "forward as
 *  attachment" arrives as a `.eml` instead and is parsed properly by
 *  `lib/emlMessage.ts`; this is the other, far more common shape.) */
const INLINE_FORWARD_MARKER_RE =
  /(?:-{2,}\s*)?\b(?:begin\s+)?(?:forwarded\s+message|original\s+message)\b(?:\s*-{2,})?/i;

/** The pseudo-header names a forward banner carries — used as each other's
 *  stop boundary, since an HTML forward block collapses to ONE line where
 *  "From: X Date: Y Subject: Z" run together with no newline between them. */
const FORWARD_HEADER_NAMES = "From|Sent|Date|To|Cc|Bcc|Subject|Reply-To";

/** Flatten HTML to text PRESERVING line structure — `<br>`/block-close tags
 *  become newlines rather than the spaces `parseReceiptFromText`'s cruder
 *  strip yields, so a forward banner's pseudo-headers stay parseable.
 *
 *  Strips only REAL tags (`<name ...>` / `</name>`), never anything merely
 *  angle-bracketed: a plain-text banner's own `From: Uber Receipts
 *  <noreply@uber.com>` must survive, and `<[^>]+>` would eat the address —
 *  taking the merchant's identity with it. */
function flattenHtmlToText(raw: string): string {
  return raw
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(?:div|p|tr|table|li|h[1-6])\s*>/gi, "\n")
    .replace(/<\/?[a-z][a-z0-9]*(?:\s[^>]*)?\/?>/gi, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/** Pull one pseudo-header value out of a forward banner, stopping at the next
 *  header name or a line break (whichever comes first). */
function captureForwardHeader(block: string, name: string): string | null {
  const re = new RegExp(
    `\\b${name}:[ \\t]*([^\\n]{1,300}?)(?=\\s*(?:${FORWARD_HEADER_NAMES}):|\\s*$)`,
    "im",
  );
  const m = block.match(re);
  const value = m?.[1]?.replace(/\s+/g, " ").trim();
  return value ? value : null;
}

/**
 * The ORIGINAL message's envelope, recovered from an inline forward's banner.
 *
 * Why it matters: on an inline forward the merchant's mail is pasted into the
 * body, so the pipeline's only envelope is the FORWARDER's — a team member's
 * gmail, or (via the Google Group) the list itself. Neither says anything
 * about the merchant, while the banner directly quotes the one that does
 * ("From: Uber Receipts <noreply@uber.com>"). This gives the body path the
 * same `ForwardedEnvelope` the `.eml` path already gets from a real parse.
 *
 * Returns `null` when there's no forward banner or nothing usable in it —
 * never a guess. Exported for direct unit testing.
 */
export function parseInlineForwardEnvelope(raw: string): ForwardedEnvelope | null {
  const text = flattenHtmlToText(raw);
  const marker = text.match(INLINE_FORWARD_MARKER_RE);
  if (!marker || marker.index == null) return null;
  // The banner's headers sit immediately after it; bound the window so a long
  // quoted body can't drag an unrelated "Subject:" in.
  const block = text.slice(marker.index + marker[0].length, marker.index + 1200);
  const fromEmail = captureForwardHeader(block, "From");
  const subject = captureForwardHeader(block, "Subject");
  if (!fromEmail && !subject) return null;
  return {
    fromEmail: fromEmail ?? undefined,
    subject: subject ?? undefined,
  };
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
  // A forwarded message is never an inline asset either — it's the envelope
  // around the real receipt (see `isEmailMessageAttachment`).
  if (isEmailMessageAttachment(a.contentType, a.filename)) return false;
  if (a.size == null || a.size >= INLINE_ASSET_SIZE_FLOOR_BYTES) return false;
  return INLINE_ASSET_NAME_RE.test(a.filename.toLowerCase());
}

/** Append a note about attachments the pipeline did NOT turn into receipts —
 *  one the inline-asset filter dropped (a logo, a signature) or one past a
 *  per-email cap — so it never just silently disappears (a bookkeeper can see
 *  it was seen). No-op when nothing was skipped. Bounded to the first 5 names
 *  inline, with a `+N more` tail for a noisier email. */
export function appendSkippedNote(detail: string, skippedNames: string[]): string {
  if (skippedNames.length === 0) return detail;
  const shown = skippedNames.slice(0, 5).join(", ");
  const rest = skippedNames.length > 5 ? `, +${skippedNames.length - 5} more` : "";
  return `${detail} (Skipped ${skippedNames.length} attachment${
    skippedNames.length === 1 ? "" : "s"
  } not processed as receipts: ${shown}${rest}.)`;
}

/**
 * True iff an attachment looks like something the pipeline can read a receipt
 * out of: a receipt IMAGE or PDF, or a FORWARDED MESSAGE (`message/rfc822` /
 * `.eml`) that may carry one inside (see `expandReceiptSources`). Checked by
 * content type AND by filename extension — a mail client that mislabels a
 * `.pdf`/`.eml` as `application/octet-stream` is common enough that the
 * extension is a necessary second signal.
 */
export function isReceiptFileAttachment(
  contentType: string | null | undefined,
  filename: string | null | undefined,
): boolean {
  const ct = (contentType ?? "").toLowerCase();
  const name = (filename ?? "").toLowerCase();
  return (
    ct.startsWith("image/") ||
    ct === "application/pdf" ||
    /\.(jpe?g|png|webp|heic|gif|pdf)$/.test(name) ||
    isEmailMessageAttachment(ct, name)
  );
}

/**
 * List a received email's attachments via the Resend API
 * (`GET /emails/receiving/{emailId}/attachments`) and return EVERY one that
 * looks like a receipt image or PDF (or a forwarded `.eml` carrying one) AND
 * isn't almost-certainly an inline email asset (`isLikelyInlineAsset`),
 * downloaded as a Blob (bounded by
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

  const skippedNames: string[] = [];
  const targets: ResendAttachment[] = [];
  for (const a of list) {
    if (!a.download_url || !isReceiptFileAttachment(a.content_type, a.filename))
      continue;
    if (isLikelyInlineAsset({ contentType: a.content_type ?? "", filename: a.filename ?? "", size: a.size })) {
      skippedNames.push(a.filename ?? a.id);
      continue;
    }
    targets.push(a);
  }
  const bounded = targets.slice(0, MAX_ATTACHMENTS);
  // Over the per-email cap — named in the row's detail rather than dropped
  // without a trace (a batch forward can legitimately run long).
  for (const over of targets.slice(MAX_ATTACHMENTS)) {
    skippedNames.push(over.filename ?? over.id);
  }

  const out: { blob: Blob; contentType: string; filename: string }[] = [];
  for (const target of bounded) {
    try {
      const dl = await fetch(target.download_url!);
      if (!dl.ok) {
        console.log(`[receiptInbox] attachment download failed (${dl.status}).`);
        continue;
      }
      // BUFFER the bytes into an in-memory Blob instead of handing the
      // response's own Blob down the pipeline. In the Convex runtime a Blob
      // from `res.blob()` is backed by the response STREAM: the first read
      // consumes it and every later one throws
      // `TypeError: Can't re-read streaming Blob`. The pipeline reads an
      // attachment TWICE — once to `ctx.storage.store` it, once for the
      // vision call's data URL — so a photo/screenshot receipt emailed in
      // died on that second read (observed in prod 2026-08-05; PDFs survived
      // only because their extraction reads the STORED file, never the blob).
      // A Blob built from an ArrayBuffer holds its bytes and re-reads fine.
      const streamed = await dl.blob();
      out.push({
        blob: new Blob([await streamed.arrayBuffer()], { type: streamed.type }),
        contentType: target.content_type ?? streamed.type ?? "application/octet-stream",
        filename: target.filename ?? "receipt",
      });
    } catch (err) {
      console.log(`[receiptInbox] attachment download errored: ${String(err)}`);
    }
  }
  return { attachments: out, skippedNames };
}

// ── Forwarded-as-attachment expansion (the `.eml` fix) ───────────────────────
/**
 * The FORWARDED message's own envelope, when a receipt came out of a `.eml`
 * attachment rather than straight off the email that was sent to us. It's the
 * merchant's envelope (`Google Payments <payments-noreply@google.com>`), not
 * the forwarder's — so the merchant fallback must prefer it (see
 * `runPipeline` step 3b): deriving "Gmail"/the team member's own domain off
 * the outer envelope would be flatly wrong for a forwarded receipt.
 */
export interface ForwardedEnvelope {
  fromEmail?: string;
  subject?: string;
}

/** One thing the pipeline will turn into a `receipts` row: a FILE to extract
 *  (image/PDF) or BODY text to parse (zero LLM). A forwarded message expands
 *  into one or more of these; a directly-attached image/PDF is just one
 *  `file`. */
export type ReceiptSource =
  | {
      kind: "file";
      blob: Blob;
      contentType: string;
      filename: string;
      envelope?: ForwardedEnvelope;
    }
  | {
      kind: "body";
      /**
       * The message's HTML part, when it has one — what a human SEES. A
       * merchant receipt is designed HTML (the Uber Eats/Givebutter layout the
       * sender got), and storing its plain-text alternative instead turns a
       * branded receipt into an unreadable wall of run-together text in the
       * review UI. See `storeBodyReceipt`.
       */
      html?: string | null;
      /**
       * The plain-text alternative, when it has one — what the PARSER reads.
       * Line structure survives here, which the zero-LLM total/merchant
       * heuristics depend on (`parseReceiptFromText` only strips tags).
       */
      text?: string | null;
      filename: string;
      envelope?: ForwardedEnvelope;
    };

/** Trim a forwarded message's subject into the `filename` a bookkeeper sees on
 *  the stored body document. */
function forwardedBodyLabel(subject: string | null): string {
  const cleaned = (subject ?? "").replace(/\s+/g, " ").trim();
  return cleaned ? `${cleaned.slice(0, 120)} (forwarded email)` : "forwarded email";
}

/**
 * Turn ONE parsed forwarded message into the receipt sources it carries.
 *
 * Per message, the SAME precedence the top-level pipeline uses: its usable
 * image/PDF attachments (a Google Workspace invoice PDF, a photo) win; only
 * when a message and everything it forwards yield NO file at all does its own
 * BODY text become the receipt. Recurses through a forward chain (bounded by
 * the parser's `MAX_EML_NESTING_DEPTH`), so "Alice forwards Bob's forward of
 * the merchant's receipt" still reaches the receipt.
 *
 * Inline assets (a signature graphic, a logo) are filtered with the exact same
 * `isLikelyInlineAsset` rule directly-attached files get, and their names are
 * pushed onto `skippedNames` so they surface in the row's detail instead of
 * vanishing. Exported for direct unit testing.
 */
export function collectForwardedReceiptSources(
  message: ParsedEmlMessage,
  skippedNames: string[] = [],
): ReceiptSource[] {
  const envelope: ForwardedEnvelope = {
    fromEmail: message.from ?? undefined,
    subject: message.subject ?? undefined,
  };
  const sources: ReceiptSource[] = [];
  for (const att of message.attachments) {
    if (!isReceiptFileAttachment(att.contentType, att.filename)) continue;
    if (
      isLikelyInlineAsset({
        contentType: att.contentType,
        filename: att.filename,
        size: att.bytes.length,
      })
    ) {
      skippedNames.push(att.filename);
      continue;
    }
    sources.push({
      kind: "file",
      blob: new Blob([att.bytes as BlobPart], { type: att.contentType }),
      contentType: att.contentType,
      filename: att.filename,
      envelope,
    });
  }
  for (const nested of message.forwarded) {
    sources.push(...collectForwardedReceiptSources(nested, skippedNames));
  }
  if (sources.length > 0) return sources;

  // No file anywhere in this branch — the forwarded message's own body IS the
  // receipt (a plain-text/HTML merchant confirmation), stored as a document
  // exactly like the top-level body path does. BOTH parts are carried: the
  // HTML is what gets stored and shown, the text is what gets parsed (see
  // `storeBodyReceipt`).
  const plain = (message.text ?? "").trim();
  const html = (message.html ?? "").trim();
  if (!plain && !html) return [];
  return [
    {
      kind: "body",
      html: html || null,
      text: plain || null,
      filename: forwardedBodyLabel(message.subject),
      envelope,
    },
  ];
}

/**
 * Expand the raw attachments off one inbound email into the receipt sources
 * the pipeline actually processes: a `message/rfc822` / `.eml` attachment (the
 * "Forward as attachment" shape — Gmail's, Apple Mail's, Outlook's) is OPENED
 * and replaced by what it carries; everything else passes through as the file
 * it already is.
 *
 * This is the fix for forwarded receipts arriving as opaque `.eml`s: before
 * it, such an email had no image/PDF attachment and an empty outer body, so
 * the whole message landed as `ignored` with the real receipt PDF one MIME
 * layer down, unread.
 *
 * Bounded by `MAX_RECEIPT_SOURCES`; anything past the cap is reported through
 * `skippedNames` (which the row's `detail` surfaces) rather than dropped
 * silently. An unparseable `.eml` degrades to the file itself, so a bookkeeper
 * still gets a document to look at.
 */
async function expandReceiptSources(
  attachments: { blob: Blob; contentType: string; filename: string }[],
  skippedNames: string[],
): Promise<ReceiptSource[]> {
  const sources: ReceiptSource[] = [];
  for (const att of attachments) {
    const asFile: ReceiptSource = { kind: "file", ...att };
    if (!isEmailMessageAttachment(att.contentType, att.filename)) {
      sources.push(asFile);
      continue;
    }
    const inner = collectForwardedReceiptSources(
      parseEmlMessage(await att.blob.arrayBuffer()),
      skippedNames,
    );
    if (inner.length === 0) {
      // Nothing readable inside — keep the `.eml` itself so the email doesn't
      // silently become a no-op; a human can still open it from the queue.
      console.log(
        `[receiptInbox] forwarded message "${att.filename}" carried no readable receipt.`,
      );
      sources.push(asFile);
      continue;
    }
    sources.push(...inner);
  }
  if (sources.length > MAX_RECEIPT_SOURCES) {
    for (const extra of sources.slice(MAX_RECEIPT_SOURCES)) {
      skippedNames.push(extra.filename);
    }
    return sources.slice(0, MAX_RECEIPT_SOURCES);
  }
  return sources;
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
 *  `lib/aiEngine.ts`'s ChatCompletionError contract one layer up). `retryable`
 *  and `retryAfterSeconds` are lifted straight off the underlying
 *  `ChatCompletionError` for a transport failure (429/5xx/timeout/network);
 *  `"no_total"` — the model replied fine but found nothing — is always
 *  `retryable: false`, since re-running the SAME call won't fix a bad read.
 *  Consumed by `receipts.ts`'s failed-extraction sweep to decide "back off and
 *  retry" vs. "permanent failure, move on". */
export interface OcrImageFailure {
  kind: OcrFailureKind;
  status: number | null;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number | null;
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
 * only runs for image/PDF attachments — body receipts never reach it.
 *
 * `dataUrls` takes ONE OR MORE `image_url` data URLs in a single user message
 * — a plain photo passes exactly one; a rendered scanned PDF
 * (`receiptPdf.ts#renderScannedPdfPages`) passes one PNG per page, bounded to
 * `SCANNED_PDF_RENDER_MAX_PAGES`, so a multipage scanned receipt still gets
 * read in ONE model call instead of degrading on page 2+. Both providers
 * handle a multi-image user message: OpenRouter's OpenAI-compat endpoint
 * natively, and Ollama's native `/api/chat` path via `toOllamaNativeMessages`
 * (`lib/aiEngine.ts`), which collects every `image_url` part into its
 * `images` array. Never a raw `application/pdf` — every entry here MUST
 * already be a rendered `image/*` data URL (see `extractReceiptFields`'s and
 * `receiptPdf.ts`'s module docs for why that invariant matters).
 *
 * `config` is resolved by the caller (via `readAiEngineConfig`) and `model` via
 * `resolveOcrModel`. On a typed engine error the human-readable reason is
 * logged (the owner's complaint was silent failures) AND returned — the
 * receipt still degrades to a recorded `ocrError`/`needs_review`, no throw
 * (the keyless-degrade contract).
 */
export async function ocrReceiptImage(
  config: AiEngineConfig,
  dataUrls: string[],
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
          "visible on the receipt at all. You may be shown MULTIPLE " +
          "images that are separate PAGES of the SAME receipt (a " +
          "multipage scanned PDF) — treat them as one document and find " +
          "the total across all of them, not per-page.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Extract the total and merchant name from this receipt.",
          },
          ...dataUrls.map((dataUrl) => ({
            type: "image_url" as const,
            image_url: { url: dataUrl },
          })),
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
      error: {
        kind: result.kind,
        status: result.status,
        message: result.message,
        retryable: result.retryable,
        retryAfterSeconds: result.retryAfterSeconds ?? null,
      },
    };
  }
  const noTotal: OcrImageResult = {
    error: {
      kind: "no_total",
      retryable: false,
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
 *  "OCR read: — · — · —" with no explanation).
 *
 *  `ocrRetryable`/`ocrRetryAfterSeconds` are ONLY ever set alongside an
 *  `ocrError` that came from a transport failure against the vision model
 *  (`ocrReceiptImage`'s `OcrImageFailure.retryable`) — a rate limit (429) or
 *  a 5xx/timeout/network blip that a later attempt could plausibly succeed
 *  at. A `"no_total"` read, an unsupported file type, or a PDF-text-layer
 *  miss are never retryable — the SAME input would just fail the same way
 *  again. `receipts.ts`'s failed-extraction sweep is the one consumer that
 *  cares: it backs off + retries on `ocrRetryable`, and otherwise treats the
 *  failure as PERMANENT and moves on to the next receipt. */
export interface OcrRoutingResult {
  ocrAmountCents?: number;
  ocrDate?: number;
  ocrMerchant?: string;
  ocrConfidence?: number;
  ocrModel?: string;
  ocrError?: string;
  ocrRetryable?: boolean;
  ocrRetryAfterSeconds?: number;
}

/** The clear, human-actionable message a scanned PDF still degrades to when
 *  NEITHER route can produce a total: rendering itself failed (a malformed/
 *  unrenderable PDF), or every rendered page vanished from storage before it
 *  could be read. Kept as one constant so the two dead-end returns in
 *  `extractReceiptFields` below can't drift apart. */
const SCANNED_PDF_UNREADABLE_MESSAGE =
  "Scanned PDF (no readable text layer) — couldn't read it " +
  "automatically; re-upload as a photo/screenshot or enter the total " +
  "manually.";

/** What extraction says when the file it was pointed at isn't in storage at
 *  all — the receipt document still exists and a human can fix the total by
 *  hand, so this is an `ocrError`, never a throw. */
const MISSING_STORED_FILE_MESSAGE =
  "The receipt file couldn't be read back from storage — enter the total manually.";

/**
 * Route ONE stored file through extraction: a PDF tries its own TEXT LAYER
 * first (zero LLM — `receiptPdf.ts#extractPdfText`, an action→action call
 * across the Node boundary). When the PDF has no usable text layer (a
 * scanned/faxed receipt), it renders each page to a PNG
 * (`receiptPdf.ts#renderScannedPdfPages`, pdfium WASM — up to
 * `SCANNED_PDF_RENDER_MAX_PAGES` pages) and hands vision THOSE rendered
 * images instead — a PDF is NEVER handed to a vision call as
 * `application/pdf` (that's the #406 invariant: Ollama sniffs the bytes and
 * 400s on a raw PDF masquerading as an image; a rendered `image/png` is the
 * fix, not a violation of that rule). If rendering itself can't produce a
 * page (a malformed/unrenderable PDF), this degrades to the same clear,
 * human-actionable `ocrError` a scanned PDF has always produced. Anything
 * else (a plain image) goes straight to vision, exactly as before. Always
 * resolves an `ocrError` when extraction produced no total — the point of the
 * PR before this one: a receipt detail that says WHY, not a silent "—".
 *
 * Shared by the email pipeline (`runPipeline`), the mass-upload pipeline
 * (`receipts.ts#runUploadPipeline`), and `receipts.ts#retryExtraction` — ONE
 * place decides "PDF text vs vision" so the three callers can't drift apart.
 *
 * The file is identified by `storageId` ONLY — every route (PDF text layer,
 * scanned-page render, plain-image vision) reads the bytes back out of
 * storage itself. It deliberately does NOT take the caller's own Blob: in the
 * Convex runtime a Blob from `res.blob()` / `ctx.storage.get()` is
 * stream-backed and single-read, so a caller that had already stored it
 * handed us a spent one and the image route died on
 * `TypeError: Can't re-read streaming Blob` (the emailed-screenshot bug).
 * Reading from storage is what the PDF routes always did; now all of them do.
 */
export async function extractReceiptFields(
  ctx: ActionCtx,
  args: {
    storageId: Id<"_storage">;
    config: AiEngineConfig;
    contentType: string;
    filename?: string;
    model: string;
  },
): Promise<OcrRoutingResult> {
  const { storageId, config, contentType, filename, model } = args;

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
    // A SCANNED pdf — no usable text layer. NEVER hand the raw PDF to the
    // vision model: Ollama's `image_url` input requires a real image mime
    // type and 400s on `application/pdf` (the bug this branch guards). Render
    // each page to a PNG instead — rendering isn't the #406 mistake (that was
    // a native canvas addon that broke bundling); pdfium is pure WASM, so it
    // bundles, and a rendered `image/png` is a completely different payload
    // than the raw PDF bytes the invariant guards against.
    // The render action's own contract is degrade-to-`{pages: []}`, but a
    // hard process death inside the node runtime (e.g. the wasm engine
    // killing the worker — observed in prod 2026-07-24 as an opaque
    // InternalServerError with no logs) surfaces HERE as a throw from
    // `runAction`. That must degrade like every other failure in this
    // pipeline — a receipt with a clear `ocrError`, never a crashed
    // retry/pipeline run.
    let pages: { storageId: Id<"_storage"> }[];
    try {
      ({ pages } = await ctx.runAction(internal.receiptPdf.renderScannedPdfPages, {
        storageId,
        maxPages: SCANNED_PDF_RENDER_MAX_PAGES,
      }));
    } catch (err) {
      console.log(`[receiptInbox] scanned-PDF render action failed hard: ${String(err)}`);
      return { ocrError: SCANNED_PDF_UNREADABLE_MESSAGE };
    }
    if (pages.length === 0) {
      // Rendering couldn't help either — a malformed/unrenderable PDF, or a
      // pdfium init/render failure. Degrade to the same clear,
      // human-actionable error a scanned PDF has always produced. Never a
      // vision call with the raw PDF, never a throw.
      return { ocrError: SCANNED_PDF_UNREADABLE_MESSAGE };
    }
    try {
      const dataUrls: string[] = [];
      for (const page of pages) {
        const pageBlob = await ctx.storage.get(page.storageId);
        if (!pageBlob) continue;
        const pageBuf = await pageBlob.arrayBuffer();
        dataUrls.push(`data:image/png;base64,${arrayBufferToBase64(pageBuf)}`);
      }
      if (dataUrls.length === 0) return { ocrError: SCANNED_PDF_UNREADABLE_MESSAGE };

      const ocr = await ocrReceiptImage(config, dataUrls, model);
      if ("error" in ocr) {
        return {
          ocrModel: model,
          ocrError: ocrFailureMessage(ocr.error, config.provider, "scanned_pdf"),
          ocrRetryable: ocr.error.retryable,
          ocrRetryAfterSeconds: ocr.error.retryAfterSeconds ?? undefined,
        };
      }
      return {
        ocrAmountCents: ocr.amountCents ?? undefined,
        ocrDate: ocr.date ?? undefined,
        ocrMerchant: ocr.merchant ?? undefined,
        ocrConfidence: ocr.confidence ?? undefined,
        ocrModel: model,
      };
    } finally {
      // The rendered pages are scratch artifacts the vision call consumed —
      // not the receipt document itself (the ORIGINAL PDF `storageId` stays
      // the canonical receipt file). Clean them up regardless of how the OCR
      // call went, so a retry doesn't accumulate orphaned page images.
      for (const page of pages) {
        await ctx.storage.delete(page.storageId);
      }
    }
  }

  // An image (or anything else worth handing to the vision model). Read the
  // bytes back out of storage — see this function's doc for why the caller's
  // own Blob is never trusted here.
  const stored = await ctx.storage.get(storageId);
  if (!stored) return { ocrError: MISSING_STORED_FILE_MESSAGE };
  const buf = await stored.arrayBuffer();
  const dataUrl = `data:${contentType};base64,${arrayBufferToBase64(buf)}`;
  const ocr = await ocrReceiptImage(config, [dataUrl], model);
  if ("error" in ocr) {
    return {
      ocrModel: model,
      ocrError: ocrFailureMessage(ocr.error, config.provider, "image"),
      ocrRetryable: ocr.error.retryable,
      ocrRetryAfterSeconds: ocr.error.retryAfterSeconds ?? undefined,
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
  /** In-pipeline only (never persisted): the merchant above is a WEAK
   *  line-shape guess off body text (`extractMerchantGuess`'s tier 3), so a
   *  forwarded message's own envelope should win over it. Unset for a
   *  merchant read off the receipt itself (vision OCR, a PDF text layer, or a
   *  business-entity-anchored body line) — those are never overridden. */
  ocrMerchantWeak?: boolean;
  /** Set only when this receipt came out of a FORWARDED message — the inner
   *  merchant envelope the merchant fallback must prefer over the forwarder's
   *  (see `ForwardedEnvelope`). */
  envelope?: ForwardedEnvelope;
  /** In-pipeline only (never persisted): the `ocrError` above is a TRANSPORT
   *  failure (engine 5xx/429/timeout), so this receipt earns an automatic
   *  re-extraction once its row exists — see `lib/receiptRetry.ts`. */
  ocrRetryable?: boolean;
  ocrRetryAfterSeconds?: number;
}

/**
 * Store one BODY receipt — an email whose text IS the receipt — as a document
 * and parse its total with the zero-LLM heuristic. Stored as a file because an
 * email receipt saved as a document IS the receipt, so a unique match can
 * auto-attach it exactly like a photo; HTML keeps its `text/html` type so the
 * review UI renders it. Shared by the top-level body path and the
 * forwarded-message body path so the two can't drift apart.
 */
/** The stored-document content types a body receipt can have. Both carry an
 *  EXPLICIT charset — see `buildBodyDocument`. */
export const HTML_DOCUMENT_TYPE = "text/html;charset=utf-8";
export const TEXT_DOCUMENT_TYPE = "text/plain;charset=utf-8";

/**
 * Decide what an email body gets STORED as and what gets PARSED out of it —
 * the ONE definition of that rule, shared by the live pipeline
 * (`storeBodyReceipt`) and the repair pass that re-stores documents written
 * before this rule existed (`receiptInboxBackfill.ts`).
 *
 * STORED (what a human opens): the HTML part whenever the message has one. A
 * merchant receipt IS designed HTML — the layout the sender saw — and storing
 * the plain-text alternative instead turns it into an unreadable wall of
 * run-together text.
 *
 * PARSED (what the zero-LLM heuristics read): the plain-text alternative
 * whenever there is one. Its line structure is what `parseReceiptFromText`'s
 * total/merchant rules depend on; HTML only works there because tags get
 * stripped, which also destroys the lines.
 *
 * CHARSET IS NOT OPTIONAL. These bodies are UTF-8 (curly apostrophes, narrow
 * no-break spaces in times, bullet runs in masked card numbers), and a blob
 * served as bare `text/html`/`text/plain` gets decoded with the viewer's
 * fallback encoding — rendering "New Lin’s" as "New Linâ€™s" and "9:35 PM" as
 * "9:35â€¯PM". Declaring it here is what stops the mojibake.
 */
export function buildBodyDocument(args: {
  html?: string | null;
  text?: string | null;
}): { content: string; contentType: string; parseSource: string } {
  const html = args.html?.trim() ? args.html : null;
  const text = args.text?.trim() ? args.text : null;
  const content = html ?? text ?? "";
  return {
    content,
    contentType: html ? HTML_DOCUMENT_TYPE : TEXT_DOCUMENT_TYPE,
    parseSource: text ?? content,
  };
}

async function storeBodyReceipt(
  ctx: ActionCtx,
  args: {
    html?: string | null;
    text?: string | null;
    filename: string;
    envelope?: ForwardedEnvelope;
  },
): Promise<ExtractedReceipt> {
  // What to store vs. what to parse is `buildBodyDocument`'s call — shared
  // with the repair pass so both can never drift.
  const doc = buildBodyDocument(args);
  const storageId = await ctx.storage.store(
    new Blob([doc.content], { type: doc.contentType }),
  );
  const parsed = parseReceiptFromText(doc.parseSource);
  return {
    storageId,
    sourceKind: "body",
    filename: args.filename,
    ocrAmountCents: parsed.amountCents ?? undefined,
    ocrDate: parsed.date ?? undefined,
    ocrMerchant: parsed.merchant ?? undefined,
    ocrMerchantWeak:
      parsed.merchant != null && !parsed.merchantStrong ? true : undefined,
    ocrConfidence: parsed.amountCents != null ? 0.5 : 0,
    ocrError:
      parsed.amountCents == null
        ? "Couldn't find a total in the email body text."
        : undefined,
    candidateTransactionIds: [],
    envelope: args.envelope,
  };
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
  // 0. Fetch the received message ONCE — its headers drive sender recovery
  //    (below) and its body is the receipt when there's no usable attachment.
  //    Best-effort: `null` without `RESEND_API_KEY`, and every use degrades.
  const received = await fetchReceivedEmail(row.emailId);

  // 1. Resolve + classify the sender. On GOOGLE-GROUP-relayed mail the
  //    envelope `From:` may be the list rather than the poster, so recover the
  //    real one from `X-Original-Sender` first (`resolveListSender`). The gate
  //    is OPEN: every email is processed. The class only decides whether an
  //    auto-attach is permitted (team/roster) or the receipt must route to
  //    review (internal/external).
  const { fromEmail: senderEmail, relayedVia } = resolveListSender(
    row.fromEmail,
    received?.headers,
  );
  if (relayedVia && senderEmail !== row.fromEmail) {
    console.log(
      `[receiptInbox] ${receiptId}: relayed via ${relayedVia.slice(0, 80)} — classifying as ${senderEmail}`,
    );
    // Record it so the review queue names the PERSON, not the list, while
    // `fromEmail` keeps the verbatim envelope for audit.
    await ctx.runMutation(internal.receiptInbox.updateInboundReceipt, {
      receiptId,
      patch: { originalSenderEmail: senderEmail },
    });
  }
  const sender = await ctx.runQuery(internal.receiptInbox.classifySender, {
    email: senderEmail,
  });
  const isTrusted = receiptSenderCanAutoAttach(sender.senderClass);

  // 2. Get receipt content: EVERY usable image/PDF attachment (skipping
  //    almost-certainly-inline assets — logos, signatures, tracking pixels;
  //    see `isLikelyInlineAsset`), else the body. A `.eml` attachment — the
  //    "Forward as attachment" shape — is OPENED first and replaced by the
  //    receipt(s) inside it (`expandReceiptSources`). A PDF tries its own text
  //    layer first (zero LLM) before ever reaching the vision model — see
  //    `extractReceiptFields`.
  const { attachments, skippedNames } = await fetchAllReceiptAttachments(row.emailId);
  const sources = await expandReceiptSources(attachments, skippedNames);
  const extracted: ExtractedReceipt[] = [];

  if (sources.length > 0) {
    // Resolve the active AI engine (provider + key + global model) ONCE for the
    // whole email, then the OCR model for this provider.
    const config = await ctx.runQuery(
      internal.integrationSettings.readAiEngineConfig,
      {},
    );
    const model = resolveOcrModel(config);
    for (const source of sources) {
      if (source.kind === "body") {
        // A forwarded message with no file inside — its body text IS the
        // receipt (ZERO LLM), stored as a document like the top-level body
        // path below.
        extracted.push(
          await storeBodyReceipt(ctx, {
            html: source.html,
            text: source.text,
            filename: source.filename,
            envelope: source.envelope,
          }),
        );
        continue;
      }
      const storageId = await ctx.storage.store(source.blob);
      const result = await extractReceiptFields(ctx, {
        storageId,
        config,
        contentType: source.contentType,
        filename: source.filename,
        model,
      });
      extracted.push({
        storageId,
        sourceKind: "attachment",
        filename: source.filename,
        ocrAmountCents: result.ocrAmountCents,
        ocrDate: result.ocrDate,
        ocrMerchant: result.ocrMerchant,
        ocrConfidence: result.ocrConfidence,
        ocrModel: result.ocrModel,
        ocrError: result.ocrError,
        candidateTransactionIds: [],
        envelope: source.envelope,
        ocrRetryable: result.ocrRetryable,
        ocrRetryAfterSeconds: result.ocrRetryAfterSeconds,
      });
    }
  } else {
    // No usable attachment — the email BODY is the receipt (ZERO LLM). Stored
    // as a file too: an email receipt saved as a document IS the receipt, so a
    // unique match can auto-attach it exactly like a photo. HTML is stored as
    // text/html so the review UI renders it.
    // The HTML is what gets stored and shown; the text is what gets parsed.
    // The subject is the last-resort stand-in when the fetch gave us neither.
    const html = received?.html ?? null;
    const text = received?.text ?? (html ? null : (row.subject ?? null));
    if (html?.trim() || text?.trim()) {
      extracted.push(
        await storeBodyReceipt(ctx, {
          html,
          text,
          filename: "email body",
          // An INLINE forward (the ordinary "Forward" — the merchant's mail
          // pasted into the body) carries the merchant's own envelope in its
          // banner. Recovering it is the difference between a merchant of
          // "Uber Receipts" and one read off whatever chrome the forwarded
          // marketing email happened to lead with.
          // Read the banner off whichever part we have — the parser flattens
          // HTML itself, so either works; the text part is tried first because
          // its line structure makes the pseudo-headers cleanest.
          envelope:
            parseInlineForwardEnvelope(text ?? "") ??
            parseInlineForwardEnvelope(html ?? "") ??
            undefined,
        }),
      );
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
  //     name (e.g. a bare Givebutter donation confirmation). A receipt that
  //     came out of a FORWARDED message uses THAT message's envelope first —
  //     the merchant's own ("Google Payments"), not the forwarder's (which
  //     would derive the team member's mail host, a flatly wrong merchant).
  //
  //     PRECEDENCE: a forwarded envelope also BEATS a WEAK body-text guess
  //     (`merchantStrong: false` — "the first plausible-looking line", which
  //     on a forwarded marketing receipt lands on chrome like "Payments" or
  //     the forwarder's own "Paying it back" note). It never overrides a
  //     STRONG one (a real "<Name>, Inc." read straight off the receipt), and
  //     the outer envelope — the forwarder's — still only ever fills a gap.
  for (const ex of extracted) {
    const forwarded = ex.envelope?.fromEmail
      ? deriveMerchantFromEmail(ex.envelope.fromEmail, ex.envelope.subject)
      : null;
    if (forwarded && (!ex.ocrMerchant || ex.ocrMerchantWeak)) {
      ex.ocrMerchant = forwarded;
    } else if (!ex.ocrMerchant) {
      ex.ocrMerchant = deriveMerchantFromEmail(row.fromEmail, row.subject) ?? undefined;
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
            // No parsed date → match on amount alone (never the email's arrival
            // time, which would wrongly window out older same-amount charges).
            receiptDate: ex.ocrDate ?? undefined,
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

  // 5b. Any receipt whose read failed on TRANSPORT (engine 5xx/429/timeout)
  //     gets an automatic re-extraction — the read never happened, so a red
  //     card that waits for a human to notice is the wrong answer
  //     (`lib/receiptRetry.ts`). Paired back by index: `receiptIds` comes out
  //     of the commit in the SAME order as `extracted`.
  for (const [i, ex] of extracted.entries()) {
    const createdId = result.receiptIds[i];
    if (!createdId || !ex.ocrError || !ex.ocrRetryable) continue;
    await scheduleAutoRetryExtraction(ctx, createdId, 1, ex.ocrRetryAfterSeconds);
  }

  // 6. Courtesy reply — ONLY to trusted (team/roster) senders. We never
  //    confirm-or-deny anything to a stranger (a spoofable From:). The reply
  //    is DEBOUNCED rather than sent here: this receipt joins the sender's
  //    open batch and one digest covers all of them (`enqueueReplyItem`), so
  //    forwarding a stack of receipts — or a backfill replaying months of
  //    them — earns one email, not one per receipt.
  if (isTrusted) {
    const outcome =
      result.status === "matched"
        ? "matched"
        : result.status === "no_match"
          ? "no_match"
          : "needs_review";
    await ctx.runMutation(internal.receiptInbox.enqueueReplyItem, {
      recipientEmail: senderEmail,
      item: {
        outcome,
        amountCents: result.amountCents ?? undefined,
        merchant: result.matchedMerchant ?? undefined,
      },
    });
  }
  return null;
}

/** The parts of Resend's received-email record this pipeline reads. */
interface ReceivedEmail {
  /** The HTML part — what a human SEES (stored as the receipt document). */
  html: string | null;
  /** The plain-text alternative — what the zero-LLM parser READS. */
  text: string | null;
  /** The message's raw headers, flattened one-per-name by Resend. Used to
   *  recover the true sender behind a mailing-list relay (`resolveListSender`). */
  headers: Record<string, string> | null;
}

/**
 * Fetch the full received email via the Resend API
 * (`GET /emails/receiving/{emailId}`) — the webhook itself carries metadata
 * only. Best-effort: returns `null` without an API key or on any failure, and
 * every caller degrades (the body path falls back to the subject; sender
 * recovery falls back to the envelope `From:`).
 */
export async function fetchReceivedEmail(emailId: string): Promise<ReceivedEmail | null> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  try {
    // `html_format=data_uri` inlines the message's own embedded images as
    // data URIs instead of leaving `cid:` references pointing at MIME parts
    // we don't serve — without it a stored merchant receipt renders with
    // every logo and illustration broken. (It's Resend's default, but the
    // rendering depends on it, so it's declared rather than assumed.)
    const res = await fetch(
      `https://api.resend.com/emails/receiving/${emailId}?html_format=data_uri`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!res.ok) return null;
    const json: any = await res.json();
    return {
      html: typeof json?.html === "string" ? json.html : null,
      text: typeof json?.text === "string" ? json.text : null,
      headers:
        json?.headers && typeof json.headers === "object" ? json.headers : null,
    };
  } catch {
    return null;
  }
}

/** Case-insensitive lookup over Resend's flat header map. */
export function headerValue(
  headers: Record<string, string> | null | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === wanted && typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  return null;
}

/**
 * Recover the address that actually POSTED a mailing-list-relayed message.
 *
 * The shape we run on: humans mail the Google Group
 * `receipts@publicworship.life`, and our Resend inbound address is a member of
 * it, so every post reaches us relayed. Google usually preserves the poster's
 * `From:` — but REWRITES it ("Charisma S. via receipts
 * <receipts@publicworship.life>") whenever the poster's domain publishes a
 * strict DMARC policy. A rewritten `From:` resolves to no roster person, so
 * the receipt would classify `internal`, never auto-attach, and (worse) a
 * courtesy reply would go to the LIST and fan out to every member. Google
 * always stamps the real poster into `X-Original-Sender`, so we read it back.
 *
 * ONLY honored on a message that actually arrived via a list (`List-Id` /
 * `List-Post` / `Mailing-list` present) — a header on a message sent straight
 * to the inbox is ignored. This is the same (spoofable) AUTOMATION axis
 * `classifySender` already documents, not a permission: recovering the sender
 * decides whether an auto-attach may be attempted, never whether it's allowed.
 *
 * Returns the address to classify + reply to, and the list it came through
 * (`null` when this wasn't list mail). Exported for direct unit testing.
 */
export function resolveListSender(
  fromEmail: string,
  headers: Record<string, string> | null | undefined,
): { fromEmail: string; relayedVia: string | null } {
  const listId =
    headerValue(headers, "list-id") ??
    headerValue(headers, "list-post") ??
    headerValue(headers, "mailing-list");
  if (!listId) return { fromEmail, relayedVia: null };
  const original =
    headerValue(headers, "x-original-sender") ??
    headerValue(headers, "x-original-from");
  const originalAddr = extractEmailAddress(original);
  return {
    fromEmail: originalAddr ?? fromEmail,
    relayedVia: listId,
  };
}

// ── Courtesy reply: debounced into ONE digest per sender ─────────────────────
/**
 * How long a sender's reply batch stays open. Someone forwarding a stack of
 * receipts in one sitting — and a BACKFILL sweep replaying months of them —
 * should get ONE email, not one per receipt. The window is fixed from the
 * FIRST receipt (never extended by later ones), so a steady trickle can't
 * postpone the reply indefinitely: a sender always hears back within this long
 * of their first receipt. See `receiptReplyBatches` in `schema/finances.ts`.
 */
export const REPLY_DEBOUNCE_MS = 10 * 60 * 1000;
/** Per-batch item cap — a digest listing hundreds of receipts helps nobody.
 *  Anything past it is COUNTED into `overflowCount` and reported as "+N more",
 *  never silently dropped. */
const MAX_BATCH_ITEMS = 50;

const replyItemValidator = v.object({
  outcome: v.union(
    v.literal("matched"),
    v.literal("no_match"),
    v.literal("needs_review"),
  ),
  amountCents: v.optional(v.number()),
  merchant: v.optional(v.string()),
});
type ReplyItem = {
  outcome: "matched" | "no_match" | "needs_review";
  amountCents?: number;
  merchant?: string;
};

/**
 * Add one receipt outcome to its sender's open reply batch, opening one (and
 * scheduling its flush) if there isn't one. This is what the pipeline calls
 * instead of sending mail directly.
 *
 * LOOP GUARD: never enqueues for the receipts inbox or the Google Group
 * fronting it (`isReceiptInboxSelf`). A reply there would fan a robot ack out
 * to every group member AND be relayed straight back to us as a fresh inbound
 * receipt.
 *
 * Concurrent arrivals are safe: Convex's OCC serializes writes, so two
 * receipts landing at once can't both open a batch — the loser retries, reads
 * the winner's open batch, and joins it.
 */
export const enqueueReplyItem = internalMutation({
  args: { recipientEmail: v.string(), item: replyItemValidator },
  returns: v.union(v.id("receiptReplyBatches"), v.null()),
  handler: async (ctx, { recipientEmail, item }) => {
    if (isReceiptInboxSelf(recipientEmail)) {
      console.log(
        `[receiptInbox] suppressing reply to our own inbox/list (${recipientEmail}).`,
      );
      return null;
    }
    const to = extractEmailAddress(recipientEmail);
    if (!to) return null;

    const open = await ctx.db
      .query("receiptReplyBatches")
      .withIndex("by_recipient_and_sent", (q) =>
        q.eq("recipientEmail", to).eq("sentAt", undefined),
      )
      .first();
    if (open) {
      if (open.items.length >= MAX_BATCH_ITEMS) {
        await ctx.db.patch(open._id, {
          overflowCount: (open.overflowCount ?? 0) + 1,
        });
      } else {
        await ctx.db.patch(open._id, { items: [...open.items, item] });
      }
      return open._id;
    }

    const batchId = await ctx.db.insert("receiptReplyBatches", {
      recipientEmail: to,
      items: [item],
      windowStartedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(
      REPLY_DEBOUNCE_MS,
      internal.receiptInbox.flushReplyBatch,
      { batchId },
    );
    return batchId;
  },
});

/**
 * CLAIM a batch: stamp `sentAt` and hand back its contents in the SAME
 * transaction. Claiming before sending (rather than after) is deliberate — a
 * double-fired schedule must never send the same digest twice, and the reply
 * is best-effort by contract, so losing one to a send failure is the better
 * trade than mailing someone the same digest again.
 */
export const claimReplyBatch = internalMutation({
  args: { batchId: v.id("receiptReplyBatches") },
  returns: v.union(
    v.object({
      recipientEmail: v.string(),
      items: v.array(replyItemValidator),
      overflowCount: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, { batchId }) => {
    const batch = await ctx.db.get(batchId);
    if (!batch || batch.sentAt != null || batch.items.length === 0) return null;
    await ctx.db.patch(batchId, { sentAt: Date.now() });
    return {
      recipientEmail: batch.recipientEmail,
      items: batch.items,
      overflowCount: batch.overflowCount ?? 0,
    };
  },
});

/** Fire the digest for one batch. Scheduled `REPLY_DEBOUNCE_MS` after the
 *  batch opened; a no-op if the batch is gone or already claimed. */
export const flushReplyBatch = internalAction({
  args: { batchId: v.id("receiptReplyBatches") },
  returns: v.null(),
  handler: async (ctx, { batchId }) => {
    const claimed = await ctx.runMutation(internal.receiptInbox.claimReplyBatch, {
      batchId,
    });
    if (!claimed) return null;
    const { subject, html } = composeReplyDigest(
      claimed.items,
      claimed.overflowCount,
    );
    try {
      await sendEmail(ctx, { to: claimed.recipientEmail, subject, html });
    } catch (err) {
      // Best-effort by contract: `sendEmail` can still throw on a NETWORK
      // error (its own catch only covers non-2xx). A failed courtesy reply
      // must never surface as a pipeline failure — every receipt's terminal
      // status was written long before this ran.
      console.log(`[receiptInbox] reply digest failed: ${String(err)}`);
    }
    return null;
  },
});

/** One line describing a single receipt's outcome, for a multi-receipt digest. */
function digestLine(item: ReplyItem): string {
  const amt = item.amountCents != null ? fmtUsd(item.amountCents) : "Receipt";
  const from = item.merchant ? ` from ${item.merchant}` : "";
  const tail =
    item.outcome === "matched"
      ? "attached to a card charge"
      : item.outcome === "no_match"
        ? "no matching charge yet — filed for a bookkeeper"
        : "needs a bookkeeper's eye";
  return `${amt}${from} — ${tail}`;
}

/**
 * Compose the digest for one batch. A SINGLE receipt reads exactly as it
 * always did (this is the common case and shouldn't have become a "digest");
 * several read as a summary line plus one line per receipt. Pure + exported
 * for direct unit testing.
 */
export function composeReplyDigest(
  items: ReplyItem[],
  overflowCount = 0,
): { subject: string; html: string } {
  const wrap = (body: string) =>
    `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#2b2320">${body}<p style="color:#8a7d78;font-size:13px">— Public Worship finance</p></div>`;

  if (items.length === 1) {
    const only = items[0];
    const amt = only.amountCents != null ? fmtUsd(only.amountCents) : "your receipt";
    if (only.outcome === "matched") {
      return {
        subject: "Receipt matched ✓",
        html: wrap(
          `<p>We matched ${amt}${only.merchant ? ` from ${only.merchant}` : ""} to a card charge and attached your receipt. Nothing else to do.</p>`,
        ),
      };
    }
    if (only.outcome === "no_match") {
      return {
        subject: "Receipt received — no matching charge yet",
        html: wrap(
          `<p>Thanks — we read ${amt}, but couldn't find a card charge for it yet. We've filed it for a bookkeeper to place. If the charge posts later, they'll attach it.</p>`,
        ),
      };
    }
    return {
      subject: "Receipt received — needs a quick look",
      html: wrap(
        `<p>Thanks — we've received your receipt${only.amountCents != null ? ` for ${amt}` : ""} and filed it for a bookkeeper to attach to the right charge.</p>`,
      ),
    };
  }

  const total = items.length + overflowCount;
  const matched = items.filter((i) => i.outcome === "matched").length;
  const needsReview = items.filter((i) => i.outcome === "needs_review").length;
  const noMatch = items.filter((i) => i.outcome === "no_match").length;
  const allMatched = matched === items.length && overflowCount === 0;

  const parts: string[] = [];
  if (matched) parts.push(`${matched} attached to charges`);
  if (noMatch) parts.push(`${noMatch} with no matching charge yet`);
  if (needsReview) parts.push(`${needsReview} needing a bookkeeper's eye`);

  const lead = allMatched
    ? `We matched all ${total} receipts you sent to card charges and attached them. Nothing else to do.`
    : `We processed ${total} receipt${total === 1 ? "" : "s"} you sent: ${parts.join(", ")}. Anything unmatched is filed for a bookkeeper — nothing is lost.`;
  const list = items.map((i) => `<li>${digestLine(i)}</li>`).join("");
  const more = overflowCount
    ? `<p style="color:#8a7d78;font-size:13px">+${overflowCount} more not listed individually.</p>`
    : "";

  return {
    subject: allMatched
      ? `${total} receipts matched ✓`
      : `${total} receipts received`,
    html: wrap(
      `<p>${lead}</p><ul style="padding-left:18px;margin:8px 0">${list}</ul>${more}`,
    ),
  };
}

// ── Review-queue surface (in-app, bookkeeper+) ───────────────────────────────
const reviewRow = v.object({
  _id: v.id("inboundReceipts"),
  status: statusValidator,
  fromEmail: v.string(),
  /** The real poster, when a mailing list rewrote `From:` — what the queue
   *  should show instead of the list. See the schema field's doc. */
  originalSenderEmail: v.optional(v.string()),
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
        originalSenderEmail: r.originalSenderEmail,
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
