// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals instead of adding a new dependency.
import { describe, expect, test } from "@jest/globals";
import { buildAddPersonArgs, EMPTY_ADD_PERSON_FORM } from "./addPersonForm.logic";
import type { AddPersonFormState } from "./addPersonForm.logic";

/**
 * `buildAddPersonArgs` turns the Add Person modal's raw form state into
 * `people.create` args: required-first-name validation, blank-field
 * omission (never send an empty string), numeric-rate parsing, comma-list
 * parsing, and always-explicit booleans for the three toggles.
 */
function form(overrides: Partial<AddPersonFormState>): AddPersonFormState {
  return { ...EMPTY_ADD_PERSON_FORM, ...overrides };
}

describe("buildAddPersonArgs", () => {
  test("returns an error and no args when first name is blank", () => {
    const result = buildAddPersonArgs(form({ firstName: "   " }));
    expect(result).toEqual({ error: expect.any(String) });
    expect("args" in result).toBe(false);
  });

  test("trims and composes the display name from first + last, omitting lastName when blank", () => {
    const result = buildAddPersonArgs(form({ firstName: " Ada ", lastName: " " }));
    expect(result.args?.name).toBe("Ada");
    expect(result.args?.firstName).toBe("Ada");
    expect("lastName" in (result.args ?? {})).toBe(false);
  });

  test("omits every optional text field left blank instead of sending empty strings", () => {
    const result = buildAddPersonArgs(
      form({
        firstName: "Ada",
        email: "",
        phone: "",
        role: "",
        company: "",
        pwEmail: "",
        pocName: "",
        socialLink: "",
        location: "",
        referralSource: "",
      }),
    );
    const args = result.args ?? {};
    for (const key of [
      "email",
      "phone",
      "role",
      "company",
      "pwEmail",
      "pocName",
      "socialLink",
      "location",
      "referralSource",
    ]) {
      expect(key in args).toBe(false);
    }
  });

  test("includes optional text fields that are set, trimmed", () => {
    const result = buildAddPersonArgs(
      form({ firstName: "Ada", email: " ada@example.com " }),
    );
    expect(result.args?.email).toBe("ada@example.com");
  });

  test("parses usualRateUsd into a number, omitting it when blank or non-numeric", () => {
    expect(
      buildAddPersonArgs(form({ firstName: "Ada", usualRateUsd: "450" })).args?.usualRateUsd,
    ).toBe(450);
    expect(
      "usualRateUsd" in
        (buildAddPersonArgs(form({ firstName: "Ada", usualRateUsd: "" })).args ?? {}),
    ).toBe(false);
    expect(
      "usualRateUsd" in
        (buildAddPersonArgs(form({ firstName: "Ada", usualRateUsd: "abc" })).args ?? {}),
    ).toBe(false);
  });

  test("splits projects/commsPreferences into deduped trimmed arrays, omitting when empty", () => {
    const withProjects = buildAddPersonArgs(
      form({ firstName: "Ada", projects: "Eden, Eden, Love Thy Neighbor" }),
    );
    expect(withProjects.args?.projects).toEqual(["Eden", "Love Thy Neighbor"]);

    const withoutComms = buildAddPersonArgs(form({ firstName: "Ada", commsPreferences: "" }));
    expect("commsPreferences" in (withoutComms.args ?? {})).toBe(false);
  });

  test("passes status/vettingStatus/gender/managerId through only when selected", () => {
    const none = buildAddPersonArgs(form({ firstName: "Ada" }));
    const noneArgs = none.args ?? {};
    for (const key of ["status", "vettingStatus", "gender", "managerId"]) {
      expect(key in noneArgs).toBe(false);
    }

    const set = buildAddPersonArgs(
      form({
        firstName: "Ada",
        status: "active",
        vettingStatus: "vetted",
        gender: "female",
        managerId: "person123" as AddPersonFormState["managerId"],
      }),
    );
    expect(set.args?.status).toBe("active");
    expect(set.args?.vettingStatus).toBe("vetted");
    expect(set.args?.gender).toBe("female");
    expect(set.args?.managerId).toBe("person123");
  });

  test("always includes isTeamMember/isVolunteer/marketingOptOut as explicit booleans", () => {
    const result = buildAddPersonArgs(form({ firstName: "Ada" }));
    expect(result.args?.isTeamMember).toBe(false);
    expect(result.args?.isVolunteer).toBe(false);
    expect(result.args?.marketingOptOut).toBe(false);
  });

  test("passes serviceIds through as given", () => {
    const result = buildAddPersonArgs(
      form({ firstName: "Ada", serviceIds: ["svc1"] as AddPersonFormState["serviceIds"] }),
    );
    expect(result.args?.serviceIds).toEqual(["svc1"]);
  });
});
