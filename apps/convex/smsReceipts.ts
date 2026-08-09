/**
 * Inbound SMS/MMS → OCR → SUGGEST pipeline (Twilio channel) — feeds the
 * SAME receipts pipeline as `receiptInbox.ts` (email), just triggered by a
 * text message instead of an email. Reuses the email pipeline's matcher
 * (`findReceiptMatches`), zero-LLM body parser (`parseReceiptFromText`), image
 * OCR call (`ocrReceiptImage`), PDF-aware routing (`extractReceiptFields` —
 * text layer first, scanned-PDF render as a fallback, vision only ever sees a
 * rendered `image/*`, never raw `application/pdf`), and row-lifecycle
 * plumbing (`getInboundReceipt`/`updateInboundReceipt`) rather than
 * duplicating them — see `receiptInbox.ts`'s module doc for the shared MONEY
 * SAFETY contract.
 *
 * FLOW (see `http.ts`'s `/twilio/receipts` route for the entry point):
 *   1. Twilio POSTs an inbound-message webhook when a text lands on the
 *      receipts number (form-encoded: `MessageSid`, `From`, `Body`,
 *      `NumMedia`, `MediaUrl{N}`, `MediaContentType{N}`). The route verifies
 *      `X-Twilio-Signature` (`lib/twilio.ts#verifyTwilioSignature`) against
 *      the auth token resolved the SAME stored-first way every other Twilio
 *      call in this repo does (`lib/twilio.ts#resolveTwilioCredentials`), then
 *      calls `recordSmsReceipt` — DEDUPES on Twilio's `MessageSid` (the
 *      provider's unique id, same first-sight guard `recordInboundReceipt`
 *      gives email) and inserts a `pending` row with `channel: "sms"`.
 *   2. The route schedules `processSmsReceipt`, passing the message's `Body`
 *      text + parsed media list DIRECTLY as action args (NOT persisted on the
 *      row — Twilio's inbound media URLs are short-lived-adjacent and the
 *      webhook already has them in hand; re-deriving them from `MessageSid`
 *      via a second Twilio API round-trip would be pure overhead), then
 *      returns an empty TwiML `<Response/>` fast.
 *   3. `processSmsReceipt` mirrors `processInboundReceipt`'s crash-safe shape
 *      (any throw is caught and stamped onto the row as `error` so nothing
 *      strands invisibly in `pending`):
 *        a. CLASSIFIES the sender by PHONE (`classifySmsSender`) — team /
 *           roster / external. NO "internal" class exists for a phone number
 *           (there's no org-domain equivalent to trust) — see
 *           `RECEIPT_SENDER_CLASSES`'s doc comment in `@events-os/shared`.
 *           Only a team/roster number OWNS the receipt it texts in (which is
 *           what puts it on that person's coding sheet); the class permits no
 *           write of its own.
 *        b. Gets the receipt content: every MMS media item (each fetched with
 *           Twilio's Basic-auth scheme, mirroring `fetchAllReceiptAttachments`,
 *           then stored and routed through `extractReceiptFields` — a PDF
 *           gets its text layer/page render first, an image goes to vision),
 *           else the SMS `Body` text (`parseReceiptFromText`, ZERO LLM — same
 *           as an email body).
 *        c. Matches each via the SAME matcher email uses
 *           (`internal.receiptInbox.findReceiptMatches`) — a SUGGESTION
 *           shortlist, never a decision.
 *        d. Creates `receipts` rows (source `"sms"`), UNLINKED, attributed to
 *           the sender and carrying their suggestions — exactly like email
 *           (`commitSmsReceipt`), with the same fileSha256 duplicate guard.
 *           NOTHING is attached to a charge here (capture-and-suggest, owner
 *           decision 2026-08-08 — see `receiptInbox.ts`'s module doc): texting
 *           a photo at the counter is the whole point, since the charge posts
 *           a day later, and the human confirms the link when they code it.
 *        e. Best-effort SMS reply — ONLY to team/roster senders (never a
 *           confirm-or-deny to an unverified number).
 */
