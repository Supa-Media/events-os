/**
 * Import of the Public Worship newsletter artwork into the campaign image
 * library (migration slot 0052 — see `migrations/index.ts`'s module doc for
 * the numbering scheme).
 *
 * ── Why this is needed ─────────────────────────────────────────────────────
 * The real newsletter is roughly 40% artwork: the masthead, the section
 * banners (which ARE the headings — they contain the words), the card photos,
 * the song-of-the-month GIF, and the footer logo. Those files currently live
 * on a `canva-cdn.email` host, which is a per-send CDN that will stop
 * resolving. Referencing it from a stored template would produce an email
 * that renders today and breaks silently later, which is worse than not
 * shipping the images at all. This fetches each asset ONCE and re-hosts it in
 * Convex file storage as an ordinary `emailImages` row, after which the
 * template can place it by `sourceKey` and never touch the CDN again.
 *
 * ── HOW THIS ACTUALLY REACHES PRODUCTION: a cron, not a migration ──────────
 * `ensureNewsletterImagesImported` (bottom of this file) is registered in
 * `crons.ts` and runs HOURLY against the central scope. It is what ships the
 * artwork; the human-facing `importNewsletterImages` below is now only the
 * dry-run/inspection entry point.
 *
 * WHY A CRON AND NOT A REGISTERED MIGRATION. Three reasons, in order of how
 * much they mattered:
 *
 *  1. A ledgered migration runs EXACTLY ONCE. Our source is a per-send CDN we
 *     fully expect to be dead — so the single most likely outcome of a
 *     one-shot is "the deploy happened during an outage, the migration is
 *     ledgered as done, and the newsletter renders with eleven blank slots
 *     forever." Retry is the whole requirement, and the ledger is precisely a
 *     mechanism for never retrying.
 *  2. `runPending` executes migrations inside a `MutationCtx`, which cannot
 *     `fetch` at all. A migration could therefore only `ctx.scheduler` this
 *     action — fire-and-forget, with the same no-retry problem plus a layer of
 *     indirection.
 *  3. Deploy safety. `migrations:runPending` is a post-deploy CI step; work
 *     that depends on a third-party host has no business in the path that can
 *     take a production deploy red. A cron is out-of-band by construction —
 *     the CDN can be down for a week without a deploy ever noticing.
 *
 * This also matches how this backend already handles "converge on a state
 * that depends on somebody else's server": see `crons.ts`'s Increase and
 * Stripe reconciliation backstops and the AI auto-coding sweep — quiet,
 * repeatable, and cheap when there is nothing to do.
 *
 * ── WHAT HAPPENS WHEN THE FETCH FAILS (be honest about this) ───────────────
 * Nothing breaks and nothing is written; the run logs a `console.error`
 * naming every asset that failed and its HTTP status, and returns
 * `status: "incomplete"` with the missing keys. The next hour tries again,
 * fetching ONLY the assets still absent. If the CDN is permanently dead this
 * repeats hourly forever and the template keeps its empty slots — which is
 * the correct outcome (an empty slot renders as a labelled placeholder, not a
 * broken image), and the recurring error log is the intended alarm telling a
 * human to re-upload the eleven files by hand via the image library. It is
 * deliberately NOT silent.
 *
 * ── AND WHEN IT SUCCEEDS: the cron stops working ───────────────────────────
 * Once all eleven `sourceKey`s are on file, each subsequent run does ONE
 * bounded indexed read, sees nothing missing, and returns without a single
 * fetch or write. That is the "self-disables when complete" part — Convex
 * crons cannot literally unregister themselves, so the cheap completeness
 * check is the honest equivalent.
 *
 * No `"use node"`: `fetch` and `ctx.storage.store` are both available in
 * Convex's default V8 action runtime, and adding it would force this into a
 * separate file from nothing (see the action guidelines).
 *
 * ── DRY-RUN FIRST, ALWAYS (for the HUMAN entry point) ──────────────────────
 * `importNewsletterImages`'s `dryRun: true` (the default) performs the same
 * fetches and reports exactly what WOULD be imported, what is already on
 * file, and what failed to download — writing nothing. It exists so a human
 * can inspect the CDN's current state:
 *
 *   npx convex run --prod \
 *     migrations/0052_import_newsletter_images:importNewsletterImages \
 *     '{"scope": "central"}'
 *
 * The CRON never dry-runs — a dry run that writes nothing would be exactly
 * the silent no-op this file used to be.
 *
 * ── IDEMPOTENT ─────────────────────────────────────────────────────────────
 * Keyed on `emailImages.sourceKey`. A key already on file is skipped without
 * being re-fetched, so re-running after a partial failure imports only the
 * stragglers. The insert re-checks the key inside its own mutation, so two
 * concurrent runs can't both write the same asset (the loser deletes the blob
 * it just stored rather than leaking it).
 *
 * ── Alt text is deliberately left EMPTY ────────────────────────────────────
 * These images carry text nobody involved has transcribed — a banner reading
 * "WHAT'S ON" is a heading, not decoration. Writing plausible alt text would
 * make the library look finished while describing images I have not seen. The
 * result reports every row that still needs alt, and the composer already
 * warns on an image block without it.
 *
 * ── IT ALSO RE-SEEDS THE BUILT-IN TEMPLATE ─────────────────────────────────
 * A committing run finishes by calling `ensureBuiltInTemplates`, which is what
 * actually places the imported artwork into the newsletter template's empty
 * slots (`lib/builtInTemplates.ts` → `fillTemplateArtwork`). Without it the
 * import would "succeed" and the template would still render blank: the seed
 * that fills it is ledgered (0049 never fires twice) and otherwise only runs
 * opportunistically from `createCampaign`. A dry run skips this, like every
 * other write here.
 */

