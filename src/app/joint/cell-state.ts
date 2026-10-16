import { dia } from '@joint/core';

/**
 * Everything the facade keeps on a cell, in one declaration.
 *
 * JointJS cells are open bags: `cell.set('anything', value)` works and
 * `cell.get('anythnig')` quietly returns `undefined`. The facade leans on
 * that for the state it needs — the element's `data` bag, its selector
 * classes, whether a group is collapsed, and the bookkeeping that lets a
 * collapse be undone — which left those keys spelled out as string literals
 * at forty call sites, each read needing a cast to be useful.
 *
 * Declaring them once makes the set discoverable (this interface is the
 * answer to "what does a collapsed group carry?") and makes a typo a
 * compile error instead of an `undefined`.
 *
 * JointJS's own attributes — `vertices`, `router`, `z`, `markup`, `labels` —
 * are not here. Those have real typed accessors already.
 */
export interface CellState {
  /** The definition the cell was built from; what selectors read. */
  data: Record<string, unknown>;

  /** Selector classes, as Cytoscape passes them: a list or a spaced string. */
  classes: string | string[];

  /** Set on a group whose children are stashed off-graph. */
  collapsed: boolean;

  /** A collapsed group's size before it shrank, restored on expand. */
  expandedSize: dia.Size;

  /**
   * Where a link pointed before it was re-aimed at a collapsing group. Only
   * the end that crossed the boundary is recorded.
   */
  redirect: { source?: dia.Link.EndJSON; target?: dia.Link.EndJSON };

  /** Links folded into this one while a group is collapsed, as JSON. */
  bundled: object[];

  /** The labels this link had before a bundle count replaced them. */
  unbundledLabels: dia.Link.Label[];
}

/** Reads one of the facade's keys off a cell. */
export function read<K extends keyof CellState>(
  cell: dia.Cell,
  key: K,
): CellState[K] | undefined {
  return cell.get(key) as CellState[K] | undefined;
}

/** Writes one of the facade's keys. Passing `undefined` clears it. */
export function write<K extends keyof CellState>(
  cell: dia.Cell,
  key: K,
  value: CellState[K] | undefined,
): void {
  cell.set(key, value);
}

/** The cell's data bag, never undefined — an unset bag is an empty one. */
export function dataOf(cell: dia.Cell): Record<string, unknown> {
  return read(cell, 'data') ?? {};
}

/** The cell's selector classes, however they were given, as a list. */
export function classesOf(cell: dia.Cell): string[] {
  const classes = read(cell, 'classes');
  if (!classes) return [];
  return Array.isArray(classes) ? classes : classes.split(/\s+/).filter(Boolean);
}

/** True for a group whose children are currently stashed off-graph. */
export function isCollapsed(cell: dia.Cell): boolean {
  return read(cell, 'collapsed') === true;
}
