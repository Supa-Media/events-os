/**
 * GIVING · Wall — the staff moderation desk for the PUBLIC giving wall
 * ("Backers & gifts" on `/give/<slug>` and "Giving, as it comes in" on `/give`,
 * both rendered by `apps/convex/lib/givePage.ts` from
 * `givingActivity.getPublicWall`).
 *
 * WHY THIS SCREEN EXISTS: `hideActivity` shipped with the wall but never had a
 * UI, so the only way to take an entry down was a developer running the
 * mutation by hand. That is not an answer you can give a donor who emails
 * asking to be removed. This screen makes a takedown a thirty-second job for
 * whoever is at the desk, with no deploy.
 *
 * CENTRAL-only, like Interest and Territories: the wall spans every territory,
 * so the backend gates the list on central `giving.view`
 * (`listActivityAdmin`) and both writes on central `giving.manage`
 * (`hideActivity` / `restoreActivity`). A view-only central holder gets a
 * read-only list rather than an access wall, mirroring `interest.tsx`.
 *
 * Every takedown here is REVERSIBLE — `hideActivity` stamps
 * `hiddenReason: "staff"`, and `restoreActivity` puts exactly those rows back —
 * anonymously if that is how they came down. (It no longer refuses over
 * consent: since v3 the public read decides attribution on every read, so a
 * restore cannot confer a name, and refusing would have made an accidental
 * takedown of an unconsented row permanent.) Entries pulled because a payment
 * reversed (`withdrawActivity`, ACH failure) are NOT restorable and say so.
 */
import { useState } from "react";
import { ActivityIndicator, Platform, View, Text } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  EmptyState,
  Narrow,
  Screen,
  SectionHeader,
} from "../../../components/ui";
import { alertError } from "../../../lib/errors";
import { colors } from "../../../lib/theme";
import { useGivingScope } from "../../../lib/useGivingScope";

type ActivityKind = "backer" | "gift";
type ActivityStatus = "pending" | "visible" | "hidden";
type HiddenReason = "staff" | "payment_reversed";

type WallRow = {
  _id: Id<"givingActivity">;
  scope: Id<"chapters">;
  kind: ActivityKind;
  displayName: string | null;
  amountCents: number;
  message: string | null;
  status: ActivityStatus;
  refKey: string;
  createdAt: number;
  settledAt: number | null;
  consent: boolean;
  hiddenReason: HiddenReason | null;
  hiddenByName: string | null;
  hiddenAt: number | null;
  territoryName: string | null;
  territorySlug: string | null;
};

/** "Taken down by Seyi on 8/9/2026" — who changed what the public sees.
 *  A reversed payment has no actor, so it reads as the system doing it. */
function takedownLine(row: WallRow): string | null {
  if (row.status !== "hidden") return null;
  const when = row.hiddenAt
    ? ` on ${new Date(row.hiddenAt).toLocaleDateString()}`
    : "";
  if (row.hiddenReason === "payment_reversed") {
    return `Taken down automatically${when} — the payment was reversed.`;
  }
  if (row.hiddenByName) return `Taken down by ${row.hiddenByName}${when}.`;
  // Hidden before we recorded who did it.
  return `Taken down${when} — actor not recorded.`;
}

const STATUS_LABEL: Record<ActivityStatus, string> = {
  pending: "Not published",
  visible: "On the public wall",
  hidden: "Taken down",
};

function statusTone(status: ActivityStatus): BadgeTone {
  if (status === "visible") return "success";
  if (status === "pending") return "neutral";
  return "warn";
}

/** Cross-platform confirm — RN's `Alert.alert` is a no-op on web, and this desk
 *  is used in a browser. Same guarded-`window.confirm` idiom as
 *  `components/giving/DonorDuplicatesSheet.tsx`. */
function confirmTakedown(message: string): boolean {
  if (Platform.OS === "web") {
    return (
      typeof window !== "undefined" &&
      typeof window.confirm === "function" &&
      window.confirm(message)
    );
  }
  return true;
}

export default function WallScreen() {
  // The app's chapter lens — see `useGivingScope`. The wall is a CENTRAL
  // surface (it spans every territory), so wiring the lens through means the
  // screen is only reachable from the central desk.
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
  if (access.scope !== "central") {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="The wall is managed centrally"
            message="The public giving wall spans every territory — ask a development director to review it here."
          />
        </Narrow>
      </Screen>
    );
  }
  return <WallBody canManage={access.canManage} />;
}

