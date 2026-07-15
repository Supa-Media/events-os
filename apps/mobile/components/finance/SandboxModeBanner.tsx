/**
 * SANDBOX MODE BANNER — a self-contained, drop-in warning strip for the finance
 * layer.
 *
 * When the deployment-wide finance `sandboxMode` flag is ON, the whole money
 * layer provisions NEW accounts against the Increase test environment — no real
 * money moves. This banner makes that state impossible to miss so nobody
 * mistakes a test run for a live one.
 *
 * It carries its OWN viewer-gated query (`getFinanceSettings`) so it can be
 * dropped straight into a finances layout without threading props. It renders
 * `null` while the query is loading/undefined and whenever sandbox mode is off,
 * so it costs nothing visually in the normal (production) case.
 */
import { Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Icon } from "../ui";
import { colors } from "../../lib/theme";

export function SandboxModeBanner() {
  const settings = useQuery(api.financeSettings.getFinanceSettings);

  // Loading / undefined / production → render nothing.
  if (!settings?.sandboxMode) return null;

  return (
    <View className="mb-3 flex-row items-start gap-3 rounded-lg border border-warn bg-warn-bg px-4 py-3">
      <Icon name="alert-triangle" size={16} color={colors.warn} />
      <Text className="flex-1 text-sm text-ink">
        <Text className="font-bold">Sandbox mode</Text> — finance is running
        against the Increase test environment. No real money moves.
      </Text>
    </View>
  );
}

export default SandboxModeBanner;