import {
  internalQuery,
  internalMutation,
  internalAction,
} from "./_generated/server";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { INBOUND_RECEIPT_STATUSES, receiptSenderCanAutoAttach } from "@events-os/shared";
import { ROLLUP_SCAN_LIMIT } from "./finances";
import { createReceipt, findDuplicateReceiptBySha256 } from "./lib/receiptLinks";
import {
  normalizePhone,
  resolveTwilioCredentials,
  sendSms,
  type TwilioCredentials,
} from "./lib/twilio";
import {
  CAPTURED_STATUS,
  parseReceiptFromText,
  resolveOcrModel,
  senderDisplayName,
  extractReceiptFields,
} from "./receiptInbox";

// ── Tuning constants ─────────────────────────────────────────────────────────
/** How many MMS media items we ever process off one text (bounded — a receipt
 *  text carries one or a couple of photos, not dozens; mirrors
 *  `receiptInbox.ts`'s `MAX_ATTACHMENTS`). */
const MAX_MEDIA = 10;

const statusValidator = v.union(
  ...INBOUND_RECEIPT_STATUSES.map((s) => v.literal(s)),
);
/** A phone sender's automation class. Deliberately NARROWER than the shared
 *  `RECEIPT_SENDER_CLASSES` union — `"internal"` never applies to a phone
 *  number (see this module's doc comment) — but every value here is still a
 *  valid `ReceiptSenderClass`, so it composes with `receiptInbox.ts`'s shared
 *  helpers (`receiptSenderCanAutoAttach`, `createReceipt`'s `senderClass`). */
const smsSenderClassValidator = v.union(
  v.literal("team"),
  v.literal("roster"),
  v.literal("external"),
);

// ── Webhook URL resolution (the signature subtlety) ──────────────────────────
/**
 * The EXACT URL Twilio POSTed to — REQUIRED for `verifyTwilioSignature` (its
 * HMAC is computed over this URL verbatim). Defaults to the incoming
 * request's own `req.url`, which is correct ONLY when Twilio's console points
 * directly at the Convex site origin (`https://<deployment>.convex.site/twilio/receipts`
 * — see the docs section this PR adds). If the number's webhook is instead
 * pointed at the `publicworship.life`-proxied path, the `pw-router` Cloudflare
 * Worker rewrites the request's host to the Convex origin before forwarding
 * (`infra/router/src/route.ts`'s `isConvexPath` proxy), so the httpAction sees
 * a DIFFERENT URL than the one Twilio actually signed — verification would
 * incorrectly fail. `TWILIO_RECEIPTS_WEBHOOK_URL` overrides the default for
 * exactly that case: set it to the literal URL configured in Twilio's console.
 */
export function resolveTwilioReceiptsWebhookUrl(req: Request): string {
  return process.env.TWILIO_RECEIPTS_WEBHOOK_URL ?? req.url;
}

// ── Sender resolution + classification (by PHONE) ────────────────────────────
/** Strip everything but digits and keep the last 10 — the US-biased
 *  normalization this org's `normalizePhone` also assumes, but comparison-only
 *  (never reconstructs a dialable number): a bare `9175550000`, a `+1
 *  9175550000`, and a `(917) 555-0000` all reduce to the same key, so a
 *  `people.phone` stored in any of those shapes still matches Twilio's
 *  E.164 `From`. Returns `null` for anything shorter than 10 digits (too
 *  little signal to match on). */
