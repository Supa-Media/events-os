import { describe, expect, test } from "@jest/globals";
import {
  CADENCE_OPTIONS,
  DEFAULT_SEND_HOUR_LOCAL,
  DEFAULT_SEND_WEEKDAY,
  HOUR_OPTIONS,
  MAX_RULE_RECIPIENTS,
  WEEKDAY_OPTIONS,
  addRecipients,
  buildSaveArgs,
  cadenceLabel,
  centsToDollarsInput,
  deliveryLabel,
  hourLabel,
  isLikelyEmail,
  lastEditedLabel,
  parseDollarsToCents,
  removeRecipient,
  ruleScopeChoices,
  scheduleSummary,
  thresholdLabel,
  weekdayLabel,
  type RuleDraft,
} from "./notificationRules";

describe("isLikelyEmail", () => {
  test("accepts an ordinary address", () => {
    expect(isLikelyEmail("shay@publicworship.life")).toBe(true);
    expect(isLikelyEmail("a.b+tag@sub.example.co.uk")).toBe(true);
  });

  test("rejects the typos this exists to catch", () => {
    expect(isLikelyEmail("")).toBe(false);
    expect(isLikelyEmail("shay")).toBe(false);
    expect(isLikelyEmail("shay@localhost")).toBe(false); // no dotted domain
    expect(isLikelyEmail("shay@@x.org")).toBe(false);
    expect(isLikelyEmail("shay @x.org")).toBe(false);
  });

  test("trims before judging", () => {
    expect(isLikelyEmail("  shay@x.org  ")).toBe(true);
  });

  test("rejects an address past the length bound", () => {
    expect(isLikelyEmail(`${"a".repeat(250)}@x.org`)).toBe(false);
  });
});

describe("addRecipients", () => {
  test("adds one address, lowercased", () => {
    const { recipients, error } = addRecipients([], "Shay@X.ORG");
    expect(recipients).toEqual(["shay@x.org"]);
    expect(error).toBeNull();
  });

  test("splits a pasted list on commas, semicolons, and whitespace", () => {
    const { recipients, error } = addRecipients(
      [],
      "shay@x.org, aj@x.org; dev@x.org\nops@x.org",
    );
    expect(recipients).toEqual([
      "shay@x.org",
      "aj@x.org",
      "dev@x.org",
      "ops@x.org",
    ]);
    expect(error).toBeNull();
  });

  test("a duplicate is dropped silently, not errored", () => {
    const { recipients, error } = addRecipients(["shay@x.org"], "SHAY@x.org");
    expect(recipients).toEqual(["shay@x.org"]);
    expect(error).toBeNull();
  });

  test("a bad address in the batch adds NOTHING and names it", () => {
    const { recipients, error } = addRecipients(
      ["shay@x.org"],
      "aj@x.org, notanemail",
    );
    expect(recipients).toEqual(["shay@x.org"]);
    expect(error).toContain("notanemail");
  });

  test("blank input is an error, not a silent no-op", () => {
    const { recipients, error } = addRecipients(["shay@x.org"], "   ");
    expect(recipients).toEqual(["shay@x.org"]);
    expect(error).toBe("Enter an email address.");
  });

  test("refuses to go past the cap, leaving the list untouched", () => {
    const full = Array.from(
      { length: MAX_RULE_RECIPIENTS },
      (_, i) => `p${i}@x.org`,
    );
    const { recipients, error } = addRecipients(full, "one.more@x.org");
    expect(recipients).toEqual(full);
    expect(error).toContain(String(MAX_RULE_RECIPIENTS));
  });

  test("the cap counts duplicates as no-ops, so re-adding at the cap is fine", () => {
    const full = Array.from(
      { length: MAX_RULE_RECIPIENTS },
      (_, i) => `p${i}@x.org`,
    );
    const { recipients, error } = addRecipients(full, "P0@X.ORG");
    expect(recipients).toEqual(full);
    expect(error).toBeNull();
  });

  test("does not mutate the list it was given", () => {
    const current = ["shay@x.org"];
    addRecipients(current, "aj@x.org");
    expect(current).toEqual(["shay@x.org"]);
  });
});

