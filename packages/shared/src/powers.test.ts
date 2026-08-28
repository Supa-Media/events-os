import { describe, expect, test } from "vitest";
import {
  LEGACY_POWER_MIGRATION,
  POWERS,
  POWER_ACTIONS,
  POWER_AREAS,
  POWER_DEFS,
  POWER_DOMAINS,
  type Power,
  domainOf,
  expandPowers,
  grantsAnyInDomain,
  grantsPower,
  isPower,
  migrateLegacyPowers,
  powerLabel,
  powersAtScope,
} from "./powers";
import { SEAT_DEFS, SEAT_IDS } from "./seats";

/**
 * `powers.ts` is the org's permission vocabulary. This suite pins the three
 * things that make it a system rather than a list: the GRAMMAR every id obeys,
 * the IMPLICATION rules gates depend on, and — most importantly — the claim
 * that standardizing cost nobody access. That last one is what a reviewer
 * actually needs to trust, so it is tested against the real seat chart rather
 * than asserted in a comment.
 */

describe("grammar", () => {
  test("every id is <domain>[.<area>].<action>, lowercase, 2–3 segments", () => {
    for (const power of POWERS) {
      const segments = power.split(".");
      expect(segments.length, power).toBeGreaterThanOrEqual(2);
      expect(segments.length, power).toBeLessThanOrEqual(3);
      expect(power, power).toBe(power.toLowerCase());
      // No camelCase anywhere — the thing `org.editChart` used to violate.
      expect(power, power).toMatch(/^[a-z]+(\.[a-z]+){1,2}$/);
    }
  });

  test("the LAST segment is always a declared action", () => {
    for (const power of POWERS) {
      const action = power.split(".").at(-1) as string;
      expect(POWER_ACTIONS as readonly string[], power).toContain(action);
    }
  });

  test("the FIRST segment is always a declared domain", () => {
    for (const power of POWERS) {
      const domain = power.split(".")[0];
      expect(POWER_DOMAINS as readonly string[], power).toContain(domain);
    }
  });

  test("no id encodes a role noun or a bare resource", () => {
    // The four shapes the old vocabulary had grown, as a regression guard:
    // `finance.manager`/`finance.viewer` (role nouns), `finance.accounts`
    // (bare resource), `org.editChart` (verb-first camelCase), `nav.finances`
    // (a UI flag wearing a domain).
    const banned = ["manager", "viewer", "nav", "accounts", "editchart"];
    for (const power of POWERS) {
      const last = power.split(".").at(-1) as string;
      expect(banned, power).not.toContain(last);
      expect(power.split(".")[0], power).not.toBe("nav");
    }
  });

  test("every def agrees with the id it is filed under", () => {
    for (const power of POWERS) {
      const def = POWER_DEFS[power];
      expect(def.id).toBe(power);
      const segments = power.split(".");
      expect(def.domain).toBe(segments[0]);
      expect(def.action).toBe(segments.at(-1));
      expect(def.area).toBe(segments.length === 3 ? segments[1] : undefined);
    }
  });

  test("POWERS has no duplicates and matches POWER_DEFS exactly", () => {
    expect(new Set(POWERS).size).toBe(POWERS.length);
    expect(Object.keys(POWER_DEFS).sort()).toEqual([...POWERS].sort());
  });

  test("every power has a human label and description — no raw id can reach the UI", () => {
    for (const power of POWERS) {
      expect(powerLabel(power), power).toBeTruthy();
      expect(powerLabel(power), power).not.toBe(power);
      expect(POWER_DEFS[power].description, power).toBeTruthy();
    }
  });

  test("every `implies` edge points at a real power", () => {
    for (const power of POWERS) {
      for (const implied of POWER_DEFS[power].implies ?? []) {
        expect(isPower(implied), `${power} implies ${implied}`).toBe(true);
      }
    }
  });
});

