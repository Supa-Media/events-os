/**
 * PEOPLE · Application form — the questions on `/team/apply`, edited here.
 *
 * The questions used to be a constant in code, so rewording one or making it
 * optional meant a pull request. Now the desk edits them on this screen and
 * the public form reads them live (`apps/convex/applicationForm.ts`). Each
 * question keeps a stable id, so rewording one never orphans the answers
 * already filed under it, and every application remembers the wording it was
 * asked, so the pipeline keeps showing old answers under their old questions.
 *
 * Same gate as the listings: `hiring.view` to look, `hiring.edit`
 * (`requireApplicationFormManage`) to change.
 */
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  APPLICATION_FORM_LIMITS,
  APPLICATION_TOGGLEABLE_FIELDS,
  isYesNoQuestion,
  newApplicationQuestionKey,
  problemsWithApplicationForm,
  type ApplicationFormConfig,
  type ApplicationQuestion,
} from "@events-os/shared";
import { PipelineTabs } from "../../../components/people/PipelineTabs";
import {
  Button,
  Card,
  EmptyState,
  Icon,
  Narrow,
  Screen,
  SectionHeader,
  Switch,
  TextField,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";

/** The editor's working copy: the answer limit is a string while typing. */
type DraftQuestion = Omit<ApplicationQuestion, "maxLength"> & { maxLength: string };

function toDraft(form: ApplicationFormConfig): DraftQuestion[] {
  return form.questions.map((q) => ({ ...q, maxLength: String(q.maxLength) }));
}

function fromDraft(
  questions: DraftQuestion[],
  requiredFields: ApplicationFormConfig["requiredFields"],
): ApplicationFormConfig {
  return {
    questions: questions.map((q) => ({
      ...q,
      label: q.label.trim(),
      help: q.help.trim(),
      // A yes/no answer has no length to cap; keep a valid number on file so
      // flipping the question back to written still saves.
      maxLength: isYesNoQuestion(q)
        ? APPLICATION_FORM_LIMITS.minAnswerLength
        : Number.parseInt(q.maxLength, 10) || 0,
    })),
    requiredFields,
  };
}

export default function ApplicationFormScreen() {
  // Lives here, not in the editor: a save changes `updatedAt`, which remounts
  // the editor below, and the confirmation has to survive that.
  const [notice, setNotice] = useState<string | null>(null);
  const access = useQuery(api.hiring.myHiringAccess, {});
  const data = useQuery(
    api.applicationForm.getApplicationForm,
    access?.canView ? {} : "skip",
  );

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
  if (data === undefined) return <Screen loading />;

  return (
    <Screen>
      <Narrow>
        <PipelineTabs />
        <SectionHeader
          title="Application form"
          count={`${data.form.questions.length} question${data.form.questions.length === 1 ? "" : "s"}`}
        />
        <Text className="mb-3 text-sm text-muted">
          What every applicant answers on /team/apply. Saved changes go live on
          the page right away. Answers already received keep the wording they
          were asked.
        </Text>
        {notice ? (
          <Text className="mb-3 text-sm font-semibold text-success">{notice}</Text>
        ) : null}
        <FormEditor
          // Re-seed the editor whenever the saved form changes underneath it.
          key={`${data.updatedAt ?? "default"}`}
          form={data.form}
          isDefault={data.isDefault}
          canEdit={access.canManage}
          onSaved={setNotice}
          onEdited={() => setNotice(null)}
        />

      </Narrow>
    </Screen>
  );
}

function FormEditor({
  form,
  isDefault,
  canEdit,
  onSaved,
  onEdited,
}: {
  form: ApplicationFormConfig;
  isDefault: boolean;
  canEdit: boolean;
  onSaved: (notice: string) => void;
  onEdited: () => void;
}) {
  const save = useMutation(api.applicationForm.saveApplicationForm);
  const reset = useMutation(api.applicationForm.resetApplicationForm);

  const [questions, setQuestions] = useState<DraftQuestion[]>(() => toDraft(form));
  const [requiredFields, setRequiredFields] = useState(form.requiredFields);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  // Any edit after a save clears the "Saved" line, so it never vouches for
  // changes that haven't been saved.
  const edit = (fn: (qs: DraftQuestion[]) => DraftQuestion[]) => {
    onEdited();
    setQuestions(fn);
  };

  const update = (i: number, patch: Partial<DraftQuestion>) =>
    edit((qs) => qs.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const move = (i: number, by: -1 | 1) =>
    edit((qs) => {
      const j = i + by;
      if (j < 0 || j >= qs.length) return qs;
      const next = [...qs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const remove = (i: number) => edit((qs) => qs.filter((_, j) => j !== i));
  const add = () =>
    edit((qs) => [
      ...qs,
      {
        key: newApplicationQuestionKey(qs.map((q) => q.key)),
        label: "",
        help: "",
        maxLength: "1000",
        required: false,
      },
    ]);

  const proposed = fromDraft(questions, requiredFields);
  const problems = problemsWithApplicationForm(proposed);

  async function onSave() {
    setError(null);
    if (problems.length > 0) {
      setError(problems.join(" "));
      return;
    }
    setSaving(true);
    try {
      await save({ form: proposed });
      onSaved("Saved. The form is live on /team/apply.");
    } catch (e) {
      setError(
        (e as { data?: { message?: string } })?.data?.message ??
          "Couldn't save. Check your access and try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function onReset() {
    setError(null);
    try {
      await reset({});
      setConfirmReset(false);
      onSaved("Reset to the original questions. The form is live on /team/apply.");
    } catch (e) {
      setError(
        (e as { data?: { message?: string } })?.data?.message ??
          "Couldn't reset. Check your access and try again.",
      );
    }
  }

  return (
    <View className="gap-3 pb-10">
      <Card padding="md">
        <Text className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
          Who you are
        </Text>
        <Text className="mb-3 text-xs text-muted">
          Name and email are always required. Choose which of the rest are too.
        </Text>
        {APPLICATION_TOGGLEABLE_FIELDS.map((f) => (
          <View key={f.key} className="mb-2 flex-row items-center justify-between gap-3">
            <Text className="flex-1 text-sm text-ink">{f.label}</Text>
            <Text className="text-xs text-muted">
              {requiredFields[f.key] ? "Required" : "Optional"}
            </Text>
            <Switch
              value={requiredFields[f.key]}
              onValueChange={(next) => {
                onEdited();
                setRequiredFields((r) => ({ ...r, [f.key]: next }));
              }}
              disabled={!canEdit}
              accessibilityLabel={`${f.label} required`}
            />
          </View>
        ))}
      </Card>

      {questions.map((q, i) => (
        <Card key={q.key} padding="md">
          <View className="mb-2 flex-row items-center justify-between gap-2">
            <Text className="text-xs font-semibold uppercase tracking-wide text-muted">
              Question {i + 1}
            </Text>
            {canEdit ? (
              <View className="flex-row items-center gap-3">
                <IconAction
                  icon="chevron-up"
                  label="Move up"
                  disabled={i === 0}
                  onPress={() => move(i, -1)}
                />
                <IconAction
                  icon="chevron-down"
                  label="Move down"
                  disabled={i === questions.length - 1}
                  onPress={() => move(i, 1)}
                />
                <IconAction
                  icon="trash-2"
                  label="Remove question"
                  danger
                  disabled={questions.length <= APPLICATION_FORM_LIMITS.minQuestions}
                  onPress={() => remove(i)}
                />
              </View>
            ) : null}
          </View>
          <TextField
            label="Question"
            value={q.label}
            onChangeText={(label) => update(i, { label })}
            placeholder="What would you want us to know?"
            editable={canEdit}
            maxLength={APPLICATION_FORM_LIMITS.label}
            multiline
            numberOfLines={2}
          />
          <TextField
            label="Helper text (optional)"
            value={q.help}
            onChangeText={(help) => update(i, { help })}
            placeholder="A line under the question to guide the answer."
            editable={canEdit}
            maxLength={APPLICATION_FORM_LIMITS.help}
            multiline
            numberOfLines={2}
          />
          <View className="mb-2 flex-row items-center justify-between gap-3">
            <Text className="text-sm text-ink">
              {isYesNoQuestion(q) ? "Answered Yes or No" : "Written answer"}
            </Text>
            <Switch
              value={isYesNoQuestion(q)}
              onValueChange={(yesNo) => update(i, { kind: yesNo ? "yesNo" : "text" })}
              disabled={!canEdit}
              accessibilityLabel={`Question ${i + 1} answered Yes or No`}
            />
          </View>
          {isYesNoQuestion(q) ? null : (
            <TextField
              label="Answer limit (characters)"
              value={q.maxLength}
              onChangeText={(maxLength) => update(i, { maxLength })}
              keyboardType="number-pad"
              editable={canEdit}
              hint={`Between ${APPLICATION_FORM_LIMITS.minAnswerLength} and ${APPLICATION_FORM_LIMITS.maxAnswerLength}.`}
            />
          )}
          <View className="flex-row items-center justify-between gap-3">
            <Text className="text-sm text-ink">
              {q.required ? "Required" : "Optional"}
            </Text>
            <Switch
              value={q.required}
              onValueChange={(required) => update(i, { required })}
              disabled={!canEdit}
              accessibilityLabel={`Question ${i + 1} required`}
            />
          </View>
        </Card>
      ))}

      {canEdit ? (
        <>
          {questions.length < APPLICATION_FORM_LIMITS.maxQuestions ? (
            <Pressable
              onPress={add}
              className="flex-row items-center gap-1.5 self-start rounded-md border border-border-strong px-3 py-2"
            >
              <Icon name="plus" size={15} />
              <Text className="text-sm font-medium text-ink">Add a question</Text>
            </Pressable>
          ) : null}

          {error ? <Text className="text-sm text-danger">{error}</Text> : null}
          <Button title="Save form" onPress={onSave} loading={saving} />

          {!isDefault ? (
            confirmReset ? (
              <View className="gap-2">
                <Text className="text-sm text-muted">
                  This replaces every question with the original set. Answers
                  already received are kept.
                </Text>
                <View className="flex-row gap-2">
                  <Button title="Reset to original" variant="danger" onPress={onReset} />
                  <Button
                    title="Cancel"
                    variant="ghost"
                    onPress={() => setConfirmReset(false)}
                  />
                </View>
              </View>
            ) : (
              <Button
                title="Reset to the original questions"
                variant="ghost"
                onPress={() => setConfirmReset(true)}
              />
            )
          ) : null}
        </>
      ) : (
        <Text className="text-sm text-muted">
          Changing the form needs hiring-desk edit access. Ask the People
          Director or the ED.
        </Text>
      )}
    </View>
  );
}

function IconAction({
  icon,
  label,
  onPress,
  disabled = false,
  danger = false,
}: {
  icon: "chevron-up" | "chevron-down" | "trash-2";
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      className={disabled ? "opacity-30" : "active:opacity-60"}
    >
      <Icon name={icon} size={16} color={danger ? "#b91c1c" : colors.muted} />
    </Pressable>
  );
}