describe("removeRecipient", () => {
  test("removes case-insensitively", () => {
    expect(removeRecipient(["shay@x.org", "aj@x.org"], "SHAY@X.ORG")).toEqual([
      "aj@x.org",
    ]);
  });

  test("an address that isn't there is a no-op", () => {
    expect(removeRecipient(["shay@x.org"], "nobody@x.org")).toEqual([
      "shay@x.org",
    ]);
  });
});

describe("parseDollarsToCents", () => {
  test("blank means every gift — undefined, NOT zero", () => {
    expect(parseDollarsToCents("")).toEqual({ cents: undefined, error: null });
    expect(parseDollarsToCents("   ")).toEqual({
      cents: undefined,
      error: null,
    });
  });

  test("whole dollars become cents", () => {
    expect(parseDollarsToCents("500").cents).toBe(50000);
    expect(parseDollarsToCents("1").cents).toBe(100);
  });

  test("an explicit zero is a real floor of zero, not blank", () => {
    expect(parseDollarsToCents("0").cents).toBe(0);
  });

  test("cents survive the round trip", () => {
    expect(parseDollarsToCents("12.34").cents).toBe(1234);
    expect(parseDollarsToCents("0.05").cents).toBe(5);
  });

  test("floating point can't leak a fractional cent", () => {
    expect(parseDollarsToCents("1.005").cents).toBe(101);
    expect(parseDollarsToCents("19.99").cents).toBe(1999);
    expect(Number.isInteger(parseDollarsToCents("1234.56").cents)).toBe(true);
  });

  test("tolerates how people type money", () => {
    expect(parseDollarsToCents("$500").cents).toBe(50000);
    expect(parseDollarsToCents("$1,250.50").cents).toBe(125050);
    expect(parseDollarsToCents("  250  ").cents).toBe(25000);
  });

  test("rejects a negative threshold", () => {
    expect(parseDollarsToCents("-50").error).toBeTruthy();
    expect(parseDollarsToCents("-50").cents).toBeUndefined();
  });

  test("accepts a decimal point at either end — a decimal-pad produces both", () => {
    expect(parseDollarsToCents(".50").cents).toBe(50);
    expect(parseDollarsToCents(".5").cents).toBe(50);
    expect(parseDollarsToCents("$.99").cents).toBe(99);
    expect(parseDollarsToCents("1.").cents).toBe(100);
    expect(parseDollarsToCents("500.").cents).toBe(50000);
  });

  test("rejects text and stray punctuation", () => {
    expect(parseDollarsToCents("a lot").error).toBeTruthy();
    // A bare point is still not a number, however lenient the ends are.
    expect(parseDollarsToCents(".").error).toBeTruthy();
    expect(parseDollarsToCents("..").error).toBeTruthy();
    expect(parseDollarsToCents("1.2.3").error).toBeTruthy();
    expect(parseDollarsToCents("500$").error).toBeTruthy();
  });

  test("refuses an amount too large to be an exact integer of cents", () => {
    expect(parseDollarsToCents("999999999999999999").error).toBeTruthy();
  });

  test("every accepted amount is a whole number of cents", () => {
    for (const raw of ["0", "0.01", "7", "7.5", "7.55", "7.555", "1,000"]) {
      const { cents } = parseDollarsToCents(raw);
      expect(Number.isSafeInteger(cents)).toBe(true);
    }
  });
});

describe("the Select option sets", () => {
  test("every hour of the day is offered, keyed by its stored number", () => {
    expect(HOUR_OPTIONS).toHaveLength(24);
    expect(HOUR_OPTIONS[0]).toEqual({ value: "0", label: "12:00 AM" });
    expect(HOUR_OPTIONS[23]).toEqual({ value: "23", label: "11:00 PM" });
    // The Select round-trips strings; the mutation takes numbers.
    expect(Number(HOUR_OPTIONS[8].value)).toBe(8);
  });

  test("every weekday is offered, 0 = Sunday like the backend", () => {
    expect(WEEKDAY_OPTIONS).toHaveLength(7);
    expect(WEEKDAY_OPTIONS[0]).toEqual({ value: "0", label: "Sunday" });
    expect(WEEKDAY_OPTIONS[6]).toEqual({ value: "6", label: "Saturday" });
  });

  test("the cadence options cover the union, immediate first", () => {
    expect(CADENCE_OPTIONS.map((o) => o.value)).toEqual([
      "immediate",
      "daily",
      "weekly",
    ]);
  });
});

