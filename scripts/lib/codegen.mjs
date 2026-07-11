/**
 * Shared helpers for the doc → TypeScript codegen scripts
 * (sync-guides.mjs, sync-playbook.mjs).
 */

/** Escape a string for embedding inside a TS backtick template literal. */
export function escapeTemplateLiteral(s) {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}
