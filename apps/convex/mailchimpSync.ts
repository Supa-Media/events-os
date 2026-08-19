/**
 * Mailchimp audience sync — keeping the mailing list honest now that bulk
 * email lives in Mailchimp rather than in this app.
 *
 * Read `schema/mailchimp.ts` first: it explains the two directions (push the
 * roster out, pull deliverability signals back) and why the mirror table
 * exists. Read `docs/plans/email-desk-parked.md` for the decision that put us
 * here and the list of what the in-app desk would have needed instead.
 *
 * ── The run, end to end ─────────────────────────────────────────────────────
 * `syncMailchimpAudience` (internalAction — nightly cron, or a human pressing
 * "Sync now"):
 *
 *   1. Resolve credentials. Missing/malformed → a logged no-op degrade, the
 *      `givebutterSync.ts#resolveGivebutterApiKey` precedent. A parked
 *      integration must never turn into a nightly error.
 *   2. `fetchAudience` — one cheap call that proves the key, the datacenter
 *      and the audience id all work, BEFORE we start pushing people.
 *   3. `ensureMergeFields` — create CHAPTER/BACKER/ROLE if this audience has
 *      never seen them. Mailchimp rejects a batch carrying an unknown merge
 *      field, so this cannot be skipped on a fresh audience.
 *   4. Walk chapters one at a time (`collectChapterMembers`), never the whole
 *      roster in a single query — a per-chapter slice keeps each query inside
 *      Convex's read limits the way `lib/audienceResolve.ts` does.
 *   5. Diff against the mirror: everyone eligible is pushed `subscribed`;
 *      everyone we previously pushed who is NO LONGER eligible is pushed
 *      `unsubscribed`. Absence from the payload would leave Mailchimp mailing
 *      them, so a leaver is an explicit instruction, never an omission.
 *   6. Batch of 500 at a time, recording per-member outcomes into the mirror.
 *   7. Finalize the `mailchimpSyncRuns` row with rollup counts.
 *
 * A per-member rejection never throws — it lands in `mailchimpMembers.lastError`
 * and the run continues, mirroring `campaigns.ts#deliverCampaignBatch`'s
 * recorded-failure-not-throw philosophy. Only a whole-run failure (bad auth,
 * a 4xx on the batch itself) marks the run `failed`.
 *
 * ── Who is eligible ─────────────────────────────────────────────────────────
 * See `collectChapterMembers`. Deliberately the SAME opt-out model the rest of
 * the app uses — a person is reachable unless something says otherwise — with
 * one documented divergence from `lib/audienceResolve.ts#resolvePeople`
 * (contact-only rows are INCLUDED here; see that function's doc).
 */
import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { ConvexError } from "convex/values";
import {
  MAILCHIMP_BATCH_SIZE,
  MAILCHIMP_CUSTOM_MERGE_FIELDS,
  buildMailchimpMember,
  buildMailchimpUnsubscribe,
  chunk,
  deriveMailchimpServerPrefix,
  normalizeMailchimpEmail,
  type MailchimpBackerValue,
  type MailchimpMemberPayload,
  type MailchimpPersonInput,
  type MailchimpRoleValue,
} from "@events-os/shared";
import { listActiveChapters } from "./lib/chapters";
import { resolveSendAddress } from "./lib/personEmails";
import { normalizeEmail } from "./lib/access";
import { requireUserId } from "./lib/context";
import {
  hasMailchimpSync,
  requireMailchimpSync,
  requireMailchimpView,
} from "./lib/mailchimpAccess";
import {
  batchUpsertMembers,
  ensureMergeFields,
  fetchAudience,
  MailchimpError,
  type MailchimpCredentials,
} from "./lib/mailchimpApi";

/** Per-chapter roster bound — the `lib/audienceResolve.ts#PEOPLE_PER_CHAPTER_LIMIT`
 *  number, same reasoning: a real cap, never `.collect()`. */
const PEOPLE_PER_CHAPTER_LIMIT = 2000;
/** Bound on the mirror scan. Comfortably above any realistic audience for this
 *  org; `truncated` is reported rather than silently binding. */
const MIRROR_SCAN_LIMIT = 20_000;
/** A single person's pledge history — small by construction. */
const PLEDGES_PER_DONOR_LIMIT = 100;
/** How many sync runs the status surface looks back over. */
const RUN_HISTORY_LIMIT = 10;

