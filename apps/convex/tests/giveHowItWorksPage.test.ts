import { describe, expect, test } from "vitest";
import {
  giveHowItWorksPath,
  GIVE_HOW_IT_WORKS_SLUG,
  renderGiveHowItWorksPage,
} from "../lib/giveHowItWorksPage";
import { ledgerPath } from "../lib/publicLedgerPage";
import { givePagePath } from "../lib/siteUrl";
import {
  BACKER_UNIT_CENTS,
  CENTRAL_SKIM_PCT,
  CHAPTER_CORE_ROLES,
  formatCents,
  LAUNCH_BUDGET_TEMPLATE,
  LAUNCH_EQUIPMENT_LINES,
  LAUNCH_TRAINING_TRIP_LINES,
  launchTemplateTotalCents,
  MONTHLY_OPERATING_LINES,
  PUBLIC_BACKER_TIERS,
} from "@events-os/shared";

/**
 * Render tests for `/give/how-it-works` — the money model, moved off both give
 * pages by docs/plans/give-redesign-v3.md (decision D5).
 *
 * TWO KINDS OF ASSERTION LIVE HERE, and the split is deliberate.
 *
 * 1. FIGURES ARE DERIVED, NEVER LITERAL. Every expected dollar amount below is
 *    computed from the same `packages/shared/src/finance.ts` constants the page
 *    renders from. Asserting `"$670"` would only prove that two hardcoded
 *    strings match each other; asserting `formatCents(sum(MONTHLY_OPERATING_LINES))`
 *    proves the page is single-sourced — if somebody adds an operating line and
 *    the page still says $670, this test fails, which is the whole point.
 *
 * 2. D3 IS ASSERTED AS AN ABSENCE. The founder cut the "nobody draws a salary"
 *    claim on purpose: it is not a flex, and it becomes false the day it
 *    changes — on a page that, unlike `/give/<slug>`, is indexed. A content
 *    regression here would be invisible to every other test in the repo, so the
 *    regex below is the only thing standing between a well-meaning copy edit
 *    and a false public claim. Note it cannot simply ban the word "volunteer":
 *    `MONTHLY_OPERATING_LINES` legitimately contains "Food — team, musicians &
 *    volunteers", so the pattern targets COMPENSATION claims specifically.
 */

const SITE = "https://publicworship.life";

/** Sum any list of money lines — mirrors the page's own totalling so the
 *  expectations move whenever the constants do. */
function sum(lines: readonly { amountCents: number }[]): number {
  return lines.reduce((total, l) => total + l.amountCents, 0);
}

function money(cents: number): string {
  return formatCents(cents, { showCents: false });
}

const html = renderGiveHowItWorksPage(SITE);

