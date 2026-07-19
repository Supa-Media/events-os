import { describe, expect, test } from "@jest/globals";
import {
  ALL_SCOPES_VALUE,
  anyFilterActive,
  buildListDonorsArgs,
  filterArg,
} from "./donorFilters";

const NONE = { status: "all", kind: "all", source: "all", band: "all" };

describe("filterArg", () => {
  test("'all' collapses to undefined; anything else passes through", () => {
    expect(filterArg("all")).toBeUndefined();
    expect(filterArg("lapsed")).toBe("lapsed");
  });
});

describe("buildListDonorsArgs", () => {
  test("all defaults + a chapter scope → single-scope, no refinements", () => {
    expect(buildListDonorsArgs(NONE, "chapter123")).toEqual({
      scope: "chapter123",
      status: undefined,
      kind: undefined,
      source: undefined,
      minLifetimeCents: undefined,
      allScopes: undefined,
    });
  });

  test("central scope stays central", () => {
    expect(buildListDonorsArgs(NONE, "central").scope).toBe("central");
    expect(buildListDonorsArgs(NONE, "central").allScopes).toBeUndefined();
  });

  test("'all' scope → allScopes true, scope falls back to central", () => {
    const args = buildListDonorsArgs(NONE, ALL_SCOPES_VALUE);
    expect(args.allScopes).toBe(true);
    expect(args.scope).toBe("central");
  });

  test("refinements map through, band → cents", () => {
    const args = buildListDonorsArgs(
      { status: "lapsed", kind: "church", source: "manual", band: "500" },
      "central",
    );
    expect(args.status).toBe("lapsed");
    expect(args.kind).toBe("church");
    expect(args.source).toBe("manual");
    expect(args.minLifetimeCents).toBe(50000);
  });

  test("each lifetime band converts to the right cents floor", () => {
    expect(buildListDonorsArgs({ ...NONE, band: "100" }, "central").minLifetimeCents).toBe(10000);
    expect(buildListDonorsArgs({ ...NONE, band: "1000" }, "central").minLifetimeCents).toBe(100000);
    expect(buildListDonorsArgs({ ...NONE, band: "all" }, "central").minLifetimeCents).toBeUndefined();
  });
});

describe("anyFilterActive", () => {
  test("false when everything is 'all', true once any refinement is set", () => {
    expect(anyFilterActive(NONE)).toBe(false);
    expect(anyFilterActive({ ...NONE, status: "active" })).toBe(true);
    expect(anyFilterActive({ ...NONE, band: "100" })).toBe(true);
  });
});
