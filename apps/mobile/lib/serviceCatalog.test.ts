// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `financeSeats.test.ts`).
import { describe, expect, test } from "@jest/globals";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  buildServiceLabelMap,
  flattenServiceCatalog,
  parentIdsWithChildren,
  topLevelServiceOptions,
  type ServiceCatalogTree,
} from "./serviceCatalog";

const VOCALS = "vocals" as Id<"serviceOptions">;
const TENOR = "tenor" as Id<"serviceOptions">;
const ALTO = "alto" as Id<"serviceOptions">;
const AUDIO = "audio" as Id<"serviceOptions">;
const SONGWRITING = "songwriting" as Id<"serviceOptions">;

// Mirrors the exact shape `apps/convex/serviceOptions.ts#list` returns: an
// array of top-level rows, each nesting its own `children`. "Vocals" has two
// children (a real parent/child group); "Audio" and "Songwriting" are bare
// top-level rows with no children (standalone leaves, same as a childless
// parent per the schema's doc).
const TREE = [
  {
    _id: VOCALS,
    name: "Vocals",
    label: "Vocals",
    isActive: true,
    sortOrder: 0,
    usageCount: 3,
    isCentral: true,
    children: [
      {
        _id: TENOR,
        name: "Tenor",
        label: "Vocals:Tenor",
        isActive: true,
        sortOrder: 0,
        usageCount: 2,
        isCentral: true,
      },
      {
        _id: ALTO,
        name: "Alto",
        label: "Vocals:Alto",
        isActive: false,
        sortOrder: 1,
        usageCount: 0,
        isCentral: true,
      },
    ],
  },
  {
    _id: AUDIO,
    name: "Audio",
    label: "Audio",
    isActive: true,
    sortOrder: 1,
    usageCount: 5,
    isCentral: true,
    children: [],
  },
  {
    _id: SONGWRITING,
    name: "Songwriting",
    label: "Songwriting",
    isActive: true,
    sortOrder: 2,
    usageCount: 0,
    isCentral: false,
    children: [],
  },
] as unknown as ServiceCatalogTree;

describe("flattenServiceCatalog", () => {
  test("orders each parent immediately followed by its own children, preserving the server-computed label", () => {
    const flat = flattenServiceCatalog(TREE);
    expect(flat.map((r) => [r.label, r.parentId])).toEqual([
      ["Vocals", undefined],
      ["Vocals:Tenor", VOCALS],
      ["Vocals:Alto", VOCALS],
      ["Audio", undefined],
      ["Songwriting", undefined],
    ]);
  });

  test("carries isActive/isCentral/usageCount through untouched — never re-derives them", () => {
    const flat = flattenServiceCatalog(TREE);
    const alto = flat.find((r) => r._id === ALTO);
    expect(alto).toMatchObject({ isActive: false, isCentral: true, usageCount: 0 });
    const songwriting = flat.find((r) => r._id === SONGWRITING);
    expect(songwriting).toMatchObject({ isActive: true, isCentral: false, usageCount: 0 });
  });
});

describe("buildServiceLabelMap", () => {
  test("resolves both parent and child ids to their pre-computed label", () => {
    const map = buildServiceLabelMap(TREE);
    expect(map.get(VOCALS)).toBe("Vocals");
    expect(map.get(TENOR)).toBe("Vocals:Tenor");
    expect(map.get(AUDIO)).toBe("Audio");
    expect(map.has("nonexistent" as Id<"serviceOptions">)).toBe(false);
  });
});

describe("parentIdsWithChildren", () => {
  test("only flags top-level rows that actually have children — a childless top-level row is a leaf, not a group", () => {
    const set = parentIdsWithChildren(TREE);
    expect(set.has(VOCALS)).toBe(true);
    expect(set.has(AUDIO)).toBe(false);
    expect(set.has(SONGWRITING)).toBe(false);
  });
});

describe("topLevelServiceOptions", () => {
  test("returns only the top-level rows, bare id+name (for the 'nest under' picker)", () => {
    expect(topLevelServiceOptions(TREE)).toEqual([
      { _id: VOCALS, name: "Vocals" },
      { _id: AUDIO, name: "Audio" },
      { _id: SONGWRITING, name: "Songwriting" },
    ]);
  });
});