// ── Eligibility + merge-field derivation ────────────────────────────────────

/**
 * A person's backer standing, as one merge-field value.
 *
 * Mirrors `schema/campaigns.ts#AUDIENCE_BACKER_STATUSES`' definition exactly so
 * "backer" means one thing across the app: `"active"` = a linked donor with a
 * currently-active pledge; `"lapsed"` = a linked donor with at least one pledge
 * on file but none active; `"none"` = no linked donor, or a donor who has never
 * pledged.
 */
async function resolveBackerValue(
  ctx: QueryCtx,
  personId: Id<"people">,
): Promise<MailchimpBackerValue> {
  const donors = await ctx.db
    .query("donors")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .take(10);
  if (donors.length === 0) return "none";

  let sawAnyPledge = false;
  for (const donor of donors) {
    const pledges = await ctx.db
      .query("pledges")
      .withIndex("by_donor", (q) => q.eq("donorId", donor._id))
      .take(PLEDGES_PER_DONOR_LIMIT);
    if (pledges.length > 0) sawAnyPledge = true;
    if (pledges.some((p) => p.status === "active")) return "active";
  }
  return sawAnyPledge ? "lapsed" : "none";
}

/**
 * One ROLE value per person, most-specific first — a merge field holds one
 * value, and the narrower description is the useful one to segment on. Someone
 * who is both core team and a volunteer is `"team"`.
 */
function resolveRoleValue(person: Doc<"people">): MailchimpRoleValue {
  if (person.isTeamMember === true) return "team";
  if (person.isVolunteer === true) return "volunteer";
  return "contact";
}

/** What one eligible person contributes to the push. */
interface EligibleMember {
  email: string;
  personId: Id<"people">;
  input: MailchimpPersonInput;
}

/**
 * Every eligible person in one chapter, with their merge-field values.
 *
 * ── The eligibility rules, and where they come from ─────────────────────────
 * These are `lib/audienceResolve.ts#resolvePeople`'s rules, deliberately
 * re-stated rather than imported, because ONE of them differs and a silent
 * divergence inside a shared helper would be worse than an explicit one here:
 *
 *  - placeholder rows        — skipped (not real people).
 *  - `status: "inactive"`    — skipped.
 *  - `marketingOptOut`       — skipped. The person-level "stop".
 *  - no deliverable address  — skipped (`resolveSendAddress`: explicit primary
 *                              > pwEmail > roster email > newest verified).
 *  - suppressed address      — skipped, checked by the caller against the
 *                              deployment-wide `emailSuppressions` ledger.
 *
 *  - `isContactOnly`         — **INCLUDED HERE, unlike `resolvePeople`.** That
 *    resolver excludes contacts to preserve the pre-Phase-1 behavior of the
 *    legacy roster-shaped "people" audience source. This is not that source:
 *    it is the org's actual mailing list, and a donor or an event guest is
 *    precisely who a newsletter is for. Their consent is governed by the same
 *    two gates as everyone else's (`marketingOptOut` + `emailSuppressions`),
 *    which is the app's established opt-out model — see `schema/people.ts`'s
 *    `consentedAt` doc, which is emphatic that affirmative consent must never
 *    be wired into send eligibility in either direction.
 */
async function collectChapterMembers(
  ctx: QueryCtx,
  chapter: Doc<"chapters">,
): Promise<{ members: EligibleMember[]; optedOut: number; noAddress: number }> {
  const rows = await ctx.db
    .query("people")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
    .take(PEOPLE_PER_CHAPTER_LIMIT);

  const members: EligibleMember[] = [];
  let optedOut = 0;
  let noAddress = 0;

  for (const person of rows) {
    if (person.isPlaceholder === true) continue;
    if (person.status === "inactive") continue;
    if (person.marketingOptOut === true) {
      optedOut++;
      continue;
    }

    const personEmails = await ctx.db
      .query("personEmails")
      .withIndex("by_person", (q) => q.eq("personId", person._id))
      .collect();
    const raw = resolveSendAddress(person, personEmails);
    const email = raw ? normalizeEmail(raw) : null;
    if (!email) {
      noAddress++;
      continue;
    }

    members.push({
      email,
      personId: person._id,
      input: {
        email,
        firstName: person.firstName ?? null,
        lastName: person.lastName ?? null,
        name: person.name,
        chapterName: chapter.name,
        backer: await resolveBackerValue(ctx, person._id),
        role: resolveRoleValue(person),
      },
    });
  }

  return { members, optedOut, noAddress };
}

