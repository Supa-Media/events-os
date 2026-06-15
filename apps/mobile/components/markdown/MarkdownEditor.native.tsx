/**
 * MarkdownEditor (native) — hosts the exact same CodeMirror 6 live-preview setup
 * as the web variant inside a react-native-webview. The Markdown string remains
 * the source of truth; the WebView is purely a rendering/editing surface.
 *
 * Bridge:
 *   - The CM6 editor lives in an HTML document (see ./webviewHtml.ts) loaded via
 *     `source={{ html }}`.
 *   - RN -> WebView: new `value` props are pushed in with `injectJavaScript`
 *     calling `window.__setValue(...)`.
 *   - WebView -> RN: edits arrive through `onMessage` as
 *     `{ type: "change", value }` and are forwarded to `onChange`.
 *
 * `editable` is fixed per mount (changing it remounts the WebView via `key`),
 * which is fine for the How-To doc feature (view vs edit are distinct screens).
 *
 * Same props as MarkdownEditor.web — see ./types.ts.
 */
import { useCallback, useEffect, useRef } from "react";
import { View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import type { MarkdownEditorProps } from "./types";
import { buildEditorHtml } from "./webviewHtml";

export function MarkdownEditor({
  value,
  onChange,
  editable = true,
  placeholder,
  minHeight = 480,
}: MarkdownEditorProps) {
  const webRef = useRef<WebView | null>(null);
  const readyRef = useRef(false);
  // Latest value we have injected, so we don't echo our own edits back in.
  const lastSentRef = useRef(value);

  // The initial HTML is captured once per (editable) mount. Subsequent `value`
  // changes are pushed over the bridge, not by rebuilding the HTML.
  const htmlRef = useRef(
    buildEditorHtml({ initialValue: value, editable, placeholder }),
  );

  const pushValue = useCallback((md: string) => {
    lastSentRef.current = md;
    const js = `window.__setValue(${JSON.stringify(md)}); true;`;
    webRef.current?.injectJavaScript(js);
  }, []);

  // Sync external value changes into the WebView once it's ready.
  useEffect(() => {
    if (!readyRef.current) return;
    if (value === lastSentRef.current) return;
    pushValue(value);
  }, [value, pushValue]);

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let msg: { type?: string; value?: string };
      try {
        msg = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      if (msg.type === "ready") {
        readyRef.current = true;
        // Flush any value that changed between mount and ready.
        if (value !== lastSentRef.current) pushValue(value);
        return;
      }
      if (msg.type === "change" && typeof msg.value === "string") {
        lastSentRef.current = msg.value;
        onChange(msg.value);
      }
    },
    [onChange, pushValue, value],
  );

  return (
    <View
      className="overflow-hidden rounded-lg border border-border bg-surface"
      style={{ height: minHeight }}
    >
      <WebView
        // Remount when editability flips (editable is a static CM facet here).
        key={editable ? "edit" : "read"}
        ref={webRef}
        originWhitelist={["*"]}
        source={{ html: htmlRef.current }}
        onMessage={onMessage}
        // Keyboard + scrolling behaviour suited to a text editor.
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        automaticallyAdjustContentInsets={false}
        scrollEnabled
        style={{ backgroundColor: "transparent" }}
      />
    </View>
  );
}

export default MarkdownEditor;