function last10Digits(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/**
 * Resolve an inbound SMS `From` number to a roster `people` doc (or null).
 * `people.phone` has NO index (`schema/people.ts`) — SMS-receipt volume is a
 * single inbound webhook at a time, so a bounded scan is the whole strategy
 * here (not just a backstop), mirroring `receiptInbox.ts#lookupPersonByEmail`'s
 * unindexed fallback path.
 */
async function lookupPersonByPhone(
  ctx: QueryCtx,
  phone: string,
): Promise<Doc<"people"> | null> {
  const target = last10Digits(phone);
  if (!target) return null;
  const scan = await ctx.db.query("people").take(ROLLUP_SCAN_LIMIT);
  return scan.find((p) => last10Digits(p.phone) === target) ?? null;
}

/** Resolve a phone to a person + chapter, or null. Kept as its own contract
 *  for direct testing — mirrors `receiptInbox.ts#resolvePersonByEmail`. */
export const resolvePersonByPhone = internalQuery({
  args: { phone: v.string() },
  returns: v.union(
    v.object({ personId: v.id("people"), chapterId: v.id("chapters") }),
    v.null(),
  ),
  handler: async (ctx, { phone }) => {
    const person = await lookupPersonByPhone(ctx, phone);
    if (!person) return null;
    return { personId: person._id, chapterId: person.chapterId };
  },
});

/**
 * Classify an inbound SMS sender into the team/roster/external trust axis
 * (never a permission — a phone number is spoofable via SIM-swap/VoIP just
 * like a `From:` header is — and, since the auto-attach retired, never a
 * licence to write either: it decides WHOSE receipt this is). NO `"internal"`
 * class: a phone number has no org-domain equivalent to trust on its own, so
 * an unresolved phone is always `external` — mirrors
 * `receiptInbox.ts#classifySender` but narrower.
 */
export const classifySmsSender = internalQuery({
  args: { phone: v.string() },
  returns: v.object({
    senderClass: smsSenderClassValidator,
    personId: v.union(v.id("people"), v.null()),
    chapterId: v.union(v.id("chapters"), v.null()),
  }),
  handler: async (ctx, { phone }) => {
    const person = await lookupPersonByPhone(ctx, phone);
    // A contact-only match (person-centric audiences Phase 1 — auto-created
    // from a donor gift, an import, or a public RSVP) is NOT a cardholder or
    // team member — classify it the same as no match at all, so a text from
    // a guest's/donor's phone number gets human review instead of being filed
    // as a roster member's own receipt (`receiptSenderCanAutoAttach`).
    if (person && person.isContactOnly !== true) {
      return {
        senderClass: person.isTeamMember ? ("team" as const) : ("roster" as const),
        personId: person._id,
        chapterId: person.chapterId,
      };
    }
    return { senderClass: "external" as const, personId: null, chapterId: null };
  },
});

// ── Dedup + insert (called by the HTTP route, first thing) ───────────────────
/** The envelope the HTTP route captures off the signature-verified webhook and
 *  hands to the dedup mutation. */
export const smsEnvelope = v.object({
  messageSid: v.string(),
  fromPhone: v.string(),
  body: v.optional(v.string()),
});

/**
 * Record an inbound SMS/MMS and report whether it is NEW. Deduped on Twilio's
 * `MessageSid` via `by_sms_sid` — a Twilio redelivery (Twilio retries on a
 * non-2xx or a timeout) finds the existing row and returns `{isNew: false}`,
 * so the route never double-schedules the pipeline. Convex mutations are
 * single-threaded transactions with optimistic concurrency control, so two
 * concurrent deliveries of the SAME MessageSid can't both observe "no
 * existing row" and both insert — one retries against the other's committed
 * insert and finds it (same race-safety argument as `recordInboundReceipt`).
 * On first sight, inserts a `pending`, `channel: "sms"` row.
 */
export const recordSmsReceipt = internalMutation({
  args: { envelope: smsEnvelope },
  returns: v.object({
    isNew: v.boolean(),
    receiptId: v.id("inboundReceipts"),
  }),
  handler: async (ctx, { envelope }) => {
    const existing = await ctx.db
      .query("inboundReceipts")
      .withIndex("by_sms_sid", (q) => q.eq("smsMessageSid", envelope.messageSid))
      .first();
    if (existing) return { isNew: false, receiptId: existing._id };
    const now = Date.now();
    const receiptId = await ctx.db.insert("inboundReceipts", {
      // `emailId` is reused as "the provider message id" across channels (see
      // the schema doc comment) — kept equal to `smsMessageSid` so the
      // pre-existing `by_email_id` uniqueness guard also covers SMS rows.
      emailId: envelope.messageSid,
      smsMessageSid: envelope.messageSid,
      channel: "sms",
      status: "pending",
      fromEmail: envelope.fromPhone,
      fromPhone: envelope.fromPhone,
      subject: envelope.body ? envelope.body.slice(0, 120) : undefined,
      receivedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return { isNew: true, receiptId };
  },
});

// ── Commit: create receipt documents + auto-attach + write the inbound row ───
const extractedSmsReceiptValidator = v.object({
  storageId: v.id("_storage"),
  sourceKind: v.union(v.literal("attachment"), v.literal("body")),
  ocrAmountCents: v.optional(v.number()),
  ocrDate: v.optional(v.number()),
  ocrMerchant: v.optional(v.string()),
  ocrConfidence: v.optional(v.number()),
  ocrModel: v.optional(v.string()),
  candidateTransactionIds: v.array(v.id("transactions")),
});

/** Format cents as "$X.YZ" for reply copy / review detail (local copy of
 *  `receiptInbox.ts`'s private `fmtUsd` — not exported there). */
function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Create the first-class `receipts` rows for one inbound SMS — UNLINKED, with
 * their suggestions recorded — and write the aggregate outcome back onto the
 * `inboundReceipts` row, all in ONE transaction. Mirrors
 * `receiptInbox.ts#commitInboundReceipts` field-for-field, the one difference
 * being `source: "sms"` (not `"email"`).
 *
 * CAPTURE-AND-SUGGEST (owner decision, 2026-08-08) — IDENTICAL to email: this
 * used to auto-attach a trusted sender's unique candidate and stamp the link
 * `auto_sms`. It no longer links anything, so no `receiptLinks` row is ever
 * written with that source again; the receipt is filed to the sender
 * (`uploadedByPersonId`) with its candidate shortlist as suggestions, and the
 * human attaches it from the coding sheet
 * (`receipts.ts#confirmSuggestedReceipt`). An `external` sender, an unreadable
 * total, an unknown chapter, or a byte-identical resend
 * (`findDuplicateReceiptBySha256`) still routes to the bookkeeper queue —
 * there's nobody to suggest it to.
 */
export const commitSmsReceipt = internalMutation({
  args: {
    receiptId: v.id("inboundReceipts"),
    personId: v.optional(v.id("people")),
    chapterId: v.optional(v.id("chapters")),
    senderClass: smsSenderClassValidator,
    extracted: v.array(extractedSmsReceiptValidator),
  },
  returns: v.object({
    status: statusValidator,
    /** The top suggestion for the first extracted receipt — what the reply
     *  text names. Never a link (see this mutation's doc). */
    suggestedTransactionId: v.union(v.id("transactions"), v.null()),
    suggestedMerchant: v.union(v.string(), v.null()),
    amountCents: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    // Trust is an ATTRIBUTION signal only now — whose receipt this is, hence
    // whose coding sheet it shows up on. It permits no write.
    const senderOwnsReceipt =
      args.personId != null && receiptSenderCanAutoAttach(args.senderClass);
    const chapterKnown = args.chapterId != null;

    let suggestedCount = 0;
    let firstSuggestedTxn: Id<"transactions"> | null = null;
    let firstSuggestedMerchant: string | null = null;
    const reasons = new Set<string>();

    for (const ex of args.extracted) {
      // Exact-dupe check — the same bytes landing twice (a resent MMS photo,
      // a Twilio redelivery that slipped past the MessageSid dedup somehow):
      // chapter-scoped `_storage` sha256 match, same guard email uses.
      const meta = await ctx.db.system.get("_storage", ex.storageId);
      const fileSha256 = meta?.sha256;
      const duplicateOfReceiptId = fileSha256
        ? ((await findDuplicateReceiptBySha256(ctx, args.chapterId, fileSha256)) ??
          undefined)
        : undefined;

      const receiptId = await createReceipt(ctx, {
        chapterId: args.chapterId,
        storageId: ex.storageId,
        source: "sms",
        inboundReceiptId: args.receiptId,
        senderClass: args.senderClass,
        // WHOSE receipt this is — the reason a cardholder is offered back the
        // photo they texted from the counter. Only a phone that RESOLVED to a
        // roster person owns one (a number is spoofable).
        uploadedByPersonId: senderOwnsReceipt ? args.personId : undefined,
        ocrAmountCents: ex.ocrAmountCents,
        ocrDate: ex.ocrDate,
        ocrMerchant: ex.ocrMerchant,
        ocrConfidence: ex.ocrConfidence,
        ocrModel: ex.ocrModel,
        candidateTransactionIds: ex.candidateTransactionIds.length
          ? ex.candidateTransactionIds
          : undefined,
        fileSha256,
        duplicateOfReceiptId,
      });

      if (duplicateOfReceiptId) {
        reasons.add("duplicate");
        continue;
      }
      if (ex.ocrAmountCents == null) {
        reasons.add("unreadable");
        continue;
      }
      if (!chapterKnown) {
        reasons.add("unknown");
        continue;
      }
      const cands = ex.candidateTransactionIds;
      if (cands.length === 0) continue; // clean read, nothing matched → no_match
      // Captured WITH suggestions — the shortlist is already on the receipt;
      // nothing is linked (see this mutation's doc).
      suggestedCount++;
      if (firstSuggestedTxn == null) {
        firstSuggestedTxn = cands[0];
        const txn = await ctx.db.get(cands[0]);
        firstSuggestedMerchant = txn?.merchantName ?? txn?.description ?? null;
      }
    }

    const total = args.extracted.length;
    const firstAmount = args.extracted[0]?.ocrAmountCents ?? null;

    // Most-actionable-first, exactly as email aggregates it.
    let status: (typeof INBOUND_RECEIPT_STATUSES)[number];
    let detail: string;
    if (reasons.size > 0) {
      status = "needs_review";
      if (reasons.has("duplicate")) {
        detail =
          "Looks like a duplicate of an already-submitted receipt — a bookkeeper should confirm.";
      } else if (reasons.has("unknown")) {
        detail = "Sender unknown — pick the transaction manually.";
      } else {
        detail =
          total === 1
            ? "Could not read a total off the photo — needs a human."
            : "One or more receipts need a human to place.";
      }
    } else if (total > 0 && suggestedCount === total) {
      status = CAPTURED_STATUS;
      const who = await senderDisplayName(ctx, args.personId);
      detail =
        total === 1
          ? `Filed to ${who}'s receipts${
              firstAmount != null ? ` (${fmtUsd(firstAmount)})` : ""
            } — suggested against ${
              firstSuggestedMerchant ?? "a charge"
            }, to confirm when the charge is coded.`
          : `Filed ${total} receipts to ${who}'s receipts with suggested charges, to confirm when those charges are coded.`;
    } else {
      status = "no_match";
      detail =
        total === 1 && firstAmount != null
          ? `No unreceipted charge for ${fmtUsd(firstAmount)} within ±14 days.`
          : "No matching charges found.";
    }

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
      // No `matchedTransactionId` — nothing is attached here any more (see the
      // doc); the suggestions live on `candidateTransactionIds`.
      status,
      detail,
      updatedAt: Date.now(),
    });

    return {
      status,
      suggestedTransactionId: firstSuggestedTxn,
      suggestedMerchant: firstSuggestedMerchant,
      amountCents: firstAmount,
    };
  },
});

// ── Media fetch (Twilio Basic auth) ──────────────────────────────────────────
/**
 * Fetch ONE MMS media item off Twilio's URL. Twilio media URLs require HTTP
 * Basic auth (`accountSid:authToken` — the SAME credentials every other
 * Twilio call in this repo resolves via `resolveTwilioCredentials`), unlike
 * Resend's short-lived signed CloudFront download URLs
 * (`receiptInbox.ts#fetchAllReceiptAttachments`). Returns `null` on any
 * failure (not configured, network, non-2xx) — best-effort, mirrors the email
 * pipeline's attachment-download degrade.
 */
async function fetchTwilioMedia(
  url: string,
  creds: TwilioCredentials | null,
): Promise<Blob | null> {
  if (!creds) {
    console.log("[smsReceipts] Twilio not configured — cannot fetch media.");
    return null;
  }
  try {
    const auth = btoa(`${creds.accountSid}:${creds.authToken}`);
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) {
      console.log(`[smsReceipts] media fetch failed (${res.status}).`);
      return null;
    }
    // BUFFERED, not the response's own stream-backed Blob: this media item is
    // read twice (stored, then base64'd for the vision call) and in the
    // Convex runtime a second read of a streaming Blob throws
    // `TypeError: Can't re-read streaming Blob` — the same failure emailed-in
    // screenshots hit (see `receiptInbox.ts#fetchAllReceiptAttachments`).
    const streamed = await res.blob();
    return new Blob([await streamed.arrayBuffer()], { type: streamed.type });
  } catch (err) {
    console.log(`[smsReceipts] media fetch errored: ${String(err)}`);
    return null;
  }
}

// ── The pipeline action ──────────────────────────────────────────────────────
interface ExtractedSmsReceipt {
  storageId: Id<"_storage">;
  sourceKind: "attachment" | "body";
  ocrAmountCents?: number;
  ocrDate?: number;
  ocrMerchant?: string;
  ocrConfidence?: number;
  ocrModel?: string;
  candidateTransactionIds: Id<"transactions">[];
}

/** One MMS media item, as parsed off the webhook's `MediaUrl{N}`/
 *  `MediaContentType{N}` form fields by the HTTP route. Passed straight
 *  through to the action as args (never persisted on the row — see this
 *  module's doc comment for why). */
const mediaItemValidator = v.object({
  url: v.string(),
  contentType: v.optional(v.string()),
});

/**
 * Process ONE inbound SMS/MMS: classify sender → get content → OCR each →
 * match each → file the documents (unlinked, with suggestions) → reply. Scheduled by
 * the HTTP route right after `recordSmsReceipt` returns `isNew: true`. Every
 * terminal state is written back onto the row so the review queue (shared
 * with email — `receiptInbox.ts#listInboundReceipts`) is truthful.
 */
export const processSmsReceipt = internalAction({
  args: {
    receiptId: v.id("inboundReceipts"),
    body: v.optional(v.string()),
    media: v.array(mediaItemValidator),
  },
  returns: v.null(),
  handler: async (ctx, { receiptId, body, media }) => {
    const row = (await ctx.runQuery(internal.receiptInbox.getInboundReceipt, {
      receiptId,
    })) as Doc<"inboundReceipts"> | null;
    if (!row || row.status !== "pending") return null; // gone or already handled

    // CRASH SAFETY: mirrors `receiptInbox.ts#processInboundReceipt` — any
    // unexpected throw is caught and stamped `error` so the row never strands
    // invisibly in `pending`.
    try {
      await runSmsPipeline(ctx, receiptId, row, { body, media });
    } catch (err) {
      console.error(`[smsReceipts] pipeline errored for ${receiptId}: ${String(err)}`);
      try {
        await ctx.runMutation(internal.receiptInbox.updateInboundReceipt, {
          receiptId,
          patch: {
            status: "error",
            detail: `Pipeline error: ${String(err).slice(0, 500)}`,
          },
        });
      } catch (patchErr) {
        console.error(`[smsReceipts] could not mark ${receiptId} errored: ${String(patchErr)}`);
      }
    }
    return null;
  },
});

async function runSmsPipeline(
  ctx: ActionCtx,
  receiptId: Id<"inboundReceipts">,
  row: Doc<"inboundReceipts">,
  args: { body?: string; media: { url: string; contentType?: string }[] },
): Promise<null> {
  const phone = row.fromPhone ?? row.fromEmail;

  // 1. Classify the sender by phone. The gate is OPEN (mirrors email): every
  //    text is processed end-to-end; the class only decides whose receipt this
  //    is (and so whether we reply at all).
  const sender = await ctx.runQuery(internal.smsReceipts.classifySmsSender, {
    phone,
  });
  const isTrusted = receiptSenderCanAutoAttach(sender.senderClass);

  // 2. Get receipt content: EVERY MMS media item, else the Body text.
  const extracted: ExtractedSmsReceipt[] = [];

  if (args.media.length > 0) {
    const creds = await resolveTwilioCredentials(ctx);
    // Resolve the active AI engine (provider + key + global model) once, then
    // the OCR model for this provider.
    const config = await ctx.runQuery(
      internal.integrationSettings.readAiEngineConfig,
      {},
    );
    const model = resolveOcrModel(config);
    for (const item of args.media.slice(0, MAX_MEDIA)) {
      const blob = await fetchTwilioMedia(item.url, creds);
      if (!blob) continue;
      const storageId = await ctx.storage.store(blob);
      const contentType = item.contentType ?? blob.type ?? "application/octet-stream";

      // EVERY media item — photo or PDF — goes through the SAME extraction
      // routing the email/upload pipelines use (`extractReceiptFields`, which
      // reads the STORED file): a PDF gets its text layer first and a
      // scanned-PDF page render as a fallback, never straight into
      // `ocrReceiptImage` with the raw bytes — base64'ing a PDF into an
      // `image_url` reproduces the exact pre-#406 bug (Ollama sniffs the
      // bytes and 400s on `application/pdf` masquerading as an image; see
      // `receiptInbox.ts`'s module doc for the full story). An image goes
      // straight to vision from the stored bytes, exactly as before.
      // Extraction's typed `ocrError` isn't surfaced on this channel yet
      // (out of scope here; email/upload/retry do), so a failure still
      // degrades to blank OCR fields.
      const result = await extractReceiptFields(ctx, {
        storageId,
        config,
        contentType,
        model,
      });
      extracted.push({
        storageId,
        sourceKind: "attachment",
        ocrAmountCents: result.ocrAmountCents,
        ocrDate: result.ocrDate,
        ocrMerchant: result.ocrMerchant,
        ocrConfidence: result.ocrConfidence,
        ocrModel: result.ocrModel,
        candidateTransactionIds: [],
      });
    }
  }

  if (extracted.length === 0) {
    // No usable media — the text BODY is the receipt (ZERO LLM), same as the
    // email pipeline's body path. Stored as a file so it can be attached to a
    // charge exactly like a photo.
    const text = args.body ?? "";
    if (text.trim()) {
      const storageId = await ctx.storage.store(
        new Blob([text], { type: "text/plain" }),
      );
      const parsed = parseReceiptFromText(text);
      extracted.push({
        storageId,
        sourceKind: "body",
        ocrAmountCents: parsed.amountCents ?? undefined,
        ocrDate: parsed.date ?? undefined,
        ocrMerchant: parsed.merchant ?? undefined,
        ocrConfidence: parsed.amountCents != null ? 0.5 : 0,
        candidateTransactionIds: [],
      });
    }
  }

  // 3. Nothing to OCR at all — a non-receipt text (e.g. "thanks!"). Mark
  //    ignored without inventing a receipt document.
  if (extracted.length === 0) {
    await ctx.runMutation(internal.receiptInbox.updateInboundReceipt, {
      receiptId,
      patch: {
        status: "ignored",
        senderClass: sender.senderClass,
        ...(sender.personId ? { personId: sender.personId } : {}),
        ...(sender.chapterId ? { chapterId: sender.chapterId } : {}),
        detail: "No MMS photo or readable text found in the message.",
      },
    });
    return null;
  }

  // 4. Match each extracted receipt — the SAME matcher email uses, producing
  //    SUGGESTIONS rather than a decision. No chapter (unresolved sender) →
  //    no candidates.
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

  // 5. Create the receipt documents (unlinked, with their suggestions) and
  //    write the aggregate outcome onto the inbound row.
  const result = await ctx.runMutation(internal.smsReceipts.commitSmsReceipt, {
    receiptId,
    personId: sender.personId ?? undefined,
    chapterId: sender.chapterId ?? undefined,
    senderClass: sender.senderClass,
    extracted: extracted.map((ex) => ({
      storageId: ex.storageId,
      sourceKind: ex.sourceKind,
      ocrAmountCents: ex.ocrAmountCents,
      ocrDate: ex.ocrDate,
      ocrMerchant: ex.ocrMerchant,
      ocrConfidence: ex.ocrConfidence,
      ocrModel: ex.ocrModel,
      candidateTransactionIds: ex.candidateTransactionIds,
    })),
  });

  // 6. Courtesy reply — ONLY to trusted (team/roster) senders, never to an
  //    unverified number (mirrors email's "never confirm-or-deny to a
  //    stranger" rule).
  if (isTrusted) {
    await replyToSmsSender(ctx, phone, result);
  }
  return null;
}

/**
 * Best-effort SMS confirmation to the sender (no-op without Twilio
 * configured). Only ever called for team/roster senders. Swallows its own
 * failures — a failed courtesy reply must never fail the pipeline, and the
 * terminal status is already written by the time this runs.
 */
async function replyToSmsSender(
  ctx: ActionCtx,
  phone: string,
  result: {
    status: (typeof INBOUND_RECEIPT_STATUSES)[number];
    amountCents: number | null;
    suggestedTransactionId: Id<"transactions"> | null;
    suggestedMerchant: string | null;
  },
): Promise<void> {
  const creds = await resolveTwilioCredentials(ctx);
  if (!creds) return;
  const to = normalizePhone(phone);
  if (!to) return;

  const amt = result.amountCents != null ? fmtUsd(result.amountCents) : "your receipt";
  let body: string;
  if (result.status === CAPTURED_STATUS && result.suggestedTransactionId != null) {
    // Captured cleanly, with at least one suggestion — the charge is waiting
    // for them, not for a bookkeeper. Requires BOTH: keyed on the suggestion
    // alone, an unreadable photo or a duplicate re-send would get this
    // reassuring copy whenever the matcher happened to find a plausible
    // charge, and its sender would never learn anything was wrong. Never says
    // "attached": nothing is (module doc).
    body = `Got ${amt}${
      result.suggestedMerchant ? ` — looks like your ${result.suggestedMerchant} charge` : ""
    }. Filed it; confirm it when you code that charge in the app.`;
  } else if (result.status === "no_match") {
    body = `Got ${amt}, but couldn't find a card charge for it yet. It's filed in your receipts — attach it when the charge posts and you code it.`;
  } else {
    body = `Got your receipt${
      result.amountCents != null ? ` for ${amt}` : ""
    } — filed it for a bookkeeper to attach to the right charge.`;
  }
  try {
    await sendSms(creds, { to, body });
  } catch (err) {
    console.log(`[smsReceipts] reply to sender failed: ${String(err)}`);
  }
}
