/**
 * The approver's redaction pass on a coding's purpose.
 *
 * Owner, 2026-08-09: the person approving should be able to *"go in and edit
 * it, or highlight something and redact it"* to get a coding ready for public
 * viewing — instead of bouncing the whole thing back because one name is in
 * the sentence.
 *
 * REDACTION IS NOT FALSIFICATION, and that is the entire shape of this
 * component. The author's own words are always rendered, labelled, and never
 * editable here; what the approver writes is a SEPARATE published version. A
 * coding is substantiation for an IRS accountable plan — what actually
 * happened has to survive — so this UI can show a rewrite, but it must never
 * look like it replaced anything.
 *
 * Deliberately a plain text field, not a highlight-and-strike range editor.
 * The owner floated that as a thought; a field with the original shown beneath
 * satisfies every requirement (retain the original, store the public version,
 * audit who and when, show the author), and three similar lines beat a
 * premature abstraction. If range redaction is ever genuinely needed, this is
 * the seam to grow it at.
 */
import { useState } from "react";
import { Text, View, Pressable } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Button, Icon, TextField } from "../../ui";
import { colors } from "../../../lib/theme";

export interface PublicPurposeState {
  /** The author's own words. Never edited by anyone. */
  businessPurpose: string;
  /** The approver's published rewrite, or null when the author's words are
   *  what publishes. */
  publicPurpose: string | null;
  publicPurposeByName: string | null;
  publicPurposeAt: number | null;
}

function when(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/**
 * READ-ONLY rendering, for anyone who isn't deciding this row — including the
 * author. The author has to be able to see their wording was changed; a
 * redaction nobody told them about is the kind of thing that erodes trust in
 * the whole record.
 */
export function PublicPurposeNotice({ state }: { state: PublicPurposeState }) {
  if (!state.publicPurpose) return null;
  return (
    <View className="mt-1.5 rounded-md border border-border bg-sunken px-3 py-2">
      <View className="flex-row items-start gap-2">
        <Icon name="edit-3" size={12} color={colors.muted} />
        <Text className="flex-1 text-2xs text-muted">
          <Text className="font-semibold text-ink">
            A reviewer edited the wording that publishes
          </Text>
          {state.publicPurposeByName ? ` — ${state.publicPurposeByName}` : ""}
          {state.publicPurposeAt ? `, ${when(state.publicPurposeAt)}` : ""}.
          Usually that means a name or personal detail came out of the public
          sentence. Your own wording is kept on the record exactly as you wrote
          it.
        </Text>
      </View>
      <Text className="mt-1.5 text-2xs text-muted">Publishes as:</Text>
      <Text className="text-xs text-ink">“{state.publicPurpose}”</Text>
    </View>
  );
}

/** The editable version, for the four approval seats. */
export function PublicPurposeEditor({
  transactionId,
  state,
  runAction,
}: {
  transactionId: string;
  state: PublicPurposeState;
  runAction: (
    action: () => Promise<unknown>,
    options?: { errorTitle?: string },
  ) => Promise<unknown>;
}) {
  const setPublicPurpose = useMutation(api.transactionCodings.setPublicPurpose);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(
    state.publicPurpose ?? state.businessPurpose,
  );
  const [busy, setBusy] = useState(false);

  async function save(next: string | null) {
    setBusy(true);
    try {
      await runAction(
        () =>
          setPublicPurpose({
            transactionId: transactionId as Id<"transactions">,
            publicPurpose: next,
          }),
        { errorTitle: "Couldn't save the published wording" },
      );
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <View className="mt-1">
        {state.publicPurpose ? (
          <View className="rounded-md border border-border bg-sunken px-3 py-2">
            <Text className="text-2xs text-muted">
              Publishes as{" "}
              {state.publicPurposeByName
                ? `(edited by ${state.publicPurposeByName}${
                    state.publicPurposeAt
                      ? `, ${when(state.publicPurposeAt)}`
                      : ""
                  })`
                : "(edited)"}
              :
            </Text>
            <Text className="text-xs text-ink">“{state.publicPurpose}”</Text>
            <Text className="mt-1 text-2xs text-muted">
              Author&apos;s own wording, kept on the record: “
              {state.businessPurpose}”
            </Text>
          </View>
        ) : null}
        <View className="mt-1 flex-row flex-wrap items-baseline gap-x-1.5">
          <Text className="text-2xs text-muted">
            {state.publicPurpose
              ? "Not right yet?"
              : "Name or personal detail in there?"}
          </Text>
          <Pressable
            onPress={() => {
              setDraft(state.publicPurpose ?? state.businessPurpose);
              setEditing(true);
            }}
            accessibilityRole="button"
            accessibilityLabel="Edit the wording that publishes"
            className="active:opacity-70"
          >
            <Text className="text-2xs font-semibold text-accent underline">
              Edit what publishes
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View className="mt-1.5 gap-2 rounded-md border border-border bg-sunken px-3 py-2.5">
      <Text className="text-2xs text-muted">
        Author&apos;s own wording — kept on the record either way:
      </Text>
      <Text className="text-xs italic text-muted">
        “{state.businessPurpose}”
      </Text>
      <TextField
        label="What publishes instead"
        hint="Take out names and anything else that identifies someone. Keep what the money was for — this still has to make sense to a stranger."
        value={draft}
        onChangeText={setDraft}
        multiline
        numberOfLines={3}
      />
      <View className="flex-row flex-wrap gap-2">
        <Button
          title="Save published wording"
          size="sm"
          loading={busy}
          onPress={() => void save(draft)}
        />
        {state.publicPurpose ? (
          <Button
            title="Use the author's wording"
            size="sm"
            variant="secondary"
            onPress={() => void save(null)}
          />
        ) : null}
        <Button
          title="Cancel"
          size="sm"
          variant="secondary"
          onPress={() => setEditing(false)}
        />
      </View>
    </View>
  );
}
