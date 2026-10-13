import { Text, View } from "react-native";
import type { AcademyQuestion } from "@events-os/shared";
import { Button, Radio, RadioGroup, TextField } from "../../ui";
import { EditorIconButton, EditorLabel, MoveControls, RadioDot } from "./EditorBits";
import { moveItem, removeAt, replaceAt } from "./listOps";

const blankQuestion = (): AcademyQuestion => ({
  prompt: "",
  options: ["", ""],
  answerIndex: 0,
  explanation: "",
});

/**
 * The lesson's quiz. Learners must get every question right to pass, and the
 * server grades against exactly what is published here.
 */
export function QuizEditor({
  quiz,
  onChange,
}: {
  quiz: AcademyQuestion[];
  onChange: (next: AcademyQuestion[]) => void;
}) {
  return (
    <View className="gap-3">
      {quiz.map((q, i) => (
        <QuestionCard
          key={i}
          index={i}
          count={quiz.length}
          question={q}
          onChange={(next) => onChange(replaceAt(quiz, i, next))}
          onMove={(to) => onChange(moveItem(quiz, i, to))}
          onRemove={() => onChange(removeAt(quiz, i))}
        />
      ))}
      <View className="flex-row">
        <Button
          title="Add a question"
          icon="plus"
          variant="secondary"
          size="sm"
          onPress={() => onChange([...quiz, blankQuestion()])}
        />
      </View>
    </View>
  );
}

function QuestionCard({
  index,
  count,
  question: q,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  question: AcademyQuestion;
  onChange: (next: AcademyQuestion) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  function removeOption(o: number) {
    const options = removeAt(q.options, o);
    // Keep the same answer marked when an option above it goes.
    const answerIndex =
      o === q.answerIndex ? 0 : o < q.answerIndex ? q.answerIndex - 1 : q.answerIndex;
    onChange({ ...q, options, answerIndex });
  }
  function moveOption(o: number, to: number) {
    const order = moveItem(
      q.options.map((_, k) => k),
      o,
      to,
    );
    onChange({
      ...q,
      options: order.map((k) => q.options[k]),
      answerIndex: order.indexOf(q.answerIndex),
    });
  }

  return (
    <View className="rounded-lg border border-border bg-raised p-3">
      <View className="mb-2 flex-row items-center justify-between">
        <Text className="text-xs font-bold uppercase tracking-wider text-muted">
          Question {index + 1}
        </Text>
        <MoveControls index={index} count={count} noun="question" onMove={onMove} onRemove={onRemove} />
      </View>
      <TextField
        label="Question"
        value={q.prompt}
        multiline
        numberOfLines={2}
        onChangeText={(prompt) => onChange({ ...q, prompt })}
      />
      <EditorLabel>Answers (mark the right one)</EditorLabel>
      <RadioGroup accessibilityLabel={`Right answer to question ${index + 1}`} className="mb-2 mt-2 gap-2">
        {q.options.map((opt, o) => (
          <View key={o} className="flex-row items-start gap-2">
            <View className="pt-2.5">
              <Radio
                checked={q.answerIndex === o}
                accessibilityLabel={`Answer ${o + 1} is right`}
                onSelect={() => onChange({ ...q, answerIndex: o })}
              >
                <RadioDot checked={q.answerIndex === o} />
              </Radio>
            </View>
            <View className="flex-1">
              <TextField
                value={opt}
                multiline
                numberOfLines={1}
                accessibilityLabel={`Answer ${o + 1}`}
                onChangeText={(t) => onChange({ ...q, options: replaceAt(q.options, o, t) })}
              />
            </View>
            <View className="flex-row gap-1">
              <EditorIconButton
                icon="arrow-up"
                label="Move answer up"
                disabled={o === 0}
                onPress={() => moveOption(o, o - 1)}
              />
              <EditorIconButton
                icon="x"
                label="Remove answer"
                tone="danger"
                disabled={q.options.length <= 2}
                onPress={() => removeOption(o)}
              />
            </View>
          </View>
        ))}
      </RadioGroup>
      {q.options.length < 8 ? (
        <View className="mb-3 flex-row">
          <Button
            title="Add an answer"
            icon="plus"
            size="sm"
            variant="ghost"
            onPress={() => onChange({ ...q, options: [...q.options, ""] })}
          />
        </View>
      ) : null}
      <TextField
        label="Explanation"
        hint="Shown after they answer, right or wrong. Restate the rule."
        value={q.explanation}
        multiline
        numberOfLines={2}
        onChangeText={(explanation) => onChange({ ...q, explanation })}
      />
    </View>
  );
}
