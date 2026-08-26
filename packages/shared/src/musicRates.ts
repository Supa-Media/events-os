/**
 * The music rate sheet — the single source of truth for what every contributor
 * role on an Official Public Worship Release earns.
 *
 * These numbers are PUBLISHED, not negotiated per release: they appear verbatim
 * on `publicworship.life/music-policy` (§12) and `publicworship.life/collaborate`,
 * and are taught in the Academy Music stream. Before this module existed the
 * sheet was hand-copied into all three, which meant a rate change could land in
 * one and silently contradict the others. Every surface now reads from here.
 *
 * MONEY IS ALWAYS INTEGER CENTS (USD), per the `finance.ts` convention. "Points"
 * are percentage points of net master income for that release — one point is 1%,
 * and `3` here means the same thing as the "3%" printed on the policy page.
 *
 * Rates are PER SONG, not per session, and are anchored to independent-artist
 * market rates — not major-label rates and not a "ministry discount". Effective
 * 2026, next scheduled review end of 2027.
 *
 * ── The featured-artist ladder ──────────────────────────────────────────────
 * The flat `Featured vocalist` rate prices LABOR: someone sings on the record.
 * It does not price a NAME — an established artist whose audience is itself part
 * of what the release gets. The policy already concedes that principle for
 * Primary Artists, whose 15-point baseline is justified in §10 as reflecting
 * "the value of carrying the named-artist identity … and ongoing brand
 * relationship" — but a courted Featured Artist had no equivalent, so the
 * outreach copy on /collaborate ("your voice — and your name") was promising
 * something the sheet priced at the session-vocal rate.
 *
 * The ladder closes that gap without giving up the "published in full, not
 * negotiated case by case" promise that makes the sheet worth having: the fee is
 * a FUNCTION of a public number, so an artist can read the page and work out
 * their own row. $300 per 100k monthly audience, capped at $1,500.
 *
 * Two deliberate properties:
 *  - The existing $300 featured-vocal rate is the FLOOR, not a separate row, so
 *    the ladder is continuous with the sheet rather than bolted onto it.
 *  - The ladder scales the CASH path only. Master participation for a featured
 *    artist stays flat at `FEATURED_ARTIST_POINTS` regardless of audience, and
 *    cash and points remain mutually exclusive under the four paths (§11) — an
 *    artist taking the cash fee takes no points for the feature.
 */

// ── Shape ────────────────────────────────────────────────────────────────────

export interface MusicRate {
  /** Display name of the role, exactly as printed on the policy page. */
  role: string;
  /** Cash fee for the role, per song, in integer cents. */
  cashCents: number;
  /** Master income participation offered INSTEAD of the cash fee, in points. */
  points: number;
  /** The market anchor justifying the number; shown in the §12 table. */
  note: string;
}

// ── The sheet ────────────────────────────────────────────────────────────────

export const MUSIC_RATE_SHEET: readonly MusicRate[] = [
  {
    role: "Lead producer (full song)",
    cashCents: 50_000,
    points: 5,
    note: "Indie tier $300–$1,500/song; emerging-producer floor $500.",
  },
  {
    role: "Co-producer",
    cashCents: 25_000,
    points: 2,
    note: "Roughly half a producer slot — common 50/50 split.",
  },
  {
    role: "Recording engineer (tracking)",
    cashCents: 20_000,
    points: 1.5,
    note: "Indie tracking $50–$150/hr × 3–5 hrs.",
  },
  {
    role: "Mix engineer",
    cashCents: 40_000,
    points: 3,
    note: "Mid-tier indie pro mixing sweet spot.",
  },
  {
    role: "Mastering engineer",
    cashCents: 12_500,
    points: 0.75,
    note: "Independent mid-tier mastering $75–$150/song.",
  },
  {
    role: "Vocal producer",
    cashCents: 25_000,
    points: 2,
    note: "Sub-discipline of producing — typically half a producer fee.",
  },
  {
    role: "Arranger",
    cashCents: 20_000,
    points: 1.5,
    note: "Per-minute arranging $50–$90/min × ~4 min.",
  },
  {
    role: "Featured vocalist",
    cashCents: 30_000,
    points: 3,
    note: "Indie/worship featured vocal $150–$500/song. Floor of the featured-artist ladder — see §12a.",
  },
  {
    role: "Background vocalist",
    cashCents: 12_500,
    points: 0.75,
    note: "Clears AFM single-song minimum; indie BGV $75–$200.",
  },
  {
    role: "Session instrumentalist",
    cashCents: 12_500,
    points: 0.75,
    note: "Same AFM floor; indie session $75–$250.",
  },
  {
    role: "Marketing / rollout lead",
    cashCents: 50_000,
    points: 3,
    note: "Indie boutique PR campaign floor.",
  },
] as const;

