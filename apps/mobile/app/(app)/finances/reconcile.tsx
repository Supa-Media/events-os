/**
 * RECONCILE — the bookkeeper/manager inbox for coding & clearing transactions.
 *
 * A two-pane workspace (built to the `finances.html` Reconcile tab): a filtered
 * transaction list on the left, a sticky detail on the right that stacks on
 * mobile. Each charge gets coded to a fund + category (`categorizeTransaction`),
 * can take an AI-proposed coding (`suggestCoding` → `acceptSuggestion`), and
 * carries a receipt-reminder schedule.
 *
 * Reconciliation is finance-manager/bookkeeper territory, so this screen is
 * gated admin-or-lead in-screen (mirroring the finances nav gate); the real,
 * finer finance-role check is enforced server-side on every mutation.
 */
import { useEffect, useMemo, useState } from "react";
import { View, Text, Platform, Alert, useWindowDimensions } from "react-native";
import { useQuery, useMutation, useAction, usePaginatedQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Button,
  EmptyState,
  Narrow,
  Pill,
  Screen,
  ToastView,
} from "../../../components/ui";
import { useActionRunner } from "../../../lib/useActionToast";
import { ReconcileList } from "../../../components/finance/reconcile/ReconcileList";
import { ReconcileDetail } from "../../../components/finance/reconcile/ReconcileDetail";
import {
  FILTERS,
  stateForStatus,
  type CodingSuggestion,
  type FilterKey,
} from "../../../components/finance/reconcile/helpers";

const TWO_PANE_MIN_WIDTH = 900;

// Web `position: sticky` isn't in RN's ViewStyle types; the app targets web too.
const STICKY = Platform.OS === "web" ? ({ position: "sticky", top: 16 } as never) : undefined;

/** Cross-platform, non-blocking-ish notice for the few info-only edges. */
function notify(title: string, message: string) {
  if (Platform.OS === "web") window.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}