import { v } from "convex/values";
import { internalAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { NEWSLETTER_ASSETS } from "@events-os/shared";

/** Where the newsletter artwork lives. Campaigns are a central-only surface
 *  (`lib/campaignsAccess.ts`), and migration 0049 seeds the built-in template
 *  into "central" for the same reason — so the cron has exactly one scope to
 *  converge, and no per-chapter fan-out to reason about. */
const CRON_SCOPE = "central" as const;

/** Per-asset outcome, so a partial import is legible rather than a count. */
const assetResultValidator = v.object({
  sourceKey: v.string(),
  label: v.string(),
  outcome: v.union(
    v.literal("imported"),
    v.literal("would_import"),
    v.literal("already_on_file"),
    v.literal("failed"),
  ),
  /** Only on "failed" — the HTTP status or error, verbatim. */
  error: v.optional(v.string()),
  /** Only on "imported"/"would_import" — bytes downloaded, so an obviously
   *  wrong payload (a 200-response error page) is visible in the summary. */
  bytes: v.optional(v.number()),
});

/** Guard against a CDN that answers 200 with an error page or a tracking
 *  pixel. Every real asset here is a photo/banner well above this. */
const MIN_PLAUSIBLE_BYTES = 1024;

/** Cap on a single asset, so a redirect to something enormous can't blow the
 *  action's memory. The largest real asset is the ~552x341 GIF. */
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/** The shape both entry points return. */
type AssetResult = {
  sourceKey: string;
  label: string;
  outcome: "imported" | "would_import" | "already_on_file" | "failed";
  error?: string;
  bytes?: number;
};
type ImportResult = {
  dryRun: boolean;
  imported: number;
  alreadyOnFile: number;
  failed: number;
  needsAltText: string[];
  reseededTemplates: Id<"campaigns">[];
  results: AssetResult[];
};

/** Validator for `ImportResult`, shared by both actions below. */
const importResultValidator = v.object({
  dryRun: v.boolean(),
  imported: v.number(),
  alreadyOnFile: v.number(),
  failed: v.number(),
  /** Keys imported with empty alt — i.e. everything this run wrote. Listed
   *  explicitly because "it worked" and "it is finished" are different
   *  things, and alt text is the difference. */
  needsAltText: v.array(v.string()),
  /** Built-in template rows re-seeded after a committing run, so the caller
   *  can see that the artwork actually reached the template rather than
   *  taking it on faith. Always empty on a dry run. */
  reseededTemplates: v.array(v.id("campaigns")),
  results: v.array(assetResultValidator),
});

/**
 * The import itself, as a plain async helper rather than a second action.
 *
 * Two entry points call it — the human `importNewsletterImages` below and the
 * cron `ensureNewsletterImagesImported` — and the guidelines are explicit that
 * an action should only call another action to cross runtimes. Sharing one
 * function also means the cron cannot drift from the behaviour the dry run
 * shows a human.
 */
async function runNewsletterImport(
  ctx: ActionCtx,
  scope: Id<"chapters"> | "central",
  isDryRun: boolean,
): Promise<ImportResult> {
  const owner: Id<"users"> | null = await ctx.runQuery(
    internal.emailImages.resolveImportOwner,
    {},
  );
  if (!owner) {
    throw new Error(
      "No users exist on this deployment — an imported image needs a real createdBy. Create the first user, then re-run.",
    );
  }

  const existingKeys = new Set<string>(
    await ctx.runQuery(internal.emailImages.listImportedSourceKeys, { scope }),
  );

  const results: AssetResult[] = [];
  const needsAltText: string[] = [];

  for (const asset of NEWSLETTER_ASSETS) {
    if (existingKeys.has(asset.sourceKey)) {
      results.push({
        sourceKey: asset.sourceKey,
        label: asset.label,
        outcome: "already_on_file",
      });
      continue;
    }

    let blob: Blob;
    try {
      const res = await fetch(asset.sourceUrl);
      if (!res.ok) {
        results.push({
          sourceKey: asset.sourceKey,
          label: asset.label,
          outcome: "failed",
          error: `HTTP ${res.status} ${res.statusText}`.trim(),
        });
        continue;
      }
      blob = await res.blob();
    } catch (err) {
      results.push({
        sourceKey: asset.sourceKey,
        label: asset.label,
        outcome: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (blob.size < MIN_PLAUSIBLE_BYTES) {
      results.push({
        sourceKey: asset.sourceKey,
        label: asset.label,
        outcome: "failed",
        error: `Only ${blob.size} bytes — almost certainly an error page, not the image.`,
        bytes: blob.size,
      });
      continue;
    }
    if (blob.size > MAX_ASSET_BYTES) {
      results.push({
        sourceKey: asset.sourceKey,
        label: asset.label,
        outcome: "failed",
        error: `${blob.size} bytes exceeds the ${MAX_ASSET_BYTES}-byte cap.`,
        bytes: blob.size,
      });
      continue;
    }

    if (isDryRun) {
      results.push({
        sourceKey: asset.sourceKey,
        label: asset.label,
        outcome: "would_import",
        bytes: blob.size,
      });
      continue;
    }

    const storageId = await ctx.storage.store(blob);
    const url = await ctx.storage.getUrl(storageId);
    if (!url) {
      // Storage accepted the blob but won't serve it — don't leave an
      // unreachable row behind.
      await ctx.storage.delete(storageId);
      results.push({
        sourceKey: asset.sourceKey,
        label: asset.label,
        outcome: "failed",
        error: "Stored but storage.getUrl returned null.",
        bytes: blob.size,
      });
      continue;
    }

    const inserted = await ctx.runMutation(
      internal.emailImages.insertImportedImage,
      {
        scope,
        sourceKey: asset.sourceKey,
        storageId,
        url,
        label: asset.label,
        createdBy: owner,
      },
    );
    if (inserted === null) {
      // A concurrent run won; the mutation already dropped our blob.
      results.push({
        sourceKey: asset.sourceKey,
        label: asset.label,
        outcome: "already_on_file",
      });
      continue;
    }

    needsAltText.push(asset.sourceKey);
    results.push({
      sourceKey: asset.sourceKey,
      label: asset.label,
      outcome: "imported",
      bytes: blob.size,
    });
  }

  // ── Push the artwork into the built-in template ───────────────────────
  // Importing the images is only half the job: the built-in newsletter
  // template ships with every slot empty and only picks the artwork up when
  // it is next seeded. Migration 0049 is ledgered and never fires again, and
  // `ensureBuiltInTemplates` has no other production caller — so without this
  // the images would sit in the library until someone happened to create a
  // campaign. Re-seeding in the SAME run that imported them closes that
  // ordering hazard deterministically.
  //
  // Idempotent and cheap (it patches only if the document actually changed),
  // and skipped entirely on a dry run because it WRITES.
  const reseededTemplates: Id<"campaigns">[] = isDryRun
    ? []
    : await ctx.runMutation(internal.campaignTemplates.ensureBuiltInTemplates, {
        scope,
        createdBy: owner,
      });

  return {
    dryRun: isDryRun,
    reseededTemplates,
    imported: results.filter((r) => r.outcome === "imported").length,
    alreadyOnFile: results.filter((r) => r.outcome === "already_on_file").length,
    failed: results.filter((r) => r.outcome === "failed").length,
    needsAltText,
    results,
  };
}

/**
 * HUMAN entry point. Dry-runs by default; see the DRY-RUN section of this
 * file's header for the exact command. Production no longer depends on anyone
 * remembering to run this — `ensureNewsletterImagesImported` below does the
 * shipping — but it remains the way to see what the CDN is currently serving,
 * and the way to import into a chapter scope should one ever want the artwork.
 */
export const importNewsletterImages = internalAction({
  args: {
    scope: v.union(v.id("chapters"), v.literal("central")),
    /** Defaults to TRUE — a human should always see the dry run first. */
    dryRun: v.optional(v.boolean()),
  },
  returns: importResultValidator,
  handler: async (ctx, { scope, dryRun }) =>
    await runNewsletterImport(ctx, scope, dryRun !== false),
});

/**
 * CRON entry point — the one that actually ships the artwork. Registered in
 * `crons.ts` (hourly); see this file's header for why a cron rather than a
 * registered migration.
 *
 * Three properties, in the order they matter:
 *
 *  - CHEAP WHEN DONE. It starts with one bounded indexed read of the scope's
 *    `sourceKey`s. With all eleven on file it returns `already_complete`
 *    immediately: no fetch, no write, no log line. That is the self-disable.
 *  - RESUMABLE. Otherwise it commits an import, which re-fetches ONLY the
 *    keys still absent (`sourceKey` uniqueness is the handle, and the insert
 *    re-checks it inside its own mutation). Ten assets landing and one 404ing
 *    leaves ten rows and retries the one, hour after hour.
 *  - NEVER SILENT. Every non-complete outcome logs — `console.error` with the
 *    per-asset reasons when anything failed, `console.info` when a run
 *    genuinely finishes the import. A cron that quietly did nothing is the
 *    exact failure this replaced.
 *
 * It never throws. A throwing cron is retried by nobody and reads as a crash;
 * the two things that can actually go wrong here (a deployment with no users
 * yet, and a dead CDN) are both expected states, so they are reported as
 * outcomes with a loud log rather than as exceptions.
 *
 * ONE HOLE, STATED PLAINLY: the completeness check asks whether the eleven
 * IMAGES are on file, not whether the TEMPLATE got them. The run that imports
 * the last asset re-seeds the template in the same breath, so the two agree in
 * practice — but if that re-seed mutation were the thing that failed, this
 * cron would see a full library on the next hour and stand down with the
 * template still blank. The backstop for that is the same one migration 0049
 * relies on: `campaigns.createCampaign` seeds the built-ins opportunistically,
 * so opening the campaigns desk repairs it. Checking the template here instead
 * would mean an unconditional seed mutation every hour forever, which is a
 * worse trade for a failure mode nothing has ever produced.
 */
export const ensureNewsletterImagesImported = internalAction({
  args: {},
  returns: v.object({
    status: v.union(
      /** Everything was already on file; this run did nothing at all. */
      v.literal("already_complete"),
      /** This run imported the last of the assets — the artwork is now live. */
      v.literal("completed"),
      /** Progress made and/or failures; still missing some assets. */
      v.literal("incomplete"),
      /** No `users` row to attribute an import to yet. Nothing was fetched. */
      v.literal("no_users"),
      /** Something unexpected threw. Logged; the next run tries again. */
      v.literal("error"),
    ),
    imported: v.number(),
    /** `sourceKey`s still absent after this run — empty iff the import is done. */
    missing: v.array(v.string()),
  }),
  handler: async (ctx) => {
    const wanted = NEWSLETTER_ASSETS.map((a) => a.sourceKey);

    // The self-disable: one bounded read, and out.
    let onFile: string[];
    try {
      onFile = await ctx.runQuery(internal.emailImages.listImportedSourceKeys, {
        scope: CRON_SCOPE,
      });
    } catch (err) {
      console.error(
        "[newsletter-artwork] could not read the image library; will retry next hour.",
        err,
      );
      return { status: "error" as const, imported: 0, missing: wanted };
    }
    const present = new Set(onFile);
    const missingBefore = wanted.filter((k) => !present.has(k));
    if (missingBefore.length === 0) {
      return { status: "already_complete" as const, imported: 0, missing: [] };
    }

    let result: ImportResult;
    try {
      result = await runNewsletterImport(ctx, CRON_SCOPE, false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A brand-new deployment has no user to attribute the rows to. That is a
      // legitimate "not yet", not a fault — say so plainly and try again later,
      // rather than logging an error hourly until somebody signs up.
      if (message.includes("No users exist")) {
        console.warn(
          `[newsletter-artwork] deferring the import: ${message} Still missing: ${missingBefore.join(", ")}.`,
        );
        return { status: "no_users" as const, imported: 0, missing: missingBefore };
      }
      console.error(
        `[newsletter-artwork] import threw; will retry next hour. Still missing: ${missingBefore.join(", ")}.`,
        err,
      );
      return { status: "error" as const, imported: 0, missing: missingBefore };
    }

    const stillMissing = result.results
      .filter((r) => r.outcome === "failed")
      .map((r) => r.sourceKey);

    if (stillMissing.length > 0) {
      // LOUD, because the alternative is eleven blank slots nobody hears about.
      console.error(
        `[newsletter-artwork] ${stillMissing.length}/${wanted.length} asset(s) could not be imported from the source CDN. ` +
          `The built-in newsletter template will keep empty slots for them until this succeeds or someone uploads the files by hand ` +
          `(Campaigns → image library). Retrying hourly. Failures: ` +
          result.results
            .filter((r) => r.outcome === "failed")
            .map((r) => `${r.sourceKey}: ${r.error ?? "unknown error"}`)
            .join("; "),
      );
      return {
        status: "incomplete" as const,
        imported: result.imported,
        missing: stillMissing,
      };
    }

    console.info(
      `[newsletter-artwork] import complete — ${result.imported} newly imported, ` +
        `${result.alreadyOnFile} already on file, ${result.reseededTemplates.length} built-in template(s) re-seeded. ` +
        `Every row still needs real alt text (see NEWSLETTER_ASSETS). This cron is a no-op from here on.`,
    );
    return { status: "completed" as const, imported: result.imported, missing: [] };
  },
});
