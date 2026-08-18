/**
 * @mentions only work on a screen that mounts `MentionDataProvider` — every
 * mentionable grid cell (`cells.tsx#GridCell`) falls back to the plain
 * editor the moment `useMentionData()` returns null. This test reads the
 * two screens that render mentionable grids straight from source and pins
 * that both mount the provider, so a future edit to either screen can't
 * silently regress one of them back to a plain-text-only surface.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "@jest/globals";

const read = (relPath: string) =>
  fs.readFileSync(path.join(__dirname, relPath), "utf8");

describe("MentionDataProvider is mounted on every screen that renders a mentionable grid", () => {
  test("the template editor mounts it", () => {
    const src = read("../../app/(app)/template/[id].tsx");
    expect(src).toContain(
      'import { MentionDataProvider } from "../../../components/mentions/MentionDataProvider";',
    );
    expect(src).toContain("<MentionDataProvider>");
  });

  test("the event workspace still mounts it (regression guard)", () => {
    const src = read("../../app/(app)/event/[id].tsx");
    expect(src).toContain(
      'import { MentionDataProvider } from "../../../components/mentions/MentionDataProvider";',
    );
    expect(src).toContain("<MentionDataProvider>");
  });
});
