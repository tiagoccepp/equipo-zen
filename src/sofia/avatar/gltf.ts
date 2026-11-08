import * as THREE from 'three';

/**
 * Head GLB loading, isolated so the geometry transforms stay pure and unit
 * tested and the loader itself is injected (mirroring `Avatar`'s
 * `rendererFactory`). The IIFE bundle passes the global `THREE.GLTFLoader`
 * vendored from `examples/js`; the demo passes the ESM `examples/jsm` loader;
 * tests pass a fake. None of this module depends on WebGL, so it runs under
 * happy-dom.
 */

/** The subset of a loaded glTF result we use: a scene graph to traverse. */
export interface GLTFResultLike {
  scene: THREE.Object3D;
}

/** The subset of three's GLTFLoader we call. */
export interface GLTFLoaderLike {
  load(
    url: string,
    onLoad: (gltf: GLTFResultLike) => void,
    onProgress?: ((event: ProgressEvent) => void) | undefined,
    onError?: ((err: unknown) => void) | undefined,
  ): void;
}

export type GLTFLoaderFactory = () => GLTFLoaderLike;

/**
 * Return the first mesh geometry in a loaded scene graph. The head GLB is a
 * single mesh, possibly nested under a Group/Scene. Throws if none is found so
 * the caller can fall back to the orb.
 */
export function extractHeadGeometry(root: THREE.Object3D): THREE.BufferGeometry {
  let found: THREE.BufferGeometry | null = null;
  root.traverse((obj) => {
    if (found) {
      return;
    }
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry && (mesh.geometry as THREE.BufferGeometry).isBufferGeometry) {
      found = mesh.geometry as THREE.BufferGeometry;
    }
  });
  if (!found) {
    throw new Error('No mesh geometry found in head model');
  }
  return found;
}

/**
 * Center the geometry at the origin, scale it so its bounding sphere matches
 * `targetRadius`, and ensure a vertex `normal` attribute exists (the per-vertex
 * deformation displaces along normals, so this is mandatory). Mutates and
 * returns the same geometry.
 */
export function normalizeHeadGeometry(
  geometry: THREE.BufferGeometry,
  targetRadius = 1.2,
): THREE.BufferGeometry {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (box) {
    const center = new THREE.Vector3();
    box.getCenter(center);
    geometry.translate(-center.x, -center.y, -center.z);
  }
  geometry.computeBoundingSphere();
  const radius = geometry.boundingSphere ? geometry.boundingSphere.radius : 0;
  if (radius > 0 && targetRadius > 0) {
    const scale = targetRadius / radius;
    geometry.scale(scale, scale, scale);
  }
  if (!geometry.getAttribute('normal')) {
    geometry.computeVertexNormals();
  }
  return geometry;
}

export interface LoadHeadOptions {
  url: string;
  loaderFactory: GLTFLoaderFactory;
  targetRadius?: number;
}

/**
 * Load and normalize the head geometry. Resolves with a ready-to-render
 * `BufferGeometry`; rejects on loader error or a model with no mesh, so the
 * caller keeps the orb fallback.
 */
export function loadHeadGeometry(options: LoadHeadOptions): Promise<THREE.BufferGeometry> {
  const toError = (err: unknown): Error => {
    if (err instanceof Error) return err;
    if (typeof err === 'string' && err) return new Error(err);
    return new Error('Failed to load head model');
  };
  return new Promise<THREE.BufferGeometry>((resolve, reject) => {
    let loader: GLTFLoaderLike;
    try {
      loader = options.loaderFactory();
    } catch (err) {
      reject(toError(err));
      return;
    }
    loader.load(
      options.url,
      (gltf) => {
        try {
          resolve(normalizeHeadGeometry(extractHeadGeometry(gltf.scene), options.targetRadius));
        } catch (err) {
          reject(toError(err));
        }
      },
      undefined,
      (err) => reject(toError(err)),
    );
  });
}