describe("ruleScopeChoices — which books the picker offers", () => {
  /** What `givingScopeOptions` returns for a CENTRAL viewer: Central plus every
   *  active chapter. `canManage` is the GIFT power and is set false here on
   *  purpose — a viewer who can't record a gift can still work a rule. */
  const centralViewer = {
    canSeeAllScopes: true,
    options: [
      { scope: "central", label: "Central", canManage: false },
      { scope: "chap_ny", label: "New York", canManage: false },
      { scope: "chap_la", label: "Los Angeles", canManage: false },
    ],
  };

  /** A chapter-scope `giving.view` seat — one book, no central reach. */
  const chapterViewer = {
    canSeeAllScopes: false,
    options: [{ scope: "chap_ny", label: "New York", canManage: false }],
  };

  test("undefined (still loading) offers nothing", () => {
    expect(ruleScopeChoices(undefined)).toEqual([]);
  });

  test("a central viewer gets All books, Central, and every chapter", () => {
    expect(ruleScopeChoices(centralViewer)).toEqual([
      { value: "all", label: "All books" },
      { value: "central", label: "Central" },
      { value: "chap_ny", label: "New York" },
      { value: "chap_la", label: "Los Angeles" },
    ]);
  });

  test("'All books' leads, so the org-wide choice is the first one seen", () => {
    expect(ruleScopeChoices(centralViewer)[0].value).toBe("all");
  });

  test("a chapter viewer is offered their own book and NOTHING else", () => {
    // The containment property, at the affordance: no "All books", no Central,
    // no sibling chapter. The server refuses all three as well — this is only
    // what stops the screen from asking for something it will be told off for.
    expect(ruleScopeChoices(chapterViewer)).toEqual([
      { value: "chap_ny", label: "New York" },
    ]);
  });

  test("a chapter viewer can still create — this is the whole change", () => {
    // Under the old manage gate this list was EMPTY for every chapter seat (no
    // chapter seat carries `giving.manage`), so "New rule" never rendered for
    // anyone but central. The screen keys `canCreate` off exactly this.
    expect(ruleScopeChoices(chapterViewer).length).toBeGreaterThan(0);
  });

  test("`canManage` is never consulted — a gift power is not a rule power", () => {
    const manageable = {
      ...chapterViewer,
      options: chapterViewer.options.map((o) => ({ ...o, canManage: true })),
    };
    expect(ruleScopeChoices(manageable)).toEqual(ruleScopeChoices(chapterViewer));
  });

  test("no books in reach means no picker, and so no create button", () => {
    expect(ruleScopeChoices({ canSeeAllScopes: false, options: [] })).toEqual([]);
  });
});

describe("centsToDollarsInput", () => {
  test("an absent floor is an empty field, never \"0\"", () => {
    expect(centsToDollarsInput(undefined)).toBe("");
  });

  test("round dollars lose the trailing zeros", () => {
    expect(centsToDollarsInput(50000)).toBe("500");
    expect(centsToDollarsInput(0)).toBe("0");
  });

  test("part-dollars keep both places", () => {
    expect(centsToDollarsInput(1234)).toBe("12.34");
    expect(centsToDollarsInput(5)).toBe("0.05");
  });

  test("round-trips through parseDollarsToCents", () => {
    for (const cents of [0, 5, 100, 1234, 50000, 125050]) {
      expect(parseDollarsToCents(centsToDollarsInput(cents)).cents).toBe(cents);
    }
  });
});

