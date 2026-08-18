/**
 * Sync cards that were created in the INCREASE DASHBOARD rather than through
 * the OS (`cards.ts#issueCard`).
 *
 * WHY THIS EXISTS: `increaseLedger.ts` keys card attribution on
 * `increaseCardId → cards.by_increase_card`. A card born in Increase's own UI
 * has no `cards` row, so every charge on it ingests with null `cardId` /
 * `personId` / `cardLast4` — recorded, but belonging to nobody. The cardholder
 * opens the app and sees none of their own spend. That is exactly what
 * happened on 2026-08-17 (`card_glov69v9jshltwbywyw8`, one $14.27 Amazon
 * charge). "Make cards through the OS" is a workaround; this is the fix.
 *
 * IDENTITY — the part worth being careful about. The card object carries no
 * person reference at all (`entity_id` is null, `cardholder_name` is null on
 * every production card). Two weaker signals stand in, in strict order:
 *
 *   1. `digital_wallet.email` → `personEmails.by_email`. This is a real link,
 *      not a similarity guess: `cards.ts#issueCard` REFUSES to mint a card for
 *      anyone without an `@publicworship.life` address (`isCardEligible`), and
 *      sets that same address as the card's wallet email. `personEmails` is
 *      the normalized copy — `people.pwEmail` is stored raw (one production
 *      row reads `Kaylamarieb@publicworship.life`), so matching that field
 *      directly would miss on case alone.
 *   2. `description` → an exact, whole-string name match across the roster.
 *      Covers a dashboard card whose wallet email was left blank.
 *
 * BOTH must resolve to EXACTLY ONE person. Neither is trusted when it lands on
 * two, and that is not hypothetical: production currently holds six addresses
 * mapped to two `people` rows each, two of them `@publicworship.life`
 * (duplicate roster rows awaiting a `dataHygiene.mergePeople`). An ambiguous
 * card is left UNSYNCED with a loud log rather than attributed to a coin flip —
 * a card row is what later says whose money a charge was, and a wrong name on
 * someone's spend is worse than a charge nobody has claimed yet.
 *
 * SCOPE: a card's `chapterId` mirrors the scope of the Increase ACCOUNT it
 * draws on, never its holder's chapter — "your card determines whose account
 * paid; reconcile determines whose budget it was" (`reconciliation.ts`). Kansi
 * is a New York person whose card is drawn on central's own account, so the
 * row is scoped `"central"` and her charge stays a central-account outflow
 * that reconcile can push onto New York's budget the normal way. Keeping the
 * two in lockstep is also what lets `increaseLedger`'s same-scope attribution
 * check keep passing untouched.
 */

import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  increaseEnvForMode,
  increaseEnvForObjectId,
  increaseGet,
} from "./lib/increaseApi";
import { normalizeEmail } from "./lib/access";
import { isCardEligible } from "@events-os/shared";
import type { FinanceScope } from "./lib/finance";

/** Increase card statuses → ours. `disabled` is what `cards.ts` pushes when we
 *  lock a card, so this is the exact inverse of `setIncreaseCardStatus`. */
function mapCardStatus(
  increaseStatus: string,
): "active" | "locked" | "canceled" | null {
  if (increaseStatus === "active") return "active";
  if (increaseStatus === "disabled") return "locked";
  if (increaseStatus === "canceled") return "canceled";
  return null;
}

/** The shape we pull off an Increase card object. */
export interface IncreaseCardLite {
  increaseCardId: string;
  accountId: string;
  last4: string | undefined;
  status: string;
  description: string | undefined;
  walletEmail: string | undefined;
}

/** Read the fields we care about off a raw Increase `/cards/:id` body. Exported
 *  for tests — the shaping is where a vendor-shape change would bite. */
export function extractIncreaseCard(
  body: Record<string, unknown>,
): IncreaseCardLite | null {
  const id = body.id;
  const accountId = body.account_id;
  const status = body.status;
  if (
    typeof id !== "string" ||
    typeof accountId !== "string" ||
    typeof status !== "string"
  ) {
    return null;
  }
  const wallet = body.digital_wallet;
  const walletEmail =
    wallet !== null && typeof wallet === "object"
      ? (wallet as Record<string, unknown>).email
      : undefined;
  // `cardholder_name` is null on every production card — Increase populates it
  // only for programs that collect one — so `description` is the name field
  // that actually carries a value. Prefer the explicit one when it IS set.
  const cardholderName = body.cardholder_name;
  const description = body.description;
  const name =
    typeof cardholderName === "string" && cardholderName.trim()
      ? cardholderName
      : typeof description === "string" && description.trim()
        ? description
        : undefined;
  return {
    increaseCardId: id,
    accountId,
    last4: typeof body.last4 === "string" ? body.last4 : undefined,
    status,
    description: name,
    walletEmail: typeof walletEmail === "string" ? walletEmail : undefined,
  };
}

