// Frontend SceneSpec v1 types. Mirrors server/lib/scene-spec.js (kept in sync
// by convention; the browser bundle must not import server code).

export type Vec3 = [number, number, number];
export type PartKind = 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus' | 'plane' | 'tube' | 'group';

export interface SceneCamera {
  position: Vec3;
  target: Vec3;
  fov?: number;
}

export interface ScenePart {
  id: string;
  label?: string;
  kind: PartKind;
  size?: Vec3;
  radius?: number;
  height?: number;
  radialSegments?: number;
  position: Vec3;
  rotation?: Vec3;
  color: string;
  metalness?: number;
  roughness?: number;
  opacity?: number;
  explode?: Vec3;
  parent?: string;
}

export interface SceneStep {
  id: string;
  title: string;
  body: string;
  highlight?: string[];
  explode?: number;
  camera?: SceneCamera;
  duration?: number;
}

export interface SceneLegendItem {
  color: string;
  label: string;
}

export interface SceneSpec {
  version: 1;
  title: string;
  subtitle?: string;
  units: 'm';
  background?: 'dark';
  camera: SceneCamera;
  parts: ScenePart[];
  steps?: SceneStep[];
  legend?: SceneLegendItem[];
}

export interface SceneEnvelope {
  projectId?: string;
  version?: number;
  publishedAt?: number;
  spec: SceneSpec;
}

export function isSceneSpec(value: unknown): value is SceneSpec {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && typeof v.title === 'string' && Array.isArray(v.parts) && !!v.camera;
}