// ── Internal queries the action reads through ───────────────────────────────

/** Active chapters to walk, smallest possible projection. */
export const listSyncChapters = internalQuery({
  args: {},
  returns: v.array(v.object({ _id: v.id("chapters"), name: v.string() })),
  handler: async (ctx) => {
    const chapters = await listActiveChapters(ctx);
    return chapters.map((c) => ({ _id: c._id, name: c.name }));
  },
});

/**
 * One chapter's eligible members, already filtered against the suppression
 * ledger. Suppression is checked HERE rather than in the action so the
 * decision reads off the database in the same transaction that read the
 * person — the `campaigns.ts` "recheck at delivery time" instinct, applied at
 * the only point this integration has.
 */
export const collectChapterSlice = internalQuery({
  args: { chapterId: v.id("chapters") },
  returns: v.object({
    members: v.array(
      v.object({
        email: v.string(),
        personId: v.id("people"),
        firstName: v.optional(v.string()),
        lastName: v.optional(v.string()),
        name: v.string(),
        chapterName: v.string(),
        backer: v.string(),
        role: v.string(),
      }),
    ),
    optedOut: v.number(),
    noAddress: v.number(),
    suppressed: v.number(),
  }),
  handler: async (ctx, { chapterId }) => {
    const chapter = await ctx.db.get(chapterId);
    if (!chapter) {
      return { members: [], optedOut: 0, noAddress: 0, suppressed: 0 };
    }
    const { members, optedOut, noAddress } = await collectChapterMembers(
      ctx,
      chapter,
    );

    const kept: typeof members = [];
    let suppressed = 0;
    for (const m of members) {
      const hit = await ctx.db
        .query("emailSuppressions")
        .withIndex("by_email", (q) => q.eq("email", m.email))
        .first();
      if (hit) {
        suppressed++;
        continue;
      }
      kept.push(m);
    }

    return {
      members: kept.map((m) => ({
        email: m.email,
        personId: m.personId,
        firstName: m.input.firstName ?? undefined,
        lastName: m.input.lastName ?? undefined,
        name: m.input.name ?? "",
        chapterName: m.input.chapterName ?? "",
        backer: m.input.backer,
        role: m.input.role,
      })),
      optedOut,
      noAddress,
      suppressed,
    };
  },
});

/** Every address we currently believe is `subscribed` in Mailchimp — the set
 *  the action diffs against to find leavers. */
export const listSubscribedMirror = internalQuery({
  args: {},
  returns: v.object({ emails: v.array(v.string()), truncated: v.boolean() }),
  handler: async (ctx) => {
    const rows = await ctx.db.query("mailchimpMembers").take(MIRROR_SCAN_LIMIT);
    return {
      emails: rows.filter((r) => r.status === "subscribed").map((r) => r.email),
      truncated: rows.length >= MIRROR_SCAN_LIMIT,
    };
  },
});

// ── Internal mutations the action writes through ────────────────────────────

export const startSyncRun = internalMutation({
  args: { triggeredByUserId: v.optional(v.id("users")) },
  returns: v.id("mailchimpSyncRuns"),
  handler: async (ctx, { triggeredByUserId }) =>
    await ctx.db.insert("mailchimpSyncRuns", {
      startedAt: Date.now(),
      status: "running",
      eligible: 0,
      pushed: 0,
      unsubscribed: 0,
      failed: 0,
      triggeredByUserId,
    }),
});

export const finishSyncRun = internalMutation({
  args: {
    runId: v.id("mailchimpSyncRuns"),
    status: v.union(v.literal("succeeded"), v.literal("failed")),
    eligible: v.number(),
    pushed: v.number(),
    unsubscribed: v.number(),
    failed: v.number(),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { runId, ...rest }) => {
    await ctx.db.patch(runId, { ...rest, finishedAt: Date.now() });
    return null;
  },
});

/**
 * Write one batch's outcomes into the mirror. Upsert by email: the mirror is
 * keyed on the ADDRESS, not the person, so an address that outlives its
 * roster row (someone changed their email) keeps its row and can still be
 * unsubscribed on a later run.
 */
