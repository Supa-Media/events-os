import { View, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuthActions } from "@convex-dev/auth/react";
import { Card, Button, Icon } from "../ui";
import { colors } from "../../lib/theme";

/**
 * Shown when a signed-in user is neither a @publicworship.life member nor a
 * seeded guest. The app is closed to them; their only action is to sign out and
 * try another account (or ask an admin to be added to the guest allowlist).
 */
export function AccessDeniedScreen({ email }: { email?: string | null }) {
  const { signOut } = useAuthActions();
  return (
    <SafeAreaView className="flex-1 bg-surface">
      <View className="flex-1 items-center justify-center px-6">
        <View className="w-full max-w-md">
          <Card padding="lg">
            <View className="mb-3 h-11 w-11 items-center justify-center rounded-full bg-danger-bg">
              <Icon name="lock" size={20} color={colors.danger} />
            </View>
            <Text className="font-display text-2xl text-ink">
              Access restricted
            </Text>
            <Text className="mb-1 mt-2 text-sm text-muted">
              This account isn't approved for Chapter OS. It's open to{" "}
              <Text className="font-semibold text-ink">@publicworship.life</Text>{" "}
              members and invited guests — ask an admin to add you.
            </Text>
            {email ? (
              <Text className="mb-5 text-sm text-muted">
                You're signed in as{" "}
                <Text className="font-semibold text-ink">{email}</Text>.
              </Text>
            ) : (
              <View className="mb-5" />
            )}
            <Button
              title="Sign out"
              variant="secondary"
              icon="log-out"
              onPress={() => signOut()}
              className="w-full"
            />
          </Card>
        </View>
      </View>
    </SafeAreaView>
  );
}
