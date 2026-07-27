/**
 * People → Identify — the "who is this?" card for bucket 4 (unidentified
 * name-only guests with no candidate at all — that's what makes it bucket 4
 * rather than bucket 2). Search box defaults to the guest's own display name
 * so likely matches ("Might be:") show up immediately, mirroring
 * `components/ui/PersonPicker.tsx`'s search-and-pick idiom but inline (no
 * modal) since the wireframe embeds it directly in the card.
 *
 * "+ Add as new person" opens a plain name/email/phone form (pre-filled name)
 * so a reviewer can type in what they found in their own contacts —
 * `identity.ts#createPersonFromGuest` already accepts all three.
 */
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { Button, Card, Icon, TextField } from "../ui";
import { colors } from "../../lib/theme";
import { formatEventSummary, type UnidentifiedRow } from "../../lib/identifyQueue";

type SearchablePerson = { _id: string; name: string; email?: string | null; phone?: string | null };

const SUGGESTION_LIMIT = 5;

export function IdentifyUnidentifiedCard({
  row,
  position,
  total,
  people,
  busy,
  onPickExisting,
  onCreateNew,
  onDontKnow,
}: {
  row: UnidentifiedRow;
  position: number;
  total: number;
  people: SearchablePerson[];
  busy: boolean;
  onPickExisting: (personId: string) => void;
  onCreateNew: (fields: { name: string; email?: string; phone?: string }) => void;
  onDontKnow: () => void;
}) {
  const [search, setSearch] = useState(row.displayName);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(row.displayName);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  const q = search.trim().toLowerCase();
  const suggestions = q
    ? people.filter((p) => p.name.toLowerCase().includes(q)).slice(0, SUGGESTION_LIMIT)
    : [];

  function startAdding() {
    setName(search.trim() || row.displayName);
    setAdding(true);
  }

  function submitNew() {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    onCreateNew({
      name: trimmedName,
      ...(email.trim() ? { email: email.trim() } : {}),
      ...(phone.trim() ? { phone: phone.trim() } : {}),
    });
  }

  return (
    <Card padding="md">
      <View className="mb-1 flex-row items-center justify-between">
        <Text className="font-display text-lg text-ink" numberOfLines={1}>
          {row.displayName}
        </Text>
        <Text className="text-xs font-semibold text-faint">
          {position} of {total}
        </Text>
      </View>
      <Text className="mb-3 text-xs text-muted">
        {formatEventSummary(row.eventCount, row.eventNames)}
      </Text>

      {adding ? (
        <View className="gap-1">
          <TextField label="Name" value={name} onChangeText={setName} placeholder="Full name" />
          <TextField
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="name@example.com"
            autoCapitalize="none"
            keyboardType="email-address"
          />
          <TextField
            label="Phone"
            value={phone}
            onChangeText={setPhone}
            placeholder="(555) 555-1234"
            keyboardType="phone-pad"
          />
          <View className="mt-1 flex-row justify-end gap-2">
            <Button title="Cancel" variant="ghost" size="sm" disabled={busy} onPress={() => setAdding(false)} />
            <Button
              title="Save"
              variant="primary"
              size="sm"
              loading={busy}
              disabled={busy || !name.trim()}
              onPress={submitNew}
            />
          </View>
        </View>
      ) : (
        <>
          <View className="mb-2 flex-row items-center gap-2 rounded-md border border-border-strong bg-raised px-3">
            <Icon name="search" size={14} color={colors.faint} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search your people…"
              placeholderTextColor={colors.faint}
              autoCapitalize="words"
              className="flex-1 py-2.5 text-base text-ink"
            />
          </View>

          {suggestions.length > 0 ? (
            <View className="mb-2 gap-1">
              <Text className="text-2xs font-bold uppercase tracking-wider text-faint">Might be</Text>
              {suggestions.map((p) => (
                <View
                  key={p._id}
                  className="flex-row items-center justify-between rounded-md border border-border px-3 py-2"
                >
                  <View className="flex-1 pr-2">
                    <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                      {p.name}
                    </Text>
                    {p.email ? (
                      <Text className="text-xs text-muted" numberOfLines={1}>
                        {p.email}
                      </Text>
                    ) : null}
                  </View>
                  <Button
                    title="This one"
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onPress={() => onPickExisting(p._id)}
                  />
                </View>
              ))}
            </View>
          ) : null}

          <View className="mt-2 flex-row flex-wrap items-center justify-between gap-2">
            <Button
              title="+ Add as new person"
              variant="secondary"
              size="sm"
              disabled={busy}
              onPress={startAdding}
            />
            <Button
              title="Don't know"
              variant="ghost"
              size="sm"
              icon="arrow-right"
              disabled={busy}
              onPress={onDontKnow}
            />
          </View>
        </>
      )}
    </Card>
  );
}
