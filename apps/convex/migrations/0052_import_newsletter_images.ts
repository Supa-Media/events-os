/**
 * One-off import of the Public Worship newsletter artwork into the campaign
 * image library (migration slot 0050 — see `migrations/index.ts`'s module doc
 * for the numbering scheme).
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
 * ── NOT wired into `migrations/index.ts`'s auto-registry ───────────────────
 * Same reasoning as the sibling `0048_import_form_submissions.ts`: `runPending`
 * executes a registered migration unconditionally on the first deploy that
 * reaches it, with no human in between. This one makes ELEVEN outbound HTTP
 * requests to a third-party host that may be dead, and it needs a human to
 * eyeball a dry run and then look at the imported images. A registry
 * migration also runs in a `MutationCtx`, which cannot `fetch` at all — so
 * this has to be an action regardless. It is numbered for discoverability
 * alongside the rest of the folder, not because it is ledger-tracked.
 *
 * No `"use node"`: `fetch` and `ctx.storage.store` are both available in
 * Convex's default V8 action runtime, and adding it would force this into a
 * separate file from nothing (see the action guidelines).
 *
 * ── DRY-RUN FIRST, ALWAYS ──────────────────────────────────────────────────
 * `dryRun: true` (the default) performs the same fetches and reports exactly
 * what WOULD be imported, what is already on file, and what failed to
 * download — writing nothing. Eyeball it, then re-run with `dryRun: false`.
 * A dry run is genuinely useful here rather than ceremonial: the most likely
 * outcome on a stale CDN is that some or all fetches 404, and you want to
 * discover that before any partial state exists.
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
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { NEWSLETTER_ASSETS } from "@events-os/shared";

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

export const importNewsletterImages = internalAction({
  args: {
    scope: v.union(v.id("chapters"), v.literal("central")),
    /** Defaults to TRUE — a human should always see the dry run first. */
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    imported: v.number(),
    alreadyOnFile: v.number(),
    failed: v.number(),
    /** Keys imported with empty alt — i.e. everything this run wrote. Listed
     *  explicitly because "it worked" and "it is finished" are different
     *  things, and alt text is the difference. */
    needsAltText: v.array(v.string()),
    results: v.array(assetResultValidator),
  }),
  handler: async (ctx, { scope, dryRun }) => {
    const isDryRun = dryRun !== false;

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

    const results: {
      sourceKey: string;
      label: string;
      outcome: "imported" | "would_import" | "already_on_file" | "failed";
      error?: string;
      bytes?: number;
    }[] = [];
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

    return {
      dryRun: isDryRun,
      imported: results.filter((r) => r.outcome === "imported").length,
      alreadyOnFile: results.filter((r) => r.outcome === "already_on_file").length,
      failed: results.filter((r) => r.outcome === "failed").length,
      needsAltText,
      results,
    };
  },
});
