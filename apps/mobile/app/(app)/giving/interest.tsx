/**
 * GIVING · Interest — the OS's triage inbox for the `/give` page's interest +
 * suggest-a-space capture: "I want this in my city," volunteer, join the
 * founding team, help fund, or suggest a physical space
 * (`apps/convex/schema/givingInterest.ts`). No payment rail — pure lead
 * capture, distinct from Donors/Backers/Territories (all of which are money
 * or a place already raising).
 *
 * CENTRAL-only, like Territories: the backend gates the list read on central
 * `giving.view` and the status write on central `giving.manage`
 * (`apps/convex/givingInterest.ts`). This screen is a VIEW surface first — a
 * central `giving.view` holder can browse every submission; tapping a row to
 * advance its status is additionally gated on `canManage`, so a view-only
 * central holder gets a read-only inbox instead of an access-needed wall.
 *
 * Public rendering of what feeds this inbox lives at `/give` +
 * `/give/<slug>` (`apps/convex/lib/givePage.ts`).
 */
import { useState } from "react";
import { ActivityIndicator, View, Text, Pressable } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Badge,
  type BadgeTone,
  Card,
  EmptyState,
  Narrow,
  Screen,
  SectionHeader,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { useGivingScope } from "../../../lib/useGivingScope";

type InterestKind =
  | "want_in_city"
  | "volunteer"
  | "join_team"
  | "fund"
  | "suggest_space";
type InterestStatus = "new" | "contacted" | "archived";

type InterestRow = {
  _id: Id<"givingInterest">;
  // Multi-select (wave 2, F4): a submission can carry several kinds at once
  // ("want it in my city" + "volunteer" + "help fund" together) — no longer a
  // single `kind`.
  kinds: InterestKind[];
  name: string | null;
  email: string | null;
  phone: string | null;
  socialHandle: string | null;
  location: string | null;
  message: string | null;
  // Founding-team fields (F7) — populated mainly on `join_team` submissions.
  roles: string[] | null;
  skills: string | null;
  church: string | null;
  territorySlug: string | null;
  status: InterestStatus;
  createdAt: number;
  handledAt: number | null;
  handledBy: Id<"users"> | null;
};

const KIND_LABELS: Record<InterestKind, string> = {
  want_in_city: "Want it in my city",
  volunteer: "Volunteer",
  join_team: "Join founding team",
  fund: "Help fund",
  suggest_space: "Suggest a space",
};

function kindTone(kind: InterestKind): BadgeTone {
  switch (kind) {
    case "want_in_city":
      return "accent";
    case "volunteer":
      return "info";
    case "join_team":
      return "lavender";
    case "fund":
      return "success";
    case "suggest_space":
      return "warn";
  }
}

function statusTone(status: InterestStatus): BadgeTone {
  if (status === "new") return "accent";
  if (status === "contacted") return "warn";
  return "neutral";
}

/** The triage cycle a tap walks through: new → contacted → archived → new. */
function nextStatus(status: InterestStatus): InterestStatus {
  if (status === "new") return "contacted";
  if (status === "contacted") return "archived";
  return "new";
}

export default function InterestScreen() {
  // WP-S follow-up: the app's chapter lens — see `useGivingScope`'s own doc.
  // Interest capture is CENTRAL-only (like Territories/Sponsorships), so
  // wiring the lens through means it's reachable only at the central desk.
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
            title="Interest is managed centrally"
            message="Interest capture is a central surface — ask a development director to view it here."
          />
        </Narrow>
      </Screen>
    );
  }
  return <InterestBody canManage={access.canManage} />;
}

function InterestBody({ canManage }: { canManage: boolean }) {
  const rows = useQuery(api.givingInterest.listInterest, {}) as
    | InterestRow[]
    | undefined;
  const setStatus = useMutation(api.givingInterest.setInterestStatus);
  const [busyId, setBusyId] = useState<Id<"givingInterest"> | null>(null);

  if (rows === undefined) {
    return (
      <View className="items-center justify-center py-16">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  async function advance(row: InterestRow) {
    if (!canManage || busyId) return;
    setBusyId(row._id);
    try {
      await setStatus({ id: row._id, status: nextStatus(row.status) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Screen>
      <Narrow>
        <SectionHeader title={`Interest (${rows.length})`} />
        {rows.length === 0 ? (
          <EmptyState
            title="No interest submissions yet"
            message="Submissions from the /give page's interest + suggest-a-space CTAs land here."
          />
        ) : (
          <View className="gap-2">
            {rows.map((row) => (
              <Pressable
                key={row._id}
                onPress={() => void advance(row)}
                disabled={!canManage || busyId === row._id}
              >
                <Card padding="md">
                  <View className="mb-2 flex-row items-center justify-between">
                    <View className="flex-1 flex-row flex-wrap items-center gap-2 pr-2">
                      {row.kinds.map((kind) => (
                        <Badge
                          key={kind}
                          label={KIND_LABELS[kind]}
                          tone={kindTone(kind)}
                        />
                      ))}
                      {row.territorySlug ? (
                        <Text className="text-xs text-muted" numberOfLines={1}>
                          /give/{row.territorySlug}
                        </Text>
                      ) : null}
                    </View>
                    <Badge label={row.status} tone={statusTone(row.status)} />
                  </View>
                  {row.name ? (
                    <Text className="text-sm font-semibold text-ink">
                      {row.name}
                    </Text>
                  ) : null}
                  {row.email ? (
                    <Text className="text-xs text-muted">{row.email}</Text>
                  ) : null}
                  {row.phone ? (
                    <Text className="text-xs text-muted">{row.phone}</Text>
                  ) : null}
                  {row.socialHandle ? (
                    <Text className="text-xs text-muted">
                      {row.socialHandle}
                    </Text>
                  ) : null}
                  {row.location ? (
                    <Text className="text-xs text-muted">{row.location}</Text>
                  ) : null}
                  {row.church ? (
                    <Text className="text-xs text-muted">
                      Church: {row.church}
                    </Text>
                  ) : null}
                  {row.roles && row.roles.length > 0 ? (
                    <View className="mt-1 flex-row flex-wrap gap-1">
                      {row.roles.map((role, i) => (
                        <Badge key={`${role}-${i}`} label={role} tone="neutral" />
                      ))}
                    </View>
                  ) : null}
                  {row.skills ? (
                    <Text className="mt-1 text-sm text-ink">
                      Skills: {row.skills}
                    </Text>
                  ) : null}
                  {row.message ? (
                    <Text className="mt-1 text-sm text-ink">
                      {row.message}
                    </Text>
                  ) : null}
                  <Text className="mt-2 text-xs text-faint">
                    {new Date(row.createdAt).toLocaleDateString()}
                    {canManage
                      ? busyId === row._id
                        ? "  ·  updating…"
                        : `  ·  tap to mark ${nextStatus(row.status)}`
                      : ""}
                  </Text>
                </Card>
              </Pressable>
            ))}
          </View>
        )}
      </Narrow>
    </Screen>
  );
}
