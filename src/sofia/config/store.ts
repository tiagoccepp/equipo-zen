/**
 * Persistence for the user-overridable subset of `AvatarConfig`. Only the
 * high-level choices a user can flip (skin, theme, glow mode, mood source,
 * feature flags, amplitude scale, head URL, and whether an API key is present)
 * are persisted. The API key itself is NEVER read or written here; only the
 * `apiKeyPresent` boolean flag is.
 *
 * Loading is defensive: unknown keys are ignored (whitelist merge), invalid enum
 * values fall back to the default, and any storage/parse error yields the
 * default config. This keeps a corrupted or hostile localStorage blob from ever
 * breaking the avatar.
 */

import {
  DEFAULT_CONFIG,
  cloneConfig,
  type AvatarConfig,
  type GlowMode,
  type MoodSource,
  type Skin,
} from './config';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const STORAGE_KEY = 'q-avatar-config';

const SKINS: readonly Skin[] = ['orb', 'head', 'reactor'];
const GLOW_MODES: readonly GlowMode[] = ['fresnel', 'halo', 'bloom'];
const MOOD_SOURCES: readonly MoodSource[] = ['tag', 'api', 'off'];
const MAX_STRING = 256;

/** The fields a user may persist; numeric internals (palette/mesh/idle) are not. */
type Persistable = Pick<
  AvatarConfig,
  | 'skin'
  | 'theme'
  | 'glowMode'
  | 'amplitudeScale'
  | 'features'
  | 'moodSource'
  | 'apiKeyPresent'
  | 'headUrl'
>;

function defaultStorage(): StorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING
    ? value
    : fallback;
}

function pickNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

/** Validate an arbitrary parsed blob into a full config over the defaults. */
export function sanitizeConfig(raw: unknown): AvatarConfig {
  const config = cloneConfig(DEFAULT_CONFIG);
  if (!isRecord(raw)) {
    return config;
  }
  config.skin = pickEnum(raw.skin, SKINS, DEFAULT_CONFIG.skin);
  config.theme = pickString(raw.theme, DEFAULT_CONFIG.theme);
  config.glowMode = pickEnum(raw.glowMode, GLOW_MODES, DEFAULT_CONFIG.glowMode);
  config.moodSource = pickEnum(raw.moodSource, MOOD_SOURCES, DEFAULT_CONFIG.moodSource);
  config.amplitudeScale = pickNumber(raw.amplitudeScale, DEFAULT_CONFIG.amplitudeScale, 0, 4);
  config.apiKeyPresent = pickBool(raw.apiKeyPresent, DEFAULT_CONFIG.apiKeyPresent);
  config.headUrl = pickString(raw.headUrl, DEFAULT_CONFIG.headUrl);
  if (isRecord(raw.features)) {
    config.features.bloom = pickBool(raw.features.bloom, DEFAULT_CONFIG.features.bloom);
    config.features.shaderWarp = pickBool(
      raw.features.shaderWarp,
      DEFAULT_CONFIG.features.shaderWarp,
    );
  }
  return config;
}

function toPersistable(config: AvatarConfig): Persistable {
  return {
    skin: config.skin,
    theme: config.theme,
    glowMode: config.glowMode,
    amplitudeScale: config.amplitudeScale,
    features: { ...config.features },
    moodSource: config.moodSource,
    apiKeyPresent: config.apiKeyPresent,
    headUrl: config.headUrl,
  };
}

/** Load and validate the persisted config, falling back to defaults on any error. */
export function loadConfig(storage?: StorageLike | null): AvatarConfig {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) {
    return cloneConfig(DEFAULT_CONFIG);
  }
  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return cloneConfig(DEFAULT_CONFIG);
  }
  if (!raw) {
    return cloneConfig(DEFAULT_CONFIG);
  }
  try {
    return sanitizeConfig(JSON.parse(raw));
  } catch {
    return cloneConfig(DEFAULT_CONFIG);
  }
}

/** Merge a partial update over the persisted config and write the safe subset. */
export function saveConfig(partial: Partial<Persistable>, storage?: StorageLike | null): AvatarConfig {
  const store = storage === undefined ? defaultStorage() : storage;
  const merged = sanitizeConfig({ ...toPersistable(loadConfig(store)), ...partial });
  if (store) {
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(toPersistable(merged)));
    } catch {
      /* persistence is best-effort; ignore quota/security errors */
    }
  }
  return merged;
}