export default function ReconcileScreen() {
  const org = useQuery(api.org.nav);
  const { results, status, loadMore } = usePaginatedQuery(
    api.finances.listTransactions,
    {},
    { initialNumItems: 50 },
  );
  const funds = useQuery(api.finances.listFunds) ?? [];
  const categories = useQuery(api.finances.listCategories, {}) ?? [];

  const categorize = useMutation(api.finances.categorizeTransaction);
  const acceptSuggestion = useMutation(api.aiCodingData.acceptSuggestion);
  const suggestCoding = useAction(api.aiCoding.suggestCoding);
  const { run, toast, dismiss } = useActionRunner();

  const [activeFilter, setActiveFilter] = useState<FilterKey>("needs_review");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { width } = useWindowDimensions();
  const twoPane = width >= TWO_PANE_MIN_WIDTH;

  // The inbox = every non-excluded transaction; pills narrow it by derived state.
  const inbox = useMemo(
    () => results.filter((r) => r.status !== "excluded"),
    [results],
  );
  const filterState = FILTERS.find((f) => f.key === activeFilter)!.state;
  const filtered = useMemo(
    () => inbox.filter((r) => stateForStatus(r.status) === filterState),
    [inbox, filterState],
  );
  const clearCount = useMemo(
    () => inbox.filter((r) => stateForStatus(r.status) !== "ready").length,
    [inbox],
  );

  // Auto-select the first visible row on the two-pane layout so the detail is
  // never empty; keep the selection valid as the filter/data changes.
  useEffect(() => {
    if (!twoPane) return;
    if (filtered.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !filtered.some((r) => r.id === selectedId)) {
      setSelectedId(filtered[0].id);
    }
  }, [twoPane, filtered, selectedId]);

  const selected = useMemo(
    () => inbox.find((r) => r.id === selectedId) ?? null,
    [inbox, selectedId],
  );

  const fundOpts = funds.map((f) => ({ id: f.id, name: f.name }));
  const catOpts = categories.map((c) => ({
    id: c.id,
    name: c.name,
    fundId: c.fundId,
  }));

  // In-screen guard: reconcile is admin-or-lead (finance-manager/bookkeeper).
  const tier = org?.tier;
  if (org !== undefined && tier !== "admin" && tier !== "lead") {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            title="Reconcile is restricted"
            message="Only chapter admins and leads can reconcile transactions."
          />
        </Narrow>
      </Screen>
    );
  }

  if (org === undefined) return <Screen loading />;

  const loadingFirst = status === "LoadingFirstPage";

  function renderDetail() {
    if (!selected) {
      return (
        <EmptyState
          title="Select a transaction"
          message="Pick a charge from the inbox to code it and clear the receipt."
        />
      );
    }
    return (
      <ReconcileDetail
        row={selected}
        funds={fundOpts}
        categories={catOpts}
        onSaveCoding={(fundId, categoryId) =>
          run(
            () =>
              categorize({
                transactionId: selected.id,
                fundId: fundId as Id<"funds"> | null,
                categoryId: categoryId as Id<"budgetCategories"> | null,
              }),
            { errorTitle: "Couldn't save coding" },
          ).then(() => {})
        }
        onAccept={() =>
          run(() => acceptSuggestion({ transactionId: selected.id }), {
            errorTitle: "Couldn't reconcile",
          }).then(() => {})
        }
        onRequestSuggestion={async () => {
          const result = await run(
            () => suggestCoding({ transactionId: selected.id }),
            { errorTitle: "Couldn't get a suggestion" },
          );
          if (result === undefined) return null; // threw — already surfaced
          if (result === null) {
            notify(
              "No AI suggestion",
              "The model didn't propose a coding (AI may not be configured for this chapter).",
            );
            return null;
          }
          return result as CodingSuggestion;
        }}
        onUploadReceipt={() =>
          notify(
            "Receipt upload",
            "Capturing and matching receipts ships with the receipts release.",
          )
        }
      />
    );
  }

  return (
    <>
      <Screen maxWidth={1180}>
        {/* Header — inbox title + "N to clear". */}
        <View className="mb-1 flex-row items-baseline gap-2">
          <Text className="font-display text-2xl text-ink">Reconcile</Text>
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            {clearCount} to clear
          </Text>
        </View>
        <Text className="mb-4 text-sm text-muted">
          Review each charge, code it to a fund and category, and confirm the
          receipt. AI proposes a coding — you confirm.
        </Text>

        {/* Filter pills. */}
        <View className="mb-4 flex-row flex-wrap gap-2">
          {FILTERS.map((f) => (
            <Pill
              key={f.key}
              label={f.label}
              selected={activeFilter === f.key}
              onPress={() => setActiveFilter(f.key)}
            />
          ))}
        </View>

        {loadingFirst ? (
          <View className="py-14">
            <EmptyState title="Loading transactions…" />
          </View>
        ) : inbox.length === 0 ? (
          <EmptyState
            icon="check-circle"
            title="You're all caught up"
            message="Every charge is coded and reconciled. New transactions land here to review."
          />
        ) : twoPane ? (
          <View className="flex-row items-start gap-4">
            <View style={{ flexBasis: 0, flexGrow: 1.15 }}>
              {filtered.length === 0 ? (
                <EmptyState
                  title="Nothing in this view"
                  message="Try another filter to see more transactions."
                />
              ) : (
                <ReconcileList
                  rows={filtered}
                  selectedId={selectedId}
                  onSelect={(row) => setSelectedId(row.id)}
                />
              )}
            </View>
            <View style={[{ flexBasis: 0, flexGrow: 0.85 }, STICKY]}>
              {renderDetail()}
            </View>
          </View>
        ) : (
          <View className="gap-4">
            {filtered.length === 0 ? (
              <EmptyState
                title="Nothing in this view"
                message="Try another filter to see more transactions."
              />
            ) : (
              <ReconcileList
                rows={filtered}
                selectedId={selectedId}
                onSelect={(row) => setSelectedId(row.id)}
              />
            )}
            {selected ? renderDetail() : null}
          </View>
        )}

        {status === "CanLoadMore" ? (
          <View className="mt-4 items-center">
            <Button
              title="Load more"
              variant="secondary"
              size="sm"
              onPress={() => loadMore(50)}
            />
          </View>
        ) : null}
      </Screen>
      <ToastView toast={toast} onDismiss={dismiss} />
    </>
  );
}
