/**
 * A MEMBER-FACING SCREEN MAY NOT MOUNT A ROLE-GATED QUERY WITH `useQuery`.
 *
 * `useQuery` THROWS a refusal during render. React does not treat that as a
 * failed read — it treats it as a failed component, unwinds to the root
 * `ErrorBoundary`, and replaces the whole page. On `/code`, whose entire
 * audience is volunteers with no finance seat, that turns one over-tight gate
 * into "Something went wrong" over the only screen they have.
 *
 * It has happened three times, each time invisible to the last check:
 *
 *   1. `receipts.listReceipts` behind the library-search picker. Fixed by
 *      making `ReceiptCell`'s `libraryPicker` prop REQUIRED — the default was
 *      what made the miss invisible.
 *   2. `receipts.listForTransaction` behind the "Attached ✓" chip, one control
 *      to the right of that same fix. It renders only once a receipt exists,
 *      so no fresh fixture ever reached it.
 *   3. `finances.financeAuditTrail` behind the history strip, which answers
 *      `[]` for an empty log BEFORE its gate and refuses once there is
 *      anything to show. Every fixture took the first path; a charge with an
 *      attached receipt took the second, and the coding sheet died on open.
 *
 * The pattern is not any one query. It is that these components are tested,
 * and demoed, against charges too fresh to have the state that trips the gate.
 * So this checks the SHAPE instead: on the member coding surface, a gated
 * query is read through `useQueries` (which returns the failure) or not at
 * all. Textual, like the native-import guardrails next door, and for the same
 * reason — the thing being prevented is a whole class, not an instance.
 *
 * Adding a query here is a claim that the server may refuse it for a caller
 * with no finance seat. Removing one is a claim that it never can.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/** Queries the server may refuse a member — see each one's own gate. */
const GATED_QUERIES = [
  "api.finances.financeAuditTrail",
  "api.receipts.listForTransaction",
  "api.receipts.listReceipts",
  "api.receipts.suggestedForTransaction",
  "api.receipts.suggestMatches",
  "api.receipts.searchUnreceiptedTransactions",
];

/**
 * Every component the `/code` page can mount, directly or through the coding
 * sheet. Kept explicit rather than crawled: the list IS the claim about what a
 * seatless volunteer can reach, and it should have to be edited on purpose.
 */
const MEMBER_SURFACE = [
  "components/finance/code/CodePage.tsx",
  "components/finance/myTransactions/ChargeRow.tsx",
  "components/finance/myTransactions/FinishChargeSheet.tsx",
  "components/finance/myTransactions/CodingDocumentation.tsx",
  "components/finance/myTransactions/receiptSuggestions.ts",
  "components/finance/coding/CodingFieldSet.tsx",
  "components/finance/coding/TransactionHistoryCompact.tsx",
  "components/finance/receipts/ReceiptViewerModal.tsx",
  "components/finance/modals/ReceiptExceptionModal.tsx",
  "components/finance/cards/MemberCardsView.tsx",
];

describe("member coding surface", () => {
  test("the files it mounts all exist (the list is a claim, so it must be true)", () => {
    for (const rel of MEMBER_SURFACE) {
      expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
    }
  });

  test("no role-gated query is read with useQuery — a refusal must not cost the page", () => {
    const offenders = [];
    for (const rel of MEMBER_SURFACE) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      // Strip block and line comments: these files document the very crashes
      // this test prevents, and quoting `useQuery(api.x.y)` in a comment about
      // what NOT to do must not fail the check.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const q of GATED_QUERIES) {
        // `useQuery(api.a.b` with any whitespace/newlines between.
        const re = new RegExp(
          `useQuery\\s*\\(\\s*${q.replace(/\./g, "\\.")}\\b`,
        );
        if (re.test(code)) offenders.push(`${rel} → useQuery(${q})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