describe("implication — rule 1: wildcard", () => {
  test("a domain-wide power grants its action on every declared area", () => {
    // `finance` declares accounts/cards/budgets/ledger; only the area powers
    // that actually EXIST are granted, which is why this asserts membership
    // rather than a count.
    const held = expandPowers(["finance.edit"]);
    expect(held.has("finance.cards.edit")).toBe(true);
    expect(held.has("finance.cards.view")).toBe(true);
    expect(held.has("finance.accounts.view")).toBe(true);
  });

  test("an AREA power never leaks sideways into another area", () => {
    const held = expandPowers(["finance.cards.edit"]);
    expect(held.has("finance.accounts.view")).toBe(false);
    expect(held.has("finance.edit")).toBe(false);
    expect(held.has("finance.view")).toBe(false);
  });

  test("the wildcard never crosses a domain boundary", () => {
    const held = expandPowers(["finance.edit"]);
    for (const p of held) expect(domainOf(p)).toBe("finance");
  });
});

describe("implication — rule 2: the view ladder", () => {
  test("edit grants view at the same prefix", () => {
    expect(grantsPower(["giving.edit"], "giving.view")).toBe(true);
    expect(grantsPower(["finance.cards.edit"], "finance.cards.view")).toBe(true);
  });

  test("view does NOT grant edit", () => {
    expect(grantsPower(["giving.view"], "giving.edit")).toBe(false);
    expect(grantsPower(["finance.view"], "finance.edit")).toBe(false);
  });

  test("edit does NOT grant approve — separation of duties is the point", () => {
    expect(grantsPower(["finance.edit"], "finance.budgets.approve")).toBe(false);
    expect(grantsPower(["email.campaigns.edit"], "email.campaigns.approve")).toBe(
      false,
    );
  });

  test("edit does NOT grant publish — a published number cannot be un-seen", () => {
    expect(grantsPower(["finance.edit"], "finance.ledger.publish")).toBe(false);
  });

  test("export grants no view — it never widens what you can see", () => {
    const held = expandPowers(["data.export"]);
    expect([...held]).toEqual(["data.export"]);
  });
});

describe("implication — rule 3: explicit cross-area edges", () => {
  test("the email ladder chains approve → compose → design", () => {
    const held = expandPowers(["email.campaigns.approve"]);
    expect(held.has("email.campaigns.edit")).toBe(true);
    expect(held.has("email.assets.edit")).toBe(true);
  });

  test("design alone never reaches compose or approve", () => {
    const held = expandPowers(["email.assets.edit"]);
    expect(held.has("email.campaigns.edit")).toBe(false);
    expect(held.has("email.campaigns.approve")).toBe(false);
  });
});

describe("expansion is safe on hostile input", () => {
  test("unknown strings are dropped, not thrown on", () => {
    // `seatDefs` rows are runtime-editable data; a stale string must fail
    // CLOSED rather than take down every gate that expands it.
    expect([...expandPowers(["not.a.power", "finance.view"])]).toContain(
      "finance.view",
    );
    expect(expandPowers(["not.a.power"]).size).toBe(0);
    expect(expandPowers([]).size).toBe(0);
  });

  test("expansion terminates and is idempotent", () => {
    const once = expandPowers(POWERS);
    const twice = expandPowers(once);
    expect([...twice].sort()).toEqual([...once].sort());
  });

  test("every power expands to a set containing itself", () => {
    for (const power of POWERS) {
      expect(expandPowers([power]).has(power), power).toBe(true);
    }
  });
});

describe("navigation is derived, never granted", () => {
  test("any power in a domain surfaces that domain's desk", () => {
    expect(grantsAnyInDomain(["giving.view"], "giving")).toBe(true);
    expect(grantsAnyInDomain(["finance.budgets.approve"], "finance")).toBe(true);
    expect(grantsAnyInDomain(["data.export"], "finance")).toBe(false);
    expect(grantsAnyInDomain([], "finance")).toBe(false);
  });

  test("every seat that used to carry nav.finances still surfaces Finances", () => {
    // The four seats on the pre-standardization `nav.finances` list.
    for (const seat of [
      "executive_director",
      "financial_manager",
      "chapter_director",
      "treasurer",
    ] as const) {
      expect(
        grantsAnyInDomain(SEAT_DEFS[seat].capabilities, "finance"),
        seat,
      ).toBe(true);
    }
  });

  test("every seat that used to carry nav.giving still surfaces Giving", () => {
    for (const seat of [
      "executive_director",
      "financial_manager",
      "development_director",
      "partnership_associate",
      "fundraising_associate",
      "expansion_director",
      "chapter_director",
      "treasurer",
    ] as const) {
      expect(
        grantsAnyInDomain(SEAT_DEFS[seat].capabilities, "giving"),
        seat,
      ).toBe(true);
    }
  });

  test("a seat with no power in a domain does not surface its desk", () => {
    expect(grantsAnyInDomain(SEAT_DEFS.music_lead.capabilities, "finance")).toBe(
      false,
    );
    expect(
      grantsAnyInDomain(SEAT_DEFS.graphic_designer.capabilities, "giving"),
    ).toBe(false);
  });
});

