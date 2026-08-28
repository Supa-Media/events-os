import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { BRAND_FONT_SEED } from "../lib/seed/brandKit";

/**
 * Correct the Inter row's note, which is telling the designer to do something
 * the org has since decided against.
 *
 * ── What went wrong ─────────────────────────────────────────────────────────
 * The brand kit seeded four faces, and Inter's note said the kit held an
 * unresolved argument: *"Conflicts with the brand lesson's three-face list — a
 * human needs to decide whether Inter is the org's body face or just the email
 * face."* The founder then decided, out loud: *"it doesn't matter, put all of
 * the fonts there and then make sure the designer can edit it when they want."*
 * All four stay; the designer curates.
 *
 * The seed was updated to say so. **That changed nothing anyone could see** —
 * `seedBrandKitIfEmpty` only fires against an empty table, and production's has
 * had rows since migration 0080. So the live kit went on asking a human to
 * settle a question that was already settled, in the one place a designer would
 * actually read it, while the repo said the opposite. Editing seed prose is
 * never a fix for a deployment that has already been seeded — the row is the
 * artifact, and only a migration reaches it.
 *
 * ── Why it matches on the exact old string ──────────────────────────────────
 * The whole point of this feature is that the designer owns these notes. If
 * somebody has already rewritten Inter's — which they are entitled to do at any
 * moment, with no review — then their words are the current answer and this
 * migration has no business overwriting them.
 *
 * So it patches ONLY a row whose note is still, byte for byte, the stale seeded
 * sentence. Anything else, including an empty note, is left exactly as it is.
 * That makes this safe to re-run and safe to run late, and it means the
 * migration cannot lose an edit made between the deploy and this line running.
 */

/** The note the original seed wrote. Kept as a literal on purpose: it no longer
 *  exists anywhere else in the tree, and reconstructing it from the current
 *  seed would match nothing. */
const STALE_INTER_NOTE =
  "The face the real newsletter is set in, heading and body both. Conflicts with the brand lesson's three-face list — a human needs to decide whether Inter is the org's body face or just the email face.";

/** Read the corrected wording off the seed rather than retyping it, so the two
 *  cannot drift — a fresh deployment and a migrated one must end up saying the
 *  same thing about the same face. */
function correctedInterNote(): string | undefined {
  return BRAND_FONT_SEED.find((f) => f.name === "Inter")?.notes;
}

export const correctInterFontNote: Migration = {
  name: "0082_correct_inter_font_note",
  run: async (ctx: MutationCtx) => {
    const corrected = correctedInterNote();
    // The seed is the source of the replacement text. If the Inter row is ever
    // dropped from it, this migration has nothing truthful to write and does
    // nothing at all rather than inventing a sentence.
    if (!corrected) return { corrected: 0, reason: "no Inter row in the seed" };

    const fonts = await ctx.db.query("brandFonts").take(50);
    let patched = 0;
    for (const font of fonts) {
      if (font.notes !== STALE_INTER_NOTE) continue;
      await ctx.db.patch(font._id, { notes: corrected, updatedAt: Date.now() });
      patched += 1;
    }
    return { corrected: patched };
  },
};
