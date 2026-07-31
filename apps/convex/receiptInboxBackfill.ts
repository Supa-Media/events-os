/**
 * Receipt-inbox RECOVERY — the catch-up pass for receipts that were emailed
 * before the Google-Group relay was handled correctly.
 *
 * Three distinct losses happened, so there are three passes. All are internal,
 * ops-dispatch only (no UI, no cron, nothing on the public API), and all are
 * DRY-RUN BY DEFAULT: without `execute: true` they write NOTHING and return
 * exactly the counts a real run would produce. All are idempotent — a second
 * execute run is a no-op.
 *
 *  1. `backfillMissedReceiptEmails` — DROPPED MAIL. Anything sent to the
 *     `receipts@publicworship.life` Google Group was relayed to us with the
 *     GROUP in `To:` and our own address only on the envelope, so the address
 *     filter rejected it and the webhook ack'd without recording. Those emails
 *     have NO row here at all — they exist only on Resend's side. This pass
 *     lists Resend's received mail, keeps what was addressed to the receipts
 *     inbox (the same `isReceiptInboxAddress` the live route uses, now aware of
 *     both addresses), skips anything we already have (`emailId` dedup), and
 *     runs the ordinary pipeline on the rest.
 *
 *  2. `reattributeRelayedReceipts` — MIS-ATTRIBUTED ROWS. Mail that DID get
 *     recorded but whose `From:` the group had rewritten for a DMARC-strict
 *     poster ("Jane D. via receipts <receipts@publicworship.life>") resolved to
 *     no roster person, so it classified `internal`, drew no chapter, and sat
 *     in the review queue unattributed. This pass re-reads each row's headers,
 *     recovers the poster (`resolveListSender`), and re-patches sender /
 *     chapter / class onto the row and the `receipts` it produced.
 *
 *  3. `restoreEmailBodyDocuments` — UNREADABLE DOCUMENTS. Receipts that landed
 *     fine but whose stored document was written from the message's
 *     plain-text ALTERNATIVE with no charset declared, so a bookkeeper opened
 *     a wall of run-together text full of mojibake instead of the merchant's
 *     receipt. This pass re-fetches each message and rebuilds its document
 *     through the same `buildBodyDocument` the live pipeline now uses. It
 *     swaps the FILE and nothing else — no re-OCR, no re-matching, and every
 *     receipt↔transaction link stays exactly as a human left it.
 *
 * MONEY SAFETY: pass 2 NEVER auto-attaches, and pass 3 never touches a link,
 * an amount, or a status. Re-attribution is bookkeeping
 * metadata; deciding that a months-old receipt matches a particular charge is a
 * human's call, and the review queue is where they make it. Pass 1 runs the
 * normal pipeline, which carries the normal auto-attach policy (a trusted
 * sender + exactly one candidate) — the same bar the receipt would have cleared
 * had it not been dropped.
 */
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { RECEIPT_SENDER_CLASSES } from "@events-os/shared";
import {
  isReceiptInboxAddress,
  isReceiptInboxSelf,
  resolveListSender,
  extractEmailAddress,
  fetchReceivedEmail,
  buildBodyDocument,
} from "./receiptInbox";

/** How many received emails one backfill run will look at. Bounded: this is an
 *  ops sweep, not a migration — run it again for another page. */
const DEFAULT_SCAN_LIMIT = 100;
const MAX_SCAN_LIMIT = 500;
/** Resend's own page size for `GET /emails/receiving`. */
const PAGE_SIZE = 100;
/** Stagger the scheduled pipelines so a big catch-up doesn't fire a hundred
 *  OCR calls in the same instant. */
const PIPELINE_STAGGER_MS = 500;
/** Bound on how many `receipts` rows one inbound email is expected to have
 *  produced — comfortably above `MAX_RECEIPT_SOURCES`. */
const MAX_RECEIPTS_PER_ROW = 50;
/** Bound on how many transactions one receipt's document swap will repoint. */
const MAX_LINKS_PER_RECEIPT = 50;