describe("legacy migration", () => {
  test("every legacy key maps to a real power or an explicit deletion", () => {
    for (const [legacy, mapped] of Object.entries(LEGACY_POWER_MIGRATION)) {
      if (mapped === null) continue;
      expect(isPower(mapped), `${legacy} → ${mapped}`).toBe(true);
    }
  });

  test("exactly the four non-powers are deleted", () => {
    const deleted = Object.entries(LEGACY_POWER_MIGRATION)
      .filter(([, v]) => v === null)
      .map(([k]) => k)
      .sort();
    expect(deleted).toEqual([
      "finance.central",
      "finance.record",
      "nav.finances",
      "nav.giving",
    ]);
  });

  test("every power in the new vocabulary is reachable from some legacy string", () => {
    // Guards against a rename landing in POWERS but not in the migration
    // table, which would silently strip that power from every existing org.
    // `finance.cards.*` and `giving.partners.edit` are the deliberate
    // exceptions: NEW areas with no pre-standardization equivalent
    // (`giving.partners.edit` shipped with the partner portal, 2026-08-20).
    const reachable = new Set(Object.values(LEGACY_POWER_MIGRATION));
    const unreachable = POWERS.filter((p) => !reachable.has(p));
    expect(unreachable).toEqual([
      "finance.cards.view",
      "finance.cards.edit",
      "giving.partners.edit",
      // The Hiring desk shipped 2026-08-23 with the public careers page —
      // a whole new domain, so there is no legacy string that could have
      // meant it. Nothing to migrate from.
      "hiring.view",
      "hiring.edit",
      "hiring.approve",
      // The Marketing desk shipped 2026-08-28 (the homepage's own copy and
      // link cards + the mailing/SMS list). Same story as `hiring` — a new
      // domain, nothing in the old vocabulary meant it.
      "marketing.site.edit",
      "marketing.designs.edit",
      "marketing.blog.edit",
      "marketing.blog.publish",
      "marketing.list.view",
      "marketing.list.edit",
    ]);
  });

  test("migration is the identity on already-standardized arrays", () => {
    expect(migrateLegacyPowers([...POWERS])).toEqual([...POWERS]);
  });

  test("migration is idempotent and de-duplicates", () => {
    const once = migrateLegacyPowers([
      "finance.manager",
      "finance.central",
      "finance.record",
      "nav.finances",
    ]);
    expect(once).toEqual(["finance.edit"]);
    expect(migrateLegacyPowers(once)).toEqual(once);
  });

  test("unknown strings are dropped rather than carried forward", () => {
    expect(migrateLegacyPowers(["finance.manager", "bogus.string"])).toEqual([
      "finance.edit",
    ]);
  });
});

