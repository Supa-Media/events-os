import { describe, expect, it } from "vitest";
import { MUSIC_SECTIONS } from "./academy/streams/music";
import {
  FEATURED_ARTIST_AUDIENCE_STEP,
  FEATURED_ARTIST_CASH_CAP_CENTS,
  FEATURED_ARTIST_LADDER,
  FEATURED_ARTIST_POINTS,
  MUSIC_RATE_SHEET,
  featuredArtistCashCents,
  musicRate,
  requires1099,
} from "./musicRates";

describe("the rate sheet", () => {
  it("keeps every published role addressable by its printed name", () => {
    // The Astro pages and the Academy look rows up by this exact string; a
    // rename that misses one of them should fail here, not in production copy.
    for (const rate of MUSIC_RATE_SHEET) {
      expect(musicRate(rate.role)).toBe(rate);
    }
  });

  it("throws on an unknown role rather than rendering a blank rate", () => {
    expect(() => musicRate("Featured Vocalist")).toThrow(/no rate-sheet row/);
  });

  it("pins the published numbers", () => {
    // These appear verbatim on publicworship.life. Changing one is a policy
    // decision that must also update /music-policy §12, /collaborate, and the
    // Academy Music stream — this assert is the tripwire.
    expect(musicRate("Lead producer (full song)").cashCents).toBe(50_000);
    expect(musicRate("Lead producer (full song)").points).toBe(5);
    expect(musicRate("Featured vocalist").cashCents).toBe(30_000);
    expect(musicRate("Featured vocalist").points).toBe(3);
    expect(musicRate("Mastering engineer").cashCents).toBe(12_500);
  });

  it("never allocates a single role more than the 15-point primary baseline", () => {
    // A contributor row worth more than a named primary artist's automatic
    // baseline would invert the policy's own hierarchy (§10).
    for (const rate of MUSIC_RATE_SHEET) {
      expect(rate.points).toBeLessThan(15);
    }
  });
});

describe("the featured-artist ladder", () => {
  it("floors at the published featured-vocal rate", () => {
    // The ladder is continuous with the sheet: rung one IS the $300 row.
    expect(featuredArtistCashCents(0)).toBe(musicRate("Featured vocalist").cashCents);
    expect(featuredArtistCashCents(99_999)).toBe(30_000);
  });

  it("adds $300 per 100k monthly audience", () => {
    expect(featuredArtistCashCents(100_000)).toBe(60_000);
    expect(featuredArtistCashCents(199_999)).toBe(60_000);
    expect(featuredArtistCashCents(200_000)).toBe(90_000);
    expect(featuredArtistCashCents(300_000)).toBe(120_000);
  });

  it("caps at $1,500, however large the audience", () => {
    expect(featuredArtistCashCents(400_000)).toBe(FEATURED_ARTIST_CASH_CAP_CENTS);
    expect(featuredArtistCashCents(5_000_000)).toBe(FEATURED_ARTIST_CASH_CAP_CENTS);
    expect(featuredArtistCashCents(Number.MAX_SAFE_INTEGER)).toBe(
      FEATURED_ARTIST_CASH_CAP_CENTS,
    );
  });

  it("floors an unknown or nonsense audience to the base rate", () => {
    // An unknown audience must never silently price a feature at the top rung.
    expect(featuredArtistCashCents(Number.NaN)).toBe(30_000);
    expect(featuredArtistCashCents(-1)).toBe(30_000);
    expect(featuredArtistCashCents(Number.POSITIVE_INFINITY)).toBe(30_000);
  });

  it("rises monotonically across the whole range", () => {
    let previous = 0;
    for (let audience = 0; audience <= 1_000_000; audience += 25_000) {
      const cash = featuredArtistCashCents(audience);
      expect(cash).toBeGreaterThanOrEqual(previous);
      previous = cash;
    }
  });

  it("derives display bands that agree with the formula", () => {
    // The printed table must never drift from what agreements are priced on.
    expect(FEATURED_ARTIST_LADDER).toHaveLength(5);
    for (const rung of FEATURED_ARTIST_LADDER) {
      expect(rung.cashCents).toBe(featuredArtistCashCents(rung.minAudience));
      if (rung.maxAudience !== null) {
        expect(featuredArtistCashCents(rung.maxAudience - 1)).toBe(rung.cashCents);
        expect(rung.maxAudience).toBe(rung.minAudience + FEATURED_ARTIST_AUDIENCE_STEP);
      }
    }
    const top = FEATURED_ARTIST_LADDER[FEATURED_ARTIST_LADDER.length - 1];
    expect(top.isCap).toBe(true);
    expect(top.maxAudience).toBeNull();
    expect(top.cashCents).toBe(FEATURED_ARTIST_CASH_CAP_CENTS);
    expect(FEATURED_ARTIST_LADDER.filter((r) => r.isCap)).toHaveLength(1);
  });

  it("leaves master participation flat — the ladder prices the name in cash", () => {
    // §11's four paths are mutually exclusive: scaling points alongside cash
    // would hand a featured artist both, and eat into the 50-point cap.
    expect(FEATURED_ARTIST_POINTS).toBe(musicRate("Featured vocalist").points);
  });
});