describe("thresholdLabel", () => {
  test("no floor reads as every gift", () => {
    expect(thresholdLabel(undefined)).toBe("Every gift");
  });

  test("an explicit zero also reads as every gift, not $0.00 and up", () => {
    expect(thresholdLabel(0)).toBe("Every gift");
  });

  test("a floor names the amount", () => {
    expect(thresholdLabel(50000)).toBe("$500.00 and up");
    expect(thresholdLabel(1234)).toBe("$12.34 and up");
  });
});

describe("cadenceLabel", () => {
  test("each cadence has a short badge label", () => {
    expect(cadenceLabel("immediate")).toBe("Immediate");
    expect(cadenceLabel("daily")).toBe("Daily");
    expect(cadenceLabel("weekly")).toBe("Weekly");
  });
});

describe("hourLabel", () => {
  test("midnight and noon are the twelves", () => {
    expect(hourLabel(0)).toBe("12:00 AM");
    expect(hourLabel(12)).toBe("12:00 PM");
  });

  test("morning and afternoon hours", () => {
    expect(hourLabel(8)).toBe("8:00 AM");
    expect(hourLabel(13)).toBe("1:00 PM");
    expect(hourLabel(23)).toBe("11:00 PM");
  });
});

describe("weekdayLabel", () => {
  test("0 is Sunday through 6 is Saturday", () => {
    expect(weekdayLabel(0)).toBe("Sunday");
    expect(weekdayLabel(6)).toBe("Saturday");
  });

  test("absent falls back to the backend's default weekday", () => {
    expect(weekdayLabel(undefined)).toBe("Monday");
    expect(weekdayLabel(undefined)).toBe(weekdayLabel(DEFAULT_SEND_WEEKDAY));
  });

  test("out of range falls back rather than rendering undefined", () => {
    expect(weekdayLabel(9)).toBe("Monday");
  });
});

describe("scheduleSummary", () => {
  test("immediate says what it does", () => {
    expect(scheduleSummary({ cadence: "immediate" })).toBe(
      "As each gift arrives",
    );
  });

  test("immediate ignores any stored send time", () => {
    expect(
      scheduleSummary({ cadence: "immediate", sendHourLocal: 17, sendWeekday: 3 }),
    ).toBe("As each gift arrives");
  });

  test("daily names the hour, in ET", () => {
    expect(scheduleSummary({ cadence: "daily", sendHourLocal: 8 })).toBe(
      "Every day at 8:00 AM ET",
    );
  });

  test("weekly names the day and the hour", () => {
    expect(
      scheduleSummary({ cadence: "weekly", sendHourLocal: 17, sendWeekday: 5 }),
    ).toBe("Every Friday at 5:00 PM ET");
  });

  test("a rule with no stored send time reads as the backend's defaults", () => {
    expect(scheduleSummary({ cadence: "weekly" })).toBe(
      `Every ${weekdayLabel(DEFAULT_SEND_WEEKDAY)} at ${hourLabel(DEFAULT_SEND_HOUR_LOCAL)} ET`,
    );
    expect(scheduleSummary({ cadence: "daily" })).toBe("Every day at 8:00 AM ET");
  });
});

describe("deliveryLabel", () => {
  const fmt = (ts: number) => `#${ts}`;

  test("a brand-new rule has nothing to report, and says so", () => {
    expect(deliveryLabel({}, fmt)).toBe("Hasn't sent yet");
  });

  test("a delivered email is what 'last sent' means", () => {
    expect(deliveryLabel({ lastDeliveredAt: 1700 }, fmt)).toBe(
      "Last sent #1700",
    );
  });

  test("a WATERMARK is never reported as a send", () => {
    // The pause/resume bug: `setRuleActive` stamps `lastSentAt` so a resumed
    // rule doesn't replay its dormancy. A rule that has mailed nobody must not
    // claim it has.
    const label = deliveryLabel({ lastSentAt: 1700 }, fmt);
    expect(label).not.toContain("Last sent");
    expect(label).toBe("Nothing sent yet — watching from #1700");
  });

  test("once something is delivered, the watermark stops being the story", () => {
    expect(deliveryLabel({ lastDeliveredAt: 1800, lastSentAt: 1700 }, fmt)).toBe(
      "Last sent #1800",
    );
  });
});