describe("ACCESS PRESERVATION — standardizing cost nobody a power", () => {
  /**
   * The pre-standardization capability list, verbatim, for every seat that
   * carried one. This is the ground truth the migration has to preserve, so it
   * is pinned here rather than derived from anything — a bug in the new code
   * cannot quietly change what this suite compares against.
   */
  const LEGACY_BY_SEAT: Partial<Record<(typeof SEAT_IDS)[number], string[]>> = {
    executive_director: [
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
    ],
    financial_manager: [
      "finance.manager",
      "finance.central",
      "finance.accounts",
      "finance.record",
      "nav.finances",
      "giving.view",
      "nav.giving",
      "campaigns.approve",
      "campaigns.compose",
      "campaigns.design",
      "data.export",
      "finance.publish",
    ],
    development_director: [
      "giving.manage",
      "giving.view",
      "nav.giving",
      "data.export",
    ],
    partnership_associate: ["giving.view", "nav.giving"],
    fundraising_associate: ["giving.view", "nav.giving"],
    marketing_director: [
      "campaigns.approve",
      "campaigns.compose",
      "campaigns.design",
      "data.export",
    ],
    social_media_manager: ["campaigns.design"],
    graphic_designer: ["campaigns.design"],
    expansion_director: ["giving.view", "nav.giving", "data.export"],
    chapter_director: [
      "finance.approve",
      "finance.viewer",
      "nav.finances",
      "giving.view",
      "nav.giving",
      "data.export",
      "events.checkin",
      "finance.publish",
    ],
    treasurer: [
      "finance.manager",
      "finance.record",
      "nav.finances",
      "giving.view",
      "nav.giving",
    ],
    event_lead: ["events.checkin"],
    event_organizers: ["events.checkin"],
    production_coordinator: ["events.checkin"],
  };

  test("no seat lost a power it used to hold", () => {
    for (const seatId of SEAT_IDS) {
      const legacy = LEGACY_BY_SEAT[seatId] ?? [];
      // What the OLD strings mean once translated, vs. what the seat grants now.
      const expected = expandPowers(migrateLegacyPowers(legacy));
      const actual = expandPowers(SEAT_DEFS[seatId].capabilities);
      for (const power of expected) {
        expect(actual.has(power), `${seatId} lost ${power}`).toBe(true);
      }
    }
  });

  /**
   * Domains granted DELIBERATELY, after the standardization this block
   * guards. The invariant here is about the 2026-08-12 migration — that
   * translating the old strings neither dropped nor widened anyone's reach.
   * A new domain added later is a reviewed product decision, not migration
   * drift, so it is named here (with the seats that got it) instead of the
   * check being loosened.
   *
   *  - `hiring` (2026-08-23, careers page + application pipeline): the People
   *    seat and the ED hold the call; the recruiting associate runs the
   *    funnel without being able to close a file.
   *  - `marketing` (2026-08-28, the Marketing desk): the marketing chain gets
   *    the homepage's words and cards; the Director and the ED also get the
   *    mailing list, while the associate and the chapter Marketing Lead only
   *    read it. This is a NEW surface, not a re-grant — before the desk
   *    existed, changing a headline or a link was a pull request.
   *  - `marketing` for `chapter_director` (2026-08-28, second wave): the brand
   *    kit, on the founder's instruction. The CD held nothing in this domain
   *    before, so it is named here for the same reason the rest are.
   */
  const POST_STANDARDIZATION_DOMAINS: Partial<Record<string, string[]>> = {
    executive_director: ["hiring", "marketing"],
    expansion_director: ["hiring"],
    recruiting_associate: ["hiring"],
    marketing_director: ["marketing"],
    social_media_manager: ["marketing"],
    graphic_designer: ["marketing"],
    marketing_associate: ["marketing"],
    marketing_lead: ["marketing"],
    chapter_director: ["marketing"],
  };

  test("no seat gained a power outside its own domains", () => {
    // The wildcard rule can widen WITHIN a domain a seat already had powers in
    // (that is its purpose — `finance.edit` reaching `finance.cards.edit`).
    // Reaching a domain the seat held nothing in would be a real escalation.
    for (const seatId of SEAT_IDS) {
      const legacy = LEGACY_BY_SEAT[seatId] ?? [];
      const allowedDomains = new Set([
        ...migrateLegacyPowers(legacy).map((p) => domainOf(p)),
        ...(POST_STANDARDIZATION_DOMAINS[seatId] ?? []),
      ]);
      for (const power of expandPowers(SEAT_DEFS[seatId].capabilities)) {
        expect(
          allowedDomains.has(domainOf(power)),
          `${seatId} gained ${power} in a new domain`,
        ).toBe(true);
      }
    }
  });

  test("seats store the MINIMAL set — no implied power is written down", () => {
    for (const seatId of SEAT_IDS) {
      const stored = SEAT_DEFS[seatId].capabilities;
      for (const power of stored) {
        const others = stored.filter((p) => p !== power);
        expect(
          expandPowers(others).has(power),
          `${seatId} stores ${power}, which ${others.join("/")} already implies`,
        ).toBe(false);
      }
    }
  });

  /**
   * THE WIDENING THE WILDCARD RULE INTRODUCES, pinned deliberately.
   *
   * `finance.edit` (the Treasurer's, from the old `finance.manager`) expands to
   * `finance.accounts.view`, which the Treasurer did not hold before. That is
   * safe ONLY because of scope: the Treasurer's seat is chapter-scoped and the
   * org's bank accounts live at central, so the grant never reaches them
   * (`lib/finance.ts#isCentralEdOrFm` reads `seatDerived["central"]`
   * specifically). If that scoping is ever weakened, this test is the tripwire
   * — it documents WHY the expansion is acceptable, not merely that it happens.
   */
  test("the Treasurer's finance.edit reaches accounts only in principle, and is chapter-scoped", () => {
    expect(SEAT_DEFS.treasurer.chart).toBe("chapter");
    expect(
      expandPowers(SEAT_DEFS.treasurer.capabilities).has("finance.accounts.view"),
    ).toBe(true);
    // The seats that reach central's accounts for real are central-chart ones.
    for (const seat of ["executive_director", "financial_manager"] as const) {
      expect(SEAT_DEFS[seat].chart).toBe("central");
      expect(
        expandPowers(SEAT_DEFS[seat].capabilities).has("finance.accounts.view"),
      ).toBe(true);
    }
  });
});

