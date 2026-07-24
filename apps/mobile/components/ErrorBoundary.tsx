/**
 * App-wide error boundary. Catches render-time errors in its subtree (a thrown
 * exception otherwise unmounts the whole React tree to a blank screen) and shows
 * a branded recovery UI instead. Wrap route trees or risky feature subtrees.
 *
 * Class component because React error boundaries require the lifecycle methods
 * `getDerivedStateFromError` / `componentDidCatch` — there is no hook equivalent.
 */
import { Component, type ReactNode } from "react";
import { View, Text, Pressable } from "react-native";
import { Screen } from "./ui/Screen";
import { EmptyState } from "./ui/EmptyState";
import { Button } from "./ui/Button";
import { Icon } from "./ui/Icon";
import { colors } from "../lib/theme";
import { errorMessage } from "../lib/errors";

type Props = {
  children: ReactNode;
  /** Optional reset hook — runs in addition to clearing the caught error. */
  onReset?: () => void;
  /** Renders a compact inline notice instead of the full-screen recovery UI —
   *  for wrapping ONE risky section of a larger screen (e.g. a query that can
   *  legitimately fail) so the rest of the form stays usable instead of the
   *  whole screen going blank. */
  inline?: boolean;
};

type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Surface it for local debugging; a Sentry hook can attach here later.
    console.error("ErrorBoundary caught:", error);
  }

  handleReset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.inline) {
      return (
        <View className="gap-1.5 rounded-lg border border-danger/40 bg-dangerBg px-3 py-2">
          <View className="flex-row items-center gap-1.5">
            <Icon name="alert-triangle" size={14} color={colors.danger} />
            <Text className="text-xs font-semibold text-danger">Couldn't load this</Text>
          </View>
          <Text className="text-2xs text-danger">{errorMessage(error)}</Text>
          <Pressable onPress={this.handleReset} className="self-start">
            <Text className="text-2xs font-semibold text-accent">Try again</Text>
          </Pressable>
        </View>
      );
    }

    return (
      <Screen>
        <View className="flex-1 items-center justify-center">
          <EmptyState
            icon="alert-triangle"
            title="Something went wrong"
            message={errorMessage(error)}
            action={
              <Button title="Try again" icon="refresh-cw" onPress={this.handleReset} />
            }
          />
        </View>
      </Screen>
    );
  }
}
