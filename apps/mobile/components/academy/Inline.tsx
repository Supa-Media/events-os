import { Fragment } from "react";
import { Text } from "react-native";

/**
 * Minimal inline-emphasis parser for Academy article prose: splits on
 * `**bold**` / `*italic*` runs and renders each as a styled <Text> span —
 * no markdown lib. Anything else passes through verbatim. Must be rendered
 * inside a parent <Text> (spans inherit its base style).
 */
export function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
          return (
            <Text key={i} className="font-bold">
              {part.slice(2, -2)}
            </Text>
          );
        }
        if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
          return (
            <Text key={i} className="italic">
              {part.slice(1, -1)}
            </Text>
          );
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}
