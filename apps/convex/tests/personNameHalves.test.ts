import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";


/**
 * Giving a LAST NAME to a person who has none.
 *
 * `splitPersonName` only splits an exactly-two-token name, so a mononym
 * ("Cher") or a 3+-token name ("Mary Jo Van Der Berg") is stored with NO
 * halves at all. The People grid used to render that row's Last Name cell as
 * a dead em-dash that named no way forward, so in the grid the column just
 * looked broken. The cell is editable now, which puts the burden on
 * `people.update`: composing a display name from a last name alone would wipe
 * "Mary Jo Van Der Berg" down to "Van Der Berg".
 *
 * The rule (`firstNameForDesignatedLast`) reads the typist's intent from
 * whether the surname is already the tail of the display name: designating an
 * existing tail preserves the display name exactly, adding a brand-new
 * surname grows it by one token.
 */

async function seedPerson(
  s: ChapterSetup,
  fields: Partial<Doc<"people">> & { name: string },
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      createdAt: Date.now(),
      ...fields,
    }),
  );
}

function readPerson(s: ChapterSetup, personId: Id<"people">) {
  return run(s.t, (ctx) => ctx.db.get(personId));
}
describe("people.update — a last name on an unsplit person", () => {
  test("a mononym GAINS the surname and keeps its name as the first half", async () => {
    const s = await setupChapter(newT());
    const personId = await seedPerson(s, { name: "Cher" });

    await s.as.mutation(api.people.update, { personId, lastName: "Sarkisian" });

    const person = await readPerson(s, personId);
    expect(person?.firstName).toBe("Cher");
    expect(person?.lastName).toBe("Sarkisian");
    expect(person?.name).toBe("Cher Sarkisian");
  });

  test("designating the tail of a 3+-token name PRESERVES the display name", async () => {
    const s = await setupChapter(newT());
    const personId = await seedPerson(s, { name: "Mary Jo Van Der Berg" });

    await s.as.mutation(api.people.update, { personId, lastName: "Van Der Berg" });

    const person = await readPerson(s, personId);
    expect(person?.firstName).toBe("Mary Jo");
    expect(person?.lastName).toBe("Van Der Berg");
    // The whole point: naming the surname must not rewrite who they are.
    expect(person?.name).toBe("Mary Jo Van Der Berg");
  });

  test("a surname the display name never contained is appended, not substituted", async () => {
    const s = await setupChapter(newT());
    const personId = await seedPerson(s, { name: "Ama (Gina) Oppong" });

    await s.as.mutation(api.people.update, { personId, lastName: "Asante" });

    const person = await readPerson(s, personId);
    expect(person?.firstName).toBe("Ama (Gina) Oppong");
    expect(person?.lastName).toBe("Asante");
    expect(person?.name).toBe("Ama (Gina) Oppong Asante");
    // The regression this guards: composing from the surname alone.
    expect(person?.name).not.toBe("Asante");
  });

  test("an explicit firstName in the same call still wins over the derivation", async () => {
    const s = await setupChapter(newT());
    const personId = await seedPerson(s, { name: "Mary Jo Van Der Berg" });

    await s.as.mutation(api.people.update, {
      personId,
      firstName: "Mary",
      lastName: "Van Der Berg",
    });

    const person = await readPerson(s, personId);
    expect(person?.firstName).toBe("Mary");
    expect(person?.name).toBe("Mary Van Der Berg");
  });

  test("an explicit firstName CLEAR is respected, not quietly re-derived", async () => {
    const s = await setupChapter(newT());
    const personId = await seedPerson(s, { name: "Cher" });

    await s.as.mutation(api.people.update, {
      personId,
      firstName: null,
      lastName: "Sarkisian",
    });

    const person = await readPerson(s, personId);
    expect(person?.firstName).toBeUndefined();
    expect(person?.lastName).toBe("Sarkisian");
    expect(person?.name).toBe("Sarkisian");
  });
});

describe("people.update — existing half-editing behaviour is unchanged", () => {
  test("an already-split person edits one half without disturbing the other", async () => {
    const s = await setupChapter(newT());
    const personId = await seedPerson(s, {
      name: "Ada Lovelace",
      firstName: "Ada",
      lastName: "Lovelace",
    });

    await s.as.mutation(api.people.update, { personId, lastName: "Byron" });

    const person = await readPerson(s, personId);
    expect(person?.firstName).toBe("Ada");
    expect(person?.lastName).toBe("Byron");
    expect(person?.name).toBe("Ada Byron");
  });

  test("clearing a last name drops the half without borrowing one back", async () => {
    const s = await setupChapter(newT());
    const personId = await seedPerson(s, {
      name: "Ada Lovelace",
      firstName: "Ada",
      lastName: "Lovelace",
    });

    await s.as.mutation(api.people.update, { personId, lastName: null });

    const person = await readPerson(s, personId);
    expect(person?.firstName).toBe("Ada");
    expect(person?.lastName).toBeUndefined();
    expect(person?.name).toBe("Ada");
  });

  test("a person already carrying ONE half gets no first name invented for them", async () => {
    // The derivation is deliberately scoped to records with no halves at all —
    // the exact rows the grid used to render as a dead dash. A half-split
    // record (a `lastName`-only import, say) stays on its existing path.
    const s = await setupChapter(newT());
    const personId = await seedPerson(s, { name: "Van Der Berg", lastName: "Van Der Berg" });

    await s.as.mutation(api.people.update, { personId, lastName: "Berg" });

    const person = await readPerson(s, personId);
    expect(person?.firstName).toBeUndefined();
    expect(person?.lastName).toBe("Berg");
    expect(person?.name).toBe("Berg");
  });

  test("an empty-string last name on an unsplit person is a no-op, not a rename", async () => {
    const s = await setupChapter(newT());
    const personId = await seedPerson(s, { name: "Mary Jo Van Der Berg" });

    await s.as.mutation(api.people.update, { personId, lastName: "   " });

    const person = await readPerson(s, personId);
    expect(person?.firstName).toBeUndefined();
    expect(person?.lastName).toBeUndefined();
    expect(person?.name).toBe("Mary Jo Van Der Berg");
  });
});
