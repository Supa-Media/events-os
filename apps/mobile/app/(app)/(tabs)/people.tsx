import { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Card,
  Button,
  Badge,
  Pill,
  TextField,
  EmptyState,
  SectionHeader,
} from "../../../components/ui";
import { colors, spacing } from "../../../lib/theme";
import { type VettingStatus } from "@events-os/shared";

const VETTING_TONE: Record<VettingStatus, "neutral" | "warn" | "success"> = {
  unvetted: "neutral",
  pending: "warn",
  vetted: "success",
};

const VETTING_LABEL: Record<VettingStatus, string> = {
  unvetted: "Unvetted",
  pending: "Pending",
  vetted: "Vetted",
};

/** PEOPLE roster + inline add-person form. */
export default function PeopleScreen() {
  const people = useQuery(api.people.list);
  const create = useMutation(api.people.create);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);

  if (people === undefined) return <Screen loading />;

  async function handleAdd() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await create({
        name: trimmed,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
      });
      setName("");
      setEmail("");
      setPhone("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen>
      <Card style={styles.form}>
        <TextField
          label="Add person"
          placeholder="Full name"
          value={name}
          onChangeText={setName}
        />
        <TextField
          placeholder="Email (optional)"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
        />
        <TextField
          placeholder="Phone (optional)"
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
        />
        <Button
          title="Add person"
          onPress={handleAdd}
          loading={saving}
          disabled={!name.trim()}
        />
      </Card>

      <SectionHeader title={`Roster (${people.length})`} />

      {people.length === 0 ? (
        <EmptyState
          title="No people yet"
          message="Add team members above so you can assign roles and tasks."
        />
      ) : (
        <View style={styles.list}>
          {people.map((p: any) => (
            <Card key={p._id}>
              <View style={styles.rowTop}>
                <Text style={styles.name} numberOfLines={1}>
                  {p.name}
                </Text>
                <Badge
                  label={VETTING_LABEL[(p.vettingStatus ?? "unvetted") as VettingStatus]}
                  tone={VETTING_TONE[(p.vettingStatus ?? "unvetted") as VettingStatus]}
                />
              </View>

              {p.email || p.phone ? (
                <Text style={styles.contact}>
                  {[p.email, p.phone].filter(Boolean).join(" · ")}
                </Text>
              ) : null}

              {p.skills && p.skills.length > 0 ? (
                <View style={styles.skills}>
                  {p.skills.map((s: string) => (
                    <Pill key={s} label={s} />
                  ))}
                </View>
              ) : null}
            </Card>
          ))}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.sm },
  list: { gap: spacing.md },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  name: { fontSize: 16, fontWeight: "700", color: colors.text, flex: 1 },
  contact: { fontSize: 13, color: colors.muted, marginTop: spacing.xs },
  skills: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
});
