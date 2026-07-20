import { describe, expect, test } from "vitest";
import {
  deriveSupplyStatus,
  isInventoryBackedSource,
  normalizeSupplySource,
} from "./index";

describe("normalizeSupplySource", () => {
  test("maps the retired values onto the provenance set", () => {
    expect(normalizeSupplySource("storage")).toBe("chapter_storage");
    expect(normalizeSupplySource("misc")).toBe("buy_in_store");
  });

  test("passes current values and empties through untouched", () => {
    expect(normalizeSupplySource("chapter_storage")).toBe("chapter_storage");
    expect(normalizeSupplySource("borrowed")).toBe("borrowed");
    expect(normalizeSupplySource(null)).toBeNull();
    expect(normalizeSupplySource(undefined)).toBeUndefined();
  });
});

describe("isInventoryBackedSource", () => {
  test("true for chapter_storage and its legacy alias only", () => {
    expect(isInventoryBackedSource("chapter_storage")).toBe(true);
    expect(isInventoryBackedSource("storage")).toBe(true);
    expect(isInventoryBackedSource("misc")).toBe(false);
    expect(isInventoryBackedSource("borrowed")).toBe(false);
    expect(isInventoryBackedSource(null)).toBe(false);
    expect(isInventoryBackedSource(undefined)).toBe(false);
  });
});

describe("deriveSupplyStatus legacy aliases", () => {
  test("a legacy 'storage' row derives like chapter_storage", () => {
    expect(deriveSupplyStatus({ source: "storage" }).value).toBe(
      "pull_from_storage",
    );
  });

  test("a legacy 'misc' row derives like buy_in_store", () => {
    expect(deriveSupplyStatus({ source: "misc" }).value).toBe("need_to_buy");
  });
});
