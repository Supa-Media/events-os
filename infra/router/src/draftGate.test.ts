import { describe, expect, it } from "vitest";
import {
  DRAFT_COOKIE,
  decideDraftAccess,
  draftCookieHeader,
  draftToken,
  readCookie,
  safeEqual,
} from "./draftGate";

/**
 * The password gate in front of /blog/drafts/* — the only thing standing
 * between an unpublished post and anyone who guesses its URL. The properties
 * that matter: it fails CLOSED with no secret configured, the cookie is a
 * digest rather than the password itself, and a wrong password never lands
 * anywhere except back on the form.
 */

const PASSWORD = "shibboleth";

async function cookieFor(password: string): Promise<string> {
  return `${DRAFT_COOKIE}=${await draftToken(password)}`;
}

describe("draftToken", () => {
  it("is a 64-char lowercase hex digest", async () => {
    expect(await draftToken(PASSWORD)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never contains the password it was derived from", async () => {
    expect(await draftToken(PASSWORD)).not.toContain(PASSWORD);
  });

  it("is stable for one password and different for another", async () => {
    expect(await draftToken(PASSWORD)).toBe(await draftToken(PASSWORD));
    expect(await draftToken(PASSWORD)).not.toBe(await draftToken("other"));
  });
});

describe("safeEqual", () => {
  it("matches identical strings and rejects everything else", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "ab")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("readCookie", () => {
  it("finds a value among several cookies", () => {
    expect(readCookie(`other=1; ${DRAFT_COOKIE}=xyz; more=2`, DRAFT_COOKIE)).toBe(
      "xyz",
    );
  });

  it("returns null for a missing cookie or absent header", () => {
    expect(readCookie("other=1", DRAFT_COOKIE)).toBeNull();
    expect(readCookie(null, DRAFT_COOKIE)).toBeNull();
  });

  it("does not match a cookie whose name merely ends with the target", () => {
    expect(readCookie(`not_${DRAFT_COOKIE}=xyz`, DRAFT_COOKIE)).toBeNull();
  });
});

describe("decideDraftAccess", () => {
  it("fails closed when no DRAFT_PASSWORD is configured", async () => {
    // Even with a would-be-correct submission and cookie.
    expect(
      await decideDraftAccess({
        password: undefined,
        cookieHeader: await cookieFor(PASSWORD),
        submitted: PASSWORD,
      }),
    ).toEqual({ kind: "unavailable" });
  });

  it("challenges a visitor with no cookie and no password", async () => {
    expect(
      await decideDraftAccess({
        password: PASSWORD,
        cookieHeader: null,
        submitted: null,
      }),
    ).toEqual({ kind: "challenge", wrongPassword: false });
  });

  it("grants the digest — not the password — on a correct submission", async () => {
    const decision = await decideDraftAccess({
      password: PASSWORD,
      cookieHeader: null,
      submitted: PASSWORD,
    });
    expect(decision).toEqual({
      kind: "grant",
      token: await draftToken(PASSWORD),
    });
  });

  it("re-challenges a wrong password, flagged as wrong", async () => {
    expect(
      await decideDraftAccess({
        password: PASSWORD,
        cookieHeader: null,
        submitted: "guess",
      }),
    ).toEqual({ kind: "challenge", wrongPassword: true });
  });

  it("allows a valid cookie with nothing submitted", async () => {
    expect(
      await decideDraftAccess({
        password: PASSWORD,
        cookieHeader: await cookieFor(PASSWORD),
        submitted: null,
      }),
    ).toEqual({ kind: "allow" });
  });

  it("rejects a cookie holding the raw password rather than its digest", async () => {
    expect(
      await decideDraftAccess({
        password: PASSWORD,
        cookieHeader: `${DRAFT_COOKIE}=${PASSWORD}`,
        submitted: null,
      }),
    ).toEqual({ kind: "challenge", wrongPassword: false });
  });

  it("rotating the secret invalidates an outstanding cookie", async () => {
    expect(
      await decideDraftAccess({
        password: "rotated",
        cookieHeader: await cookieFor(PASSWORD),
        submitted: null,
      }),
    ).toEqual({ kind: "challenge", wrongPassword: false });
  });

  it("lets a submitted password override a stale cookie", async () => {
    // Without this, a rotated secret would strand anyone holding an old
    // cookie until they cleared it by hand.
    expect(
      await decideDraftAccess({
        password: "rotated",
        cookieHeader: await cookieFor(PASSWORD),
        submitted: "rotated",
      }),
    ).toEqual({ kind: "grant", token: await draftToken("rotated") });
  });

  it("treats an empty submission as no submission, not as a wrong password", async () => {
    expect(
      await decideDraftAccess({
        password: PASSWORD,
        cookieHeader: null,
        submitted: "",
      }),
    ).toEqual({ kind: "challenge", wrongPassword: false });
  });
});

describe("draftCookieHeader", () => {
  it("is HttpOnly, Lax, and scoped to the drafts prefix", () => {
    const header = draftCookieHeader("tok", true);
    expect(header).toContain(`${DRAFT_COOKIE}=tok`);
    expect(header).toContain("Path=/blog/drafts");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Secure");
  });

  it("omits Secure over http so `wrangler dev` works locally", () => {
    expect(draftCookieHeader("tok", false)).not.toContain("Secure");
  });
});