describe("scope says where the RESOURCE lives, not who may edit it", () => {
  /**
   * `marketing.designs.edit` is the case that made this distinction explicit.
   * It carried `scope: "central"` on the reasoning "one brand" — which is a
   * true statement about the RESOURCE and does not follow to a claim about the
   * editors. The declaration made a chapter-chart grant INERT: the org chart
   * would print it and the gate would never honor it, which is exactly the
   * dishonest rendering the field exists to prevent, pointed the other way.
   *
   * These four assertions are the tripwire for someone "restoring" it. If the
   * founder's decision is ever reversed, the fix is to remove the grant from
   * `chapter_director`, not to re-add `scope` here — the resource is still
   * global either way.
   */
  test("the brand kit is global but NOT scope-central, so a chapter seat can hold it", () => {
    expect(POWER_DEFS["marketing.designs.edit"].scope).toBeUndefined();
    expect(SEAT_DEFS.chapter_director.chart).toBe("chapter");
    expect(SEAT_DEFS.chapter_director.capabilities).toContain(
      "marketing.designs.edit",
    );
    // The point of the whole change: it survives the chapter-scope filter, so
    // the chart prints a power the holder can actually exercise.
    expect(
      powersAtScope(SEAT_DEFS.chapter_director.capabilities, "chapter"),
    ).toContain("marketing.designs.edit");
  });

  test("the ED holds the brand kit power too — the other half of the founder's ask", () => {
    expect(SEAT_DEFS.executive_director.capabilities).toContain(
      "marketing.designs.edit",
    );
    expect(
      grantsPower(
        SEAT_DEFS.executive_director.capabilities,
        "marketing.designs.edit",
      ),
    ).toBe(true);
  });

  test("the site and the blog did NOT move — only the brand kit did", () => {
    // The founder asked about the brand kit. publicworship.life is still the
    // ORG's one homepage and the blog is still the org's one blog, so those
    // three stay `scope: "central"` and stay invisible at a chapter scope.
    for (const power of [
      "marketing.site.edit",
      "marketing.blog.edit",
      "marketing.blog.publish",
    ] as const) {
      expect(POWER_DEFS[power].scope, power).toBe("central");
      expect(powersAtScope([power], "chapter"), power).not.toContain(power);
    }
  });
});

