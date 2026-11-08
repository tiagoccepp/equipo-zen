/**
 * Vendored from jarvis-ai-orb-web-animation (MIT, Copyright (c) 2026 cyber1443).
 * https://github.com/cyber1443/jarvis-ai-orb-web-animation -- see ./LICENSE.
 * Local change only: three r128 compat (colorSpace/outputColorSpace -> encoding/
 * outputEncoding). Vendored third-party code; excluded from our eslint.
 */
export type QStateName = "idle" | "thinking" | "success" | "alert";

export type QSize = "hero" | "panel" | "avatar";

export type QPaletteName = "cyan" | "aurora" | "ember";

export interface QStateTarget {
  energy: number;
  rotationSpeed: number;
  particleSpeed: number;
  shellRadius: number;
  ringSpread: number;
  filamentOpacity: number;
  coreScale: number;
  bloom: number;
}

export interface QSizePreset {
  px: number;
  particleCount: number;
  filamentCount: number;
  ringSegments: number;
  sceneScale: number;
  dpr: number;
  minDpr: number;
}

export interface QPaletteValues {
  core: number;
  primary: number;
  secondary: number;
  tertiary: number;
  deep: number;
  fallback: string;
}

export type QState = QStateName | QStateTarget;
export type QPalette = QPaletteName | QPaletteValues;

export const STATE_TARGETS: Record<QStateName, QStateTarget> = {
  idle: {
    energy: 0.72,
    rotationSpeed: 0.48,
    particleSpeed: 0.55,
    shellRadius: 1.0,
    ringSpread: 0.88,
    filamentOpacity: 0.34,
    coreScale: 0.92,
    bloom: 0.55,
  },
  thinking: {
    energy: 1.08,
    rotationSpeed: 1.35,
    particleSpeed: 1.24,
    shellRadius: 1.06,
    ringSpread: 1.06,
    filamentOpacity: 0.5,
    coreScale: 1.05,
    bloom: 0.82,
  },
  success: {
    energy: 1.24,
    rotationSpeed: 0.82,
    particleSpeed: 1.08,
    shellRadius: 1.12,
    ringSpread: 1.16,
    filamentOpacity: 0.64,
    coreScale: 1.18,
    bloom: 1.0,
  },
  alert: {
    energy: 0.94,
    rotationSpeed: 0.92,
    particleSpeed: 0.92,
    shellRadius: 1.04,
    ringSpread: 0.98,
    filamentOpacity: 0.46,
    coreScale: 1.0,
    bloom: 0.74,
  },
};

export const SIZE_PRESETS: Record<QSize, QSizePreset> = {
  hero: {
    px: 640,
    particleCount: 660,
    filamentCount: 74,
    ringSegments: 168,
    sceneScale: 0.82,
    dpr: 2,
    minDpr: 1.25,
  },
  panel: {
    px: 320,
    particleCount: 460,
    filamentCount: 50,
    ringSegments: 144,
    sceneScale: 0.88,
    dpr: 2.25,
    minDpr: 1.75,
  },
  avatar: {
    px: 112,
    particleCount: 165,
    filamentCount: 18,
    ringSegments: 128,
    sceneScale: 0.82,
    dpr: 3.5,
    minDpr: 2.75,
  },
};

export const PALETTES: Record<QPaletteName, QPaletteValues> = {
  cyan: {
    core: 0xeaffff,
    primary: 0x38f4ff,
    secondary: 0x19a8ff,
    tertiary: 0x7fffee,
    deep: 0x063952,
    fallback:
      "radial-gradient(circle at 50% 50%, rgba(238,255,255,0.96) 0%, rgba(56,244,255,0.82) 16%, rgba(25,168,255,0.48) 42%, rgba(6,57,82,0.22) 70%, rgba(0,0,0,0) 82%)",
  },
  aurora: {
    core: 0xeeffee,
    primary: 0x38ff94,
    secondary: 0x19cc77,
    tertiary: 0x7fffaa,
    deep: 0x063920,
    fallback:
      "radial-gradient(circle at 50% 50%, rgba(238,255,238,0.96) 0%, rgba(56,255,148,0.82) 16%, rgba(25,204,119,0.48) 42%, rgba(6,57,32,0.22) 70%, rgba(0,0,0,0) 82%)",
  },
  ember: {
    core: 0xffffea,
    primary: 0xff9438,
    secondary: 0xffa819,
    tertiary: 0xffcc7f,
    deep: 0x523906,
    fallback:
      "radial-gradient(circle at 50% 50%, rgba(255,255,234,0.96) 0%, rgba(255,148,56,0.82) 16%, rgba(255,168,25,0.48) 42%, rgba(82,57,6,0.22) 70%, rgba(0,0,0,0) 82%)",
  },
};

export function resolvePalette(input: QPalette | undefined): QPaletteValues {
  if (!input) return PALETTES.cyan;
  if (typeof input === "string") return PALETTES[input] ?? PALETTES.cyan;
  return input;
}

export function resolveStateTarget(input: QState | undefined): QStateTarget {
  if (!input) return STATE_TARGETS.idle;
  if (typeof input === "string") return STATE_TARGETS[input] ?? STATE_TARGETS.idle;
  return input;
}
