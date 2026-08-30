import { DOCK_SLOTS, dockSelection } from "./mobileNav";

type Item = { path: string; active: boolean };

const item = (path: string, active = false): Item => ({ path, active });

/** The full admin nav, in `AppShell`'s fixed `NAV` order. */
const ADMIN = [
  "/",
  "/people",
  "/team",
  "/song-library",
  "/inventory",
  "/finances",
  "/giving",
  "/marketing",
  "/people/pipeline",
  "/academy",
  "/org-chart",
];

const nav = (activePath?: string): Item[] =>
  ADMIN.map((p) => item(p, p === activePath));

describe("dockSelection", () => {
  it("takes the leading entries in the order given", () => {
    expect(dockSelection(nav("/")).map((i) => i.path)).toEqual([
      "/",
      "/people",
      "/team",
      "/song-library",
    ]);
  });

  it("never returns more than DOCK_SLOTS entries", () => {
    for (const path of ADMIN) {
      expect(dockSelection(nav(path))).toHaveLength(DOCK_SLOTS);
    }
  });

  it("always includes the active destination, even from far down the list", () => {
    for (const path of ADMIN) {
      const paths = dockSelection(nav(path)).map((i) => i.path);
      expect(paths).toContain(path);
    }
  });

  it("puts a displaced active destination in the LAST slot, keeping the rest in order", () => {
    // `/finances` is 6th — outside the leading four.
    expect(dockSelection(nav("/finances")).map((i) => i.path)).toEqual([
      "/",
      "/people",
      "/team",
      "/finances",
    ]);
  });

  it("leaves the leading entries untouched when the active one is already among them", () => {
    expect(dockSelection(nav("/team")).map((i) => i.path)).toEqual([
      "/",
      "/people",
      "/team",
      "/song-library",
    ]);
  });

  it("falls back to the plain prefix when nothing is active", () => {
    // Happens on a route with no nav entry of its own — an event detail page,
    // a deep-linked receipt — where no destination should claim to be current.
    expect(dockSelection(nav()).map((i) => i.path)).toEqual([
      "/",
      "/people",
      "/team",
      "/song-library",
    ]);
  });

  it("returns every entry, unpadded, when the caller sees fewer than a full dock", () => {
    // A volunteer's nav is short: Briefing, Songs, Academy, Org Chart — and a
    // member with no Work row can be shorter still.
    const short = [item("/briefing", true), item("/academy")];
    expect(dockSelection(short).map((i) => i.path)).toEqual([
      "/briefing",
      "/academy",
    ]);
  });

  it("handles an empty nav (still loading) without throwing", () => {
    expect(dockSelection([])).toEqual([]);
  });
});