/**
 * One received email as the LIST endpoint reports it (metadata only).
 *
 * CAVEAT: `received_for` (the envelope recipient) is documented on the single
 * RETRIEVE endpoint but is NOT dependable on this LIST response, so the sweep
 * matches on `to`/`cc` and treats `received_for` as a bonus when present. That
 * still catches the shape this backfill exists for — a Google-Group-relayed
 * post names the GROUP in `To:`, and the group address is in the inbox
 * allow-list. A message that named NEITHER address in its headers (a pure BCC
 * or alias delivery) can only be identified by retrieving it individually, and
 * this sweep will not pick it up.
 */
interface ReceivedEmailSummary {
  id: string;
  from?: string;
  to?: string[] | string;
  cc?: string[] | string;
  received_for?: string[] | string;
  subject?: string;
  created_at?: string;
}

function asList(value: string[] | string | undefined): string[] {
  return Array.isArray(value) ? value : value ? [value] : [];
}

/** Both passes call functions declared in THIS module via `internal.*`, which
 *  makes their handlers self-referential to the inference engine. Explicit
 *  return + row types break that cycle (the usual Convex fix). */
interface BackfillReport {
  executed: boolean;
  scanned: number;
  notReceiptMail: number;
  alreadyIngested: number;
  ingested: number;
  samples: string[];
  error: string | null;
}
interface ReattributeReport {
  executed: boolean;
  scanned: number;
  reattributed: number;
  unchanged: number;
  samples: string[];
}
interface RestoreReport {
  executed: boolean;
  scanned: number;
  restored: number;
  skipped: number;
  repointedTransactions: number;
  samples: string[];
}
interface BodyDocumentCandidate {
  receiptId: Id<"receipts">;
  storageId: Id<"_storage">;
  emailId: string;
  filename: string | null;
}
interface ReattributionCandidate {
  _id: Id<"inboundReceipts">;
  emailId: string;
  fromEmail: string;
  subject?: string;
  hasPerson: boolean;
}

/**
 * Page through Resend's received-email list
 * (`GET /emails/receiving?limit=&after=`). The API answers
 * `{object, has_more, data}` and returns NO cursor field — you page by handing
 * back the last item's `id` as `after` — so that's the primary path here.
 * Defensive around it (a bare array, or a future explicit cursor, both work)
 * and it always terminates: no `has_more`, an empty page, or a cursor that
 * didn't advance all stop the loop, so an API shape change degrades to
 * "backfilled less" rather than to a crash or a spin.
 */
async function listReceivedEmails(
  limit: number,
): Promise<{ emails: ReceivedEmailSummary[]; error: string | null }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { emails: [], error: "RESEND_API_KEY is not set." };

  const emails: ReceivedEmailSummary[] = [];
  let after: string | null = null;
  while (emails.length < limit) {
    const params = new URLSearchParams({
      limit: String(Math.min(PAGE_SIZE, limit - emails.length)),
    });
    if (after) params.set("after", after);
    let json: any;
    try {
      const res = await fetch(
        `https://api.resend.com/emails/receiving?${params.toString()}`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      if (!res.ok) {
        return {
          emails,
          error: `list failed (${res.status}) after ${emails.length} email(s)`,
        };
      }
      json = await res.json();
    } catch (err) {
      return { emails, error: `list errored: ${String(err)}` };
    }
    const page: ReceivedEmailSummary[] =
      (Array.isArray(json) ? json : json?.data) ?? [];
    emails.push(...page.filter((e) => e && typeof e.id === "string"));
    // Only continue when the API both says there's more AND gives us a cursor
    // to ask for it — no cursor means one page is all we can safely read.
    const nextCursor: string | null =
      typeof json?.next_cursor === "string"
        ? json.next_cursor
        : json?.has_more === true && page.length > 0
          ? (page[page.length - 1]?.id ?? null)
          : null;
    if (page.length === 0 || !nextCursor || nextCursor === after) break;
    after = nextCursor;
  }
  return { emails: emails.slice(0, limit), error: null };
}

