/**
 * Drag-to-resize table columns, persisted to `localStorage` per `storageKey`
 * — WEB ONLY. Native keeps `defaults` fixed: RN has no `window.localStorage`,
 * and dragging a column edge fights native touch-scroll, so there's no native
 * equivalent to build here (mirrors `ReceiptCell`'s own `Platform.OS==="web"`
 * gate on `pickWeb`/`pickNative`).
 *
 * A saved width only applies to a column key still present in `defaults` —
 * add/remove/rename a column and its stale saved width (or lack of one) is
 * silently dropped in favor of the new default, never crashes.
 */
import { useCallback, useRef, useState } from "react";
import { Platform } from "react-native";

const MIN_COLUMN_WIDTH = 60;

function readStored(storageKey: string): Record<string, number> | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : null;
  } catch {
    return null;
  }
}

function writeStored(storageKey: string, widths: Record<string, number>) {
  if (Platform.OS !== "web" || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(widths));
  } catch {
    // Storage full/disabled (private browsing, quota) — resizing still works
    // for this session, it just won't be remembered next visit.
  }
}

export function useResizableColumns<Key extends string>(
  storageKey: string,
  defaults: Record<Key, number>,
) {
  const [widths, setWidths] = useState<Record<Key, number>>(() => {
    const stored = readStored(storageKey);
    if (!stored) return defaults;
    const merged = { ...defaults };
    for (const key of Object.keys(defaults) as Key[]) {
      const saved = stored[key];
      if (typeof saved === "number" && Number.isFinite(saved) && saved >= MIN_COLUMN_WIDTH) {
        merged[key] = saved;
      }
    }
    return merged;
  });

  // Live drag state lives in a ref (not state) — `mousemove` fires far faster
  // than a render needs to; only `widths` itself (written per-frame below)
  // needs to be state so the header/cells re-render as the handle moves.
  const dragKey = useRef<Key | null>(null);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const startResize = useCallback(
    (key: Key) => (clientX: number) => {
      if (Platform.OS !== "web" || typeof window === "undefined") return;
      dragKey.current = key;
      dragStartX.current = clientX;
      dragStartWidth.current = widths[key];

      const handleMove = (ev: MouseEvent) => {
        const k = dragKey.current;
        if (!k) return;
        const next = Math.max(MIN_COLUMN_WIDTH, dragStartWidth.current + (ev.clientX - dragStartX.current));
        setWidths((prev) => (prev[k] === next ? prev : { ...prev, [k]: next }));
      };
      const handleUp = () => {
        dragKey.current = null;
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
        setWidths((prev) => {
          writeStored(storageKey, prev);
          return prev;
        });
      };
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [storageKey, widths],
  );

  const resetWidths = useCallback(() => {
    setWidths(defaults);
    writeStored(storageKey, defaults);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  return { widths, startResize, resetWidths };
}