function WallBody({ canManage }: { canManage: boolean }) {
  const rows = useQuery(api.givingActivity.listActivityAdmin, {}) as
    | WallRow[]
    | undefined;
  const hide = useMutation(api.givingActivity.hideActivity);
  const restore = useMutation(api.givingActivity.restoreActivity);
  const [busyId, setBusyId] = useState<Id<"givingActivity"> | null>(null);

  if (rows === undefined) {
    return (
      <View className="items-center justify-center py-16">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const liveCount = rows.filter((r) => r.status === "visible").length;

  async function takeDown(row: WallRow) {
    if (!canManage || busyId) return;
    const who = row.displayName ?? "This entry";
    if (
      !confirmTakedown(
        `Take ${who} off the public giving wall?\n\n` +
          `It disappears from /give/${row.territorySlug ?? "…"} immediately. ` +
          `The gift itself is untouched — only its public echo comes down — ` +
          `and you can put it back from this screen at any time.`,
      )
    ) {
      return;
    }
    setBusyId(row._id);
    try {
      await hide({ id: row._id });
    } catch (e) {
      alertError(e);
    } finally {
      setBusyId(null);
    }
  }

  async function putBack(row: WallRow) {
    if (!canManage || busyId) return;
    setBusyId(row._id);
    try {
      await restore({ id: row._id });
    } catch (e) {
      alertError(e);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Screen>
      <Narrow>
        <SectionHeader title={`Public giving wall (${liveCount} live)`} />
        {/* Don't promise a read-only holder an action they don't have — the
            second sentence is only true for someone who can manage. */}
        <Text className="mb-3 text-sm text-muted">
          Everything a giver agreed to show publicly on their territory&apos;s
          /give page — display name, amount, and message.
          {canManage
            ? " Taking an entry down removes it from the public page right away and never touches the gift record. You can put a takedown back."
            : " Taking an entry down is a development director's call — ask one if a giver has asked to be removed."}
        </Text>
        {rows.length === 0 ? (
          <EmptyState
            title="Nothing on the wall yet"
            message="Entries appear here once a giver ticks “Show my name and gift amount on our public giving wall” and their payment settles."
          />
        ) : (
          <View className="gap-2">
            {rows.map((row) => {
              const restorable =
                row.status === "hidden" &&
                row.hiddenReason === "staff" &&
                row.consent;
              return (
                <Card key={row._id} padding="md">
                  <View className="mb-2 flex-row items-center justify-between">
                    <View className="flex-1 flex-row flex-wrap items-center gap-2 pr-2">
                      <Badge
                        label={row.kind === "backer" ? "Backer" : "Gift"}
                        tone={row.kind === "backer" ? "lavender" : "accent"}
                      />
                      {row.territorySlug ? (
                        <Text className="text-xs text-muted" numberOfLines={1}>
                          /give/{row.territorySlug}
                        </Text>
                      ) : null}
                    </View>
                    <Badge
                      label={STATUS_LABEL[row.status]}
                      tone={statusTone(row.status)}
                    />
                  </View>
                  <Text className="text-sm font-semibold text-ink">
                    {row.displayName ?? "A backer"}
                    {"  ·  "}
                    {formatCents(row.amountCents)}
                    {row.kind === "backer" ? "/mo" : ""}
                  </Text>
                  {row.territoryName ? (
                    <Text className="text-xs text-muted">
                      {row.territoryName}
                    </Text>
                  ) : null}
                  {row.message ? (
                    <Text className="mt-1 text-sm text-ink">
                      “{row.message}”
                    </Text>
                  ) : null}
                  {/* Consent is the whole reason a row may be shown at all, so
                      say it out loud rather than leaving staff to infer it. */}
                  {!row.consent ? (
                    <Text className="mt-1 text-xs text-muted">
                      No recorded consent — this entry can never be published.
                    </Text>
                  ) : null}
                  {/* Who took it down and when — a takedown changes what the
                      public sees, so it should never be anonymous. */}
                  {takedownLine(row) ? (
                    <Text className="mt-1 text-xs text-muted">
                      {takedownLine(row)}
                      {row.hiddenReason === "payment_reversed"
                        ? " It can't be restored."
                        : ""}
                    </Text>
                  ) : null}
                  <View className="mt-2 flex-row items-center justify-between">
                    <Text className="text-xs text-faint">
                      {new Date(
                        row.settledAt ?? row.createdAt,
                      ).toLocaleDateString()}
                    </Text>
                    {canManage ? (
                      row.status === "visible" ? (
                        <Button
                          title="Take down"
                          size="sm"
                          variant="danger"
                          disabled={busyId === row._id}
                          onPress={() => void takeDown(row)}
                        />
                      ) : restorable ? (
                        <Button
                          title="Put back"
                          size="sm"
                          variant="secondary"
                          disabled={busyId === row._id}
                          onPress={() => void putBack(row)}
                        />
                      ) : null
                    ) : null}
                  </View>
                </Card>
              );
            })}
          </View>
        )}
      </Narrow>
    </Screen>
  );
}
