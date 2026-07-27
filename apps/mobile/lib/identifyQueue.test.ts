// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `components/money/duplicateMatch.test.ts`).
import { describe, expect, test } from "@jest/globals";
import {
  applySkipOrder,
  buildHighConfidenceQueue,
  candidateTagLine,
  evidenceLine,
  formatEventSummary,
  pickMergeDirection,
  pushToBack,
  type DuplicateMatchKind,
  type DuplicateRow,
  type NameMatchRow,
  type PersonCandidate,
} from "./identifyQueue";

function person(overrides: Partial<PersonCandidate> = {}): PersonCandidate {
  return {
    _id: "person1" as PersonCandidate["_id"],
    name: "Jamie Guest",
    email: null,
    phone: null,
    userId: null,
    isTeamMember: false,
    notes: null,
    status: null,
    role: null,
    company: null,
    createdAt: 0,
    ...overrides,
  };
}

describe("buildHighConfidenceQueue", () => {
  test("combines name-match and duplicate rows, duplicates first, with stable unique keys", () => {
    const nameMatches: NameMatchRow[] = [
      { guestNameKey: "jamie guest", displayName: "Jamie Guest", eventCount: 2, candidate: person({ _id: "p1" as any }) },
    ];
    const duplicates: DuplicateRow[] = [
      { matchKind: "phone", subject: person({ _id: "p2" as any }), candidate: person({ _id: "p3" as any }) },
    ];
    const queue = buildHighConfidenceQueue(nameMatches, duplicates);
    expect(queue).toHaveLength(2);
    expect(queue[0].kind).toBe("duplicate");
    expect(queue[1].kind).toBe("name_match");
    expect(new Set(queue.map((c) => c.key)).size).toBe(2);
  });

  test("empty buckets produce an empty queue", () => {
    expect(buildHighConfidenceQueue([], [])).toEqual([]);
  });
});

describe("applySkipOrder / pushToBack", () => {
  test("no skips leaves the original order untouched", () => {
    expect(applySkipOrder(["a", "b", "c"], (x) => x, [])).toEqual(["a", "b", "c"]);
  });

  test("a skipped item moves to the back", () => {
    expect(applySkipOrder(["a", "b", "c"], (x) => x, ["a"])).toEqual(["b", "c", "a"]);
  });

  test("multiple skips resurface in the order they were skipped, not source order", () => {
    // "c" was skipped BEFORE "a", so once the queue cycles, "c" comes back first.
    expect(applySkipOrder(["a", "b", "c"], (x) => x, ["c", "a"])).toEqual(["b", "c", "a"]);
  });

  test("a skip key for an item no longer present (resolved elsewhere) is silently dropped", () => {
    expect(applySkipOrder(["a", "b"], (x) => x, ["a", "gone"])).toEqual(["b", "a"]);
  });

  test("pushToBack re-skipping an already-skipped key doesn't duplicate it", () => {
    const skipped = pushToBack(pushToBack([], "a"), "a");
    expect(skipped).toEqual(["a"]);
  });

  test("pushToBack appends new skips after existing ones", () => {
    expect(pushToBack(["a"], "b")).toEqual(["a", "b"]);
  });
});

describe("pickMergeDirection", () => {
  test("a team member survives over a bare contact", () => {
    const subject = person({ _id: "contact" as any, isTeamMember: false });
    const candidate = person({ _id: "team" as any, isTeamMember: true });
    expect(pickMergeDirection(subject, candidate)).toEqual({ fromId: "contact", toId: "team" });
  });

  test("a person with a sign-in account outranks one without, even if neither is a team member", () => {
    const subject = person({ _id: "hasAccount" as any, userId: "u1" as any });
    const candidate = person({ _id: "noAccount" as any });
    expect(pickMergeDirection(subject, candidate)).toEqual({ fromId: "noAccount", toId: "hasAccount" });
  });

  test("a tie defaults to the candidate surviving, deterministically", () => {
    const subject = person({ _id: "s" as any });
    const candidate = person({ _id: "c" as any });
    expect(pickMergeDirection(subject, candidate)).toEqual({ fromId: "s", toId: "c" });
  });
});

describe("evidenceLine", () => {
  test("a name-match card always reads 'matching name'", () => {
    const card = {
      kind: "name_match" as const,
      key: "k",
      row: { guestNameKey: "x", displayName: "X", eventCount: 1, candidate: person() },
    };
    expect(evidenceLine(card)).toBe("matching name");
  });

  test.each([
    ["email", "same email address"],
    ["phone", "same phone number"],
    ["name", "same name"],
    ["similar", "similar name"],
  ] as [DuplicateMatchKind, string][])(
    "a duplicate card with matchKind=%s reads %s",
    (matchKind, expected) => {
      const card = {
        kind: "duplicate" as const,
        key: "k",
        row: { matchKind, subject: person(), candidate: person() },
      };
      expect(evidenceLine(card)).toBe(expected);
    },
  );
});

describe("candidateTagLine", () => {
  test("role + team member combine", () => {
    expect(candidateTagLine(person({ role: "Vocals", isTeamMember: true }))).toBe("Vocals · Team member");
  });
  test("company is used only when there's no role or team flag", () => {
    expect(candidateTagLine(person({ company: "Acme" }))).toBe("Acme");
  });
  test("falls back to Contact when nothing else is known", () => {
    expect(candidateTagLine(person())).toBe("Contact");
  });
});

describe("formatEventSummary", () => {
  test("matches the approved wireframe exactly", () => {
    expect(formatEventSummary(5, ["Eden", "Pop the Balloon"])).toBe("5 events · Eden, Pop the Balloon, +3");
  });
  test("singular event, no remainder", () => {
    expect(formatEventSummary(1, ["Eden"])).toBe("1 event · Eden");
  });
  test("no event names at all falls back to just the count", () => {
    expect(formatEventSummary(3, [])).toBe("3 events");
  });
});