/** How a cardholder was identified — recorded in the log line so an operator
 *  reading back can tell a hard link from a name match. */
type HolderMatch =
  | { kind: "email"; personId: Id<"people"> }
  | { kind: "name"; personId: Id<"people"> }
  | { kind: "none"; reason: string };

/**
 * Resolve the person a dashboard-made card belongs to. Email first (a real
 * link), then an exact whole-string name match; anything landing on two people
 * — or on none — resolves to `none` and the caller declines to sync.
 */
export async function resolveCardholder(
  ctx: MutationCtx,
  card: { walletEmail?: string; description?: string },
): Promise<HolderMatch> {
  const email = normalizeEmail(card.walletEmail);
  if (email) {
    const rows = await ctx.db
      .query("personEmails")
      .withIndex("by_email", (q) => q.eq("email", email))
      .collect();
    const ids = [...new Set(rows.map((r) => r.personId))];
    if (ids.length === 1) return { kind: "email", personId: ids[0] };
    if (ids.length > 1) {
      return {
        kind: "none",
        reason: `wallet email ${email} maps to ${ids.length} people (duplicate roster rows — merge them, then resync)`,
      };
    }
  }

  const name = card.description?.trim();
  if (name) {
    // No org-wide name index exists, so walk the chapters — bounded by the
    // chapter count (4 today), each lookup indexed on `by_chapter_and_name`.
    const chapters = await ctx.db.query("chapters").collect();
    const perChapter = await Promise.all(
      chapters.map((c) =>
        ctx.db
          .query("people")
          .withIndex("by_chapter_and_name", (q) =>
            q.eq("chapterId", c._id).eq("name", name),
          )
          .collect(),
      ),
    );
    // Only people who could actually HOLD a card. `isPlaceholder` rows are
    // Template Crew stand-ins and `isContactOnly` rows are donors/guests
    // auto-created from a gift or RSVP — both are real `people` rows a bare
    // name lookup would otherwise return (390 contact rows and 34 placeholders
    // in production today). `isCardEligible` is the same gate `issueCard`
    // enforces, so this can only ever resolve to someone the OS would have
    // been willing to issue this card to.
    const ids = [
      ...new Set(
        perChapter
          .flat()
          .filter(
            (p) =>
              p.isPlaceholder !== true &&
              p.isContactOnly !== true &&
              isCardEligible(p.pwEmail),
          )
          .map((p) => p._id),
      ),
    ];
    if (ids.length === 1) return { kind: "name", personId: ids[0] };
    if (ids.length > 1) {
      return {
        kind: "none",
        reason: `name "${name}" matches ${ids.length} people`,
      };
    }
  }

  return {
    kind: "none",
    reason: email
      ? `wallet email ${email} is on no roster person, and name ${name ? `"${name}"` : "(absent)"} matched none`
      : `card has no wallet email, and name ${name ? `"${name}"` : "(absent)"} matched none`,
  };
}

const UPSERT_RESULTS = [
  "created",
  "adopted",
  "updated",
  "unknown_account",
  "unattributed",
  "bad_status",
] as const;

/**
 * Idempotent upsert of one Increase card into `cards`. Safe to call repeatedly
 * — Increase redelivers webhooks, and the backfill overlaps the live hook.
 */
