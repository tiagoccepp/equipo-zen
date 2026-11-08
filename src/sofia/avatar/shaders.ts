/**
 * GLSL for the avatar's neon wireframe material.
 *
 * Vertex deformation (breathing/impulse) is computed on the CPU in
 * `Avatar.deform` so the displacement math stays unit-tested in TypeScript; the
 * shader only handles the look: a fresnel rim glow that mixes the deep blue and
 * neon cyan and scales with a `uGlow` uniform the state machine drives.
 */

export const AVATAR_VERTEX_SHADER = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

export const AVATAR_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform vec3 uColorA; // neon cyan (rim)
  uniform vec3 uColorB; // deep blue (core)
  uniform float uGlow;  // emissive intensity, driven by avatar state
  uniform float uOpacity;

  varying vec3 vNormal;
  varying vec3 vView;

  void main() {
    float fresnel = pow(1.0 - max(dot(vNormal, vView), 0.0), 2.0);
    vec3 color = mix(uColorB, uColorA, fresnel);
    gl_FragColor = vec4(color * uGlow, uOpacity);
  }
`;

/**
 * Solid glowing head material (the 'head' skin). Unlike the additive wireframe
 * orb, this renders an opaque, depth-writing surface so the head has a real
 * silhouette. The look: an interior fill that brightens toward the camera plus a
 * bright fresnel rim (uColorA), so the head reads as a glowing form that glows
 * hottest at its edges. Shares the uColorA/uColorB/uGlow contract with the orb,
 * so the controller's setColors/setGlow drive both skins identically.
 */
export const HEAD_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform vec3 uColorA; // rim (bright)
  uniform vec3 uColorB; // core (deep)
  uniform float uGlow;  // emissive intensity, driven by avatar state

  varying vec3 vNormal;
  varying vec3 vView;

  void main() {
    float facing = max(dot(vNormal, vView), 0.0);
    float fresnel = pow(1.0 - facing, 2.5);
    // Interior fill leans on the brighter rim color so the head stays visible,
    // and brightens toward the camera for a volumetric feel.
    vec3 interior = mix(uColorB, uColorA, 0.5) * (0.45 + 0.4 * facing);
    vec3 rim = uColorA * fresnel * 1.6;
    gl_FragColor = vec4((interior + rim) * uGlow, 1.0);
  }
`;

/**
 * Halo shell material for the head: a slightly enlarged BackSide shell rendered
 * additively so it forms a soft glow ring around the silhouette (a cheap,
 * transparency-preserving alternative to post-processing bloom). Brightest at the
 * rim via fresnel; `uColorA`/`uGlow` follow the avatar state/mood.
 */
export const HALO_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform vec3 uColorA; // glow color (rim)
  uniform float uGlow;  // emissive intensity, driven by avatar state

  varying vec3 vNormal;
  varying vec3 vView;

  void main() {
    float fresnel = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.5);
    // Additive blending adds this to the scene, so a dark center contributes
    // little and the rim glows. Alpha is unused under AdditiveBlending.
    gl_FragColor = vec4(uColorA * uGlow * fresnel, 1.0);
  }
`;

/**
 * Reactor rings/orbits material (the 'reactor' skin): additive neon fresnel,
 * brighter and more edge-biased than the orb so thin tori read as glowing arcs.
 * Shares the uColorA/uColorB/uGlow/uOpacity contract, so the controller's
 * setColors/setGlow drive it identically to the other skins.
 */
export const REACTOR_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform vec3 uColorA; // neon rim
  uniform vec3 uColorB; // deep core
  uniform float uGlow;  // emissive intensity, driven by avatar state
  uniform float uOpacity;
  uniform float uAudio; // 0..~1 voice/activity level

  varying vec3 vNormal;
  varying vec3 vView;

  void main() {
    // Audio-reactive fresnel exponent (borrowed from the Filip Zrnzevic orb): the
    // rim sharpens and "heats" with the voice level, so the rings flare on speech.
    float fresnel = pow(1.0 - max(dot(normalize(vNormal), normalize(vView)), 0.0), 1.6 + uAudio * 2.0);
    // Bias toward the rim color even head-on so the whole ring glows, brightest
    // at grazing angles.
    vec3 color = mix(uColorB, uColorA, 0.35 + 0.65 * fresnel);
    gl_FragColor = vec4(color * uGlow * (1.0 + uAudio * 0.6), uOpacity);
  }
`;

/**
 * Reactor core material: an intense additive "white-hot" center that flares on
 * speaking impulses purely through additive overdraw (no post-process bloom, so
 * the canvas stays transparent, same constraint that drove the halo). Uses
 * uColorA as the base and burns toward white toward the camera.
 */
export const REACTOR_CORE_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform vec3 uColorA; // bright base
  uniform vec3 uColorB; // (carried for the setColors contract; unused here)
  uniform float uGlow;  // emissive intensity, driven by avatar state
  uniform float uOpacity;
  uniform float uAudio; // 0..~1 voice/activity level: burns hotter on the beat

  varying vec3 vNormal;
  varying vec3 vView;

  void main() {
    float facing = max(dot(normalize(vNormal), normalize(vView)), 0.0);
    float hot = pow(facing, 1.5);
    vec3 color = mix(uColorA, vec3(1.0), (0.5 + uAudio * 0.4) * hot);
    gl_FragColor = vec4(color * uGlow * (1.8 + uAudio * 0.8), 1.0);
  }
`;

/**
 * Particle-field point shaders (the rotating "dust" around the reactor), adapted
 * from the openclaw / Filip Zrnzevic orb visualizer: each point gently sin/cos
 * drifts, is perspective-sized, brightens with the voice level, and renders as a
 * soft round additive glow. One shared color (the rim) keeps it cohesive.
 */
export const PARTICLE_VERTEX_SHADER = /* glsl */ `
  attribute float aSize;
  uniform float uTime;
  uniform float uAudio;

  void main() {
    vec3 pos = position;
    pos.x += sin(uTime * 0.2 + position.z * 0.5) * 0.06;
    pos.y += cos(uTime * 0.2 + position.x * 0.5) * 0.06;
    pos.z += sin(uTime * 0.2 + position.y * 0.5) * 0.06;
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    // The field sits close to the camera, so a modest perspective scale keeps the
    // points as small discrete sparkles (not a fog).
    gl_PointSize = aSize * (1.0 + uAudio * 1.2) * (140.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

export const PARTICLE_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform vec3 uColor;
  uniform float uGlow;
  uniform float uAudio;

  void main() {
    float r = distance(gl_PointCoord, vec2(0.5));
    if (r > 0.5) {
      discard;
    }
    float glow = pow(1.0 - r * 2.0, 2.0); // soft round falloff
    gl_FragColor = vec4(uColor * uGlow * glow * (0.35 + uAudio * 0.5), 1.0);
  }
`;