export const recordMemberResults = internalMutation({
  args: {
    results: v.array(
      v.object({
        email: v.string(),
        personId: v.optional(v.id("people")),
        status: v.union(v.literal("subscribed"), v.literal("unsubscribed")),
        unsubscribeReason: v.optional(v.string()),
        error: v.optional(v.string()),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { results }) => {
    const now = Date.now();
    for (const r of results) {
      const email = normalizeEmail(r.email);
      if (!email) continue;
      const existing = await ctx.db
        .query("mailchimpMembers")
        .withIndex("by_email", (q) => q.eq("email", email))
        .first();
      const fields = {
        email,
        personId: r.personId,
        status: r.status,
        unsubscribeReason: r.unsubscribeReason,
        lastSyncedAt: now,
        lastError: r.error,
      };
      if (existing) await ctx.db.patch(existing._id, fields);
      else await ctx.db.insert("mailchimpMembers", fields);
    }
    return null;
  },
});

/**
 * Mark the mirror after a deliverability signal arrived FROM Mailchimp, so the
 * next sync doesn't try to re-add someone Mailchimp has already dropped.
 *
 * This is the BOOKKEEPING half only. The important half — writing
 * `emailSuppressions`, which `blasts.ts` and every other send path already
 * consults, so an unsubscribe in Mailchimp silences event blasts too — is a
 * separate call the webhook makes to `emailSuppressions.recordSuppression`.
 * Two calls from the httpAction rather than one nested mutation, mirroring how
 * `/resend/webhook` composes its own writes.
 */
export const markMirrorUnsubscribed = internalMutation({
  args: { email: v.string() },
  returns: v.null(),
  handler: async (ctx, { email }) => {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;

    const existing = await ctx.db
      .query("mailchimpMembers")
      .withIndex("by_email", (q) => q.eq("email", normalized))
      .first();
    const fields = {
      email: normalized,
      status: "unsubscribed" as const,
      // Deliberately NOT set: why a Mailchimp-originated unsubscribe happened
      // lives in the suppression ledger, which is the authoritative record.
      // This field is only for unsubscribes WE decided on.
      unsubscribeReason: undefined,
      lastSyncedAt: Date.now(),
      lastError: undefined,
    };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("mailchimpMembers", fields);
    return null;
  },
});

// ── The sync itself ─────────────────────────────────────────────────────────

/**
 * Resolve credentials: the stored setting, else nothing. Unlike Givebutter and
 * Resend there is deliberately NO env-var fallback — this integration was
 * configured in-app from day one, and a second source of truth for a key is
 * how a deployment ends up syncing to the wrong audience.
 *
 * Returns `null` (a logged no-op degrade) rather than throwing, so an
 * unconfigured deployment's nightly cron is quiet instead of noisy.
 */
async function resolveCredentials(
  ctx: ActionCtx,
): Promise<MailchimpCredentials | null> {
  const stored = await ctx.runQuery(
    internal.integrationSettings.readMailchimpSettings,
    {},
  );
  if (!stored?.apiKey || !stored.audienceId) {
    console.log("[mailchimp] sync skipped — API key or audience id not set");
    return null;
  }
  const serverPrefix = deriveMailchimpServerPrefix(stored.apiKey);
  if (!serverPrefix) {
    console.error(
      "[mailchimp] sync skipped — API key has no datacenter suffix (expected `…-us21`)",
    );
    return null;
  }
  return { apiKey: stored.apiKey, serverPrefix, audienceId: stored.audienceId };
}

/**
 * Push the roster onto the configured Mailchimp audience. Idempotent: running
 * it twice in a row is two identical upserts, and the second one changes
 * nothing.
 */
export const syncMailchimpAudience = internalAction({
  args: { triggeredByUserId: v.optional(v.id("users")) },
  returns: v.object({
    ok: v.boolean(),
    eligible: v.number(),
    pushed: v.number(),
    unsubscribed: v.number(),
    failed: v.number(),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, { triggeredByUserId }) => {
    const creds = await resolveCredentials(ctx);
    if (!creds) {
      return {
        ok: false,
        eligible: 0,
        pushed: 0,
        unsubscribed: 0,
        failed: 0,
        error: "Mailchimp is not configured",
      };
    }

    const runId = await ctx.runMutation(internal.mailchimpSync.startSyncRun, {
      triggeredByUserId,
    });

    let eligible = 0;
    let pushed = 0;
    let unsubscribed = 0;
    let failed = 0;

    try {
      // Prove the credentials before touching a single person.
      const audience = await fetchAudience(creds);
      const created = await ensureMergeFields(creds, MAILCHIMP_CUSTOM_MERGE_FIELDS);
      if (created.length > 0) {
        console.log(
          `[mailchimp] created merge fields on "${audience.name}": ${created.join(", ")}`,
        );
      }

      // ── Gather (per chapter, never the whole roster at once) ──────────────
      const chapters = await ctx.runQuery(
        internal.mailchimpSync.listSyncChapters,
        {},
      );
      const byEmail = new Map<
        string,
        { personId: Id<"people">; payload: MailchimpMemberPayload }
      >();
      let optedOut = 0;
      let noAddress = 0;
      let suppressed = 0;

      for (const chapter of chapters) {
        const slice = await ctx.runQuery(
          internal.mailchimpSync.collectChapterSlice,
          { chapterId: chapter._id },
        );
        optedOut += slice.optedOut;
        noAddress += slice.noAddress;
        suppressed += slice.suppressed;
        for (const m of slice.members) {
          // First chapter wins on a shared address — deterministic, and the
          // alternative (last wins) would make CHAPTER flap between runs for
          // a couple who share an inbox across two chapters.
          if (byEmail.has(m.email)) continue;
          byEmail.set(m.email, {
            personId: m.personId,
            payload: buildMailchimpMember(
              {
                email: m.email,
                firstName: m.firstName ?? null,
                lastName: m.lastName ?? null,
                name: m.name,
                chapterName: m.chapterName,
                backer: m.backer as MailchimpBackerValue,
                role: m.role as MailchimpRoleValue,
              },
              "subscribed",
            ),
          });
        }
      }
      eligible = byEmail.size;

      // ── Diff against the mirror to find the leavers ───────────────────────
      const mirror = await ctx.runQuery(
        internal.mailchimpSync.listSubscribedMirror,
        {},
      );
      if (mirror.truncated) {
        console.error(
          `[mailchimp] mirror scan hit its ${MIRROR_SCAN_LIMIT}-row ceiling — some leavers may not be unsubscribed this run`,
        );
      }
      const leavers = mirror.emails.filter((e) => !byEmail.has(e));

      // ── Push ─────────────────────────────────────────────────────────────
      const payloads: {
        payload: MailchimpMemberPayload;
        personId?: Id<"people">;
        unsubscribeReason?: string;
      }[] = [
        ...[...byEmail.entries()].map(([, v2]) => ({
          payload: v2.payload,
          personId: v2.personId,
        })),
        // NOT `buildMailchimpMember(…, "unsubscribed")` — see
        // `buildMailchimpUnsubscribe`'s doc. All we have for a leaver is the
        // address, so writing merge fields would blank their name and chapter
        // in Mailchimp on the way out.
        ...leavers.map((email) => ({
          payload: buildMailchimpUnsubscribe(email),
          unsubscribeReason: "No longer eligible in events-os",
        })),
      ];

      for (const batch of chunk(payloads, MAILCHIMP_BATCH_SIZE)) {
        const result = await batchUpsertMembers(
          creds,
          batch.map((b) => b.payload),
        );
        const errorByEmail = new Map(
          result.errors.map((e) => [normalizeMailchimpEmail(e.email), e.message]),
        );
        const results = batch.map((b) => {
          const email = b.payload.email_address;
          const error = errorByEmail.get(email);
          if (!error) {
            if (b.payload.status === "subscribed") pushed++;
            else unsubscribed++;
          } else {
            failed++;
          }
          return {
            email,
            personId: b.personId,
            status: b.payload.status,
            unsubscribeReason: b.unsubscribeReason,
            error,
          };
        });
        await ctx.runMutation(internal.mailchimpSync.recordMemberResults, {
          results,
        });
      }

      console.log(
        `[mailchimp] synced "${audience.name}": ${pushed} subscribed, ${unsubscribed} unsubscribed, ${failed} rejected ` +
          `(skipped ${optedOut} opted out, ${suppressed} suppressed, ${noAddress} with no address)`,
      );

      await ctx.runMutation(internal.mailchimpSync.finishSyncRun, {
        runId,
        status: "succeeded",
        eligible,
        pushed,
        unsubscribed,
        failed,
      });
      return { ok: true, eligible, pushed, unsubscribed, failed };
    } catch (err) {
      const message =
        err instanceof MailchimpError
          ? `Mailchimp: ${err.message} (HTTP ${err.status})`
          : err instanceof Error
            ? err.message
            : String(err);
      console.error("[mailchimp] sync failed", message);
      await ctx.runMutation(internal.mailchimpSync.finishSyncRun, {
        runId,
        status: "failed",
        eligible,
        pushed,
        unsubscribed,
        failed,
        error: message,
      });
      return { ok: false, eligible, pushed, unsubscribed, failed, error: message };
    }
  },
});

// ── Public surface ──────────────────────────────────────────────────────────

/**
 * "Sync now" — the manual trigger, the `givebutterSync.requestGivebutterSync`
 * precedent. Schedules the action rather than running it inline so the button
 * returns immediately; the screen watches `mailchimpStatus` for the outcome.
 */
export const requestMailchimpSync = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await requireMailchimpSync(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const settings = await ctx.db.query("integrationSettings").first();
    if (!settings?.mailchimpApiKey || !settings.mailchimpAudienceId) {
      throw new ConvexError({
        code: "NOT_CONFIGURED",
        message:
          "Add a Mailchimp API key and audience id under Profile → Integrations first.",
      });
    }

    await ctx.scheduler.runAfter(
      0,
      internal.mailchimpSync.syncMailchimpAudience,
      { triggeredByUserId: userId },
    );
    return null;
  },
});

/**
 * What the integrations screen shows: whether it's configured, how the last
 * runs went, and how many people we currently believe are on the list.
 *
 * Soft-gated on purpose — a caller without the power gets `canSync: false`,
 * never a thrown error, so a passively-rendered card can't crash the screen
 * (the `campaigns.ts#listPendingApprovals` lesson).
 */
export const mailchimpStatus = query({
  args: {},
  returns: v.object({
    configured: v.boolean(),
    canSync: v.boolean(),
    subscribedCount: v.number(),
    runs: v.array(
      v.object({
        startedAt: v.number(),
        finishedAt: v.optional(v.number()),
        status: v.string(),
        eligible: v.number(),
        pushed: v.number(),
        unsubscribed: v.number(),
        failed: v.number(),
        error: v.optional(v.string()),
      }),
    ),
  }),
  handler: async (ctx) => {
    await requireMailchimpView(ctx);
    const settings = await ctx.db.query("integrationSettings").first();
    const rows = await ctx.db.query("mailchimpMembers").take(MIRROR_SCAN_LIMIT);
    const runs = await ctx.db
      .query("mailchimpSyncRuns")
      .withIndex("by_startedAt")
      .order("desc")
      .take(RUN_HISTORY_LIMIT);

    return {
      configured:
        settings?.mailchimpApiKey != null && settings.mailchimpAudienceId != null,
      canSync: await hasMailchimpSync(ctx),
      subscribedCount: rows.filter((r) => r.status === "subscribed").length,
      runs: runs.map((r) => ({
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        status: r.status,
        eligible: r.eligible,
        pushed: r.pushed,
        unsubscribed: r.unsubscribed,
        failed: r.failed,
        error: r.error,
      })),
    };
  },
});

/**
 * Check the stored credentials against Mailchimp and report the audience they
 * point at, without pushing anybody. What the "Test connection" button calls —
 * the answer to "is this the right audience?" should not require mailing
 * several hundred people to find out.
 */
export const testMailchimpConnection = action({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    audienceName: v.optional(v.string()),
    memberCount: v.optional(v.number()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx) => {
    // Actions have no `ctx.db`, so the gate runs through a query — the
    // `campaigns.ts#assertAccessForAction` pattern.
    await ctx.runQuery(internal.mailchimpSync.assertCanSync, {});
    const creds = await resolveCredentials(ctx);
    if (!creds) return { ok: false, error: "Mailchimp is not configured" };
    try {
      const audience = await fetchAudience(creds);
      return {
        ok: true,
        audienceName: audience.name,
        memberCount: audience.memberCount,
      };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof MailchimpError
            ? `${err.message} (HTTP ${err.status})`
            : err instanceof Error
              ? err.message
              : String(err),
      };
    }
  },
});

/** The action-side gate for `testMailchimpConnection` (actions have no
 *  `ctx.db`). Throws exactly what `requireMailchimpSync` throws. */
export const assertCanSync = internalQuery({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await requireMailchimpSync(ctx);
    return null;
  },
});