describe("renderGiveHowItWorksPage", () => {
  test("renders a complete, indexable HTML page", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
    expect(html).toContain("<title>");
    expect(html).toContain("Where the money goes");
    // Unlike `/give/<slug>` this page publishes no donor, so it must be
    // indexable (spec §Page composition — the page exists to be found).
    expect(html).not.toContain('name="robots"');
    expect(html).toContain(`<meta property="og:url" content="${SITE}/give/how-it-works">`);
  });

  test("path helpers agree with the give tree", () => {
    expect(GIVE_HOW_IT_WORKS_SLUG).toBe("how-it-works");
    expect(giveHowItWorksPath()).toBe("/give/how-it-works");
    expect(giveHowItWorksPath()).toBe(givePagePath(GIVE_HOW_IT_WORKS_SLUG));
  });

  test("shows the monthly operating floor, itemised and totalled", () => {
    const total = sum(MONTHLY_OPERATING_LINES);
    expect(html).toContain(`${money(total)}/mo`);
    for (const line of MONTHLY_OPERATING_LINES) {
      // `&` in a label must arrive escaped — house rule, and the reason
      // `esc()` wraps every interpolated value in the renderer.
      expect(html).toContain(line.label.replace(/&/g, "&amp;"));
      expect(html).toContain(money(line.amountCents));
    }
    // The label that actually carries an ampersand, escaped.
    expect(html).toContain("Software &amp; subscriptions");
  });

  test("shows the backer ladder with 20 framed as the floor", () => {
    expect(html).toContain(money(BACKER_UNIT_CENTS));
    for (const tier of PUBLIC_BACKER_TIERS) {
      expect(html).toContain(`${tier.minBackers} backers — ${money(tier.monthlyCents)}/mo`);
      expect(html).toContain(tier.commitment);
    }
    const floor = PUBLIC_BACKER_TIERS[0];
    expect(html).toContain(
      `${floor.minBackers} backers at ${money(BACKER_UNIT_CENTS)}/mo`,
    );
    expect(html).toMatch(/floor/i);
    // Each rung above the floor is described by its step up from the rung
    // below, computed — not restated.
    for (let i = 1; i < PUBLIC_BACKER_TIERS.length; i++) {
      const step =
        PUBLIC_BACKER_TIERS[i].monthlyCents - PUBLIC_BACKER_TIERS[i - 1].monthlyCents;
      expect(html).toContain(`${money(step)}/mo more`);
    }
  });

  test("shows the ~$8,000 launch budget and what it buys", () => {
    const budgetTotal = launchTemplateTotalCents();
    const equipmentTotal = sum(LAUNCH_EQUIPMENT_LINES);
    const trainingTotal = sum(LAUNCH_TRAINING_TRIP_LINES);

    expect(html).toContain(money(budgetTotal));
    for (const line of LAUNCH_BUDGET_TEMPLATE) {
      expect(html).toContain(line.label.replace(/&/g, "&amp;"));
    }
    expect(html).toContain(money(equipmentTotal));
    expect(html).toContain(money(trainingTotal));
    expect(html).toContain(money(equipmentTotal + trainingTotal));
    for (const line of [...LAUNCH_EQUIPMENT_LINES, ...LAUNCH_TRAINING_TRIP_LINES]) {
      expect(html).toContain(line.label.replace(/&/g, "&amp;"));
    }
    // Equipment + trip is an ESTIMATE under a rounder budgeted grant; the page
    // must show both rather than silently presenting one as the other.
    expect(equipmentTotal + trainingTotal).not.toBe(budgetTotal);
  });

  test("shows the 85/15 split in percent and in dollars", () => {
    const localPct = Math.round((1 - CENTRAL_SKIM_PCT) * 100);
    const skimPct = Math.round(CENTRAL_SKIM_PCT * 100);
    const floor = PUBLIC_BACKER_TIERS[0];
    const skimCents = Math.round(floor.monthlyCents * CENTRAL_SKIM_PCT);
    const localCents = floor.monthlyCents - skimCents;

    expect(html).toContain(`${localPct}%`);
    expect(html).toContain(`${skimPct}%`);
    expect(html).toContain(`${money(localCents)}/mo`);
    expect(html).toContain(`${money(skimCents)}/mo`);
    expect(html).toContain("City Launch Fund");
  });

  test("lists all five core roles and what each owns", () => {
    expect(CHAPTER_CORE_ROLES.length).toBe(5);
    for (const role of CHAPTER_CORE_ROLES) {
      expect(html).toContain(role.role);
      expect(html).toContain(role.owns.replace(/&/g, "&amp;"));
    }
  });

  test("keeps the relocated team-philosophy copy", () => {
    // Static copy, so it carries a literal apostrophe — `esc()` is applied to
    // interpolated values, never to hand-written template text.
    expect(html).toContain("Who we're looking for");
    expect(html).toContain("sacrificial giving");
    expect(html).toContain("one-year term");
  });

  test("is a loop: links to the books AND back to /give", () => {
    expect(html).toContain(`href="${ledgerPath()}"`);
    expect(html).toContain('href="/finances"');
    expect(html).toContain(`href="${givePagePath()}"`);
    expect(html).toContain('href="/give"');
    // The books' promise, in the page's own words.
    expect(html).toMatch(/every transaction/i);
    expect(html).toMatch(/receipt/i);
  });

  test("makes no compensation claim anywhere (spec D3)", () => {
    expect(html).not.toMatch(/salary|salaries/i);
    expect(html).not.toMatch(/nobody is paid|no one is paid|nobody draws/i);
    expect(html).not.toMatch(/all volunteers|everyone is a volunteer/i);
    expect(html).not.toMatch(/volunteer (core )?team/i);
    expect(html).not.toMatch(/\bunpaid\b/i);
  });
});
