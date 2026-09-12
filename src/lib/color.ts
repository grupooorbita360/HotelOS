/**
 * Deriva las variantes "dark"/"soft" de un solo color de marca elegido por el
 * hotel en Configuración, para no pedirle 3 tonos manualmente. Mismo criterio
 * visual que la paleta fija de globals.css (dark = mezcla con negro, soft =
 * mezcla con blanco).
 */
function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix([r, g, b]: [number, number, number], target: number, amount: number): string {
  const m = (c: number) => Math.round(c + (target - c) * amount);
  return `#${[m(r), m(g), m(b)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export function isValidHexColor(hex: string): boolean {
  return hexToRgb(hex) !== null;
}

export function computeBrandShades(hex: string): { brand: string; brandDark: string; brandSoft: string } | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return {
    brand: `#${hex.replace("#", "")}`,
    brandDark: mix(rgb, 0, 0.25),
    brandSoft: mix(rgb, 255, 0.9),
  };
}

/**
 * Estilo inline para sobreescribir las variables de marca (globals.css)
 * dentro del subárbol de una página -- así cada hotel puede tener su color
 * sin tocar el CSS global ni tener que recompilar nada.
 */
export function brandStyleVars(brandColor?: string | null): Record<string, string> {
  const shades = brandColor ? computeBrandShades(brandColor) : null;
  if (!shades) return {};
  return {
    "--color-brand": shades.brand,
    "--color-brand-dark": shades.brandDark,
    "--color-brand-soft": shades.brandSoft,
  };
}
