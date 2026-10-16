/**
 * JointJS decides SVG is unsupported when `window.SVGAngle` is missing, and
 * then replaces all of Vectorizer with a stub that throws. jsdom implements
 * enough SVG for model-level work but not that interface, so declare it.
 *
 * Geometry that genuinely needs a layout engine (text measurement, screen
 * CTMs) still won't work here — keep those assertions in the browser.
 */
(globalThis as unknown as { SVGAngle: unknown }).SVGAngle ??= class SVGAngle {};
