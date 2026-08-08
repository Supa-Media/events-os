import { describe, expect, test } from "@jest/globals";
import { initialGuestState } from "./loginHelpers";

describe("initialGuestState", () => {
  test("a present guestEmail param starts the screen in guest mode, pre-filled", () => {
    expect(initialGuestState("vol@example.com")).toEqual({
      mode: "guest",
      guestEmail: "vol@example.com",
    });
  });

  test("an absent guestEmail param preserves today's member-mode default", () => {
    expect(initialGuestState(undefined)).toEqual({ mode: "member", guestEmail: "" });
  });

  test("an empty guestEmail param preserves today's member-mode default", () => {
    expect(initialGuestState("")).toEqual({ mode: "member", guestEmail: "" });
  });
});
