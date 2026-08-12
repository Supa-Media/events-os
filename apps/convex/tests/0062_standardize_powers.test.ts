/**
 * Test suite for migration 0062: rewriting every live `seatDefs.capabilities`
 * array into the standardized power vocabulary (`packages/shared/src/powers.ts`).
 *
 * `seatDefs` is a GLOBAL chart — one row per seat, not one per chapter —
 * seeded by `0022` and amended by `0025`/`0033`/`0036`/`0053`/`0058`/`0060`.
 * Every one of those wrote PRE-standardization strings, and every gate in the
 * app now asks for the new ones, so this migration is the only thing standing
 * between an already-deployed org and losing every power at once. That is what
 * these tests are really about: not that strings changed, but that nobody's
 * access did.
 *
 * Rows are inserted DIRECTLY with the old capability sets rather than through
 * `runSeedSeatDefs` — which seeds from the already-updated shared template and
 * would therefore have nothing for the migration to do.
 */
import { describe, expect, test } from "vitest";
import { expandPowers, migrateLegacyPowers } from "@events-os/shared";
import { newT, run } from "./setup.helpers";
import { runStandardizePowers } from "../migrations/0062_standardize_powers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";

type T = ReturnType<typeof newT>;

/** Insert one `seatDefs` row carrying `capabilities` verbatim, bypassing the
 *  template so a test can pin the exact pre-migration shape. */
async function seedRow(t: T, slug: string, capabilities: string[]) {
  const now = Date.now();
  return run(t, (ctx) =>
    ctx.db.insert("seatDefs", {
      slug,
      title: slug,
      chart: slug === "treasurer" || slug === "chapter_director" ? "chapter" : "central",
      parentSlug: "root",
      maxHolders: 1,
      duties: [],
      // The storage validator deliberately still accepts these (see
      // `schema/seats.ts`) — that is precisely the window this migration runs in.
      capabilities: capabilities as never,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

async function capsOf(t: T, slug: string): Promise<string[]> {
  const def = await run(t, (ctx) =>
    ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", slug)).unique(),
  );
  if (!def) throw new Error(`${slug} missing`);
  return def.capabilities as string[];
}

/** The live pre-standardization capability sets, verbatim. */
const LEGACY_ED = [
  "finance.central",
  "finance.accounts",
  "finance.approve",
  "nav.finances",
  "org.editChart",
  "giving.manage",
  "giving.view",
  "nav.giving",
  "campaigns.approve",
  "campaigns.compose",
  "campaigns.design",
  "data.export",
  "finance.publish",
];
const LEGACY_TREASURER = [
  "finance.manager",
  "finance.record",
  "nav.finances",
  "giving.view",
  "nav.giving",
];

describe("0062_standardize_powers — rewrite", () => {
  test("rewrites the ED's legacy set into the standardized vocabulary", async () => {
    const t = newT();
    await seedRow(t, "executive_director", LEGACY_ED);

    await run(t, (ctx) => runStandardizePowers(ctx));

    expect(await capsOf(t, "executive_director")).toEqual([
      "finance.accounts.view",
      "finance.budgets.approve",
      "org.chart.edit",
      "giving.edit",
      "giving.view",
      "email.campaigns.approve",
      "email.campaigns.edit",
      "email.assets.edit",
      "data.export",
      "finance.ledger.publish",
    ]);
  });

  test("drops the three strings that were never powers", async () => {
    const t = newT();
    await seedRow(t, "treasurer", LEGACY_TREASURER);

    await run(t, (ctx) => runStandardizePowers(ctx));

    const caps = await capsOf(t, "treasurer");
    for (const gone of [
      "finance.central",
      "finance.record",
      "nav.finances",
      "nav.giving",
    ]) {
      expect(caps, gone).not.toContain(gone);
    }
    expect(caps).toEqual(["finance.edit", "giving.view"]);
  });

  test("leaves an already-standardized row untouched", async () => {
    const t = newT();
    const standardized = ["finance.edit", "giving.view"];
    await seedRow(t, "treasurer", standardized);

    await run(t, (ctx) => runStandardizePowers(ctx));

    expect(await capsOf(t, "treasurer")).toEqual(standardized);
  });

  test("is idempotent — a second run changes nothing", async () => {
    const t = newT();
    await seedRow(t, "executive_director", LEGACY_ED);

    await run(t, (ctx) => runStandardizePowers(ctx));
    const afterFirst = await capsOf(t, "executive_director");
    await run(t, (ctx) => runStandardizePowers(ctx));

    expect(await capsOf(t, "executive_director")).toEqual(afterFirst);
  });

  test("a seat with no powers survives the run", async () => {
    const t = newT();
    await seedRow(t, "music_lead", []);
    await run(t, (ctx) => runStandardizePowers(ctx));
    expect(await capsOf(t, "music_lead")).toEqual([]);
  });

  test("runs cleanly over a freshly seeded chart (0022 output is already standard)", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const before = await capsOf(t, "executive_director");
    await run(t, (ctx) => runStandardizePowers(ctx));
    expect(await capsOf(t, "executive_director")).toEqual(before);
  });
});

describe("0062_standardize_powers — ACCESS PRESERVATION", () => {
  /**
   * The property that actually matters. For each seat, what the OLD strings
   * granted (once translated) must still be granted after migrating — checked
   * through `expandPowers`, because that is what the gates themselves ask.
   */
  const CASES: Array<[string, string[]]> = [
    ["executive_director", LEGACY_ED],
    ["treasurer", LEGACY_TREASURER],
    [
      "chapter_director",
      [
        "finance.approve",
        "finance.viewer",
        "nav.finances",
        "giving.view",
        "nav.giving",
        "data.export",
        "events.checkin",
        "finance.publish",
      ],
    ],
  ];

  for (const [slug, legacy] of CASES) {
    test(`${slug} keeps every power it had`, async () => {
      const t = newT();
      await seedRow(t, slug, legacy);
      await run(t, (ctx) => runStandardizePowers(ctx));

      const granted = expandPowers(await capsOf(t, slug));
      for (const power of expandPowers(migrateLegacyPowers(legacy))) {
        expect(granted.has(power), `${slug} lost ${power}`).toBe(true);
      }
    });
  }

  test("the Treasurer's chapter-scoped finance.edit is unchanged in reach", async () => {
    // `finance.edit` expands to `finance.accounts.view`, which the Treasurer
    // did not previously hold. Safe only because the seat is CHAPTER-scoped and
    // the org's bank accounts live at central — `isCentralEdOrFm` reads the
    // central scope specifically. This pins the seat's chart so a future edit
    // that promotes the Treasurer to a central seat trips here first.
    const t = newT();
    await seedRow(t, "treasurer", LEGACY_TREASURER);
    await run(t, (ctx) => runStandardizePowers(ctx));

    const def = await run(t, (ctx) =>
      ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", "treasurer")).unique(),
    );
    expect(def!.chart).toBe("chapter");
  });
});
