import { View, Text, Pressable, ScrollView } from "react-native";

/**
 * Horizontal, scrollable tab bar — Overview, each active module, and Crew. Same
 * component on web and mobile; on a phone it scrolls sideways instead of
 * wrapping so the planning surfaces stay one tap apart.
 */
export function EventTabBar({
  tabs,
  activeKey,
  onSelect,
}: {
  tabs: { key: string; label: string }[];
  activeKey: string;
  onSelect: (key: string) => void;
}) {
  return (
    <View className="mb-6 border-b border-border">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 4 }}
      >
        {tabs.map((t) => {
          const active = t.key === activeKey;
          return (
            <Pressable
              key={t.key}
              onPress={() => onSelect(t.key)}
              className={`border-b-2 px-3 py-2.5 ${
                active ? "border-accent" : "border-transparent"
              } active:opacity-80`}
            >
              <Text
                className={`text-sm ${
                  active ? "font-semibold text-accent" : "text-muted"
                }`}
              >
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
