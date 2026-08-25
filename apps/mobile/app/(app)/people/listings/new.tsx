/**
 * PEOPLE · Job listings · New — create a posting.
 *
 * A first save creates a DRAFT (never live), so this form is safe to abandon
 * half-filled. On save we jump to the listing's own editor, where publishing
 * and status live — publishing needs an id, and completeness is checked there.
 */
import { View, Text } from "react-native";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import {
  EmptyState,
  Narrow,
  Screen,
  SectionHeader,
} from "../../../../components/ui";
import { ListingEditor } from "./ListingEditor";

export default function NewListingScreen() {
  const access = useQuery(api.hiring.myHiringAccess, {});
  const router = useRouter();

  if (access === undefined) return <Screen loading />;
  if (!access.canManage) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Manage access needed"
            message="You can view listings, but creating or editing one needs hiring-desk edit access. Ask the People Director or the ED."
          />
        </Narrow>
      </Screen>
    );
  }

  return (
    <Screen>
      <Narrow>
        <SectionHeader title="New listing" />
        <Text className="mb-3 text-sm text-muted">
          This starts as a private draft — it won't appear on /team until you
          publish it from the listing.
        </Text>
        <View className="pb-10">
          <ListingEditor
            onSaved={(id) =>
              router.replace(`/people/listings/${id}` as never)
            }
          />
        </View>
      </Narrow>
    </Screen>
  );
}