/** Look up one row by its printed role name. Throws rather than rendering a
 *  silent em-dash, so a typo in a page fails the build instead of shipping. */
export function musicRate(role: string): MusicRate {
  const found = MUSIC_RATE_SHEET.find((r) => r.role === role);
  if (!found) {
    throw new Error(
      `musicRate: no rate-sheet row named "${role}". Known roles: ${MUSIC_RATE_SHEET.map((r) => r.role).join(", ")}`,
    );
  }
  return found;
}

// ── The featured-artist ladder ───────────────────────────────────────────────

/** One rung is earned per this many monthly listeners. */
export const FEATURED_ARTIST_AUDIENCE_STEP = 100_000;

/** Cash added per rung, in integer cents. Rung one is the $300 floor. */
export const FEATURED_ARTIST_STEP_CENTS = 30_000;

/** The ladder stops here — reached at 400k monthly listeners and above. */
export const FEATURED_ARTIST_CASH_CAP_CENTS = 150_000;

/**
 * Master participation offered to a featured artist INSTEAD of the cash fee.
 * Deliberately flat: the ladder prices the name in cash, not in points, and the
 * 50-point contributor cap (§11) has to absorb every contributor on a release.
 */
export const FEATURED_ARTIST_POINTS = 3;

/**
 * The published cash fee for a featured artist, per song, in integer cents.
 *
 * $300 for every 100k monthly audience, floored at one rung and capped at
 * $1,500. Audience is the artist's monthly listener count from public streaming
 * data, measured when the featured-artist agreement is signed — fixed at that
 * point so the fee is never reopened mid-release.
 *
 * A missing, negative, or non-finite audience floors to the base rate rather
 * than throwing: an unknown audience must never silently price a feature high.
 */
export function featuredArtistCashCents(monthlyAudience: number): number {
  const audience =
    Number.isFinite(monthlyAudience) && monthlyAudience > 0 ? monthlyAudience : 0;
  const rungs = Math.floor(audience / FEATURED_ARTIST_AUDIENCE_STEP) + 1;
  return Math.min(rungs * FEATURED_ARTIST_STEP_CENTS, FEATURED_ARTIST_CASH_CAP_CENTS);
}

export interface FeaturedArtistRung {
  /** Inclusive lower bound of the band, in monthly listeners. */
  minAudience: number;
  /** Exclusive upper bound, or null for the capped top rung. */
  maxAudience: number | null;
  /** Cash fee for the band, in integer cents. */
  cashCents: number;
  /** Whether this rung is the cap. */
  isCap: boolean;
}

/**
 * The ladder as display bands, DERIVED from `featuredArtistCashCents` so the
 * printed table can never drift from the formula the agreements are priced on.
 */
export const FEATURED_ARTIST_LADDER: readonly FeaturedArtistRung[] = (() => {
  const capRungs = FEATURED_ARTIST_CASH_CAP_CENTS / FEATURED_ARTIST_STEP_CENTS;
  const rows: FeaturedArtistRung[] = [];
  for (let rung = 1; rung <= capRungs; rung++) {
    const minAudience = (rung - 1) * FEATURED_ARTIST_AUDIENCE_STEP;
    const isCap = rung === capRungs;
    rows.push({
      minAudience,
      maxAudience: isCap ? null : minAudience + FEATURED_ARTIST_AUDIENCE_STEP,
      cashCents: featuredArtistCashCents(minAudience),
      isCap,
    });
  }
  return rows;
})();

/**
 * Whether a featured-artist cash fee triggers IRS information reporting. The
 * Operating Manual requires a W-9 before the first payment and a 1099-NEC for
 * anyone paid $600+ in a calendar year — every rung above the floor clears it.
 */
export const IRS_1099_THRESHOLD_CENTS = 60_000;

export function requires1099(cashCents: number): boolean {
  return cashCents >= IRS_1099_THRESHOLD_CENTS;
}
