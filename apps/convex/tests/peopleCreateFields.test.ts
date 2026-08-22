import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * `people.create` form-widening (Add Person modal, specs/add-person-modal-fields.md):
 * `create` gains the handful of args `update` already supported —
 * explicit `firstName`/`lastName` halves, `location`, `referralSource`,
 * `isVolunteer`, `marketingOptOut`, `notes` — so the Add Person modal can set
 * everything it collects in one mutation instead of create-then-patch.
 */

function readPerson(s: ChapterSetup, personId: Id<"people">) {
  return run(s.t, (ctx) => ctx.db.get(personId));
}

describe("people.create — explicit name halves", () => {
  test("stores explicit firstName/lastName instead of re-deriving them from name", async () => {
    const s = await setupChapter(newT());

    const personId = await s.as.mutation(api.people.create, {
      name: "Mary Jo Van Der Berg",
      firstName: "Mary Jo",
      lastName: "Van Der Berg",
    });

    const person = await readPerson(s, personId);
    expect(person?.firstName).toBe("Mary Jo");
    expect(person?.lastName).toBe("Van Der Berg");
  });

  test("falls back to automatic name-splitting when firstName/lastName are omitted", async () => {
    const s = await setupChapter(newT());

    const personId = await s.as.mutation(api.people.create, { name: "Ada Lovelace" });

    const person = await readPerson(s, personId);
    expect(person?.firstName).toBe("Ada");
    expect(person?.lastName).toBe("Lovelace");
  });
});

describe("people.create — the remaining form-widening fields", () => {
  test("persists location, referralSource, isVolunteer, marketingOptOut, and notes", async () => {
    const s = await setupChapter(newT());

    const personId = await s.as.mutation(api.people.create, {
      name: "Test Person",
      location: "Nyack NY",
      referralSource: "Instagram",
      isVolunteer: true,
      marketingOptOut: true,
      notes: "met at retreat",
    });

    const person = await readPerson(s, personId);
    expect(person?.location).toBe("Nyack NY");
    expect(person?.referralSource).toBe("Instagram");
    expect(person?.isVolunteer).toBe(true);
    expect(person?.marketingOptOut).toBe(true);
    expect(person?.notes).toBe("met at retreat");
  });

  test("leaves the five new fields unset when omitted", async () => {
    const s = await setupChapter(newT());

    const personId = await s.as.mutation(api.people.create, { name: "Plain Person" });

    const person = await readPerson(s, personId);
    expect(person?.location).toBeUndefined();
    expect(person?.referralSource).toBeUndefined();
    expect(person?.isVolunteer).toBeUndefined();
    expect(person?.marketingOptOut).toBeUndefined();
    expect(person?.notes).toBeUndefined();
  });
});