export const upsertIncreaseCard = internalMutation({
  args: {
    increaseCardId: v.string(),
    accountId: v.string(),
    last4: v.optional(v.string()),
    status: v.string(),
    description: v.optional(v.string()),
    walletEmail: v.optional(v.string()),
    // Resolve and report, write nothing. The preview shares this whole handler
    // rather than reimplementing it, so what a dry run promises is what a
    // commit does — the two cannot drift.
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    result: v.union(...UPSERT_RESULTS.map((r) => v.literal(r))),
    detail: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun === true;
    const status = mapCardStatus(args.status);
    if (status === null) {
      console.warn(
        `[increase][cardSync] ${args.increaseCardId}: unrecognized Increase status "${args.status}" — not synced`,
      );
      return { result: "bad_status" as const, detail: args.status };
    }

    // Scope comes from the ACCOUNT the card draws on. An account we don't hold
    // is skipped — same rule the ledger applies to a transaction on it.
    const account = await ctx.db
      .query("increaseAccounts")
      .withIndex("by_increase_account", (q) =>
        q.eq("increaseAccountId", args.accountId),
      )
      .first();
    if (!account) {
      console.warn(
        `[increase][cardSync] ${args.increaseCardId}: account ${args.accountId} is not ours — not synced`,
      );
      return { result: "unknown_account" as const, detail: args.accountId };
    }
    const chapterId: FinanceScope = account.chapterId;

    // Already synced → mirror the mutable fields and stop.
    const existing = await ctx.db
      .query("cards")
      .withIndex("by_increase_card", (q) =>
        q.eq("increaseCardId", args.increaseCardId),
      )
      .first();
    if (existing) {
      const patch: Partial<Doc<"cards">> = {};
      if (args.last4 && args.last4 !== existing.last4) patch.last4 = args.last4;
      if (chapterId !== existing.chapterId) patch.chapterId = chapterId;
      // Status mirrors ONE WAY: Increase may tighten (a card disabled or
      // canceled in the dashboard locks here too), never loosen. Our own
      // `locked` carries reasons Increase knows nothing about — a receipt
      // auto-lock, a holder's `frozenByHolder` freeze — and letting a
      // dashboard toggle clear them would route around the OS's own rules.
      // Unlocking stays an OS action.
      // `canceled` is TERMINAL. `cancelCard` pushes `disabled` to Increase
      // best-effort (it logs and moves on if the vendor call fails), so a
      // canceled card can legitimately sit at `disabled` upstream — and
      // mapping that back would resurrect it as `locked`, which a manager can
      // then unlock. A cancellation must never be undone by a webhook.
      if (
        status !== existing.status &&
        status !== "active" &&
        existing.status !== "canceled"
      ) {
        patch.status = status;
      }
      if (Object.keys(patch).length > 0 && !dryRun) {
        await ctx.db.patch(existing._id, patch);
      }
      return { result: "updated" as const };
    }

    const match = await resolveCardholder(ctx, args);
    if (match.kind === "none") {
      // Loud, and deliberately does NOT write a row: `cards` means "owned by
      // ONE person", and a holderless card would flow into receipt chasing,
      // auto-lock and repayment as an owner-shaped hole. Fix the roster and
      // rerun `resyncIncreaseCards`.
      console.error(
        `[increase][cardSync][ALERT] ${args.increaseCardId} (last4 ${args.last4 ?? "?"}) NOT synced — ${match.reason}. Charges on it stay unattributed until this is resolved.`,
      );
      return { result: "unattributed" as const, detail: match.reason };
    }

    // Close the race against `cards.ts#issueCard`: it inserts the row FIRST and
    // patches the Increase id on afterwards, so a `card.created` hook can land
    // in between and find nothing by `by_increase_card`. Adopt that pending row
    // instead of inserting a second one for the same physical card. Never a
    // `legacy` row — those are external cards linked by last-4 and have no
    // Increase object to claim them.
    const pending = (
      await ctx.db
        .query("cards")
        .withIndex("by_cardholder", (q) =>
          q.eq("cardholderPersonId", match.personId),
        )
        .collect()
    )
      .filter(
        (c) =>
          c.increaseCardId === undefined &&
          c.chapterId === chapterId &&
          c.source !== "legacy" &&
          c.status !== "canceled",
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];

    if (pending) {
      if (!dryRun) {
        await ctx.db.patch(pending._id, {
          increaseCardId: args.increaseCardId,
          ...(args.last4 ? { last4: args.last4 } : {}),
          source: "increase" as const,
        });
      }
      console.log(
        `[increase][cardSync]${dryRun ? " [dry run]" : ""} ${args.increaseCardId} adopted the pending card row for person ${match.personId} (matched by ${match.kind})`,
      );
      return { result: "adopted" as const };
    }

    if (!dryRun) {
      await ctx.db.insert("cards", {
        chapterId,
        cardholderPersonId: match.personId,
        increaseCardId: args.increaseCardId,
        // Increase models physical cards as a separate `physical_card` object;
        // a card known only by its `/cards` entry is virtual.
        type: "virtual",
        last4: args.last4,
        source: "increase",
        status,
        createdAt: Date.now(),
      });
    }
    console.log(
      `[increase][cardSync]${dryRun ? " [dry run]" : ""} ${args.increaseCardId} synced to person ${match.personId} (matched by ${match.kind}), scope ${chapterId}`,
    );
    return { result: "created" as const };
  },
});

/**
 * Fetch one Increase card and upsert it. The `card.created` / `card.updated`
 * webhook entry point (`increase.ts#handleIncreaseWebhook`), and the unit of
 * work the backfill reuses.
 */