// ── Pass 1: mail that was dropped before it was ever recorded ────────────────
/** True iff we already hold a row for this provider email id. */
export const hasInboundReceipt = internalQuery({
  args: { emailId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { emailId }) => {
    const existing = await ctx.db
      .query("inboundReceipts")
      .withIndex("by_email_id", (q) => q.eq("emailId", emailId))
      .first();
    return existing != null;
  },
});

const backfillResult = v.object({
  executed: v.boolean(),
  scanned: v.number(),
  notReceiptMail: v.number(),
  alreadyIngested: v.number(),
  /** Recorded + pipeline scheduled (or, on a dry run, WOULD be). */
  ingested: v.number(),
  /** One line per email this run acted on, for the ops transcript. */
  samples: v.array(v.string()),
  error: v.union(v.string(), v.null()),
});

/**
 * Ingest receipt emails Resend received but we never recorded — the mail the
 * address filter dropped before it recognized the Google Group. Dry-run by
 * default; `execute: true` records each missing email and schedules the same
 * pipeline the live webhook would have.
 *
 * Idempotent via the `emailId` dedup that guards the webhook itself, so a
 * re-run only ever picks up what's genuinely still missing.
 */
export const backfillMissedReceiptEmails = internalAction({
  args: {
    limit: v.optional(v.number()),
    /** Only consider mail received at/after this ms timestamp. */
    sinceMs: v.optional(v.number()),
    execute: v.optional(v.boolean()),
  },
  returns: backfillResult,
  handler: async (ctx, args): Promise<BackfillReport> => {
    const executed = args.execute === true;
    const limit = Math.min(args.limit ?? DEFAULT_SCAN_LIMIT, MAX_SCAN_LIMIT);
    const { emails, error } = await listReceivedEmails(limit);

    let notReceiptMail = 0;
    let alreadyIngested = 0;
    let ingested = 0;
    const samples: string[] = [];

    for (const email of emails) {
      const receivedAt = email.created_at ? Date.parse(email.created_at) : NaN;
      if (args.sinceMs != null && Number.isFinite(receivedAt) && receivedAt < args.sinceMs) {
        continue;
      }
      const recipients = [
        ...asList(email.to),
        ...asList(email.cc),
        ...asList(email.received_for),
      ];
      if (!isReceiptInboxAddress(recipients)) {
        notReceiptMail++;
        continue;
      }
      const known: boolean = await ctx.runQuery(
        internal.receiptInboxBackfill.hasInboundReceipt,
        { emailId: email.id },
      );
      if (known) {
        alreadyIngested++;
        continue;
      }
      ingested++;
      if (samples.length < 20) {
        samples.push(
          `${email.created_at ?? "?"} — ${email.from ?? "?"} — ${email.subject ?? "(no subject)"}`,
        );
      }
      if (!executed) continue;

      const { isNew, receiptId } = await ctx.runMutation(
        internal.receiptInbox.recordInboundReceipt,
        {
          envelope: {
            emailId: email.id,
            fromEmail: email.from ?? "",
            toEmail: asList(email.to)[0] ?? asList(email.received_for)[0],
            subject: email.subject,
          },
        },
      );
      // Raced with the live webhook between the check and the insert — the
      // dedup won, so leave the pipeline to whoever scheduled it first.
      if (!isNew) {
        ingested--;
        alreadyIngested++;
        continue;
      }
      await ctx.scheduler.runAfter(
        ingested * PIPELINE_STAGGER_MS,
        internal.receiptInbox.processInboundReceipt,
        { receiptId },
      );
    }

    return {
      executed,
      scanned: emails.length,
      notReceiptMail,
      alreadyIngested,
      ingested,
      samples,
      error,
    };
  },
});

// ── Pass 2: rows recorded, but attributed to the list instead of the poster ──
/** Rows worth re-checking: no resolved person yet, or a `From:` that IS one of
 *  our own inbox/list addresses (the DMARC-rewrite shape). Bounded scan —
 *  the inbound table is small and this is an ops sweep. */
