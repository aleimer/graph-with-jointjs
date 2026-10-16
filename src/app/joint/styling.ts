import { dia } from '@joint/core';
import { dataOf } from './cell-state';
import { setBandWidth } from './edges';
import { matcher, matches } from './selector';
import type { Config, EdgeWeightConfig, EdgeWeightLabel, StylesheetStyle } from './types';

/**
 * Turning the stylesheets, the weight scale and the filter into cell
 * attributes.
 *
 * All three write to the same place and the order they run in is the whole
 * behaviour — weights are applied after the stylesheets so a measured width
 * beats a declared one, and the filter runs last because hiding a cell has to
 * survive whatever the other two just set. The facade calls them in that
 * order; keeping them together is what makes the order reviewable.
 */

/** Applies every matching rule, in the order they were registered. */
export function applyStylesheets(cells: dia.Cell[], styles: StylesheetStyle[]): void {
  for (const cell of cells) {
    for (const rule of styles) {
      if (!matches(cell, rule.selector)) continue;
      for (const [path, value] of Object.entries(rule.style)) {
        cell.attr(path, value);
      }
    }
  }
}

/**
 * Hides what the filter does not match.
 *
 * A filtered-out cell is hidden rather than removed, so clearing the filter
 * brings it straight back — and so the router still sees it as an obstacle,
 * which keeps the remaining routes where they were.
 */
export function applyFilter(cells: dia.Cell[], filter: Config['filter']): void {
  const test = !filter ? null : typeof filter === 'function' ? filter : matcher(filter);

  for (const cell of cells) {
    // Only write when the answer changed. Setting an attribute to the value
    // it already holds still costs a view update, and with no filter
    // configured that is every cell on the graph, every time anything is
    // restyled — the most expensive of the three passes, spent on nothing.
    const next = !test || test(cell) ? null : 'none';
    if ((cell.attr('root/display') ?? null) !== next) cell.attr('root/display', next);
  }
}

/**
 * Scales link thickness by a numeric field, so volume is readable at a
 * glance.
 *
 * The values are collected before any of them is used: a quantile scale has
 * to see the whole distribution to know which band a link falls in, and a
 * link whose field is missing or unparseable is left at whatever width the
 * stylesheets gave it rather than being forced to the bottom of the scale.
 */
export function applyWeights(links: dia.Link[], weight: EdgeWeightConfig): void {
  const values = new Map<dia.Cell.ID, number>();
  for (const link of links) {
    const raw = dataOf(link)[weight.field];
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(value)) values.set(link.id, value);
  }
  if (!values.size) return;

  const domain = weight.domain ?? [Math.min(...values.values()), Math.max(...values.values())];
  const sorted = [...values.values()].sort((a, b) => a - b);

  for (const link of links) {
    const value = values.get(link.id);
    if (value === undefined) continue;

    setBandWidth(link, strokeWidthFor(value, domain, weight, sorted));
    applyWeightLabel(link, value, weight.label);
  }
}

/**
 * Prints the weight on the link. The label is tagged so it can be found and
 * updated in place: rebuilding the whole label list would wipe the text
 * labels from the data and the `×n` added by edge bundling.
 */
function applyWeightLabel(
  link: dia.Link,
  value: number,
  config: EdgeWeightLabel | false | undefined,
): void {
  const labels = link.labels();
  const index = labels.findIndex((label) => (label as { weightLabel?: boolean }).weightLabel);

  if (!config) {
    if (index >= 0) link.removeLabel(index);
    return;
  }

  const label = {
    weightLabel: true,
    // Just above the line at its midpoint, clear of any text label on it.
    position: { distance: 0.5, offset: -11 },
    attrs: {
      rect: { fill: '#ffffff', stroke: '#e2e8f0', strokeWidth: 1, rx: 3, ry: 3 },
      text: {
        text: formatWeight(value, config),
        fill: '#475569',
        fontSize: 10,
        fontFamily: 'Inter, system-ui, sans-serif',
      },
    },
  };

  if (index >= 0) link.label(index, label);
  else link.appendLabel(label);
}

/** `15000` → `15k`, `1664` → `1.7k`, `90` → `90`. */
export function formatWeight(
  value: number,
  { unit = '', compact = true, decimals = 0 }: EdgeWeightLabel,
): string {
  if (compact && Math.abs(value) >= 1000) {
    const thousands = value / 1000;
    const text = thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10;
    return `${text}k${unit}`;
  }
  return `${value.toFixed(decimals)}${unit}`;
}

/**
 * Splits `sorted` into `steps` equally sized groups and returns which one
 * `value` falls in, 0-based. Equal values always land in the same group.
 */
function quantileStep(value: number, sorted: number[], steps: number): number {
  if (sorted.length < 2) return 0;
  // The first position holding this value, so ties are not split across steps.
  const rank = sorted.findIndex((entry) => entry >= value);
  const position = rank < 0 ? sorted.length - 1 : rank;
  const step = Math.floor((position / sorted.length) * steps);
  return Math.min(steps - 1, step);
}

/** Maps a value onto a stroke width, via the configured scale. */
export function strokeWidthFor(
  value: number,
  [low, high]: [number, number],
  { min = 1.5, max = 9, scale = 'quantile', steps = 5 }: EdgeWeightConfig,
  sorted: number[] = [],
): number {
  if (scale === 'quantile') {
    const bands = Math.max(2, steps);
    const step = quantileStep(value, sorted, bands);
    return Math.round((min + (step / (bands - 1)) * (max - min)) * 10) / 10;
  }

  const clamped = Math.min(high, Math.max(low, value));
  // `log` needs a positive domain; shift it up when the data starts at zero.
  const shift = scale === 'log' && low <= 0 ? 1 - low : 0;
  const curve = (input: number) =>
    scale === 'sqrt'
      ? Math.sqrt(input)
      : scale === 'log'
        ? Math.log(input + shift)
        : input;

  const span = curve(high) - curve(low);
  const ratio = span === 0 ? 1 : (curve(clamped) - curve(low)) / span;
  return Math.round((min + ratio * (max - min)) * 10) / 10;
}
