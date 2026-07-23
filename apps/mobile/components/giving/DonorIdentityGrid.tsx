/**
 * DonorIdentityGrid — the cross-chapter donor IDENTITY view (donor-identity,
 * 2026-07). The scope-partitioned donors list (`donors.tsx`) shows ONE `donors`
 * row per (book, person) — on purpose, so a chapter keeps its own donors. This
 * grid sits OVER that: one row per underlying PERSON, with the chapters they're
 * part of / have given to as book chips, their combined lifetime, and a drill
 * into each book's own donor row.
 *
 * Backed by `givingPlatform.listDonorIdentities` (central-gated, reads the
 * persistent `donorIdentities` table). Central reach only — a chapter-only
 * viewer never sees this toggle, so chapter separation is preserved. Styled on
 * the same `DataGrid` primitives as the book grid for one consistent look.
 */
import { View, Text, Pressable, ActivityIndicator } from "react-native";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  GridCell,
  GridContainer,
  GridCountLabel,
  GridHeaderRow,
  GridRow,
  SortableHeaderCell,
  EmptyState,
  Narrow,
} from "../ui";
import { colors } from "../../lib/theme";

const NUM = { fontVariant: ["tabular-nums" as const] };

const COLS = {
  name: 200,
  chapters: 260,
  lifetime: 130,
  gifts: 90,
  lastGift: 116,
} as const;

type IdentityBook = {
  donorId: Id<"donors">;
  scope: "central" | Id<"chapters">;
  bookLabel: string;
  lifetimeCents: number;
  giftCount: number;
  status: string;
};

type IdentityRow = {
  identityId: Id<"donorIdentities">;
  key: string;
  name: string;
  email: string | null;
  lifetimeCents: number;
  giftCount: number;
  lastGiftAt: number | null;
  scopeLabels: string[];
  bookCount: number;
  books: IdentityBook[];
};

export function DonorIdentityGrid() {
  const router = useRouter();
  const data = useQuery(api.givingPlatform.listDonorIdentities, {}) as
    | { donors: IdentityRow[] }
    | undefined;

  if (data === undefined) {
    return (
      <View className="items-center justify-center py-16">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const rows = data.donors;
  if (rows.length === 0) {
    return (
      <Narrow>
        <EmptyState
          title="No donors yet"
          message="Record a gift on a donor, or bring in history from the Import tab. People who give to more than one book will group into one person here."
        />
      </Narrow>
    );
  }

  const width =
    COLS.name + COLS.chapters + COLS.lifetime + COLS.gifts + COLS.lastGift;

  return (
    <>
      <Narrow>
        <View className="mb-3">
          <GridCountLabel label="People" count={rows.length} />
        </View>
      </Narrow>
      <GridContainer width={width}>
        <GridHeaderRow>
          <SortableHeaderCell label="Name" width={COLS.name} />
          <SortableHeaderCell label="Chapters" width={COLS.chapters} />
          <SortableHeaderCell label="Lifetime" width={COLS.lifetime} align="right" />
          <SortableHeaderCell label="Gifts" width={COLS.gifts} align="right" />
          <SortableHeaderCell label="Last gift" width={COLS.lastGift} />
        </GridHeaderRow>
        {rows.map((r, i) => (
          <GridRow key={r.identityId} isLast={i === rows.length - 1}>
            <GridCell width={COLS.name}>
              <View className="flex-1 px-2 py-1.5">
                <Text className="text-sm font-medium text-ink" numberOfLines={1}>
                  {r.name}
                </Text>
                {r.email ? (
                  <Text className="text-2xs text-faint" numberOfLines={1}>
                    {r.email}
                  </Text>
                ) : null}
              </View>
            </GridCell>
            <GridCell width={COLS.chapters}>
              <View className="flex-1 flex-row flex-wrap items-center gap-1 px-2 py-1.5">
                {r.books.map((b) => (
                  <Pressable
                    key={b.donorId}
                    onPress={() =>
                      router.navigate(`/giving/donor/${b.donorId}` as never)
                    }
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${r.name} in ${b.bookLabel}`}
                    className="rounded-md border border-border px-1.5 py-0.5 active:opacity-70 web:hover:bg-sunken"
                  >
                    <Text className="text-2xs font-semibold text-accent" numberOfLines={1}>
                      {b.bookLabel}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </GridCell>
            <GridCell width={COLS.lifetime}>
              <Text
                className="flex-1 px-2 py-1.5 text-right text-sm font-semibold text-ink"
                style={NUM}
              >
                {formatCents(r.lifetimeCents)}
              </Text>
            </GridCell>
            <GridCell width={COLS.gifts}>
              <Text
                className="flex-1 px-2 py-1.5 text-right text-sm text-muted"
                style={NUM}
              >
                {r.giftCount}
              </Text>
            </GridCell>
            <GridCell width={COLS.lastGift}>
              <Text className="flex-1 px-2 py-1.5 text-sm text-muted" style={NUM}>
                {r.lastGiftAt ? new Date(r.lastGiftAt).toLocaleDateString() : "—"}
              </Text>
            </GridCell>
          </GridRow>
        ))}
      </GridContainer>
    </>
  );
}
