// ═══════════════════════════════════════════════════════════════════════
// Combined glyph index (A from T2a + B from T2b). Renderers
// (orb-morph.ts, orb3d.ts) use THIS module: GLYPH_REGISTRY, lookupGlyph,
// listGlyphNames. Keys normalized with foldGlyphName (case/accent/spaces),
// same as glyphs-a.ts.
//
// Bridge with T2a: at load it also registers B into glyphs-a via
// registerExtraGlyphs, so A's lookupGlyph stays complete even if a
// renderer uses it directly. On collision A wins (today: 0 collisions).
// ═══════════════════════════════════════════════════════════════════════

import { GLYPHS_A, foldGlyphName, registerExtraGlyphs } from './glyphs-a.ts';
import type { Glyph } from './glyphs-a.ts';
import { GLYPHS_B } from './glyphs-b.ts';

export type { Glyph };

export const GLYPH_REGISTRY: Map<string, Glyph> = new Map();
for (const g of GLYPHS_A) GLYPH_REGISTRY.set(foldGlyphName(g.name), g);
for (const g of GLYPHS_B) {
  const key = foldGlyphName(g.name);
  if (!GLYPH_REGISTRY.has(key)) GLYPH_REGISTRY.set(key, g);
}

registerExtraGlyphs(GLYPHS_B);

export function lookupGlyph(name: string): Glyph | null {
  if (!name) return null;
  return GLYPH_REGISTRY.get(foldGlyphName(name)) ?? null;
}

export function listGlyphNames(): string[] {
  return [...GLYPH_REGISTRY.keys()].sort();
}
