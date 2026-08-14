import { describe, expect, test } from "vitest";
import { GIVE_CAMPAIGN_SCRIPT } from "../lib/givePageClient";

/**
 * THE GIVE PAGE'S BROWSER SCRIPT MUST AT LEAST PARSE.
 *
 * It is a string in a TypeScript template literal, so `tsc` checks nothing
 * inside it, no test imported it as code, and the only place a syntax error
 * showed up was a blank fee panel in a real browser — on the public giving
 * page, silently, for everyone.
 *
 * IT HAS ALREADY HAPPENED ONCE, in the least obvious way available: a lone
 * backslash. `'we\'ll'` is a correctly escaped JS string, but inside a template
 * literal TypeScript eats the backslash first and emits `'we'll'`, which is a
 * syntax error that takes the whole IIFE — and every fee surface, the rail
 * picker and the submit handler with it — down at parse time. Escapes meant for
 * the emitted JS have to be doubled (`\\'`, `\\d`, `\\$`), and nothing about
 * the source makes that visible.
 *
 * `new Function` compiles without executing, so this needs no DOM: a parse
 * error throws, anything else passes. Cheap, and it closes the whole class.
 *
 * NOT a check for backslashes in the source, which was the first instinct and
 * is wrong: `\'` in the EMITTED script is correct and necessary escaping. The
 * corruption is a backslash that disappeared, and what it leaves behind is
 * simply a script that doesn't parse.
 */
describe("the give page's client script", () => {
  test("parses as JavaScript", () => {
    expect(() => new Function(GIVE_CAMPAIGN_SCRIPT)).not.toThrow();
  });

  test("the escaping regression it exists for would fail it", () => {
    // Proof the guard has teeth, since a passing parse test looks identical
    // whether or not it is actually checking anything. This is the exact
    // corruption a lost backslash produces.
    const corrupted = GIVE_CAMPAIGN_SCRIPT.replace("var G=", "var G='unclosed;");
    expect(() => new Function(corrupted)).toThrow();
  });
});
