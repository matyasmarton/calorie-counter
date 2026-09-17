/** Minimal design tokens for a clean, responsive interface. */
export const colors = {
  primary: '#16a34a',
  primaryDark: '#15803d',
  bg: '#FAF7F2',
  card: '#ffffff',
  border: '#E7E0D3',
  text: '#1A2E22',
  textMuted: '#64748b',
  danger: '#dc2626',
  warning: '#d97706',
  chart: '#16a34a',
  chartWeight: '#2563eb',
  chartGrid: '#E7E0D3',
  /** Editorial rust — the surplus/warning ink used by the Log summary and balance chart. */
  rust: '#C2410C',
};

/**
 * Display face — Bodoni Moda (editorial serif) for typography-as-art headings.
 * Set by the root layout once the font has loaded; falls back to a system serif
 * when loading fails so a missing font never blanks a heading. Read it at render
 * time (inline style) rather than baking it into StyleSheet.create, which would
 * freeze the value before the font resolves.
 */
export let fontDisplay = 'BodoniModa_700Bold';

/** Called by the root layout: the loaded family, or the fallback. */
export function setDisplayFont(family: string): void {
  fontDisplay = family;
}

/** System serif used when the display font cannot be loaded. */
export const displayFontFallback = 'Georgia';

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
};

/** Responsive max content width — desktop browsers get a centered column. */
export const contentMaxWidth = 720;

export const font = {
  title: 20,
  section: 16,
  body: 15,
  caption: 13,
};
