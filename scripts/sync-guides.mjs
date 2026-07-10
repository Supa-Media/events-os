#!/usr/bin/env node
/**
 * Sync the in-repo enablement guides (docs/guides/*.md) into a generated
 * Convex module (apps/convex/lib/guides.ts) so they can be seeded into the
 * `docs` table as platform how-to docs.
 *
 * docs/guides/ is the source of truth (reviewed like code — see
 * docs/plans/training-and-enablement.md). Run this after editing a guide,
 * then commit the regenerated file:
 *
 *   node scripts/sync-guides.mjs
 *
 * For each guide: slug = filename without `.md`, title = the first `# `
 * heading (falls back to the slug), body = the full markdown source.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const guidesDir = join(repoRoot, "docs", "guides");
const outFile = join(repoRoot, "apps", "convex", "lib", "guides.ts");

/** Escape a string for embedding inside a TS template literal. */
function escapeTemplateLiteral(s) {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

const files = readdirSync(guidesDir)
  .filter((f) => f.endsWith(".md"))
  .sort();

if (files.length === 0) {
  console.error(`No guides found in ${guidesDir}`);
  process.exit(1);
}

const guides = files.map((file) => {
  const slug = basename(file, ".md");
  const body = readFileSync(join(guidesDir, file), "utf8");
  const heading = body.match(/^# (.+)$/m);
  const title = heading ? heading[1].trim() : slug;
  return { slug, title, body };
});

const entries = guides
  .map(
    (g) => `  {
    slug: ${JSON.stringify(g.slug)},
    title: ${JSON.stringify(g.title)},
    body: \`${escapeTemplateLiteral(g.body)}\`,
  },`,
  )
  .join("\n");

const output = `// GENERATED FILE — DO NOT EDIT.
//
// Source of truth: docs/guides/*.md (reviewed like code). Regenerate with:
//
//   node scripts/sync-guides.mjs
//
// These are the platform enablement guides, seeded into each chapter's \`docs\`
// table as markdown how-to docs (see \`seedPlatformGuides\` in convex/docs.ts).

export type PlatformGuide = {
  /** Stable key — the guide's filename without \`.md\`. */
  slug: string;
  /** The guide's first \`# \` heading. */
  title: string;
  /** Full markdown source. */
  body: string;
};

export const PLATFORM_GUIDES: PlatformGuide[] = [
${entries}
];
`;

writeFileSync(outFile, output);
console.log(
  `Wrote ${guides.length} guide(s) to ${outFile}: ${guides.map((g) => g.slug).join(", ")}`,
);
