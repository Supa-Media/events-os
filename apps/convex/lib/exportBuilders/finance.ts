/**
 * Export builder for the Finance dataset: `transactions` — the biggest table
 * this feature walks, and the only one whose money is real actuals (integer
 * cents) rather than an estimate.
 *
 * `transactions.chapterId` is `Id<"chapters"> | "central"` — the same union
 * `bctx.scope` carries — so this paginates `by_chapter_and_postedAt` with
 * `bctx.scope` directly (the dataset declares `supportsCentral: true`).
 *
 * See `./types.ts` for the one-`.paginate()`-per-`page()` rule this follows.
 */
import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { centsToDollars, isoOrBlank, type CsvColumn, type CsvValue } from "@events-os/shared";
import type { ExportBuilder, ExportBuilderContext, ExportPage } from "./types";

const TRANSACTION_COLUMNS: CsvColumn[] = [
  { key: "transaction_id", label: "Transaction ID" },
  { key: "date", label: "Date" },
  { key: "amount_dollars", label: "Amount ($)" },
  { key: "flow", label: "Flow" },
  { key: "description", label: "Description" },
  { key: "merchant_name", label: "Merchant" },
  { key: "fund_id", label: "Fund ID" },
  { key: "fund_name", label: "Fund" },
  { key: "category_id", label: "Category ID" },
  { key: "category_name", label: "Budget category" },
  { key: "person_id", label: "Person ID" },
  { key: "person_name", label: "Person name" },
  { key: "receipt_status", label: "Receipt status" },
  { key: "is_personal", label: "Personal" },
  { key: "is_excluded", label: "Excluded" },
  { key: "status", label: "Reconciliation state" },
  { key: "scope", label: "Scope" },
];

const transactionsBuilder: ExportBuilder = {
  datasetId: "transactions",
  async columns(): Promise<CsvColumn[]> {
    return TRANSACTION_COLUMNS;
  },
  async page(
    ctx: QueryCtx,
    bctx: ExportBuilderContext,
    cursor: string | null,
    numItems: number,
  ): Promise<ExportPage> {
    // dateRange on `postedAt`, honoured at the index — never scan-and-discard
    // on this table (it's the largest one this feature exports).
    const { from, to } = bctx.filters;
    const result = await ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_postedAt", (q) => {
        const withScope = q.eq("chapterId", bctx.scope);
        const withFrom = from !== undefined ? withScope.gte("postedAt", from) : withScope;
        return to !== undefined ? withFrom.lte("postedAt", to) : withFrom;
      })
      .paginate({ numItems, cursor });

    const txns = result.page;

    const fundIds = [
      ...new Set(txns.map((t) => t.fundId).filter((id): id is Id<"funds"> => !!id)),
    ];
    const fundNames = new Map<string, string>();
    for (const id of fundIds) {
      const fund = await ctx.db.get(id);
      if (fund) fundNames.set(id, fund.name);
    }

    const categoryIds = [
      ...new Set(
        txns.map((t) => t.categoryId).filter((id): id is Id<"budgetCategories"> => !!id),
      ),
    ];
    const categoryNames = new Map<string, string>();
    for (const id of categoryIds) {
      const category = await ctx.db.get(id);
      if (category) categoryNames.set(id, category.name);
    }

    const personIds = [
      ...new Set(txns.map((t) => t.personId).filter((id): id is Id<"people"> => !!id)),
    ];
    const personNames = new Map<string, string>();
    for (const id of personIds) {
      const person = await ctx.db.get(id);
      if (person) personNames.set(id, person.name);
    }

    const rows: Record<string, CsvValue>[] = txns.map((t) => ({
      transaction_id: t._id,
      date: isoOrBlank(t.postedAt),
      amount_dollars: centsToDollars(t.amountCents),
      flow: t.flow,
      description: t.description ?? "",
      merchant_name: t.merchantName ?? "",
      fund_id: t.fundId ?? "",
      fund_name: t.fundId ? (fundNames.get(t.fundId) ?? "") : "",
      category_id: t.categoryId ?? "",
      category_name: t.categoryId ? (categoryNames.get(t.categoryId) ?? "") : "",
      person_id: t.personId ?? "",
      person_name: t.personId ? (personNames.get(t.personId) ?? "") : "",
      receipt_status: t.receiptStorageId ? "attached" : "missing",
      is_personal: t.isPersonal === true,
      is_excluded: t.status === "excluded",
      status: t.status,
      scope: String(t.chapterId),
    }));

    return { rows, cursor: result.continueCursor, isDone: result.isDone };
  },
};

export const financeBuilders: ExportBuilder[] = [transactionsBuilder];
