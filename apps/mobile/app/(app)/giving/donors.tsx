/**
 * GIVING · Donors — the scope's donor list, sorted by lifetime giving (the
 * "top donors" relationship workflow needs this ordering on day one, PRD §1).
 *
 * Giving-dashboard v2 CRM: the four stacked chip rows are replaced by compact
 * `FilterSelect` dropdowns (status / kind / source / lifetime band). A CENTRAL
 * holder also gets a SCOPE dropdown — All chapters / Central / each chapter —
 * where "All chapters" runs `listDonors`'s central-gated all-scopes merge (each
 * row tagged with its chapter). A chapter-only viewer sees neither the scope
 * dropdown nor the fleet — they stay locked to their own chapter. Tapping a row
 * opens the donor detail. The backend `listDonors` gates on `requireGivingView`.
 */
import { useState } from "react";
import { ActivityIndicator, View, Text, Pressable } from "react-native";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  type BadgeTone,
  EmptyState,
  FilterSelect,
  type FilterSelectOption,
  Icon,
  Narrow,
  Screen,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { useGivingScope } from "../../../lib/useGivingScope";
import { DonorDuplicatesSheet } from "../../../components/giving/DonorDuplicatesSheet";
import {
  ALL_SCOPES_VALUE,
  anyFilterActive,
  buildListDonorsArgs,
} from "../../../components/giving/dashboard/donorFilters";

type GivingScope = "central" | Id<"chapters">;

// ── CRM filters (territories P5) ────────────────────────────────────────────
// Hardcoded, mirroring `donor/[id].tsx`'s `SOURCE_OPTIONS` — mobile doesn't
// import the convex-side schema literals directly, so the option lists are
// kept in step with `schema/givingPlatform.ts`'s `DONOR_STATUSES`/
// `DONOR_KINDS`/`DONOR_SOURCES` by hand (small, stable unions).

const STATUS_FILTERS: FilterSelectOption[] = [
  { value: "all", label: "All" },
  { value: "prospect", label: "Prospect" },
  { value: "active", label: "Active" },
  { value: "lapsed", label: "Lapsed" },
];

const KIND_FILTERS: FilterSelectOption[] = [
  { value: "all", label: "All kinds" },
  { value: "individual", label: "Individual" },
  { value: "church", label: "Church" },
  { value: "business", label: "Business" },
  { value: "foundation", label: "Foundation" },
];

const SOURCE_FILTERS: FilterSelectOption[] = [
  { value: "all", label: "All sources" },
  { value: "manual", label: "Manual" },
  { value: "event-donation", label: "Event donation" },
  { value: "givebutter-import", label: "Givebutter" },
  { value: "map", label: "Map" },
];

// Lifetime bands (dollars, converted to cents for the query arg — see
// `donorFilters.LIFETIME_BAND_CENTS`).
const LIFETIME_BANDS: FilterSelectOption[] = [
  { value: "all", label: "Any amount" },
  { value: "100", label: "$100+" },
  { value: "500", label: "$500+" },
  { value: "1000", label: "$1k+" },
];

/** Donor status → chip tone: active reads calm, lapsed warns (reactivation
 *  queue), prospect is neutral (no gift yet). */
export function donorStatusTone(status: string): BadgeTone {
  if (status === "active") return "success";
  if (status === "lapsed") return "warn";
  return "neutral";
}

export default function DonorsScreen() {
  // WP-S follow-up: the app's chapter lens — see `useGivingScope`'s own doc.
  const chapterId = useGivingScope();
  const access = useQuery(api.givingPlatform.myGivingAccess, { chapterId });

  if (access === undefined) return <Screen loading />;
  if (!access.canView || access.scope === null) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Development desk access needed"
            message="Ask a development director to grant you access to the giving desk."
          />
        </Narrow>
      </Screen>
    );
  }
  return (
    <DonorsBody
      lensScope={access.scope}
      isCentral={access.isCentral}
      canManage={access.canManage}
    />
  );
}

