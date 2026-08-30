/**
 * A static guardrail for a NativeWind failure mode that is invisible until you
 * look at the running app.
 *
 * NativeWind v4 styles a component by wrapping it (`cssInterop`). It ships
 * wrappers for the React Native primitives — `View`, `Text`, `Pressable`,
 * `ScrollView`, `Image` — but NOT for the `Animated.*` versions of them.
 * A `className` on an `<Animated.View>` is therefore accepted by the type
 * checker, accepted by the bundler, and then silently dropped at render: no
 * warning, no error, just an element with none of the styles you asked for.
 *
 * Found the hard way while building the bottom sheet: `<Animated.View
 * className="absolute inset-0 bg-scrim">` produced a scrim with no color and
 * no positioning, and `<Animated.View className="rounded-t-xl bg-sunken">`
 * produced a fully transparent sheet — the menu rows floated over an undimmed
 * page, and every separator and section label sat directly on top of whatever
 * the user had been reading. It looked like a z-index bug for a while.
 *
 * The rule: anything animated styles itself through `style={{ ... }}` using the
 * tokens in `lib/theme.ts` (the same values the classes compile from). Static
 * children inside an `Animated.*` wrapper keep using `className` as normal —
 * only the animated element itself is affected.
 *
 * Same shape as `toggleAria.test.js` beside it: this app has no component test
 * runtime (`jest.config.js` is a node environment with no jsdom and no
 * renderer), so the enforceable thing is the source pattern.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SCANNED = ["app", "components"];

/** Every .tsx file under the scanned roots. */
function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      sourceFiles(full, out);
    } else if (entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Opening `<Animated.Foo ... >` tags, with their attribute list. Non-greedy up
 * to the first `>` that isn't inside braces or a string is more parsing than
 * this needs — an `Animated.*` tag whose props span to the next `>` is close
 * enough, because a false positive here is a `className` we'd want to look at
 * anyway.
 */
const ANIMATED_TAG = /<Animated\.[A-Za-z]+((?:[^<>]|=>)*?)\/?>/g;

describe("NativeWind cannot style Animated.* — use style={{...}} there", () => {
  const files = SCANNED.flatMap((d) => sourceFiles(path.join(ROOT, d)));

  it("scans a non-trivial number of files", () => {
    // Guards against a refactor that moves the source tree and quietly turns
    // this whole suite into a no-op.
    expect(files.length).toBeGreaterThan(100);
  });

  it("finds no className on an Animated.* element", () => {
    const offenders = [];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      for (const match of src.matchAll(ANIMATED_TAG)) {
        if (/\bclassName\s*=/.test(match[1])) {
          const line = src.slice(0, match.index).split("\n").length;
          offenders.push(`${path.relative(ROOT, file)}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
