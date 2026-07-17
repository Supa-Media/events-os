// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors
// `components/orgchart/treeUtils.test.ts`, the one prior test file here).
import { describe, expect, test } from "@jest/globals";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { mergeDesks, seatKeyOf, seatLabelOf, type DeskChapter, type Seat } from "./financeSeats";

const NY = "ny" as Id<"chapters">;
const CHICAGO = "chicago" as Id<"chapters">;

describe("mergeDesks", () => {
  test("an org-chart-seat-only chapter desk (no financeRoles grant) is surfaced", () => {
    // The bug this fixes: a chapter_director seat holder with NO separate
    // financeRoles grant used to be entirely absent from `financeRoles.mySeats`,
    // so their own chapter fell through to the Peek list read-only.
    const financeSeats: Seat[] = [];
    const deskChapters: DeskChapter[] = [
      { scope: NY, chapterName: "New York", title: "president" },
    ];

    expect(mergeDesks(financeSeats, deskChapters)).toEqual([
      { scope: "chapter", chapterId: NY, chapterName: "New York", title: "president" },
    ]);
  });

  test("a financeRoles-granted seat wins over the org-chart-only desk at the same scope", () => {
    // The financeRoles side carries a real `role` + its own title enrichment;
    // the org-chart-derived desk must not clobber it with a role-less entry.
    const financeSeats: Seat[] = [
      { scope: "chapter", chapterId: NY, chapterName: "New York", role: "manager", title: "finance_manager" },
    ];
    const deskChapters: DeskChapter[] = [
      { scope: NY, chapterName: "New York", title: "finance_manager" },
    ];

    expect(mergeDesks(financeSeats, deskChapters)).toEqual([
      { scope: "chapter", chapterId: NY, chapterName: "New York", role: "manager", title: "finance_manager" },
    ]);
  });

  test("central desk is the union: an org-chart central seat alone still makes central a desk", () => {
    const financeSeats: Seat[] = [];
    const deskChapters: DeskChapter[] = [{ scope: "central", title: "executive_director" }];

    expect(mergeDesks(financeSeats, deskChapters)).toEqual([
      { scope: "central", title: "executive_director" },
    ]);
  });

  test("a finance-only central grant with no central seat assignment keeps its desk", () => {
    const financeSeats: Seat[] = [{ scope: "central", role: "manager" }];
    const deskChapters: DeskChapter[] = [];

    expect(mergeDesks(financeSeats, deskChapters)).toEqual([
      { scope: "central", role: "manager" },
    ]);
  });

  test("central first, chapters alphabetical, merged across both sources", () => {
    const financeSeats: Seat[] = [
      { scope: "chapter", chapterId: CHICAGO, chapterName: "Chicago", role: "bookkeeper" },
    ];
    const deskChapters: DeskChapter[] = [
      { scope: "central", title: "executive_director" },
      { scope: NY, chapterName: "New York", title: "president" },
    ];

    expect(mergeDesks(financeSeats, deskChapters)).toEqual([
      { scope: "central", title: "executive_director" },
      { scope: "chapter", chapterId: CHICAGO, chapterName: "Chicago", role: "bookkeeper" },
      { scope: "chapter", chapterId: NY, chapterName: "New York", title: "president" },
    ]);
  });

  test("no seats at all merges to an empty list", () => {
    expect(mergeDesks([], [])).toEqual([]);
  });
});

describe("seatKeyOf", () => {
  test("keys a role-less org-chart-only desk the same way as a financeRoles seat", () => {
    const deskOnly: Seat = { scope: "chapter", chapterId: NY, chapterName: "New York" };
    const financeGranted: Seat = {
      scope: "chapter",
      chapterId: NY,
      chapterName: "New York",
      role: "viewer",
    };
    expect(seatKeyOf(deskOnly)).toBe(seatKeyOf(financeGranted));
  });
});

describe("seatLabelOf", () => {
  test("an org-chart-only desk with a legacyTitle shows the org-chart label, not a finance-role rank", () => {
    const seat: Seat = { scope: "chapter", chapterId: NY, chapterName: "New York", title: "president" };
    expect(seatLabelOf(seat)).toBe("New York · Chapter Director");
  });

  test("an org-chart-only desk with no title and no role falls back to 'Member'", () => {
    const seat: Seat = { scope: "chapter", chapterId: NY, chapterName: "New York" };
    expect(seatLabelOf(seat)).toBe("New York · Member");
  });

  test("a financeRoles seat with a role and no title still shows the finance-role rank", () => {
    const seat: Seat = { scope: "central", role: "bookkeeper" };
    expect(seatLabelOf(seat)).toBe("Central · Bookkeeper");
  });
});