export const listReattributionCandidates = internalQuery({
  args: { limit: v.number() },
  returns: v.array(
    v.object({
      _id: v.id("inboundReceipts"),
      emailId: v.string(),
      fromEmail: v.string(),
      subject: v.optional(v.string()),
      hasPerson: v.boolean(),
    }),
  ),
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db.query("inboundReceipts").order("desc").take(limit);
    return rows
      .filter(
        (r) =>
          r.channel !== "sms" &&
          r.originalSenderEmail == null &&
          (r.personId == null || isReceiptInboxSelf(r.fromEmail)),
      )
      .map((r) => ({
        _id: r._id,
        emailId: r.emailId,
        fromEmail: r.fromEmail,
        subject: r.subject,
        hasPerson: r.personId != null,
      }));
  },
});

/**
 * Apply one recovered attribution to the inbound row AND to the `receipts` it
 * produced (so the receipt library scopes them to the right chapter and the
 * queue names the right person). Metadata ONLY — never touches links,
 * statuses, or transactions; see the module doc's money-safety note.
 */
export const patchAttribution = internalMutation({
  args: {
    receiptId: v.id("inboundReceipts"),
    originalSenderEmail: v.string(),
    personId: v.optional(v.id("people")),
    chapterId: v.optional(v.id("chapters")),
    senderClass: v.union(...RECEIPT_SENDER_CLASSES.map((c) => v.literal(c))),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.receiptId, {
      originalSenderEmail: args.originalSenderEmail,
      ...(args.personId ? { personId: args.personId } : {}),
      ...(args.chapterId ? { chapterId: args.chapterId } : {}),
      senderClass: args.senderClass,
      updatedAt: Date.now(),
    });
    // The receipts this email produced follow their inbound row's attribution.
    const produced = await ctx.db
      .query("receipts")
      .withIndex("by_inbound", (q) => q.eq("inboundReceiptId", args.receiptId))
      .take(MAX_RECEIPTS_PER_ROW);
    for (const receipt of produced) {
      await ctx.db.patch(receipt._id, {
        ...(args.chapterId ? { chapterId: args.chapterId } : {}),
        senderClass: args.senderClass,
        updatedAt: Date.now(),
      });
    }
    return produced.length;
  },
});

const reattributeResult = v.object({
  executed: v.boolean(),
  scanned: v.number(),
  /** Rows whose headers named a different, resolvable sender. */
  reattributed: v.number(),
  /** Rows re-checked but left alone (not list mail, or nothing recoverable). */
  unchanged: v.number(),
  samples: v.array(v.string()),
});

/**
 * Re-attribute already-recorded rows whose sender was the mailing list rather
 * than the person. Dry-run by default. Metadata only — never attaches a
 * receipt to a charge (a human confirms a months-old match).
 */
export const reattributeRelayedReceipts = internalAction({
  args: {
    limit: v.optional(v.number()),
    execute: v.optional(v.boolean()),
  },
  returns: reattributeResult,
  handler: async (ctx, args): Promise<ReattributeReport> => {
    const executed = args.execute === true;
    const limit = Math.min(args.limit ?? DEFAULT_SCAN_LIMIT, MAX_SCAN_LIMIT);
    const candidates: ReattributionCandidate[] = await ctx.runQuery(
      internal.receiptInboxBackfill.listReattributionCandidates,
      { limit },
    );

    let reattributed = 0;
    let unchanged = 0;
    const samples: string[] = [];

    for (const row of candidates) {
      const headers = await fetchReceivedHeaders(row.emailId);
      const { fromEmail: recovered } = resolveListSender(row.fromEmail, headers);
      const recoveredAddr = extractEmailAddress(recovered);
      if (
        !recoveredAddr ||
        recoveredAddr === extractEmailAddress(row.fromEmail) ||
        isReceiptInboxSelf(recoveredAddr)
      ) {
        unchanged++;
        continue;
      }
      const sender = await ctx.runQuery(internal.receiptInbox.classifySender, {
        email: recoveredAddr,
      });
      reattributed++;
      if (samples.length < 20) {
        samples.push(
          `${row.subject ?? "(no subject)"} — ${row.fromEmail} → ${recoveredAddr} (${sender.senderClass})`,
        );
      }
      if (!executed) continue;
      await ctx.runMutation(internal.receiptInboxBackfill.patchAttribution, {
        receiptId: row._id,
        originalSenderEmail: recoveredAddr,
        personId: sender.personId ?? undefined,
        chapterId: sender.chapterId ?? undefined,
        senderClass: sender.senderClass,
      });
    }

    return {
      executed,
      scanned: candidates.length,
      reattributed,
      unchanged,
      samples,
    };
  },
});

