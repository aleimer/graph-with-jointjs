import { dia } from '@joint/core';

/**
 * Public types for the Graph facade.
 *
 * These deliberately mirror the Cytoscape-shaped API (ElementDefinition with a
 * `data` bag, string selectors, a stylesheet array) so call sites can move over
 * with minimal edits. The JointJS specifics stay behind the facade.
 */

/** Pixel coordinates, as JointJS stores them. */
export interface Position {
  x: number;
  y: number;
}

/**
 * Whole-number grid coordinates: `{ col: 0, row: 0 }` is the top-left cell,
 * `{ col: 5, row: 2 }` is six cells right and three down. One cell is
 * `Config.grid` pixels; the facade converts with `toPixels()` / `toGrid()`.
 */
export interface GridPosition {
  col: number;
  row: number;
}

/** Positions may be given either way; grid coordinates are the default. */
export type PositionInput = GridPosition | Position;

export interface GridSize {
  cellWidth: number;
  cellHeight: number;
}

export interface ViewPort {
  pan: Position;
  zoom: number;
}

export interface NodeData {
  id: string;
  label?: string;
  /** id of the parent node — becomes a JointJS embedding. */
  parent?: string;
  [key: string]: unknown;
}

export interface EdgeData {
  id?: string;
  source: string;
  target: string;
  label?: string;
  [key: string]: unknown;
}

export interface NodeDefinition {
  group?: 'nodes';
  /**
   * Which node class to build, e.g. `'FieldNode'` (or the fully qualified
   * `'playground.FieldNode'`). Unknown or missing falls back to `TaskNode`.
   */
  type?: string;
  data: NodeData;
  position?: PositionInput;
  classes?: string | string[];
}

export interface EdgeDefinition {
  group?: 'edges';
  data: EdgeData;
  classes?: string | string[];
}

export type ElementDefinition = NodeDefinition | EdgeDefinition;

/**
 * One stylesheet rule. `selector` uses the mini selector language in
 * `selector.ts`; `style` keys are JointJS attribute paths, e.g.
 * `{ 'body/fill': '#fff', 'label/fontSize': 12 }`.
 */
export interface StylesheetStyle {
  selector: string;
  style: Record<string, unknown>;
}

export interface EdgeConfig {
  /** Collapse several redirected edges between the same pair into one. */
  bundle?: boolean;
  /** Re-point edges at the collapsed ancestor instead of hiding them. */
  redirectOnCollapse?: boolean;
  /**
   * `manhattan` routes each link on its own (JointJS built-in); `avoid` uses
   * libavoid, which knows about every other route and nudges overlapping
   * segments apart. `avoid` needs `AvoidRouter.load()` to have been awaited.
   */
  router?: 'manhattan' | 'avoid';
  /** Scales link thickness from a numeric field in the edge's `data`. */
  weight?: EdgeWeightConfig;
}

export interface EdgeWeightConfig {
  /** Key in the edge's `data` bag, e.g. `'litres'`. */
  field: string;
  /** Stroke width in px for the smallest value. Default 1.5. */
  min?: number;
  /** Stroke width in px for the largest value. Default 9. */
  max?: number;
  /**
   * How values map onto that range.
   *
   * `quantile` (the default) sorts the values and splits them into `steps`
   * equally sized groups, giving each group one width. Use it whenever the
   * values span orders of magnitude: a continuous scale then crowds most
   * links into the bottom of the range, where a flow five times bigger than
   * its neighbour looks barely thicker.
   *
   * `linear`, `sqrt` and `log` map the value itself onto the range, which is
   * the right answer only when the values sit within an order or two.
   */
  scale?: 'quantile' | 'linear' | 'sqrt' | 'log';
  /** Number of width classes for the `quantile` scale. Default 5. */
  steps?: number;
  /**
   * Fix the value domain instead of taking it from the data. Useful when
   * several diagrams must stay comparable.
   */
  domain?: [number, number];
  /** Also print the value on the link. Omit or set false to show no label. */
  label?: EdgeWeightLabel | false;
}

export interface EdgeWeightLabel {
  /** Appended to the number, e.g. `' L'`. */
  unit?: string;
  /** 15000 → `15k`. On by default; large numbers crowd a dense diagram. */
  compact?: boolean;
  /** Decimal places for the plain (non-compact) form. Default 0. */
  decimals?: number;
}

export interface Config {
  /** Selector or predicate; anything that does NOT match is hidden. */
  filter?: string | ((cell: dia.Cell) => boolean);
  edges?: EdgeConfig;
  /** Keyed by node id. Grid coordinates unless given as `{ x, y }`. */
  positions?: Record<string, PositionInput>;
  /** Pixels per grid cell. Dragged nodes snap to this. */
  grid?: GridSize;
  /** Node ids that should start collapsed, applied once on first render. */
  collapsed?: string[];
}

/** The shape of `graph.json` — what `toData()` emits and `addElements` takes. */
export interface GraphData {
  elements: ElementDefinition[];
  config?: Config;
  /** Carried in the data file so a demo is fully self-describing. */
  stylesheets?: StylesheetStyle[];
}

export interface EventObject {
  type: string;
  /** The cell under the pointer, or null for events on blank paper. */
  cell: dia.Cell | null;
  view: dia.CellView | null;
  paper: dia.Paper;
  originalEvent: dia.Event | null;
  position: Position;
}

export type EventHandler = (event: EventObject) => void;

export interface Event {
  /** Space-separated list, e.g. `'tap'`, `'mouseover mouseout'`. */
  events: string;
  selector?: string;
  handler: EventHandler;
}

// JointJS has no collection type; arrays keep the signatures honest.
export type NodeCollection = dia.Element[];
export type EdgeCollection = dia.Link[];

export type ParentDefinition = { id: string; label?: string; children: string[] };
/** Either `{ childId: parentId }` or an explicit list of parents. */
export type ParentInput = Record<string, string> | ParentDefinition[];
