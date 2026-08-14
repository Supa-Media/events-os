/**
 * D3's ban, in ONE place — because it used to live in two and they disagreed.
 *
 * `docs/plans/give-redesign-v3.md` D3: **no "nobody draws a salary" claim
 * anywhere**. It is not a flex, and it becomes false the day one person is
 * paid — on pages that are now indexed.
 *
 * WHAT IS BANNED IS THE COMPENSATION CLAIM, not the word "volunteer". Saying
 * "the volunteer team that puts worship on a neighborhood corner" describes WHO
 * DOES THE WORK; saying "nobody draws a salary" makes a promise about the
 * org's payroll. Only the second one goes false when someone is hired, and only
 * the second one is what the founder cut.
 *
 * The pages depend on being able to say the first thing:
 * `givePage.ts` uses "the volunteer team" in the hero subhead, in the
 * `og:description`, and in the city progress card, and `MONTHLY_OPERATING_LINES`
 * carries a "Food — team, musicians & volunteers" line that every money surface
 * renders verbatim. `/finances` is separately about to publish compensation BY
 * POSITION, which is what makes describing the team as volunteer a checkable
 * statement rather than a hidden claim: the numbers are on the page next to it.
 *
 * `giveHowItWorksPage.test.ts` used to add `/volunteer (core )?team/i` to its
 * own copy of this ban while `givePageRender.test.ts` explicitly whitelisted
 * the same phrase, so the repo enforced two opposite rules and whichever page
 * a future editor happened to be looking at decided which one they inherited.
 * Both files now import THIS constant. If D3 ever needs to widen, it widens
 * here, once, for every give surface.
 */
export const COMPENSATION_CLAIM =
  /salary|salaries|nobody draws|nobody is paid|no one is paid|everyone is a volunteer|all volunteers|\bunpaid\b/i;
