import type { SceneSpec } from './spec.ts';

// Browser mirror of server/lib/scene-spec.js sceneDemo(). Kept data-only so the
// stage demo runs without importing server code. A representative V6 engine:
// block, heads, cam covers, pistons/rods, crankshaft, cams, valves, oil pan,
// intake, exhaust, with per-part explode vectors, labels and 4 explanation steps.

const rad = (deg: number) => (deg * Math.PI) / 180;
const bank = rad(30);
const halfPi = Math.PI / 2;
const boreX = [-0.24, -0.144, -0.048, 0.048, 0.144, 0.24];

function buildDemo(): SceneSpec {
  const parts: SceneSpec['parts'] = [];

  parts.push(
    { id: 'floor', kind: 'plane', size: [2.4, 2.4, 0.001], position: [0, -0.62, 0], rotation: [-halfPi, 0, 0], color: '#14181d', metalness: 0, roughness: 0.95 },
    { id: 'block', label: 'Cylinder block', kind: 'box', size: [0.62, 0.3, 0.34], position: [0, 0.11, 0], color: '#59616b', metalness: 0.45, roughness: 0.5 },
    { id: 'crankshaft', label: 'Crankshaft', kind: 'cylinder', radius: 0.03, height: 0.66, radialSegments: 28, position: [0, 0, 0], rotation: [0, 0, halfPi], color: '#a7b0b9', metalness: 0.85, roughness: 0.3, explode: [0, -0.18, 0] },
    { id: 'crank-pulley', label: 'Pulley', kind: 'cylinder', radius: 0.055, height: 0.028, radialSegments: 28, position: [0, 0.35, 0], color: '#6c7680', metalness: 0.55, roughness: 0.45, parent: 'crankshaft' },
    { id: 'oil-pan', label: 'Oil pan', kind: 'box', size: [0.52, 0.09, 0.28], position: [0, -0.075, 0], color: '#4a5158', metalness: 0.35, roughness: 0.65, explode: [0, -0.34, 0] },
    { id: 'intake-plenum', label: 'Intake plenum', kind: 'box', size: [0.52, 0.07, 0.1], position: [0, 0.36, 0], color: '#5fb49c', metalness: 0.35, roughness: 0.45, explode: [0, 0.4, 0] }
  );

  for (let i = 0; i < 6; i += 1) {
    const side = i % 2 === 0 ? 1 : -1;
    const x = boreX[i];
    const n = i + 1;
    parts.push(
      { id: `piston-${n}`, label: `Piston ${n}`, kind: 'cylinder', radius: 0.048, height: 0.05, radialSegments: 28, position: [x, 0.121, side * 0.07], rotation: [side * bank, 0, 0], color: '#c3cad2', metalness: 0.75, roughness: 0.3, explode: [0, 0.2, side * 0.22] },
      { id: `rod-${n}`, label: `Rod ${n}`, kind: 'box', size: [0.018, 0.115, 0.012], position: [x, 0.067, side * 0.039], rotation: [side * bank, 0, 0], color: '#9aa4ae', metalness: 0.8, roughness: 0.35, explode: [0, 0.1, side * 0.11] },
      { id: `runner-${n}`, kind: 'cone', radius: 0.024, height: 0.11, radialSegments: 20, position: [x, 0.3, side * 0.06], rotation: [side * bank, 0, 0], color: '#4f9e8a', metalness: 0.3, roughness: 0.5, explode: [0, 0.3, side * 0.12] },
      { id: `header-${n}`, kind: 'tube', radius: 0.017, height: 0.11, radialSegments: 20, position: [x, 0.2, side * 0.19], rotation: [side * rad(65), 0, 0], color: '#b0704f', metalness: 0.65, roughness: 0.4, explode: [0, 0.16, side * 0.24] }
    );
  }

  for (const side of [1, -1]) {
    const tag = side > 0 ? 'r' : 'l';
    parts.push(
      { id: `head-${tag}`, label: side > 0 ? 'Right head' : 'Left head', kind: 'box', size: [0.6, 0.09, 0.17], position: [0, 0.215, side * 0.124], rotation: [side * bank, 0, 0], color: '#7d8791', metalness: 0.6, roughness: 0.42, explode: [0, 0.26, side * 0.3] },
      { id: `cam-${tag}`, label: side > 0 ? 'Right cam' : 'Left cam', kind: 'cylinder', radius: 0.02, height: 0.56, radialSegments: 24, position: [0, 0.26, side * 0.15], rotation: [0, 0, halfPi], color: '#b6bec6', metalness: 0.85, roughness: 0.28, explode: [0, 0.34, side * 0.4] },
      { id: `cover-${tag}`, label: side > 0 ? 'Right cam cover' : 'Left cam cover', kind: 'box', size: [0.58, 0.055, 0.14], position: [0, 0.286, side * 0.165], rotation: [side * bank, 0, 0], color: '#68727d', metalness: 0.5, roughness: 0.55, explode: [0, 0.4, side * 0.46] },
      { id: `collector-${tag}`, label: side > 0 ? 'Right collector' : 'Left collector', kind: 'tube', radius: 0.028, height: 0.44, radialSegments: 24, position: [0, 0.16, side * 0.26], rotation: [0, 0, halfPi], color: '#9b5f43', metalness: 0.65, roughness: 0.42, explode: [0, 0.1, side * 0.34] }
    );
    for (let i = 0; i < 3; i += 1) {
      const n = side > 0 ? i * 2 + 1 : i * 2 + 2;
      const x = boreX[n - 1];
      for (const dx of [-0.024, 0.024]) {
        const vid = `valve-${n}-${dx < 0 ? 'a' : 'b'}`;
        parts.push({ id: vid, label: n === 1 && dx < 0 ? 'Intake valve' : undefined, kind: 'cylinder', radius: 0.011, height: 0.1, radialSegments: 16, position: [x + dx, 0.234, side * 0.135], rotation: [side * (bank + rad(6)), 0, 0], color: '#d5dbe0', metalness: 0.9, roughness: 0.22, explode: [0, 0.46, side * 0.54] });
      }
    }
  }

  return {
    version: 1,
    title: 'V6 engine, exploded',
    subtitle: 'Sixty-degree V6: block, rotating assembly, valvetrain, intake and exhaust.',
    units: 'm',
    background: 'dark',
    camera: { position: [1.15, 0.62, 1.3], target: [0, 0.1, 0], fov: 38 },
    parts,
    steps: [
      { id: 'block', title: 'The block holds the geometry', body: 'Six bores sit in two banks at sixty degrees. The block fixes the bore spacing, so every other part finds its place from here.', highlight: ['block', 'piston-1', 'piston-2', 'piston-3', 'piston-4', 'piston-5', 'piston-6'], explode: 0, camera: { position: [1.25, 0.5, 1.2], target: [0, 0.12, 0], fov: 38 }, duration: 5000 },
      { id: 'rotating', title: 'Crank, rods and pistons', body: 'The crankshaft turns the up-and-down motion of six pistons into rotation. Each rod links one piston to its crank pin.', highlight: ['crankshaft', 'crank-pulley', 'piston-1', 'piston-2', 'piston-3', 'piston-4', 'piston-5', 'piston-6', 'rod-1', 'rod-2', 'rod-3', 'rod-4', 'rod-5', 'rod-6'], explode: 0.55, camera: { position: [1.45, 0.35, 1.45], target: [0, 0.06, 0], fov: 40 }, duration: 6000 },
      { id: 'valvetrain', title: 'Heads and valvetrain', body: 'One head per bank carries two valves per cylinder and a camshaft. The cam covers seal the oil; lift them and the whole valvetrain comes with them.', highlight: ['head-l', 'head-r', 'cover-l', 'cover-r', 'cam-l', 'cam-r', 'valve-1-a', 'valve-2-a', 'valve-3-a', 'valve-4-a', 'valve-5-a', 'valve-6-a'], explode: 0.85, camera: { position: [1.2, 0.7, 1.3], target: [0, 0.3, 0], fov: 40 }, duration: 6000 },
      { id: 'circuits', title: 'Air in, gas out, oil below', body: 'The plenum feeds six runners into the heads. Burnt gas leaves through the headers and collectors. The pan keeps the oil under the crank.', highlight: ['intake-plenum', 'runner-1', 'runner-2', 'runner-3', 'runner-4', 'runner-5', 'runner-6', 'header-1', 'header-2', 'header-3', 'header-4', 'header-5', 'header-6', 'collector-l', 'collector-r', 'oil-pan'], explode: 1, camera: { position: [1.5, 0.55, 1.5], target: [0, 0.15, 0], fov: 40 }, duration: 6000 }
    ],
    legend: [
      { color: '#59616b', label: 'Structure' },
      { color: '#c3cad2', label: 'Rotating assembly' },
      { color: '#b6bec6', label: 'Valvetrain' },
      { color: '#5fb49c', label: 'Intake' },
      { color: '#b0704f', label: 'Exhaust' }
    ]
  };
}

export const demoSpec: SceneSpec = buildDemo();
