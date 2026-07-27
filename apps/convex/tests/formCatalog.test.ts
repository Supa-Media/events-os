import { describe, expect, test } from "vitest";
import {
  findFormByKey,
  parseCsvText,
  parseFormCsv,
  parseGoogleFormsTimestamp,
  splitMultiselectWithOther,
  KNOWN_TEAM_INTEREST_OPTIONS,
  resolveTeamInterestServiceIds,
  isMarketingOptOut,
} from "../lib/formCatalog";
import type { Id } from "../_generated/dataModel";

/**
 * `lib/formCatalog.ts` — pure parsing/normalization for the PW Forms import.
 * No Convex runtime dependency, so these run as plain vitest (no
 * `convex-test`/edge-runtime harness needed).
 */

describe("parseCsvText", () => {
  test("handles quoted fields with embedded commas, quotes, and newlines", () => {
    const csv = 'a,b,c\n"hello, world","she said ""hi""","line1\nline2"\n';
    const rows = parseCsvText(csv);
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["hello, world", 'she said "hi"', "line1\nline2"],
    ]);
  });

  test("drops a trailing wholly-blank line", () => {
    const rows = parseCsvText("a,b\n1,2\n");
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("trailing-space headers", () => {
  test("a form's header definition matches an export header with a trailing space", () => {
    const form = findFormByKey("crossover_vocals")!;
    // Real export headers carry trailing spaces ("Full Name ", "email ") —
    // the catalog's own header strings don't need to, since both sides are
    // normalized (trimmed) before comparison.
    const csv =
      "Timestamp,Full Name ,phone number ,email ,Voice Part,Are you available for rehearsal Wednesday December 17th @ 6:00 pm ,Do you have experience singing background vocals,Years of Experience,Are you familiar with African Praise and Worship,Please upload a short singing clip. (30 secs- 1 minutes) ,\"Please provide a short singing clip (30 seconds–1 minute) and a public video link (e.g., YouTube, Instagram, Dropbox). Make sure the link is viewable without login.\"\n" +
      "9/20/2025 10:04:58,Jane Doe,3473836748,jane@example.com,Alto,Yes,Yes,4,Yes,,\n";
    const rows = parseFormCsv(form, csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Jane Doe");
    expect(rows[0].email).toBe("jane@example.com");
    expect(rows[0].phone).toBe("3473836748");
    expect(rows[0].answers.voice_part).toBe("Alto");
  });
});

describe("splitMultiselectWithOther", () => {
  test("matches known options and files the rest as one _other remainder", () => {
    const known = ["Event Coordinator", "Photography", "Greeter"];
    const raw =
      "Event Coordinator, Photography, Setup and breakdown of any equipment, if you need someone to do followup calls";
    const { matched, other } = splitMultiselectWithOther(raw, known);
    expect(matched).toEqual(["Event Coordinator", "Photography"]);
    expect(other).toBe(
      "Setup and breakdown of any equipment, if you need someone to do followup calls",
    );
  });

  test("no leftover free text → other is undefined", () => {
    const { matched, other } = splitMultiselectWithOther("Greeter, Photography", [
      "Greeter",
      "Photography",
    ]);
    expect(matched).toEqual(["Greeter", "Photography"]);
    expect(other).toBeUndefined();
  });

  test("case-insensitive match against the known option list", () => {
    const { matched } = splitMultiselectWithOther("greeter", ["Greeter"]);
    expect(matched).toEqual(["Greeter"]);
  });

  test("Team Interest catalog: a real multi-value + free-text-with-commas row splits correctly", () => {
    const raw =
      "Event Coordinator, In person Evangelism and Prayer, Hi. Good afternoon.   I saw a post of your recent event, immediately I thought this would be a great opportunity";
    const { matched, other } = splitMultiselectWithOther(raw, KNOWN_TEAM_INTEREST_OPTIONS);
    expect(matched).toEqual(["Event Coordinator", "In person Evangelism and Prayer"]);
    expect(other).toContain("Hi. Good afternoon.");
  });
});

describe("Pop The Balloon column merge", () => {
  test("merges the exact-duplicate 'available to meet' columns and the near-duplicate Givebutter/GiveButter columns", () => {
    const form = findFormByKey("pop_the_balloon")!;
    const header = [
      "Timestamp",
      "What's your name (first and last)?",
      "Email address?",
      "Age?",
      "What is your preferred age range when dating?",
      "are you a fruit-bearing, Jesus loving, God-fearing, bible believing, spirit filled individual?",
      "Occupation?",
      "Do you live in NYC or surrounding areas permanently? ",
      "How would you describe your single season?",
      "Which church do you attend?",
      "Do you want to be the main person facing the panel or in the panel holding a balloon?",
      "Do you have any kids?",
      "Would you be open to someone with children?",
      "Instagram username / recent photo link (please link a recent photo of yourself if your page is private or you don't have social media)",
      "Gender? (Only accepting male applicants)",
      "Please select when you'd be available to meet!",
      "Have you gotten your ticket or RSVP’d on Partiful or Givebutter?",
      "Please select when you'd be available to meet!",
      "Have you gotten your ticket or RSVP’d on Partiful or GiveButter?",
    ];
    // Row answers only the SECOND branch (Givebutter column blank, GiveButter
    // column filled) — exactly the real export's pattern.
    const row = [
      "11/27/2025 2:22:31",
      "Jane Roe",
      "jane@example.com",
      "23",
      "24-27",
      "Yes!",
      "Marketing",
      "yes",
      "single",
      "Church Alive",
      "either one",
      "No",
      "No",
      "janeroe",
      "female",
      "",
      "",
      "tuesday, december 2nd at 8:00pm",
      "Yes",
    ];
    // Cells with embedded commas (a header like the "fruit-bearing, Jesus
    // loving, …" one, or a value like "tuesday, december 2nd…") MUST be
    // CSV-quoted before joining, or a naive `.join(",")` shifts every later
    // column — exactly the bug this parser has to handle on the real export.
    const csvField = (v: string) => (v.includes(",") || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v);
    const csv =
      [header.map(csvField).join(","), row.map(csvField).join(",")].join("\n") + "\n";
    const rows = parseFormCsv(form, csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].answers.availability).toBe("tuesday, december 2nd at 8:00pm");
    expect(rows[0].answers.rsvp_confirmed).toBe("Yes");
  });
});

describe("parseGoogleFormsTimestamp", () => {
  test("parses an EST (winter) timestamp", () => {
    const ms = parseGoogleFormsTimestamp("1/15/2026 10:00:00");
    const iso = new Date(ms).toISOString();
    expect(iso).toBe("2026-01-15T15:00:00.000Z"); // UTC-5
  });

  test("parses an EDT (summer) timestamp", () => {
    const ms = parseGoogleFormsTimestamp("7/15/2025 10:00:00");
    const iso = new Date(ms).toISOString();
    expect(iso).toBe("2025-07-15T14:00:00.000Z"); // UTC-4
  });
});

describe("isMarketingOptOut", () => {
  test("only an exact 'No' opts out", () => {
    expect(isMarketingOptOut({ consent: "No" })).toBe(true);
    expect(isMarketingOptOut({ consent: "Yes" })).toBe(false);
    expect(isMarketingOptOut({ consent: undefined })).toBe(false);
    expect(isMarketingOptOut({})).toBe(false);
  });
});

describe("resolveTeamInterestServiceIds", () => {
  test("maps a matched option to its canonical label(s), including a 1-to-2 mapping", () => {
    const labelToId = new Map<string, Id<"serviceOptions">>([
      ["event coordination", "svc_event_coord" as Id<"serviceOptions">],
      ["evangelism", "svc_evangelism" as Id<"serviceOptions">],
      ["prayer & intercession", "svc_prayer" as Id<"serviceOptions">],
    ]);
    const { serviceIds, unmapped } = resolveTeamInterestServiceIds(labelToId, [
      "Event Coordinator",
      "In person Evangelism and Prayer",
      "Miscellaneous", // known option, but no promotion mapping given
    ]);
    expect(serviceIds.sort()).toEqual(
      ["svc_event_coord", "svc_evangelism", "svc_prayer"].sort(),
    );
    expect(unmapped).toEqual(["Miscellaneous"]);
  });
});
