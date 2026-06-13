import { useState } from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
} from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { colors, radius, spacing } from "../../lib/theme";

type PersonId = string;

type Props = {
  visible: boolean;
  title?: string;
  /** Currently-assigned person id, highlighted in the list. */
  selectedId?: PersonId | null;
  onPick: (personId: PersonId) => void;
  /** When provided, shows a "Clear assignment" row. */
  onClear?: () => void;
  onClose: () => void;
};

/**
 * Bottom-sheet-style modal that lists chapter people. Used to assign tasks and
 * roles. Loads people via api.people.list (undefined while loading).
 */
export function PersonPicker({
  visible,
  title = "Assign person",
  selectedId,
  onPick,
  onClear,
  onClose,
}: Props) {
  const people = useQuery(api.people.list);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Inner press target stops backdrop dismiss when tapping the sheet. */}
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.close}>Done</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.list}>
            {onClear ? (
              <Row label="— Clear assignment —" muted onPress={onClear} />
            ) : null}

            {people === undefined ? (
              <Text style={styles.empty}>Loading…</Text>
            ) : people.length === 0 ? (
              <Text style={styles.empty}>No people yet. Add some first.</Text>
            ) : (
              people.map((p: any) => (
                <Row
                  key={p._id}
                  label={p.name}
                  selected={p._id === selectedId}
                  onPress={() => onPick(p._id)}
                />
              ))
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Row({
  label,
  selected,
  muted,
  onPress,
}: {
  label: string;
  selected?: boolean;
  muted?: boolean;
  onPress: () => void;
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[styles.row, pressed && styles.rowPressed]}
    >
      <Text
        style={[
          styles.rowText,
          muted && styles.rowMuted,
          selected && styles.rowSelected,
        ]}
      >
        {label}
      </Text>
      {selected ? <Text style={styles.check}>✓</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    maxHeight: "70%",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  title: { fontSize: 16, fontWeight: "700", color: colors.text },
  close: { fontSize: 15, fontWeight: "600", color: colors.accent },
  list: { marginTop: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowPressed: { opacity: 0.6 },
  rowText: { fontSize: 15, color: colors.text },
  rowMuted: { color: colors.muted },
  rowSelected: { color: colors.accent, fontWeight: "600" },
  check: { color: colors.accent, fontWeight: "700" },
  empty: { padding: spacing.lg, color: colors.muted, textAlign: "center" },
});
