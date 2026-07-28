import { describe, expect, test } from "@jest/globals";
import {
  newTemplateArgs,
  templateArchiveCopy,
  templateBlockCount,
  templateBlockSummary,
  templateDetailsPatch,
} from "./templateFields";

describe("templateDetailsPatch — the null-sentinel contract", () => {
  const current = { name: "Monthly newsletter", description: "The first-Tuesday send." };

  test("an untouched form sends nothing at all", () => {
    expect(
      templateDetailsPatch({ name: current.name, description: current.description }, current),
    ).toEqual({ ok: true, changed: false });
  });

  test("a renamed template sends only the name", () => {
    expect(
      templateDetailsPatch({ name: "  Monthly letter  ", description: current.description }, current),
    ).toEqual({ ok: true, changed: true, name: "Monthly letter" });
  });

  test("an EMPTIED description sends the explicit null that clears it", () => {
    // `undefined` would mean "leave the stored description alone", which is
    // the opposite of what clearing the field means.
    const patch = templateDetailsPatch({ name: current.name, description: "   " }, current);
    expect(patch).toEqual({ ok: true, changed: true, description: null });
  });

  test("a description added to a template that had none is sent as text", () => {
    expect(
      templateDetailsPatch(
        { name: "Welcome", description: "  Send to first-timers.  " },
        { name: "Welcome" },
      ),
    ).toEqual({ ok: true, changed: true, description: "Send to first-timers." });
  });

  test("a blank description on a template that never had one is a no-op", () => {
    expect(templateDetailsPatch({ name: "Welcome", description: "" }, { name: "Welcome" })).toEqual({
      ok: true,
      changed: false,
    });
  });

  test("a whitespace-only name is refused here, not round-tripped to the server", () => {
    const patch = templateDetailsPatch({ name: "   ", description: "" }, current);
    expect(patch.ok).toBe(false);
    if (!patch.ok) expect(patch.error).toMatch(/name/i);
  });
});

describe("newTemplateArgs — the design-only door in", () => {
  const existing = [
    { name: "Monthly newsletter", description: "First Tuesday." },
    { name: "Advent appeal" },
  ];

  test("a named template sends a trimmed name and no description", () => {
    expect(newTemplateArgs({ name: "  Welcome  ", description: "  " }, existing)).toEqual({
      ok: true,
      name: "Welcome",
    });
  });

  test("a description rides along, trimmed", () => {
    expect(
      newTemplateArgs({ name: "Welcome", description: "  For first-timers. " }, existing),
    ).toEqual({ ok: true, name: "Welcome", description: "For first-timers." });
  });

  test("a whitespace-only name is refused here, not round-tripped to the server", () => {
    const args = newTemplateArgs({ name: "  ", description: "" }, existing);
    expect(args.ok).toBe(false);
    if (!args.ok) expect(args.error).toMatch(/name/i);
  });

  test("a name already in the library is refused, however it's cased or spaced", () => {
    for (const name of ["Monthly newsletter", "  monthly NEWSLETTER "]) {
      const args = newTemplateArgs({ name, description: "" }, existing);
      expect(args.ok).toBe(false);
      if (!args.ok) expect(args.error).toMatch(/already/i);
    }
  });

  test("an empty library takes any name", () => {
    expect(newTemplateArgs({ name: "First one", description: "" }, [])).toEqual({
      ok: true,
      name: "First one",
    });
  });
});

describe("templateBlockSummary", () => {
  const doc = {
    blocks: [
      { id: "a", kind: "heading", text: "Hi" },
      { id: "b", kind: "text", markdown: "..." },
      { id: "c", kind: "text", markdown: "..." },
      { id: "d", kind: "image", url: "x", alt: "" },
      { id: "e", kind: "button", label: "Go", url: "x" },
    ],
  };

  test("counts blocks and names the distinct kinds it starts with", () => {
    expect(templateBlockSummary(doc)).toBe("5 blocks · Heading, Text, Image and 1 more");
  });

  test("stops naming kinds once the line would spill", () => {
    expect(templateBlockSummary(doc, 5)).toBe("5 blocks · Heading, Text, Image, Button");
  });

  test("a single block reads in the singular", () => {
    expect(templateBlockSummary({ blocks: [{ id: "a", kind: "poll", question: "?" }] })).toBe(
      "1 block · Poll",
    );
  });

  test("a malformed or empty doc lists rather than crashing the library", () => {
    // `doc` is `v.any()` on the row — a document written before a rule
    // existed must still render a row.
    expect(templateBlockSummary(undefined)).toBe("Empty template");
    expect(templateBlockSummary({})).toBe("Empty template");
    expect(templateBlockSummary({ blocks: "nope" })).toBe("Empty template");
    expect(templateBlockCount({ blocks: [{}, {}] })).toBe(2);
    expect(templateBlockSummary({ blocks: [{}, {}] })).toBe("2 blocks");
  });
});

describe("templateArchiveCopy", () => {
  test("an ordinary template just warns that it disappears for everyone", () => {
    const copy = templateArchiveCopy("Advent appeal", false);
    expect(copy.message).toContain("Advent appeal");
    expect(copy.message).not.toMatch(/permanent/i);
  });

  test("a BUILT-IN says plainly that it isn't coming back", () => {
    // `ensureBuiltInTemplates` deliberately never resurrects an archived
    // built-in, which is what makes removal effectively permanent.
    const copy = templateArchiveCopy("Public Worship Newsletter", true);
    expect(copy.message).toMatch(/permanent/i);
    expect(copy.message).toMatch(/updates will not bring it back/i);
  });

  test("both promise that campaigns already made from it are untouched", () => {
    for (const isBuiltIn of [true, false]) {
      expect(templateArchiveCopy("X", isBuiltIn).message).toMatch(/already created from it/i);
    }
  });
});