function DonorsBody({
  lensScope,
  isCentral,
  canManage,
}: {
  lensScope: GivingScope;
  isCentral: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState("all");
  const [kind, setKind] = useState("all");
  const [source, setSource] = useState("all");
  const [band, setBand] = useState("all");
  // The scope selector (central holders only): a chapter id, "central", or the
  // all-scopes sentinel. Defaults to the app lens's own scope.
  const [scopeSel, setScopeSel] = useState<string>(lensScope);
  // Duplicate review + merge — manage-gated (Attendance C).
  const [dupOpen, setDupOpen] = useState(false);

  // Central holders get a scope dropdown built from the fleet (central + each
  // active chapter). Skipped for chapter-only viewers (never central-gated).
  const fleet = useQuery(
    api.givingPlatform.dashboardFleet,
    isCentral ? {} : "skip",
  );
  const scopeOptions: FilterSelectOption[] = [
    { value: ALL_SCOPES_VALUE, label: "All chapters" },
    ...(fleet?.scopes ?? []).map((s) => ({ value: s.scope, label: s.name })),
  ];

  const filters = { status, kind, source, band };
  const args = buildListDonorsArgs(filters, isCentral ? scopeSel : lensScope);
  const donors = useQuery(api.givingPlatform.listDonors, args as never);

  const isAllScopes = isCentral && scopeSel === ALL_SCOPES_VALUE;
  const filtersActive = anyFilterActive(filters);

  if (donors === undefined) {
    return (
      <View className="items-center justify-center py-16">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <Screen>
      <Narrow>
        {canManage && !isAllScopes ? (
          <View className="mb-2 flex-row items-center justify-end">
            <Pressable
              onPress={() => setDupOpen(true)}
              hitSlop={6}
              accessibilityLabel="Review duplicate donors"
              className="flex-row items-center gap-1 rounded-md border border-border px-2 py-1 active:bg-sunken web:hover:bg-sunken"
            >
              <Icon name="copy" size={13} color={colors.muted} />
              <Text className="text-xs font-semibold text-muted">Duplicates</Text>
            </Pressable>
          </View>
        ) : null}

        {/* CRM filter row — compact dropdowns, wrapping. */}
        <View className="mb-3 flex-row flex-wrap items-center gap-2">
          {isCentral ? (
            <FilterSelect
              label="Scope"
              value={scopeSel}
              options={scopeOptions}
              onChange={setScopeSel}
              minWidth={220}
            />
          ) : null}
          <FilterSelect label="Status" value={status} options={STATUS_FILTERS} onChange={setStatus} />
          <FilterSelect label="Kind" value={kind} options={KIND_FILTERS} onChange={setKind} />
          <FilterSelect label="Source" value={source} options={SOURCE_FILTERS} onChange={setSource} />
          <FilterSelect label="Lifetime" value={band} options={LIFETIME_BANDS} onChange={setBand} />
        </View>

        {donors.length === 0 ? (
          <EmptyState
            title={filtersActive ? "No donors match those filters" : "No donors yet"}
            message={
              filtersActive
                ? "Try widening a filter above."
                : "Record a gift on a donor, or bring in history from the Import tab."
            }
          />
        ) : (
          <View className="gap-2">
            {donors.map((d) => {
              // All-scopes rows carry a `scopeLabel` chapter tag; single-scope
              // rows don't (see `listDonors`).
              const tag =
                "scopeLabel" in d ? (d as { scopeLabel: string }).scopeLabel : null;
              return (
                <Pressable
                  key={d._id}
                  onPress={() => router.navigate(`/giving/donor/${d._id}` as never)}
                >
                  <View className="flex-row items-center justify-between rounded-lg border border-border bg-raised p-3">
                    <View className="flex-1 pr-3">
                      <View className="flex-row items-center gap-2">
                        <Text
                          className="text-base font-semibold text-ink"
                          numberOfLines={1}
                        >
                          {d.name}
                        </Text>
                        {tag ? (
                          <View className="rounded-pill bg-sunken px-1.5 py-0.5">
                            <Text className="text-2xs font-semibold text-muted" numberOfLines={1}>
                              {tag}
                            </Text>
                          </View>
                        ) : null}
                      </View>
                      <Text className="text-xs text-muted" numberOfLines={1}>
                        {d.email ?? "No email"}
                        {d.phone ? ` · ${d.phone}` : ""} · {d.giftCount}{" "}
                        {d.giftCount === 1 ? "gift" : "gifts"}
                      </Text>
                    </View>
                    <View className="items-end gap-1">
                      <Text
                        className="text-base font-semibold text-ink"
                        style={{ fontVariant: ["tabular-nums"] }}
                      >
                        {formatCents(d.lifetimeCents)}
                      </Text>
                      <Badge label={d.status} tone={donorStatusTone(d.status)} />
                    </View>
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </Narrow>

      {canManage && !isAllScopes ? (
        <DonorDuplicatesSheet
          scope={scopeSel as GivingScope}
          visible={dupOpen}
          onClose={() => setDupOpen(false)}
        />
      ) : null}
    </Screen>
  );
}
