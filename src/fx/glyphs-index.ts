// ═══════════════════════════════════════════════════════════════════════
// Índice combinado de glifos (A de T2a + B de T2b). Los renderers
// (orb-morph.ts, orb3d.ts) usan ESTE módulo: GLYPH_REGISTRY, lookupGlyph,
// listGlyphNames. Claves normalizadas con foldGlyphName (case/tilde/
// espacios), igual que glyphs-a.ts.
//
// Puente con T2a: al cargar también registra B en glyphs-a vía
// registerExtraGlyphs, así el lookupGlyph de A queda completo aunque un
// renderer lo use directo. Ante colisión gana A (hoy: 0 colisiones).
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
