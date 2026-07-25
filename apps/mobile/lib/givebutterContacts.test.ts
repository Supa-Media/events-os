import { describe, expect, it } from "@jest/globals";
import { parseGivebutterContacts, splitCsvRecords } from "./givebutterContacts";

/**
 * Givebutter CONTACTS export parser — detection by its own headers, pre-split
 * names (Preferred First wins), phone normalization, quoted newlines in
 * free-text columns, and the no-identifier/dropped counters. The header list
 * mirrors a real 2026 export verbatim (values below are synthetic).
 */

const HEADER =
  '"Givebutter Contact ID","Contact External ID","Contact Since","Prefix","First Name","Preferred First Name","Middle Name","Last Name","Suffix","Date of Birth","Gender","Pronouns","Employer","Title","Primary Email","Additional Emails","Primary Phone","Additional Phones","Address Line 1","Address Line 2","City","State","Postal Code","Country","Additional Addresses","Website","Twitter","LinkedIn","Facebook","TikTok","Instagram","Recurring Contributions","Total Contributions","Last Donation Amount","Total Soft Credits","Engage Email Subscribed","Engage SMS Subscribed","Engage Mail Subscribed","Tags","Notes","Household ID","Household","Household Primary Contact","Date Created (UTC)","Last Modified (UTC)"';

function row(cells: Partial<Record<string, string>>): string {
  const order = HEADER.split('","').map((h) => h.replace(/^"|"$/g, ""));
  return order.map((h) => `"${cells[h] ?? ""}"`).join(",");
}

describe("splitCsvRecords", () => {
  it("handles quoted commas, escaped quotes, and newlines inside quotes", () => {
    const text = '"a","b ""quoted""","line1\nline2"\n"c","d","e"';
    expect(splitCsvRecords(text)).toEqual([
      ["a", 'b "quoted"', "line1\nline2"],
      ["c", "d", "e"],
    ]);
  });
});

describe("parseGivebutterContacts", () => {
  it("returns null for non-contacts pastes (canonical rows, transactions export)", () => {
    expect(parseGivebutterContacts("gift,Ada Lovelace,ada@example.com")).toBeNull();
    expect(
      parseGivebutterContacts('"Campaign Title","Reference Number","First Name"\n"C","R","F"'),
    ).toBeNull();
  });

  it("parses contacts: preferred name wins, phones normalize, emails lowercase", () => {
    const text = [
      HEADER,
      row({
        "Givebutter Contact ID": "1",
        "First Name": "Alexandra",
        "Preferred First Name": "Alex",
        "Last Name": "Kim",
        "Primary Email": "Alex.Kim@Example.com",
        "Primary Phone": "+1 (310) 290-3015",
      }),
      row({
        "Givebutter Contact ID": "2",
        "First Name": "Sam",
        "Last Name": "Ode",
        "Primary Email": "sam@example.com",
        // Too short to be a real phone — normalized away.
        "Primary Phone": "12345",
        Notes: "met at\nWorship Night",
      }),
    ].join("\n");
    const parse = parseGivebutterContacts(text)!;
    expect(parse.contacts).toEqual([
      {
        firstName: "Alex",
        lastName: "Kim",
        name: "Alex Kim",
        email: "alex.kim@example.com",
        phone: "13102903015",
      },
      { firstName: "Sam", lastName: "Ode", name: "Sam Ode", email: "sam@example.com" },
    ]);
    expect(parse.noIdentifier).toBe(0);
    expect(parse.dropped).toBe(0);
  });

  it("counts identifier-less rows and drops fully empty ones; nameless-but-emailed rows fall back to the local part", () => {
    const text = [
      HEADER,
      row({ "Givebutter Contact ID": "3", "First Name": "Name", "Last Name": "Only" }),
      row({ "Givebutter Contact ID": "4", "Primary Email": "no.name@example.com" }),
      row({ "Givebutter Contact ID": "5" }),
    ].join("\n");
    const parse = parseGivebutterContacts(text)!;
    expect(parse.noIdentifier).toBe(1); // Name Only — parsed, flagged
    expect(parse.dropped).toBe(1); // row 5 — nothing at all
    expect(parse.contacts.find((c) => c.email === "no.name@example.com")!.name).toBe("no.name");
  });
});
