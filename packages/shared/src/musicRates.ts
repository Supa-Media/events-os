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
 *  - Cash and points BOTH scale, on the same rungs: rung N is $300N in cash or
 *    N points. Points cap at 5 while cash caps at $1,500.
 *
 * Why points cap so much lower than the cash:points ratio elsewhere on the
 * sheet: every other row prices a point at roughly $100 of cash (a $500 lead
 * producer takes 5 points; a $300 featured vocal takes 3). Carrying that ratio
 * up the ladder would make a capped feature worth 15 points — the exact Primary
 * Artist baseline in §10 — so a single guest verse would earn the same
 * ownership as an artist we build a catalog with over years. The ladder
 * deliberately breaks the ratio: a NAME is paid in cash, and equity stays
 * weighted toward the people building the catalog.
 *
 * The points column is floored at `FEATURED_ARTIST_MIN_POINTS` — the flat
 * Featured vocalist rate. Without that floor, rung one would offer an INVITED
 * artist 1 point where a walk-in featured vocalist takes 3, paying less equity
 * for more standing. A featured artist is never worse off on the ladder than
 * on the flat row.
 *
 * Cash and points are alternatives, not a package (§11's four paths are
 * mutually exclusive) — but they are divisible. `featuredArtistMix` splits the
 * rung proportionally, which is what §13's "partial cash fee plus partial
 * equity" has always gestured at without publishing a rate.
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

/** Points earned per rung — one point per `FEATURED_ARTIST_AUDIENCE_STEP`. */
export const FEATURED_ARTIST_POINTS_PER_RUNG = 1;

/** Never fewer points than the flat Featured vocalist row offers a walk-in. */
export const FEATURED_ARTIST_MIN_POINTS = 3;

/**
 * The points ceiling. Well under the 15-point Primary Artist baseline (§10) —
 * a one-song feature must never earn the ownership of an artist we're building
 * a catalog with.
 */
export const FEATURED_ARTIST_MAX_POINTS = 5;

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
export function featuredArtistRungs(monthlyAudience: number): number {
  const audience =
    Number.isFinite(monthlyAudience) && monthlyAudience > 0 ? monthlyAudience : 0;
  return Math.floor(audience / FEATURED_ARTIST_AUDIENCE_STEP) + 1;
}

export function featuredArtistCashCents(monthlyAudience: number): number {
  const rungs = featuredArtistRungs(monthlyAudience);
  return Math.min(rungs * FEATURED_ARTIST_STEP_CENTS, FEATURED_ARTIST_CASH_CAP_CENTS);
}

/**
 * Master income participation offered INSTEAD of the cash fee, in points.
 * One point per 100k monthly listeners, floored at the flat featured-vocal
 * rate and capped at `FEATURED_ARTIST_MAX_POINTS`.
 */
export function featuredArtistPoints(monthlyAudience: number): number {
  const earned = featuredArtistRungs(monthlyAudience) * FEATURED_ARTIST_POINTS_PER_RUNG;
  return Math.min(
    Math.max(earned, FEATURED_ARTIST_MIN_POINTS),
    FEATURED_ARTIST_MAX_POINTS,
  );
}

export interface FeaturedArtistRung {
  /** Inclusive lower bound of the band, in monthly listeners. */
  minAudience: number;
  /** Exclusive upper bound, or null for the capped top rung. */
  maxAudience: number | null;
  /** Cash fee for the band, in integer cents. */
  cashCents: number;
  /** Master participation offered instead of the cash, in points. */
  points: number;
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
      points: featuredArtistPoints(minAudience),
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

export interface FeaturedArtistMix {
  /** Cash taken, in integer cents. */
  cashCents: number;
  /** Points taken, rounded to the quarter-point the sheet already uses. */
  points: number;
}

/**
 * The published mixed path: take any percentage of the cash fee, and the
 * REMAINING percentage of the points. 100 is all cash, 0 is all points, 50 is
 * half of each — which is what "if you want points, take less cash" means in
 * numbers, and what §13's "partial cash plus partial equity" always implied.
 *
 * Proportional rather than a $/point exchange rate on purpose: an exchange rate
 * would let someone convert a capped cash fee into points at a ratio the sheet
 * deliberately does not offer (see the header note on why points cap at 5).
 *
 * `cashPercent` is clamped to 0–100; a non-finite value is treated as all cash,
 * since cash is the path that cannot be taken by accident — it has to be funded.
 */
export function featuredArtistMix(
  monthlyAudience: number,
  cashPercent: number,
): FeaturedArtistMix {
  const pct = Number.isFinite(cashPercent)
    ? Math.min(Math.max(cashPercent, 0), 100)
    : 100;
  const fullCash = featuredArtistCashCents(monthlyAudience);
  const fullPoints = featuredArtistPoints(monthlyAudience);
  return {
    cashCents: Math.round((fullCash * pct) / 100),
    // Quarter-point granularity matches the 0.75/1.5 values already on the sheet.
    points: Math.round((fullPoints * (100 - pct)) / 100 / 0.25) * 0.25,
  };
}
