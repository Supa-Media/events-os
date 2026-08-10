/**
 * The mobile screen transcribes three things from the backend's rules lib —
 * the recipient cap, the two schedule defaults, and the address check — rather
 * than importing them into the app bundle (see `notificationRules.ts`'s module
 * doc for why). Transcriptions rot silently: nothing about raising
 * `MAX_RULE_RECIPIENTS` to 50 in `apps/convex` would fail a build, and the
 * screen would go on refusing the 21st address with a message the server no
 * longer agrees with.
 *
 * The bundle objection doesn't apply HERE — jest is a node environment, so the
 * backend module's module-scope `Intl.DateTimeFormat` costs nothing and its
 * `_generated/dataModel` import is type-only. So this file imports both sides
 * and asserts they still say the same thing. It is the only place in the mobile
 * app that reaches into `apps/convex`, and it does so to prove a duplication is
 * still honest.
 */
import { describe, expect, test } from "@jest/globals";
import {
  DEFAULT_SEND_HOUR_LOCAL as BACKEND_DEFAULT_HOUR,
  DEFAULT_SEND_WEEKDAY as BACKEND_DEFAULT_WEEKDAY,
  MAX_RULE_RECIPIENTS as BACKEND_MAX_RECIPIENTS,
  isLikelyEmail as backendIsLikelyEmail,
  normalizeRecipients as backendNormalizeRecipients,
} from "@events-os/convex/lib/givingNotificationRules";
import {
  DEFAULT_SEND_HOUR_LOCAL,
  DEFAULT_SEND_WEEKDAY,
  MAX_RULE_RECIPIENTS,
  addRecipients,
  isLikelyEmail,
} from "./notificationRules";

describe("the transcribed constants still match apps/convex", () => {
  test("the recipient cap", () => {
    expect(MAX_RULE_RECIPIENTS).toBe(BACKEND_MAX_RECIPIENTS);
  });

  test("the default send hour", () => {
    expect(DEFAULT_SEND_HOUR_LOCAL).toBe(BACKEND_DEFAULT_HOUR);
  });

  test("the default send weekday", () => {
    expect(DEFAULT_SEND_WEEKDAY).toBe(BACKEND_DEFAULT_WEEKDAY);
  });
});

describe("the address check agrees with the one that will actually judge it", () => {
  // Both the ordinary cases and every edge the backend's own tests care about.
  // A client that accepted what the server rejects is a round trip ending in a
  // ConvexError; a client that rejected what the server accepts is a user who
  // simply cannot enter their own colleague's address.
  const cases = [
    "shay@publicworship.life",
    "a.b+tag@sub.example.co.uk",
    "UPPER@Example.Org",
    "  padded@example.org  ",
    "",
    "   ",
    "shay",
    "shay@localhost",
    "shay@@example.org",
    "shay @example.org",
    "shay@example .org",
    "@example.org",
    "shay@",
    "shay@.org",
    "shay@example.",
    `${"a".repeat(250)}@example.org`,
    `${"a".repeat(240)}@example.org`,
  ];

  test.each(cases)("agrees about %p", (raw) => {
    expect(isLikelyEmail(raw)).toBe(backendIsLikelyEmail(raw));
  });
});

describe("what the chips show is what the server will store", () => {
  // `addRecipients` exists so the user sees the stored form immediately. If it
  // and `normalizeRecipients` ever disagree, the chips are a preview of
  // something else.
  const batches = [
    ["shay@x.org"],
    ["Shay@X.ORG"],
    ["shay@x.org", "SHAY@x.org"],
    ["shay@x.org", "aj@x.org", "  dev@x.org  "],
    ["shay@x.org", "", "   ", "aj@x.org"],
  ];

  test.each(batches)("normalizes %p the same way", (...raw: string[]) => {
    const mine = addRecipients([], raw.join(","));
    expect(mine.error).toBeNull();
    expect(mine.recipients).toEqual(backendNormalizeRecipients(raw).recipients);
  });

  test("a batch the client rejects is one the server would have rejected too", () => {
    const raw = ["shay@x.org", "notanemail"];
    expect(addRecipients([], raw.join(",")).error).toBeTruthy();
    expect(backendNormalizeRecipients(raw).invalid).toEqual(["notanemail"]);
  });
});
