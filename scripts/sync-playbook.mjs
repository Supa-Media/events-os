#!/usr/bin/env node
/**
 * Sync the planning playbook into the shared package.
 *
 * Reads `docs/agent.md` (the public worship event planning playbook — one
 * document for both the human lead and the AI agent) and generates
 * `packages/shared/src/playbook.ts`, exporting the full markdown as
 * `PLAYBOOK_MD`. The Convex assistant bakes it into its system prompt, so the
 * agent and the humans literally read the same manual (playbook Philosophy 11).
 *
 * Run from the repo root after editing docs/agent.md:
 *
 *   node scripts/sync-playbook.mjs
 *
 * and commit the regenerated playbook.ts alongside the doc change.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeTemplateLiteral } from "./lib/codegen.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(repoRoot, "docs", "agent.md");
const outPath = join(repoRoot, "packages", "shared", "src", "playbook.ts");

const markdown = readFileSync(sourcePath, "utf8");

const header = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * This is docs/agent.md (the worship event planning playbook) compiled into a
 * TypeScript constant so the AI assistant can bake it into its system prompt.
 *
 * To change the playbook, edit docs/agent.md and regenerate this file with:
 *
 *   node scripts/sync-playbook.mjs
 *
 * then commit both files together.
 */

/** The full planning playbook (docs/agent.md) as markdown. */
export const PLAYBOOK_MD = \`${escapeTemplateLiteral(markdown)}\`;
`;

writeFileSync(outPath, header);
console.log(
  `Wrote ${outPath} (${markdown.length} chars from ${sourcePath}).`,
);
