/**
 * A static guardrail for the two react-native-web defects #598 found and #600
 * / #602 fixed across the app.
 *
 * Why static: this app has no component-test runtime. `jest.config.js` runs in
 * a node environment with no jsdom and no renderer, and its own comment says
 * so ("this makes RN's pure helpers importable, NOT the component runtime").
 * The real evidence for these fixes is a browser measuring the rendered DOM,
 * which CI can't do — so the next best thing is refusing to let the SOURCE
 * pattern come back. This is the same shape as the `@supa-media/testing`
 * guardrails beside it: read the files, assert a rule.
 *
 * The two rules, both learned the hard way:
 *
 * 1. A control claiming `checkbox` / `switch` / `radio` must pass
 *    `aria-checked`. `accessibilityState={{ checked }}` is NOT in
 *    react-native-web 0.21.2's forwarded-prop list, so it reaches the DOM as
 *    nothing at all and a screen reader announces the control as permanently
 *    off. Measured on `main` before #598: `aria-checked` was literally `null`
 *    on all ~24 such controls.
 *
 * 2. It must also carry an accessible name. `SetupCard`'s feature switch — the
 *    one that turns ticketing on for an event — had none, because its label
 *    lives in a sibling pressable; it announced as "switch, off" with no clue
 *    WHICH feature. The name may be an `accessibilityLabel` or an
 *    `aria-label`.
 *
 * Both rules are satisfied for free by the shared `ui/Checkbox`, `ui/Switch`
 * and `ui/Radio`, which is the point: the exemptions below are those three
 * components themselves.
 */
const fs = require("fs");
const path = require("path");

const APP_ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set([
  "node_modules",
  ".expo",
  "dist",
  "build",
  ".playwright-mcp",
]);

/** The primitives that IMPLEMENT the rules — they're where `aria-checked` and
 *  the required-label prop live, so they define the pattern rather than
 *  following it. */
const PRIMITIVES = new Set([
  path.join("components", "ui", "Checkbox.tsx"),
  path.join("components", "ui", "CheckboxRow.tsx"),
  path.join("components", "ui", "Switch.tsx"),
  path.join("components", "ui", "RadioGroup.tsx"),
]);

/**
 * The one known offender, exempted deliberately rather than silently.
 *
 * The day-of task toggle is TRI-state (`todo → in_progress → done`) while
 * claiming `role="checkbox"` — the wrong role before `aria-checked` even
 * enters the picture, and a two-valued attribute can't describe it. Fixing the
 * role is a behaviour question (does it become a button with `aria-pressed`? a
 * three-way `radiogroup`?) that belongs with whoever owns that screen, not to
 * an ARIA sweep. Delete this entry when it's fixed — the rules apply to it
 * like everything else.
 */
const EXEMPT = new Set([path.join("app", "(app)", "event", "[id]", "day-of.tsx")]);

const TOGGLE_ROLE = /accessibilityRole=(?:"(checkbox|switch|radio)"|\{"(checkbox|switch|radio)"\})/g;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The source of the JSX element whose props contain `index`.
 *
 * Walks back to the element's `<`, then forward to the `>` that closes the
 * opening tag — tracking `{}` nesting and quotes so a `>` inside a prop
 * expression (a comparison, an arrow function) doesn't end the tag early.
 */
function openingTagAt(src, index) {
  let start = index;
  while (start > 0 && src[start] !== "<") start--;
  let depth = 0;
  let quote = null;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

describe("toggle controls carry the props react-native-web actually forwards", () => {
  const files = walk(APP_ROOT).filter((f) => {
    const rel = path.relative(APP_ROOT, f);
    return !PRIMITIVES.has(rel) && !EXEMPT.has(rel);
  });

  it("finds files to check", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("passes aria-checked, not only accessibilityState", () => {
    const offenders = [];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      for (const m of src.matchAll(TOGGLE_ROLE)) {
        const tag = openingTagAt(src, m.index);
        if (!/\baria-checked=/.test(tag)) {
          offenders.push(
            `${path.relative(APP_ROOT, file)}:${lineOf(src, m.index)} — role="${m[1] ?? m[2]}" with no aria-checked`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gives every toggle an accessible name", () => {
    const offenders = [];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      for (const m of src.matchAll(TOGGLE_ROLE)) {
        const tag = openingTagAt(src, m.index);
        if (!/\b(accessibilityLabel|aria-label)=/.test(tag)) {
          offenders.push(
            `${path.relative(APP_ROOT, file)}:${lineOf(src, m.index)} — role="${m[1] ?? m[2]}" with no accessible name`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
