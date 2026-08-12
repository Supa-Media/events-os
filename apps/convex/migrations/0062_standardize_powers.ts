import { migrateLegacyPowers } from "@events-os/shared";
import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Rewrite every `seatDefs.capabilities` array into the standardized power
 * vocabulary (`packages/shared/src/powers.ts`).
 *
 * Powers had accumulated in four incompatible shapes — role nouns
 * (`finance.manager`), bare resources (`finance.accounts`), a camelCase
 * verb-first id (`org.editChart`), and a pseudo-domain that was really a UI
 * flag (`nav.finances`). The new grammar is `<domain>[.<area>].<action>` with
 * real implication rules. `seatDefs` rows are RUNTIME-EDITABLE data stamped by
 * `0022_seed_seat_defs` (and amended by `0025`/`0033`/`0036`/`0053`/`0058`/
 * `0060`), so the template change in `packages/shared/src/seats.ts` reaches
 * brand-new orgs only — every existing deployment's rows still carry the old
 * strings, and every gate now asks the new ones. Without this migration those
 * orgs lose every power at once.
 *
 * The mapping is `LEGACY_POWER_MIGRATION`, applied via `migrateLegacyPowers`
 * — deliberately shared with the schema validator and pinned by
 * `powers.test.ts`, so the table can't drift from the registry it targets.
 *
 * ACCESS-PRESERVING, which is the property that matters here and is worth
 * spelling out per deletion:
 *
 *  - `finance.central` is dropped. It meant "this seat sees every chapter's
 *    money", which is now simply what holding a finance power at CENTRAL scope
 *    means (scope rule 2 in `powers.ts`), uniformly with giving and campaigns,
 *    which never needed such a string. Both carriers (`executive_director`,
 *    `financial_manager`) are central seats holding finance powers, so their
 *    reach is unchanged.
 *  - `finance.record` is dropped. It was granted to two seats and read by
 *    NOTHING — the record-side separation-of-duties it appears to enforce is
 *    actually derived from `legacyTitle` (see `seats.ts`'s
 *    `RECORD_SEAT_SLUGS`). Both carriers also hold `finance.manager`, which
 *    becomes `finance.edit` and covers recording and reconciling.
 *  - `nav.finances` / `nav.giving` are dropped. Tab visibility is derived now
 *    (`grantsAnyInDomain`), and every seat that carried one already holds a
 *    real power in that domain, so every tab that was visible stays visible.
 *
 * The other renames are one-for-one, and three strings (`giving.view`,
 * `events.checkin`, `data.export`) already conformed and pass through
 * untouched.
 *
 * WIDENING CHECK. The new wildcard rule means a domain-wide power grants its
 * action on every declared area, so `finance.edit` (the Treasurer's, from
 * `finance.manager`) now also expands to `finance.accounts.view`. That is not
 * a widening: the Treasurer's seat is CHAPTER-scoped, and the org's bank
 * accounts live at central, which a chapter grant never reaches (scope rule
 * 3). `lib/finance.ts#isCentralEdOrFm` reads `seatDerived["central"]`
 * specifically, so a chapter Treasurer cannot satisfy it. Pinned by
 * `tests/powersMigration.test.ts`.
 *
 * Idempotent, and safely re-runnable: `migrateLegacyPowers` is the identity on
 * an already-standardized array, and a row whose rewrite is a no-op is skipped
 * without a write. Runtime edits made AFTER this runs are never reverted — the
 * mapping only ever renames what it finds.
 */

/** Bound on `seatDefs` rows scanned. The template stamps 27; the runtime chart
 *  editor can add more, so this leaves generous headroom (mirrors the bounds
 *  in `0060` and `lib/seatStructure.ts`). */
const MAX_SEAT_DEFS = 1000;

export async function runStandardizePowers(ctx: MutationCtx): Promise<void> {
  const defs = await ctx.db.query("seatDefs").take(MAX_SEAT_DEFS);

  for (const def of defs) {
    const next = migrateLegacyPowers(def.capabilities);

    const unchanged =
      next.length === def.capabilities.length &&
      next.every((c, i) => c === def.capabilities[i]);
    if (unchanged) continue;

    await ctx.db.patch(def._id, { capabilities: next, updatedAt: Date.now() });
  }
}

export const standardizePowers: Migration = {
  name: "0062_standardize_powers",
  run: runStandardizePowers,
};
