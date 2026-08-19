import { describe, expect, test } from "vitest";
import {
  MAILCHIMP_BATCH_SIZE,
  MAILCHIMP_CUSTOM_MERGE_FIELDS,
  MAILCHIMP_SUPPRESSION_EVENTS,
  buildMailchimpMember,
  buildMailchimpUnsubscribe,
  chunk,
  deriveMailchimpServerPrefix,
  mailchimpApiBase,
  normalizeMailchimpEmail,
  splitName,
} from "./mailchimp";

/**
 * The pure half of the Mailchimp audience sync.
 *
 * These tests exist because each of these functions guards a failure that is
 * INVISIBLE until it has already happened to real people: a payload that omits
 * a merge field leaves a stale value in Mailchimp forever, a batch over 500 is
 * rejected wholesale, and a webhook map that accepted `subscribe` would
 * silently resurrect suppressed addresses.
 */

describe("deriveMailchimpServerPrefix", () => {
  // Fixtures are deliberately NOT shaped like real keys (a real one is 32 hex
  // characters before the dash) — GitHub's push protection rejects a commit
  // containing anything that looks like a live Mailchimp credential, and it is
  // right to. Only the suffix matters to this function.
  test.each([
    ["placeholder-not-a-key-us21", "us21"],
    ["placeholder-not-a-key-us6", "us6"],
    ["placeholder-not-a-key-eu1", "eu1"],
  ])("reads the datacenter off %s", (key, expected) => {
    expect(deriveMailchimpServerPrefix(key)).toBe(expected);
  });

  test("trims surrounding whitespace from a pasted key", () => {
    expect(deriveMailchimpServerPrefix("  key-us21  ")).toBe("us21");
  });

  test.each([
    ["a key with no suffix at all", "nodashhere"],
    ["a trailing dash and nothing after it", "key-"],
    ["a suffix that isn't a datacenter", "key-notadc"],
    ["an empty string", ""],
  ])("rejects %s", (_label, key) => {
    expect(deriveMailchimpServerPrefix(key)).toBeNull();
  });

  test("the derived prefix builds the API host", () => {
    const prefix = deriveMailchimpServerPrefix("key-us21");
    expect(mailchimpApiBase(prefix!)).toBe("https://us21.api.mailchimp.com/3.0");
  });
});

describe("normalizeMailchimpEmail", () => {
  test("lowercases and trims, matching the suppression ledger's key", () => {
    expect(normalizeMailchimpEmail("  Someone@Example.COM ")).toBe(
      "someone@example.com",
    );
  });
});

describe("splitName", () => {
  test.each([
    ["Ada Lovelace", "Ada", "Lovelace"],
    ["Mary Anne van der Berg", "Mary", "Anne van der Berg"],
    ["Cher", "Cher", ""],
    ["   ", "", ""],
  ])("splits %s", (full, first, last) => {
    expect(splitName(full)).toEqual({ first, last });
  });
});

describe("buildMailchimpMember", () => {
  const person = {
    email: "Ada@Example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    name: "Ada Lovelace",
    chapterName: "Brooklyn",
    backer: "active" as const,
    role: "team" as const,
  };

  test("normalizes the address and carries every merge field", () => {
    expect(buildMailchimpMember(person, "subscribed")).toEqual({
      email_address: "ada@example.com",
      status: "subscribed",
      merge_fields: {
        FNAME: "Ada",
        LNAME: "Lovelace",
        CHAPTER: "Brooklyn",
        BACKER: "active",
        ROLE: "team",
      },
    });
  });

  test("sets `status`, not `status_if_new` — this is how a leaver gets unsubscribed", () => {
    const member = buildMailchimpMember(person, "unsubscribed");
    expect(member.status).toBe("unsubscribed");
    expect(member).not.toHaveProperty("status_if_new");
  });

  test("falls back to splitting the full name when first/last are absent", () => {
    const member = buildMailchimpMember(
      { ...person, firstName: null, lastName: null },
      "subscribed",
    );
    expect(member.merge_fields.FNAME).toBe("Ada");
    expect(member.merge_fields.LNAME).toBe("Lovelace");
  });

  test("explicit first/last always beat the parsed full name", () => {
    const member = buildMailchimpMember(
      { ...person, firstName: "Augusta", name: "Ada Lovelace" },
      "subscribed",
    );
    expect(member.merge_fields.FNAME).toBe("Augusta");
  });

  test("blank values are WRITTEN, never omitted — an absent field would leave Mailchimp's stale one in place", () => {
    const member = buildMailchimpMember(
      {
        email: "x@example.com",
        chapterName: null,
        backer: "none",
        role: "contact",
      },
      "subscribed",
    );
    // The point of the assertion is the KEYS, not the emptiness.
    expect(Object.keys(member.merge_fields).sort()).toEqual([
      "BACKER",
      "CHAPTER",
      "FNAME",
      "LNAME",
      "ROLE",
    ]);
    expect(member.merge_fields.CHAPTER).toBe("");
  });
});

