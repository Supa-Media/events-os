import { describe, expect, test } from "@jest/globals";
import {
  domainWrites,
  groupByDomain,
  heldCountByDomain,
  holdersOf,
  offerablePowers,
  powerDiff,
  powerState,
  searchPowers,
  type DirectorySeat,
} from "./powerPicker";

describe("searchPowers", () => {
  test("matches label, description, and domain name, case-insensitively", () => {
    expect(searchPowers("DONOR", "all", "central")).toContain("giving.view");
    expect(searchPowers("reconcile", "all", "central")).toContain("finance.edit");
    expect(searchPowers("hiring desk", "all", "central")).toEqual([
      "hiring.view",
      "hiring.edit",
      "hiring.approve",
    ]);
  });

  test("the domain filter narrows to one area", () => {
    const emails = searchPowers("", "email", "central");
    expect(emails).toEqual(["email.assets.edit", "email.campaigns.edit", "email.campaigns.approve"]);
  });

  test("a chapter seat is never offered a central-only power", () => {
    expect(offerablePowers("central")).toContain("finance.accounts.view");
    expect(offerablePowers("chapter")).not.toContain("finance.accounts.view");
    expect(searchPowers("accounts", "all", "chapter")).not.toContain("finance.accounts.view");
  });
});

describe("powerState", () => {
  test("names the stored power an implied one comes from", () => {
    const stored = ["email.campaigns.approve"];
    expect(powerState(stored, "email.campaigns.approve")).toEqual({ kind: "granted" });
    expect(powerState(stored, "email.assets.edit")).toEqual({
      kind: "included",
      via: "email.campaigns.approve",
    });
    expect(powerState(stored, "giving.view")).toEqual({ kind: "off" });
  });

  test("editing the chart includes filling seats", () => {
    expect(powerState(["org.chart.edit"], "org.seats.edit")).toEqual({
      kind: "included",
      via: "org.chart.edit",
    });
  });
});

describe("holdersOf", () => {
  const seats: DirectorySeat[] = [
    { defId: "ed", slug: "executive_director", title: "Executive Director", chart: "central", capabilities: ["finance.accounts.view", "giving.edit"] },
    { defId: "tr", slug: "treasurer", title: "Treasurer", chart: "chapter", capabilities: ["finance.edit", "giving.view"] },
    { defId: "dd", slug: "development_director", title: "Development Director", chart: "central", capabilities: ["giving.edit"] },
  ];

  test("reads each seat at its own scope", () => {
    // The Treasurer's finance.edit expands to accounts.view, but accounts are
    // central-only, so it isn't a holder in any sense the chart should print.
    expect(holdersOf("finance.accounts.view", seats).map((h) => h.seat.defId)).toEqual(["ed"]);
  });

  test("reports implied grants and skips the excluded seat", () => {
    const rows = holdersOf("giving.view", seats, "dd");
    expect(rows).toEqual([
      { seat: seats[0], via: "giving.edit" },
      { seat: seats[1], via: null },
    ]);
  });
});

describe("domainWrites", () => {
  test("writes only the domains whose stored powers changed", () => {
    const before = ["finance.view", "email.campaigns.approve", "data.export"];
    const after = ["finance.edit", "email.campaigns.approve", "data.export"];
    expect(domainWrites(before, after)).toEqual([{ domain: "finance", powers: ["finance.edit"] }]);
  });

  test("clearing a domain writes an empty set for it", () => {
    expect(domainWrites(["data.export"], [])).toEqual([{ domain: "data", powers: [] }]);
  });

  test("order within a domain is not a change", () => {
    expect(domainWrites(["marketing.site.edit", "marketing.list.edit"], ["marketing.list.edit", "marketing.site.edit"])).toEqual([]);
  });
});

describe("summaries", () => {
  test("powerDiff lists additions and removals in registry order", () => {
    expect(powerDiff(["giving.view", "data.export"], ["giving.edit", "data.export"])).toEqual({
      added: ["giving.edit"],
      removed: ["giving.view"],
    });
  });

  test("heldCountByDomain counts expanded powers per domain", () => {
    expect(heldCountByDomain(["email.campaigns.approve"], "central")).toEqual({ email: 3 });
  });

  test("groupByDomain keeps registry domain order and drops empty groups", () => {
    const groups = groupByDomain(["data.export", "finance.view"]);
    expect(groups.map((g) => g.domain)).toEqual(["finance", "data"]);
  });
});
