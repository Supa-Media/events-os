// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `reconcile/helpers.test.ts`).
import { describe, expect, test } from "@jest/globals";
import {
  centsToDollarsInput,
  snapshotReceiptForm,
  shouldReseedReceiptForm,
  type ReceiptFormFields,
  type ReceiptFormSnapshot,
} from "./helpers";

/**
 * BUG 1 — "retry/re-extract results only appear after closing & reopening
 * the modal." `ReceiptDetailModal` used to seed its local form state in a
 * `useEffect` gated on `seededFor !== receipt._id` — ONCE per receipt id.
 * `shouldReseedReceiptForm` is the pure decision extracted from the fix: it
 * decides whether a live `getReceipt` update should re-seed the open form,
 * WITHOUT ever clobbering an in-progress human edit. Tested directly since
 * RN component testing isn't set up for this package.
 */

function receipt(overrides: {
  _id?: string;
  amountCents?: number | null;
  receiptDate?: number | null;
  merchant?: string | null;
  note?: string | null;
}) {
  return {
    _id: "r1",
    amountCents: null,
    receiptDate: null,
    merchant: null,
    note: null,
    ...overrides,
  };
}

describe("snapshotReceiptForm", () => {
  test("maps null canonical fields to the form's empty representations", () => {
    expect(snapshotReceiptForm(receipt({ _id: "r1" }))).toEqual({
      receiptId: "r1",
      amountText: "",
      date: null,
      merchant: "",
      note: "",
    });
  });

  test("formats a populated receipt using the same money formatting as the input field", () => {
    const snap = snapshotReceiptForm(
      receipt({ _id: "r1", amountCents: 30386, receiptDate: 1234, merchant: "DoorDash", note: "lunch" }),
    );
    expect(snap).toEqual({
      receiptId: "r1",
      amountText: centsToDollarsInput(30386),
      date: 1234,
      merchant: "DoorDash",
      note: "lunch",
    });
  });
});

describe("shouldReseedReceiptForm", () => {
  const blankForm: ReceiptFormFields = { amountText: "", date: null, merchant: "", note: "" };

  test("a freshly opened receipt (no prior snapshot) always reseeds", () => {
    const server = snapshotReceiptForm(receipt({ _id: "r1", amountCents: 4210 }));
    expect(shouldReseedReceiptForm(blankForm, null, server)).toBe(true);
  });

  test("switching to a DIFFERENT receipt always reseeds, even mid-edit on the old one", () => {
    const lastSeeded: ReceiptFormSnapshot = {
      receiptId: "r1",
      amountText: "10.00",
      date: null,
      merchant: "",
      note: "",
    };
    // The human edited the amount on r1 (current diverges from lastSeeded)...
    const editedForm: ReceiptFormFields = { amountText: "99.00", date: null, merchant: "", note: "" };
    const serverForDifferentReceipt = snapshotReceiptForm(receipt({ _id: "r2", amountCents: 500 }));
    // ...but the modal has switched to a whole different receipt (r2) — the
    // new receipt's own values should always show, unconditionally.
    expect(shouldReseedReceiptForm(editedForm, lastSeeded, serverForDifferentReceipt)).toBe(true);
  });

  test("THE FIX: a retry that fills a previously-blank amount reseeds when the human hasn't touched the form", () => {
    // Amount starts blank (no OCR read yet) — this is what got seeded when
    // the modal first opened.
    const lastSeeded: ReceiptFormSnapshot = {
      receiptId: "r1",
      amountText: "",
      date: null,
      merchant: "",
      note: "",
    };
    // The human hasn't typed anything — the current form still equals what
    // was seeded.
    const untouchedForm: ReceiptFormFields = { ...lastSeeded };
    // A retry lands: the server now has an amount.
    const server = snapshotReceiptForm(
      receipt({ _id: "r1", amountCents: 30386, merchant: "DoorDash" }),
    );

    expect(shouldReseedReceiptForm(untouchedForm, lastSeeded, server)).toBe(true);
  });

  test("never clobbers an in-progress human edit on the SAME receipt", () => {
    const lastSeeded: ReceiptFormSnapshot = {
      receiptId: "r1",
      amountText: "",
      date: null,
      merchant: "",
      note: "",
    };
    // The human typed an amount themselves before any retry landed.
    const editedForm: ReceiptFormFields = { ...lastSeeded, amountText: "12.34" };
    // A retry lands concurrently with a DIFFERENT amount.
    const server = snapshotReceiptForm(receipt({ _id: "r1", amountCents: 30386 }));

    expect(shouldReseedReceiptForm(editedForm, lastSeeded, server)).toBe(false);
  });

  test("dirty check is whole-form: an edit on ANY field holds back a reseed of every field", () => {
    const lastSeeded: ReceiptFormSnapshot = {
      receiptId: "r1",
      amountText: "",
      date: null,
      merchant: "",
      note: "",
    };
    // Human only touched the note; amount is still exactly what was seeded.
    const editedForm: ReceiptFormFields = { ...lastSeeded, note: "ask Sam about this" };
    const server = snapshotReceiptForm(receipt({ _id: "r1", amountCents: 30386, merchant: "DoorDash" }));

    // Even though `amountText` itself still matches, the note diverges — the
    // whole form is considered dirty (matches the fix's spec: per-form, not
    // per-field).
    expect(shouldReseedReceiptForm(editedForm, lastSeeded, server)).toBe(false);
  });

  test("a no-op server refresh (nothing actually changed) is harmless to reseed", () => {
    const lastSeeded: ReceiptFormSnapshot = {
      receiptId: "r1",
      amountText: "42.10",
      date: null,
      merchant: "Costco",
      note: "",
    };
    const untouchedForm: ReceiptFormFields = { ...lastSeeded };
    const server = snapshotReceiptForm(
      receipt({ _id: "r1", amountCents: 4210, merchant: "Costco" }),
    );
    expect(shouldReseedReceiptForm(untouchedForm, lastSeeded, server)).toBe(true);
  });
});