describe("buildMailchimpUnsubscribe", () => {
  test("carries NO merge fields — unsubscribing must not blank a leaver's name", () => {
    // The bug this pins: building a leaver's payload with
    // `buildMailchimpMember` would write FNAME/LNAME/CHAPTER as empty strings,
    // wiping in Mailchimp the name of someone who might later re-subscribe
    // through a Mailchimp signup form. Omitting the key entirely leaves
    // whatever Mailchimp holds untouched.
    const payload = buildMailchimpUnsubscribe("Gone@Example.com");
    expect(payload).toEqual({
      email_address: "gone@example.com",
      status: "unsubscribed",
    });
    expect(payload).not.toHaveProperty("merge_fields");
  });

  test("the subscribed path still writes every field — the opposite rule", () => {
    const kept = buildMailchimpMember(
      { email: "x@example.com", backer: "none", role: "contact" },
      "subscribed",
    );
    expect(kept.merge_fields).toBeDefined();
  });
});

describe("chunk", () => {
  test("splits at the batch ceiling with a short final chunk", () => {
    const items = Array.from({ length: 1201 }, (_, i) => i);
    const chunks = chunk(items, MAILCHIMP_BATCH_SIZE);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 201]);
  });

  test("never exceeds Mailchimp's 500-member request limit", () => {
    expect(MAILCHIMP_BATCH_SIZE).toBeLessThanOrEqual(500);
  });

  test("an empty list is no batches, not one empty batch", () => {
    expect(chunk([], 500)).toEqual([]);
  });

  test("rejects a zero size rather than looping forever", () => {
    expect(() => chunk([1, 2], 0)).toThrow();
  });
});

describe("MAILCHIMP_SUPPRESSION_EVENTS", () => {
  test.each([
    ["unsubscribe", "unsubscribe"],
    ["cleaned", "bounce"],
    ["spam", "complaint"],
  ])("maps %s to the %s suppression reason", (type, reason) => {
    expect(MAILCHIMP_SUPPRESSION_EVENTS[type]).toBe(reason);
  });

  test.each(["subscribe", "profile", "upemail", "campaign", ""])(
    "ignores %s — a re-subscribe in Mailchimp must never un-suppress an address here",
    (type) => {
      expect(MAILCHIMP_SUPPRESSION_EVENTS[type]).toBeUndefined();
    },
  );
});

describe("MAILCHIMP_CUSTOM_MERGE_FIELDS", () => {
  test("excludes FNAME/LNAME — creating a built-in merge field is a 400", () => {
    const tags = MAILCHIMP_CUSTOM_MERGE_FIELDS.map((f) => f.tag);
    expect(tags).not.toContain("FNAME");
    expect(tags).not.toContain("LNAME");
    expect(tags).toEqual(["CHAPTER", "BACKER", "ROLE"]);
  });

  test("every field we create is one the payload actually writes", () => {
    const written = Object.keys(
      buildMailchimpMember(
        { email: "x@example.com", backer: "none", role: "contact" },
        "subscribed",
      ).merge_fields,
    );
    for (const field of MAILCHIMP_CUSTOM_MERGE_FIELDS) {
      expect(written).toContain(field.tag);
    }
  });
});
