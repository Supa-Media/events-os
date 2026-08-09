import { describe, expect, test } from "vitest";
import {
  matchesReconcileSearch,
  reconcileSearchTerms,
  type ReconcileSearchFields,
} from "./reconcileSearch";

const row = (overrides: Partial<ReconcileSearchFields> = {}): ReconcileSearchFields => ({
  merchantNameOverride: null,
  merchantName: null,
  description: null,
  cardholderName: null,
  cardLast4: null,
  bookName: "New York",
  amountCents: 12994,
  ...overrides,
});

const matches = (f: ReconcileSearchFields, q: string) =>
  matchesReconcileSearch(f, reconcileSearchTerms(q));

// A renamed row must be findable by BOTH names. "Costco" has to find it
// because that's what the grid now calls it; the bank's own
// `IC* COSTCO BY IN CAR` has to keep finding it because someone reconciling
// against a statement is reading the provider's string, and a rename must
// never make a row unfindable by what the statement calls it.
// (Moved here from the mobile package's `filterReconcileRows` test when search
// became server-side — same guarantees, one source of truth.)
describe("matchesReconcileSearch — a rename doesn't hide a row", () => {
  const renamed = row({
    merchantNameOverride: "Costco",
    merchantName: "IC* COSTCO BY IN CAR",
  });

  test("finds it by the new name", () => {
    expect(matches(renamed, "costco")).toBe(true);
  });

  test("still finds it by the bank's own string", () => {
    expect(matches(renamed, "IC* COSTCO")).toBe(true);
  });

  test("doesn't match an unrelated row", () => {
    expect(matches(renamed, "amazon")).toBe(false);
    expect(matches(row({ merchantName: "AMAZON MKTPL*56OXD2TB2" }), "amazon")).toBe(true);
  });
});

describe("matchesReconcileSearch — the other searchable fields", () => {
  test("matches the cardholder's name", () => {
    expect(matches(row({ cardholderName: "Seyi Olujide" }), "seyi")).toBe(true);
  });

  test("matches the card's last four", () => {
    expect(matches(row({ cardLast4: "9370" }), "9370")).toBe(true);
  });

  test("matches the book name, so the merged queue can be narrowed by typing", () => {
    expect(matches(row({ bookName: "Central" }), "central")).toBe(true);
  });

  test("matches the description", () => {
    expect(matches(row({ description: "Field Day supplies" }), "field day")).toBe(true);
  });
});

describe("matchesReconcileSearch — amounts, in every spelling a person types", () => {
  const r = row({ amountCents: 129400 }); // $1,294.00

  test("raw cents", () => {
    expect(matches(r, "129400")).toBe(true);
  });

  test("the formatted string", () => {
    expect(matches(r, "$1,294.00")).toBe(true);
  });

  test("the bare decimal, commas stripped", () => {
    expect(matches(r, "1294.00")).toBe(true);
    expect(matches(r, "1294")).toBe(true);
  });
});

describe("term semantics", () => {
  test("AND across terms — `seyi deli` is not `seyi` OR `deli`", () => {
    const seyisDeli = row({ cardholderName: "Seyi Olujide", merchantName: "CORNER DELI" });
    const seyisCab = row({ cardholderName: "Seyi Olujide", merchantName: "MTA*NYCT PAYGO" });
    expect(matches(seyisDeli, "seyi deli")).toBe(true);
    expect(matches(seyisCab, "seyi deli")).toBe(false);
  });

  test("an empty or blank query constrains nothing", () => {
    expect(reconcileSearchTerms("")).toEqual([]);
    expect(reconcileSearchTerms("   ")).toEqual([]);
    expect(matches(row(), "")).toBe(true);
    expect(matches(row(), "   ")).toBe(true);
  });

  test("case-insensitive, and tolerant of extra whitespace between terms", () => {
    expect(matches(row({ merchantName: "Olive Garden" }), "  OLIVE   garden ")).toBe(true);
  });
});
