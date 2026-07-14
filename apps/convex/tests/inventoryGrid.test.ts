import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, setupChapter } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Inventory grid adapter — the chapter-mode EditableGrid payload + cell writes:
 *   - listAssetsGrid returns the fixed INVENTORY_COLUMNS + one item per asset
 *     with a `fields` bag (tags/quantity/available/consumable/condition/…),
 *   - addAssetRow appends a blank row,
 *   - updateAssetCell maps a cell key+value onto the typed asset (title→name,
 *     tags, quantity, consumable/acquired yes-no, condition), and refuses the
 *     read-only `available` column.
 */

describe("inventory grid adapter", () => {
  test("grid payload shape + cell writes", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const id = (await s.as.mutation(api.inventory.addAssetRow, {})) as Id<"assets">;

    let grid = await s.as.query(api.inventory.listAssetsGrid, {});
    expect(grid.columns.map((c) => c.key)).toEqual([
      "title",
      "tags",
      "quantity",
      "available",
      "consumable",
      "condition",
      "acquired",
      "photo",
      "notes",
    ]);
    expect(grid.items).toHaveLength(1);
    expect(grid.items[0].title).toBe("New item");

    await s.as.mutation(api.inventory.updateAssetCell, {
      assetId: id,
      key: "title",
      value: "SM58 mic",
    });
    await s.as.mutation(api.inventory.updateAssetCell, {
      assetId: id,
      key: "tags",
      value: ["audio", "audio", " cable "],
    });
    await s.as.mutation(api.inventory.updateAssetCell, {
      assetId: id,
      key: "quantity",
      value: 4,
    });
    await s.as.mutation(api.inventory.updateAssetCell, {
      assetId: id,
      key: "consumable",
      value: "yes",
    });
    await s.as.mutation(api.inventory.updateAssetCell, {
      assetId: id,
      key: "condition",
      value: "needs_attention",
    });
    // Read-only computed column — must be a no-op.
    await s.as.mutation(api.inventory.updateAssetCell, {
      assetId: id,
      key: "available",
      value: "hacked",
    });

    grid = await s.as.query(api.inventory.listAssetsGrid, {});
    const row = grid.items[0];
    expect(row.title).toBe("SM58 mic");
    expect(row.fields.tags).toEqual(["audio", "cable"]); // trimmed + de-duped
    expect(row.fields.quantity).toBe(4);
    expect(row.fields.consumable).toBe("yes");
    expect(row.fields.condition).toBe("needs_attention");
    expect(row.fields.available).not.toBe("hacked");
  });
});
