/**
 * expo-camera — gated, dynamically loaded (classified `"gated"` in
 * native-deps.json, per `@supa-media/testing`'s native-import guardrail).
 * It's a brand-new native module: a device running a binary built BEFORE
 * this dependency shipped can still receive this app's JS over OTA, and a
 * static top-level module reference anywhere in the bundle would crash that
 * older binary the instant the JS loads it. Mirrors the "Expo Go-safe
 * (`core`)" doc-comment convention in `MarkdownEditor.native.tsx`, for the
 * opposite classification: every consumer must go through
 * `loadCameraScanning()` below, which resolves the module with a runtime
 * `require` call inside a try/catch (never a static module reference — even
 * a TYPE-ONLY static reference trips the guardrail's text scan, which is why
 * the types below use an inline `typeof import(…)` query instead of a
 * top-level import statement), and gets `null` back on a build that doesn't
 * have it — the caller's job is to fall back to manual entry in that case.
 */
import type { ComponentType } from "react";

type ExpoCameraModule = typeof import("expo-camera");

export type BarcodeScanningResult = Parameters<
  NonNullable<InstanceType<ExpoCameraModule["CameraView"]>["props"]["onBarcodeScanned"]>
>[0];

/** The subset of the module this app actually uses. */
export interface CameraScanningModule {
  CameraView: ComponentType<InstanceType<ExpoCameraModule["CameraView"]>["props"]>;
  useCameraPermissions: ExpoCameraModule["useCameraPermissions"];
}

// Cached after the first resolution attempt so a missing module doesn't pay
// the `require` cost (or log noise) on every render.
let cached: CameraScanningModule | null | undefined;

/**
 * Resolve `expo-camera`'s `CameraView` + `useCameraPermissions`, or `null`
 * if the native module isn't present on this build/platform. Safe to call
 * from a component body (cheap after the first call).
 */
export function loadCameraScanning(): CameraScanningModule | null {
  if (cached !== undefined) return cached;
  try {
    const moduleName = "expo-camera";
    const mod = require(moduleName) as ExpoCameraModule;
    cached = {
      CameraView: mod.CameraView,
      useCameraPermissions: mod.useCameraPermissions,
    };
  } catch {
    cached = null;
  }
  return cached;
}