describe("areas are earned, not reserved", () => {
  test("every declared area has at least one power", () => {
    for (const domain of POWER_DOMAINS) {
      for (const area of POWER_AREAS[domain]) {
        const powers = POWERS.filter(
          (p) => POWER_DEFS[p].domain === domain && POWER_DEFS[p].area === area,
        );
        expect(powers.length, `${domain}.${area}`).toBeGreaterThan(0);
      }
    }
  });

  test("every declared domain has at least one power", () => {
    for (const domain of POWER_DOMAINS) {
      expect(
        POWERS.some((p) => POWER_DEFS[p].domain === domain),
        domain,
      ).toBe(true);
    }
  });

  /**
   * The bug this pins shipped into a review and was caught there, not by a
   * test: `marketing.blog.publish` was granted to the ED and the Marketing
   * Director ALONE (correct under minimal storage), while every comment around
   * it claimed it implied `marketing.blog.edit`. It did not — the ladder rule
   * grants `view` at a power's own prefix, never `edit` — so those two seats
   * could publish a post they were unable to save.
   *
   * The general rule the codebase relies on: a seat stores the MINIMAL set, so
   * a power that is meant to carry a weaker sibling MUST declare the edge. Any
   * `approve`/`publish` power whose domain also has an `edit` at the same
   * prefix is a candidate for that mistake, and this test is the reason the
   * next one fails loudly instead of reaching a Director's screen.
   */
  test("an approve/publish power implies its own area's edit, or says why not", () => {
    // `email.campaigns.approve` is the deliberate exception, and it is the
    // exception that makes the rule legible: approving a campaign is a CHECK
    // on somebody else's send, so the approver is a different person by
    // design — see its def and `campaigns.ts`'s state-machine doc.
    const DELIBERATELY_UNLINKED: readonly Power[] = ["email.campaigns.approve"];

    for (const power of POWERS) {
      const def = POWER_DEFS[power];
      if (def.action !== "approve" && def.action !== "publish") continue;
      if (DELIBERATELY_UNLINKED.includes(power)) continue;

      const prefix = def.area ? `${def.domain}.${def.area}` : def.domain;
      const sibling = `${prefix}.edit` as Power;
      if (!POWERS.includes(sibling)) continue; // no edit at this prefix

      expect(
        expandPowers([power]).has(sibling),
        `${power} does not grant ${sibling} — a seat holding only ${power} could ${def.action} something it cannot edit`,
      ).toBe(true);
    }
  });

  test("the vocabulary stays small — a growing list is the smell this replaced", () => {
    // Not a hard cap, a speed bump: if this trips, ask whether the new power
    // needed to exist or belonged inside an existing string. Raised to 22 on
    // 2026-08-28 for the Marketing desk's first three, and the question was
    // asked: site-vs-list had to split (a designer places cards, they don't
    // touch the roster) and view-vs-edit had to split (an associate reads the
    // list, a Director takes people off it). Export deliberately did NOT get a
    // fourth string — `data.export` already means that.
    //
    // Raised again to 25 the same day, when the desk grew a design library and
    // the blog. The question was asked three more times and the answers are
    // written on each def:
    //  - `designs.edit` has NO `designs.view` sibling, because reading the
    //    brand kit is deliberately ungated for the whole team.
    //  - `blog.edit` / `blog.publish` split because a post is published under
    //    the org's name and is quotable forever — the `ledger.publish` case,
    //    not the `site.edit` one.
    // Kept tight on purpose so the NEXT power trips this again.
    expect(POWERS.length).toBeLessThanOrEqual(25);
  });
});

describe("type guard", () => {
  test("isPower accepts every declared power and rejects legacy strings", () => {
    for (const power of POWERS) expect(isPower(power)).toBe(true);
    for (const legacy of ["finance.manager", "nav.giving", "org.editChart"]) {
      expect(isPower(legacy), legacy).toBe(false);
    }
  });

  test("grantsPower narrows through the guard without casting", () => {
    const stored: string[] = ["finance.edit"];
    expect(grantsPower(stored, "finance.view")).toBe(true);
    const asPower: Power = "finance.view";
    expect(grantsPower(stored, asPower)).toBe(true);
  });
});