describe("tax reporting", () => {
  it("clears the 1099 threshold on every rung above the floor", () => {
    // Operating Manual: W-9 before first payment, 1099-NEC at $600+/year.
    expect(requires1099(featuredArtistCashCents(0))).toBe(false);
    for (const rung of FEATURED_ARTIST_LADDER.slice(1)) {
      expect(requires1099(rung.cashCents)).toBe(true);
    }
  });
});

describe("the Academy tracks the sheet", () => {
  // CLAUDE.md: the Academy goes stale the moment a documented behavior
  // changes. The Music stream prints these numbers as authored prose, so it
  // can't import them — this asserts the two agree instead.
  const blocks = MUSIC_SECTIONS.flatMap((section) => section.blocks);
  const text = JSON.stringify(blocks);

  const table = (headers: string[]) =>
    blocks.find(
      (b): b is Extract<typeof b, { kind: "table" }> =>
        b.kind === "table" && headers.every((h, i) => b.headers[i] === h),
    );

  it("teaches every rate-sheet row at its published number", () => {
    const rateTable = table(["Role", "Cash fee", "Master points"]);
    expect(rateTable).toBeDefined();
    for (const rate of MUSIC_RATE_SHEET) {
      const row = rateTable!.rows.find((r) => r[0] === rate.role);
      expect(row, `Academy is missing rate-sheet row "${rate.role}"`).toBeDefined();
      expect(row![1]).toBe(
        `$${(rate.cashCents / 100).toLocaleString("en-US")}`,
      );
      expect(row![2]).toBe(`${rate.points}%`);
    }
  });

  it("teaches every ladder rung at its published number", () => {
    const ladderTable = table(["Monthly audience", "Cash fee, per song"]);
    expect(ladderTable).toBeDefined();
    expect(ladderTable!.rows).toHaveLength(FEATURED_ARTIST_LADDER.length);
    FEATURED_ARTIST_LADDER.forEach((rung, i) => {
      const printed = ladderTable!.rows[i][1];
      expect(printed).toContain(
        `$${(rung.cashCents / 100).toLocaleString("en-US")}`,
      );
      expect(printed.includes("cap")).toBe(rung.isCap);
    });
  });

  it("states the formula and the cap in prose", () => {
    expect(text).toContain("$300 for every 100k monthly listeners");
    expect(text).toContain("capped at $1,500");
  });

  it("never teaches that cash and points can be taken together", () => {
    // The one misreading that would cost real money on a signed agreement.
    expect(text).toContain("INSTEAD of the cash fee, never alongside it");
  });
});
