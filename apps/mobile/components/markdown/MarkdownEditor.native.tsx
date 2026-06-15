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
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
// expo-image-picker is Expo Go-safe (classified `core` in native-deps.json);
// only used on native, where the WebView can't reach the OS clipboard/files.
import * as ImagePicker from "expo-image-picker";

import type { MarkdownEditorProps } from "./types";
import { buildEditorHtml } from "./webviewHtml";

/**
 * Open a tapped Markdown link in the OS browser. Only http(s) and mailto/tel
 * schemes are allowed — anything malformed or with a different scheme (e.g.
 * `javascript:`, `file:`) is ignored so a doc can't trigger arbitrary deep
 * links or script execution.
 */
function openExternalUrl(raw: string): void {
  const url = raw.trim();
  if (!url) return;
  // Bare URLs (autolinks may arrive without a scheme); prefix https:// so they
  // resolve, then validate the scheme allowlist below.
  const normalized = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url) ? url : `https://${url}`;
  let scheme: string;
  try {
    scheme = new URL(normalized).protocol.replace(/:$/, "").toLowerCase();
  } catch {
    return;
  }
  if (!["http", "https", "mailto", "tel"].includes(scheme)) return;
  void Linking.openURL(normalized).catch(() => {
    // Swallow — an unopenable link simply does nothing.
  });
}

export function MarkdownEditor({
  value,
  onChange,
  editable = true,
  placeholder,
  minHeight = 480,
  uploadImage,
}: MarkdownEditorProps) {
  const webRef = useRef<WebView | null>(null);
  const readyRef = useRef(false);
  const [uploading, setUploading] = useState(false);
  // Read the latest uploadImage through a ref so the picker callback never goes
  // stale and the WebView isn't torn down when the prop identity changes.
  const uploadImageRef = useRef(uploadImage);
  uploadImageRef.current = uploadImage;
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
      let msg: { type?: string; value?: string; url?: string };
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
        return;
      }
      if (msg.type === "openLink" && typeof msg.url === "string") {
        openExternalUrl(msg.url);
      }
    },
    [onChange, pushValue, value],
  );

  // Native image flow: the WebView can't paste binary images or upload to
  // Convex itself, so we pick + upload on the RN side, then inject the resolved
  // URL into the editor as `![](url)` at the caret via the bridge.
  const pickAndInsertImage = useCallback(async () => {
    const upload = uploadImageRef.current;
    if (!upload || uploading) return;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.9,
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      if (!asset) return;
      setUploading(true);
      const resp = await fetch(asset.uri);
      const blob = await resp.blob();
      const url = await upload(blob, asset.mimeType || blob.type || "image/jpeg");
      const js = `window.__insertImage(${JSON.stringify(url)}); true;`;
      webRef.current?.injectJavaScript(js);
    } catch {
      // Swallow — a failed pick/upload simply leaves the document unchanged.
    } finally {
      setUploading(false);
    }
  }, [uploading]);

  // Show the control only when editing AND an upload path is wired (matches web).
  const showAddImage = editable && !!uploadImage;

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
      {showAddImage ? (
        <Pressable
          onPress={() => void pickAndInsertImage()}
          disabled={uploading}
          accessibilityLabel="Add image"
          style={{
            position: "absolute",
            top: 10,
            right: 14,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingVertical: 6,
            paddingHorizontal: 10,
            backgroundColor: "#FAEEE9",
            borderWidth: 1,
            borderColor: "#EFE0DC",
            borderRadius: 8,
            opacity: uploading ? 0.6 : 1,
          }}
        >
          {uploading ? (
            <ActivityIndicator size="small" color="#7A5A5A" />
          ) : (
            <Text style={{ fontSize: 14, lineHeight: 16 }}>🖼</Text>
          )}
          <Text style={{ fontSize: 13, fontWeight: "600", color: "#7A5A5A" }}>
            {uploading ? "Uploading…" : "Add image"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default MarkdownEditor;
