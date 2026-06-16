/**
 * App-wide error boundary. Catches render-time errors in its subtree (a thrown
 * exception otherwise unmounts the whole React tree to a blank screen) and shows
 * a branded recovery UI instead. Wrap route trees or risky feature subtrees.
 *
 * Class component because React error boundaries require the lifecycle methods
 * `getDerivedStateFromError` / `componentDidCatch` — there is no hook equivalent.
 */
import { Component, type ReactNode } from "react";
import { View } from "react-native";
import { Screen } from "./ui/Screen";
import { EmptyState } from "./ui/EmptyState";
import { Button } from "./ui/Button";
import { errorMessage } from "../lib/errors";

type Props = {
  children: ReactNode;
  /** Optional reset hook — runs in addition to clearing the caught error. */
  onReset?: () => void;
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