// ── Pass 3: body documents stored before the HTML/charset rule existed ───────
/**
 * Receipts whose STORED DOCUMENT predates `buildBodyDocument` — written from
 * the message's plain-text alternative, with no charset declared. Those are
 * the ones that render as a wall of run-together text with mojibake.
 *
 * This query only narrows to EMAIL-SOURCED receipts whose message we can
 * still ask Resend for; the "is this document actually the old shape?"
 * decision belongs to the action, which reads the stored blob's own type
 * (`needsRepair`). Doing it there rather than off `_storage` metadata keeps
 * one source of truth for the answer — the bytes as stored.
 */
export const listBodyDocumentCandidates = internalQuery({
  args: { limit: v.number() },
  returns: v.array(
    v.object({
      receiptId: v.id("receipts"),
      storageId: v.id("_storage"),
      emailId: v.string(),
      filename: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db.query("receipts").order("desc").take(limit);
    const out = [];
    for (const r of rows) {
      if (r.source !== "email" || r.inboundReceiptId == null) continue;
      const inbound = await ctx.db.get(r.inboundReceiptId);
      if (!inbound?.emailId) continue;
      out.push({
        receiptId: r._id,
        storageId: r.storageId,
        emailId: inbound.emailId,
        filename: r.filename ?? null,
      });
    }
    return out;
  },
});

/**
 * Point a receipt at a freshly-stored document and keep every pointer to the
 * old one honest.
 *
 * `transactions.receiptStorageId` is a DENORMALIZED CACHE of
 * `receipts.storageId` (see `lib/receiptLinks.ts`) — swapping the file without
 * repointing it would leave a reconciled charge showing a deleted blob, which
 * is strictly worse than the mojibake this pass exists to fix. Every linked
 * transaction still pointing at the old file is repointed in the SAME
 * transaction as the swap.
 *
 * `fileSha256` is re-read from the new blob so the cross-source duplicate
 * guard keeps describing the bytes that are actually stored.
 *
 * Returns the OLD storage id so the caller can delete it only after the swap
 * has committed — never before.
 */
export const swapReceiptDocument = internalMutation({
  args: { receiptId: v.id("receipts"), newStorageId: v.id("_storage") },
  returns: v.union(
    v.object({
      oldStorageId: v.id("_storage"),
      repointedTransactions: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, { receiptId, newStorageId }) => {
    const receipt = await ctx.db.get(receiptId);
    if (!receipt) return null;
    const oldStorageId = receipt.storageId;
    if (oldStorageId === newStorageId) return null;

    const meta = await ctx.db.system.get("_storage", newStorageId);
    await ctx.db.patch(receiptId, {
      storageId: newStorageId,
      ...(meta?.sha256 ? { fileSha256: meta.sha256 } : {}),
      updatedAt: Date.now(),
    });

    const links = await ctx.db
      .query("receiptLinks")
      .withIndex("by_receipt", (q) => q.eq("receiptId", receiptId))
      .take(MAX_LINKS_PER_RECEIPT);
    let repointedTransactions = 0;
    for (const link of links) {
      const txn = await ctx.db.get(link.transactionId);
      if (txn && txn.receiptStorageId === oldStorageId) {
        await ctx.db.patch(link.transactionId, { receiptStorageId: newStorageId });
        repointedTransactions++;
      }
    }
    return { oldStorageId, repointedTransactions };
  },
});

/** True iff a stored document predates the HTML/charset rule: a `text/*` blob
 *  with no declared charset. An attachment receipt (image, PDF) is stored
 *  verbatim and was never affected; a repaired document always carries
 *  `charset=`, which is what makes a re-run a no-op. */
function needsRepair(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return ct.startsWith("text/") && !ct.includes("charset=");
}

const restoreResult = v.object({
  executed: v.boolean(),
  scanned: v.number(),
  /** Documents re-stored from the message's HTML (or its text, with a charset). */
  restored: v.number(),
  /** Candidates left alone — the message is no longer fetchable from Resend,
   *  or it carried no body at all. */
  skipped: v.number(),
  repointedTransactions: v.number(),
  samples: v.array(v.string()),
});

/**
 * Re-store the body documents written before the HTML/charset rule, so
 * receipts that ALREADY landed render like the receipts they are instead of a
 * wall of text. Dry-run by default; idempotent (see
 * `listBodyDocumentCandidates`).
 *
 * Re-fetches each message from Resend and rebuilds its document through the
 * SAME `buildBodyDocument` the live pipeline uses. Deliberately does NOT
 * re-run OCR, matching, or linking: the amount, merchant, and every
 * receipt↔transaction link stay exactly as a human left them. This swaps the
 * FILE and nothing else.
 */
export const restoreEmailBodyDocuments = internalAction({
  args: {
    limit: v.optional(v.number()),
    execute: v.optional(v.boolean()),
  },
  returns: restoreResult,
  handler: async (ctx, args): Promise<RestoreReport> => {
    const executed = args.execute === true;
    const limit = Math.min(args.limit ?? DEFAULT_SCAN_LIMIT, MAX_SCAN_LIMIT);
    const candidates: BodyDocumentCandidate[] = await ctx.runQuery(
      internal.receiptInboxBackfill.listBodyDocumentCandidates,
      { limit },
    );

    let scanned = 0;
    let restored = 0;
    let skipped = 0;
    let repointedTransactions = 0;
    const samples: string[] = [];

    for (const c of candidates) {
      // The stored blob's OWN type is the decision — and its charset is the
      // idempotency marker, so a second run skips everything the first fixed.
      const currentType = await ctx.storage
        .get(c.storageId)
        .then((b) => b?.type ?? "")
        .catch(() => "");
      if (!needsRepair(currentType)) continue;
      scanned++;

      const received = await fetchReceivedEmail(c.emailId);
      const doc = received
        ? buildBodyDocument({ html: received.html, text: received.text })
        : null;
      if (!doc || !doc.content.trim()) {
        // The message is gone from Resend (or carried no body) — leave the
        // existing document exactly as it is rather than replacing it with
        // nothing.
        skipped++;
        continue;
      }
      restored++;
      if (samples.length < 20) {
        samples.push(
          `${c.filename ?? "(no filename)"}: ${currentType || "(unknown)"} → ${doc.contentType}`,
        );
      }
      if (!executed) continue;

      const newStorageId = await ctx.storage.store(
        new Blob([doc.content], { type: doc.contentType }),
      );
      const swap = await ctx.runMutation(
        internal.receiptInboxBackfill.swapReceiptDocument,
        { receiptId: c.receiptId, newStorageId },
      );
      if (!swap) {
        // The receipt vanished mid-run — drop the blob we just wrote rather
        // than orphaning it.
        await ctx.storage.delete(newStorageId);
        restored--;
        skipped++;
        continue;
      }
      repointedTransactions += swap.repointedTransactions;
      // Only now that the swap has committed is the old file safe to drop.
      await ctx.storage.delete(swap.oldStorageId);
    }

    return { executed, scanned, restored, skipped, repointedTransactions, samples };
  },
});

/** Fetch just the headers of one received email. Best-effort — a row we can't
 *  re-read is simply left as it is. */
async function fetchReceivedHeaders(
  emailId: string,
): Promise<Record<string, string> | null> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    return json?.headers && typeof json.headers === "object" ? json.headers : null;
  } catch {
    return null;
  }
}