export const syncIncreaseCard = internalAction({
  args: { increaseCardId: v.string() },
  returns: v.null(),
  handler: async (ctx, { increaseCardId }) => {
    const { key, base } = increaseEnvForObjectId(increaseCardId);
    if (!key) {
      console.warn(
        "[increase][cardSync] skipped: Increase API key not configured for this environment",
      );
      return null;
    }
    let body: Record<string, unknown>;
    try {
      body = await increaseGet(
        key,
        base,
        `/cards/${encodeURIComponent(increaseCardId)}`,
      );
    } catch (err) {
      console.error(
        `[increase][cardSync] failed to fetch card ${increaseCardId}`,
        err,
      );
      return null;
    }
    const card = extractIncreaseCard(body);
    if (!card) {
      console.error(
        `[increase][cardSync] card ${increaseCardId} had an unreadable shape — not synced`,
      );
      return null;
    }
    await ctx.runMutation(internal.increaseCardSync.upsertIncreaseCard, {
      increaseCardId: card.increaseCardId,
      accountId: card.accountId,
      status: card.status,
      ...(card.last4 ? { last4: card.last4 } : {}),
      ...(card.description ? { description: card.description } : {}),
      ...(card.walletEmail ? { walletEmail: card.walletEmail } : {}),
    });
    return null;
  },
});

/**
 * Re-sync EVERY card Increase holds — the repair path for a card the live hook
 * declined to attribute (fix the roster ambiguity it logged, then run this) and
 * the way the existing dashboard-made cards were first brought in.
 *
 * Idempotent by construction: it walks `/cards` and hands each one to the same
 * `upsertIncreaseCard` the webhook uses, so re-running only ever re-confirms
 * rows that already exist. Reports a per-outcome tally rather than a bare
 * count, so "8 processed" can't hide "3 of them unattributed".
 *
 *   npx convex run increaseCardSync:resyncIncreaseCards '{}' --prod
 */
export const resyncIncreaseCards = internalAction({
  args: { dryRun: v.optional(v.boolean()), sandbox: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    fetched: v.number(),
    created: v.number(),
    adopted: v.number(),
    updated: v.number(),
    unattributed: v.number(),
    unknownAccount: v.number(),
    badStatus: v.number(),
    unreadable: v.number(),
    problems: v.array(v.string()),
  }),
  handler: async (ctx, { dryRun, sandbox }) => {
    // Unlike the 0078 back-link, this DEFAULTS TO COMMITTING: it is the repair
    // path an operator reaches for after fixing a roster ambiguity, it writes
    // no money, and every write it makes is idempotent. Pass `dryRun: true` to
    // read the plan first — worth doing on the first run against a new
    // environment, where "which account is this even on" is still a question.
    const isDryRun = dryRun === true;
    const { key, base } = increaseEnvForMode(sandbox === true);
    if (!key) {
      throw new Error(
        `Increase API key for the ${sandbox === true ? "sandbox" : "production"} environment is not configured.`,
      );
    }

    const tally = {
      dryRun: isDryRun,
      fetched: 0,
      created: 0,
      adopted: 0,
      updated: 0,
      unattributed: 0,
      unknownAccount: 0,
      badStatus: 0,
      unreadable: 0,
      problems: [] as string[],
    };

    let cursor: string | undefined = undefined;
    // Bounded so a vendor-side cursor bug can't spin forever; far above any
    // plausible card count for this program.
    for (let page = 0; page < 50; page++) {
      const query = `?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body: Record<string, unknown> = await increaseGet(
        key,
        base,
        `/cards${query}`,
      );
      const data = Array.isArray(body.data) ? body.data : [];
      for (const raw of data) {
        tally.fetched++;
        const card =
          raw !== null && typeof raw === "object"
            ? extractIncreaseCard(raw as Record<string, unknown>)
            : null;
        if (!card) {
          tally.unreadable++;
          tally.problems.push("a card in the listing had an unreadable shape");
          continue;
        }
        const { result, detail } = await ctx.runMutation(
          internal.increaseCardSync.upsertIncreaseCard,
          {
            increaseCardId: card.increaseCardId,
            accountId: card.accountId,
            status: card.status,
            ...(card.last4 ? { last4: card.last4 } : {}),
            ...(card.description ? { description: card.description } : {}),
            ...(card.walletEmail ? { walletEmail: card.walletEmail } : {}),
            dryRun: isDryRun,
          },
        );
        if (result === "created") tally.created++;
        else if (result === "adopted") tally.adopted++;
        else if (result === "updated") tally.updated++;
        else {
          if (result === "unattributed") tally.unattributed++;
          else if (result === "unknown_account") tally.unknownAccount++;
          else tally.badStatus++;
          tally.problems.push(
            `${card.increaseCardId} (last4 ${card.last4 ?? "?"}): ${result}${detail ? ` — ${detail}` : ""}`,
          );
        }
      }
      const next = body.next_cursor;
      if (typeof next !== "string" || !next) break;
      cursor = next;
    }

    console.log(
      `[increase][cardSync] resync complete${isDryRun ? " (dry run — nothing written)" : ""}`,
      tally,
    );
    return tally;
  },
});