describe("lastEditedLabel", () => {
  const at = (ts: number) => `day ${ts}`;

  test("names the last editor, not the author", () => {
    expect(
      lastEditedLabel({ updatedByName: "Shay", updatedAt: 7 }, at),
    ).toBe("Edited by Shay · day 7");
  });

  test("a rule from before the field existed shows no line at all", () => {
    // Deliberately null rather than falling back to the creator — claiming the
    // author was the last toucher is the exact misattribution this closes.
    expect(lastEditedLabel({ updatedByName: null, updatedAt: 7 }, at)).toBeNull();
  });
});

describe("buildSaveArgs", () => {
  const base: RuleDraft = {
    name: "Big gifts to Shay + AJ",
    recipients: ["shay@x.org", "aj@x.org"],
    cadence: "immediate",
    minAmount: "500",
    scope: "central",
    sendHour: "8",
    sendWeekday: "1",
  };

  test("an immediate rule sends no schedule fields at all", () => {
    const { args, error } = buildSaveArgs(base);
    expect(error).toBeNull();
    expect(args).toEqual({
      name: "Big gifts to Shay + AJ",
      recipients: ["shay@x.org", "aj@x.org"],
      cadence: "immediate",
      minAmountCents: 50000,
      scope: "central",
    });
    expect(args && "sendHourLocal" in args).toBe(false);
    expect(args && "sendWeekday" in args).toBe(false);
  });

  test("a daily rule carries the hour but not a weekday", () => {
    const { args } = buildSaveArgs({
      ...base,
      cadence: "daily",
      sendHour: "17",
    });
    expect(args?.sendHourLocal).toBe(17);
    expect(args && "sendWeekday" in args).toBe(false);
  });

  test("a weekly rule carries both, as numbers", () => {
    const { args } = buildSaveArgs({
      ...base,
      cadence: "weekly",
      sendHour: "6",
      sendWeekday: "0",
    });
    expect(args?.sendHourLocal).toBe(6);
    expect(args?.sendWeekday).toBe(0);
  });

  test("a blank threshold means every gift — minAmountCents is undefined", () => {
    const { args } = buildSaveArgs({ ...base, minAmount: "" });
    expect(args?.minAmountCents).toBeUndefined();
  });

  test("the name is trimmed", () => {
    const { args } = buildSaveArgs({ ...base, name: "  Dev team  " });
    expect(args?.name).toBe("Dev team");
  });

  test("a whitespace-only name is refused", () => {
    const { args, error } = buildSaveArgs({ ...base, name: "   " });
    expect(args).toBeNull();
    expect(error).toBe("A rule needs a name.");
  });

  test("no recipients is refused", () => {
    const { args, error } = buildSaveArgs({ ...base, recipients: [] });
    expect(args).toBeNull();
    expect(error).toContain("at least one email address");
  });

  test("past the recipient cap is refused", () => {
    const { args, error } = buildSaveArgs({
      ...base,
      recipients: Array.from(
        { length: MAX_RULE_RECIPIENTS + 1 },
        (_, i) => `p${i}@x.org`,
      ),
    });
    expect(args).toBeNull();
    expect(error).toContain(String(MAX_RULE_RECIPIENTS));
  });

  test("no book chosen is refused", () => {
    const { args, error } = buildSaveArgs({ ...base, scope: null });
    expect(args).toBeNull();
    expect(error).toBe("Choose which book this rule watches.");
  });

  test("a bad threshold surfaces the amount error", () => {
    const { args, error } = buildSaveArgs({ ...base, minAmount: "lots" });
    expect(args).toBeNull();
    expect(error).toContain("dollar amount");
  });

  test("the recipient array is copied, not aliased to the draft's", () => {
    const recipients = ["shay@x.org"];
    const { args } = buildSaveArgs({ ...base, recipients });
    expect(args?.recipients).toEqual(recipients);
    expect(args?.recipients).not.toBe(recipients);
  });

  test("money crosses the boundary in integer cents", () => {
    expect(buildSaveArgs({ ...base, minAmount: "$1,000.50" }).args?.minAmountCents).toBe(
      100050,
    );
  });
});
