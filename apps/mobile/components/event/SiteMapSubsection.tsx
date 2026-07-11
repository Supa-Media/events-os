import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { Icon } from "../ui";
import { colors } from "../../lib/theme";
import { SiteMapEditor, type SiteMapScope } from "./SiteMapEditor";

/**
 * The site-map artifact of the Supplies & Logistics workstream — the venue
 * layout rendered beneath the supplies grid on both the event screen and the
 * template editor (any module with `hasSiteMap` gets one).
 *
 * Collapsed by default: the editor is a heavy canvas with its own queries, so
 * it only mounts once expanded. The standalone `/event/[id]/site-map` route
 * stays the full-page deep link to the same editor.
 */
export function SiteMapSubsection({ scope }: { scope: SiteMapScope }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View className="mt-6">
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={expanded ? "Collapse site map" : "Expand site map"}
        className="active:opacity-80"
      >
        <View className="flex-row items-center gap-2 rounded-md border border-border bg-raised px-3 py-2.5 web:hover:border-border-strong">
          <Icon name="map" size={15} color={colors.muted} />
          <View className="flex-1 flex-row items-baseline gap-2">
            <Text className="text-sm font-semibold text-ink">Site map</Text>
            <Text className="text-xs text-muted" numberOfLines={1}>
              The venue layout — where each team and supply is set up.
            </Text>
          </View>
          <Icon
            name={expanded ? "chevron-up" : "chevron-down"}
            size={16}
            color={colors.muted}
          />
        </View>
      </Pressable>

      {expanded ? (
        <View className="mt-3">
          <SiteMapEditor scope={scope} embedded />
        </View>
      ) : null}
    </View>
  );
}
