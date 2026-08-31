/**
 * People search must stay SERVER-side.
 *
 * The org-chart seat picker could not find a person who had just been added
 * (reported 2026-08-31): its roster query returns a capped slice, and the
 * search box filtered that slice on the client, so anyone outside the cap was
 * unfindable no matter what was typed. The fix pushed matching into the
 * queries (`convex/lib/peopleSearch.ts`).
 *
 * Nothing about that is enforceable at runtime — a client-side
 * `.filter(p => p.name.includes(q))` looks perfectly correct in review and
 * only fails once a roster outgrows its cap, which is exactly when nobody is
 * looking. So this reads the picker and its call sites from source and pins
 * the shape, in the style of `mentions/mentionProviderWiring.test.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "@jest/globals";

const MOBILE_ROOT = path.join(__dirname, "..", "..");

const read = (relPath: string) => fs.readFileSync(path.join(MOBILE_ROOT, relPath), "utf8");

/** Every `.tsx` under `components/` and `app/`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** Each `<PersonPicker … />` element in a file, as raw text. */
function personPickerElements(src: string): string[] {
  return [...src.matchAll(/<PersonPicker\b[\s\S]*?\/>/g)].map((m) => m[0]);
}

describe("PersonPicker searches on the server", () => {
  const picker = read("components/ui/PersonPicker.tsx");

  test("does not filter the fetched roster by name on the client", () => {
    // The exact expression that caused the bug. A capped roster filtered here
    // can only ever search the part of the roster the server returned.
    expect(picker).not.toMatch(/name\s*\.\s*toLowerCase\(\)\s*\.\s*includes\(/);
  });

  test("hands the typed query to whichever query supplies the roster", () => {
    // Debounced, then passed as a query arg — not applied to the result.
    expect(picker).toContain("useDebouncedValue(search, SEARCH_DEBOUNCE_MS)");
    expect(picker).toContain("search: searchArg");
  });

  test("an override caller is handed the query back so IT can re-query", () => {
    expect(picker).toContain("onSearchChangeRef.current?.(debouncedSearch.trim())");
  });
});

describe("every PersonPicker call site that supplies its own roster also drives its own search", () => {
  const callSites = [
    ...sourceFiles(path.join(MOBILE_ROOT, "components")),
    ...sourceFiles(path.join(MOBILE_ROOT, "app")),
  ]
    .flatMap((file) =>
      personPickerElements(fs.readFileSync(file, "utf8")).map((element) => ({
        file: path.relative(MOBILE_ROOT, file),
        element,
      })),
    )
    .filter(({ element }) => /\bpeople=\{/.test(element));

  test("there is at least one such call site to check (the org-chart seat picker)", () => {
    expect(callSites.map((c) => c.file)).toContain("components/orgchart/SeatActions.tsx");
  });

  test.each(callSites.map((c, i) => [`${c.file} #${i}`, c] as const))(
    "%s passes onSearchChange",
    (_label, callSite) => {
      // The props type already requires this; the point of pinning it here is
      // that a future `people={…}` picker must consciously answer "where does
      // its search run?" rather than reaching for a `.filter()`.
      expect(callSite.element).toMatch(/\bonSearchChange=/);
    },
  );
});
