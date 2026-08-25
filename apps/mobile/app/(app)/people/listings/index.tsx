/**
 * PEOPLE · Job listings — the postings shown on `/team`, managed here.
 *
 * This is the screen the recruiting desk was missing: a role used to be a
 * markdown file in the landing repo, so opening, closing, editing, or adding
 * one meant a pull request. Now a listing is data (`apps/convex/listings.ts`),
 * the public page reads it live, and this screen is where a director manages
 * it — create a posting, edit it, open or close it, publish or unpublish it.
 *
 * Same gate as the pipelines it feeds (`hiring.view` to look, `hiring.edit` /
 * `requireListingManage` to change). A viewer without manage sees the list and
 * simply gets no create/edit actions.
 */
import { View, Text, Pressable } from "react-native";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import { ROLE_STATUS_LABELS, type RoleStatus } from "@events-os/shared";
import { PipelineTabs } from "../../../../components/people/PipelineTabs";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Narrow,
  Screen,
  SectionHeader,
  type BadgeTone,
} from "../../../../components/ui";

/** Status → chip tone. Open is the invitation; the rest read as information,
 *  mirroring the public page's own status colouring. */
function statusTone(status: RoleStatus): BadgeTone {
  switch (status) {
    case "open":
      return "success";
    case "filling":
      return "info";
    case "not_open":
      return "warn";
    case "closed":
      return "neutral";
  }
}

export default function ListingsScreen() {
  const access = useQuery(api.hiring.myHiringAccess, {});
  const listings = useQuery(api.listings.listListings, {});
  const router = useRouter();

  if (access === undefined) return <Screen loading />;
  if (!access.canView) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Hiring desk access needed"
            message="Ask the People Director or the ED for access to the hiring desk."
          />
        </Narrow>
      </Screen>
    );
  }
  if (listings === undefined) return <Screen loading />;

  return (
    <Screen>
      <Narrow>
        <PipelineTabs />
        <SectionHeader
          title="Job listings"
          count={`${listings.length} posting${listings.length === 1 ? "" : "s"}`}
        />
        <Text className="mb-3 text-sm text-muted">
          What's advertised on the public /team page. Edits go live there
          immediately — no deploy. A listing stays a private draft until you
          publish it.
        </Text>

        {access.canManage ? (
          <View className="mb-4">
            <Button
              title="New listing"
              icon="plus"
              onPress={() => router.navigate("/people/listings/new" as never)}
            />
          </View>
        ) : null}

        {listings.length === 0 ? (
          <EmptyState
            title="No listings yet"
            message="Create a posting to advertise a seat on /team. It won't show publicly until you publish it."
          />
        ) : (
          <View className="gap-2">
            {listings.map((row) => (
              <Pressable
                key={row._id}
                onPress={() =>
                  router.navigate(`/people/listings/${row._id}` as never)
                }
              >
                <Card padding="md">
                  <View className="mb-1 flex-row items-center justify-between gap-2">
                    <Text
                      className="flex-1 text-sm font-semibold text-ink"
                      numberOfLines={1}
                    >
                      {row.title || "Untitled listing"}
                    </Text>
                    <Badge
                      label={ROLE_STATUS_LABELS[row.status]}
                      tone={statusTone(row.status)}
                    />
                  </View>
                  <Text className="text-xs text-muted" numberOfLines={1}>
                    {row.team || "No team set"}
                    {row.location ? ` · ${row.location}` : ""}
                  </Text>
                  <View className="mt-2 flex-row flex-wrap items-center gap-2">
                    {row.published ? (
                      <Badge label="Live" tone="success" icon="globe" />
                    ) : (
                      <Badge label="Draft" tone="warn" icon="edit-3" />
                    )}
                    <Text className="text-xs text-faint">/team/{row.slug}</Text>
                  </View>
                </Card>
              </Pressable>
            ))}
          </View>
        )}
      </Narrow>
    </Screen>
  );
}
