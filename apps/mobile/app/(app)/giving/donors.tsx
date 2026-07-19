/**
 * GIVING · Donors — the scope's donor list, sorted by lifetime giving (the
 * "top donors" relationship workflow needs this ordering on day one, PRD §1).
 * Status/kind/source/lifetime-band chips (territories P5 CRM filters) refine
 * the list; status chips flag the reactivation queue (lapsed) at a glance.
 * Tapping a row opens the donor detail. The backend `listDonors` gates on
 * `requireGivingView`.
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
  Icon,
  Narrow,
  Pill,
  Screen,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { useGivingScope } from "../../../lib/useGivingScope";
import { DonorDuplicatesSheet } from "../../../components/giving/DonorDuplicatesSheet";

type GivingScope = "central" | Id<"chapters">;

// ── CRM filters (territories P5) ────────────────────────────────────────────
// Hardcoded, mirroring `donor/[id].tsx`'s `SOURCE_OPTIONS` — mobile doesn't
// import the convex-side schema literals directly, so the option lists are
// kept in step with `schema/givingPlatform.ts`'s `DONOR_STATUSES`/
// `DONOR_KINDS`/`DONOR_SOURCES` by hand (small, stable unions).

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "prospect", label: "Prospect" },
  { value: "active", label: "Active" },
  { value: "lapsed", label: "Lapsed" },
];

const KIND_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All kinds" },
  { value: "individual", label: "Individual" },
  { value: "church", label: "Church" },
  { value: "business", label: "Business" },
  { value: "foundation", label: "Foundation" },
];

const SOURCE_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All sources" },
  { value: "manual", label: "Manual" },
  { value: "event-donation", label: "Event donation" },
  { value: "givebutter-import", label: "Givebutter" },
  { value: "map", label: "Map" },
];

// Lifetime bands (dollars, converted to cents for the query arg).
const LIFETIME_BANDS: { value: string; label: string; cents?: number }[] = [
  { value: "all", label: "Any amount" },
  { value: "100", label: "$100+", cents: 100_00 },
  { value: "500", label: "$500+", cents: 500_00 },
  { value: "1000", label: "$1k+", cents: 1_000_00 },
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
  return <DonorsBody scope={access.scope} canManage={access.canManage} />;
}

function DonorsBody({ scope, canManage }: { scope: GivingScope; canManage: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState("all");
  const [kind, setKind] = useState("all");
  const [source, setSource] = useState("all");
  const [band, setBand] = useState("all");
  // Duplicate review + merge — manage-gated (Attendance C).
  const [dupOpen, setDupOpen] = useState(false);

  const minLifetimeCents = LIFETIME_BANDS.find((b) => b.value === band)?.cents;
  const donors = useQuery(api.givingPlatform.listDonors, {
    scope,
    status: status === "all" ? undefined : (status as never),
    kind: kind === "all" ? undefined : (kind as never),
    source: source === "all" ? undefined : (source as never),
    minLifetimeCents,
  });

  const anyFilterActive =
    status !== "all" || kind !== "all" || source !== "all" || band !== "all";

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
        {canManage ? (
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
        <View className="mb-3 gap-2">
          <FilterRow options={STATUS_FILTERS} value={status} onChange={setStatus} />
          <FilterRow options={KIND_FILTERS} value={kind} onChange={setKind} />
          <FilterRow options={SOURCE_FILTERS} value={source} onChange={setSource} />
          <FilterRow options={LIFETIME_BANDS} value={band} onChange={setBand} />
        </View>

        {donors.length === 0 ? (
          <EmptyState
            title={anyFilterActive ? "No donors match those filters" : "No donors yet"}
            message={
              anyFilterActive
                ? "Try widening a filter above."
                : "Record a gift on a donor, or bring in history from the Import tab."
            }
          />
        ) : (
          <View className="gap-2">
            {donors.map((d) => (
              <Pressable
                key={d._id}
                onPress={() => router.navigate(`/giving/donor/${d._id}` as never)}
              >
                <View className="flex-row items-center justify-between rounded-lg border border-border bg-raised p-3">
                  <View className="flex-1 pr-3">
                    <Text className="text-base font-semibold text-ink" numberOfLines={1}>
                      {d.name}
                    </Text>
                    <Text className="text-xs text-muted" numberOfLines={1}>
                      {d.email ?? "No email"}
                      {d.phone ? ` · ${d.phone}` : ""} · {d.giftCount}{" "}
                      {d.giftCount === 1 ? "gift" : "gifts"}
                    </Text>
                  </View>
                  <View className="items-end gap-1">
                    <Text className="text-base font-semibold text-ink">
                      {formatCents(d.lifetimeCents)}
                    </Text>
                    <Badge label={d.status} tone={donorStatusTone(d.status)} />
                  </View>
                </View>
              </Pressable>
            ))}
          </View>
        )}
      </Narrow>

      {canManage ? (
        <DonorDuplicatesSheet
          scope={scope}
          visible={dupOpen}
          onClose={() => setDupOpen(false)}
        />
      ) : null}
    </Screen>
  );
}

/** One row of filter chips, horizontally wrapped. */
function FilterRow({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {options.map((o) => (
        <Pill
          key={o.value}
          label={o.label}
          selected={value === o.value}
          onPress={() => onChange(value === o.value ? "all" : o.value)}
        />
      ))}
    </View>
  );
}
