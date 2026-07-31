/**
 * Receipt-inbox RECOVERY — the catch-up pass for receipts that were emailed
 * before the Google-Group relay was handled correctly.
 *
 * Two distinct losses happened, so there are two passes. Both are internal,
 * ops-dispatch only (no UI, no cron, nothing on the public API), and both are
 * DRY-RUN BY DEFAULT: without `execute: true` they write NOTHING and return
 * exactly the counts a real run would produce. Both are idempotent — a second
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
 * MONEY SAFETY: pass 2 NEVER auto-attaches. Re-attribution is bookkeeping
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
