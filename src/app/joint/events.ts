import { dia } from '@joint/core';
import type { EventObject, ViewPort } from './types';

/**
 * Everything the graph announces, on one stream.
 *
 * Three things used to carry this traffic and none of them agreed: the
 * facade's own `addEvent`, raw `model.on` for changes, and raw `paper.on` for
 * hover tooling. Two of those reach past the facade into JointJS, so a
 * consumer had to know which layer owned which event — and `addEvent` had no
 * way to unsubscribe at all.
 *
 * The union is discriminated on `kind` so a subscriber narrows by filtering,
 * and `type` keeps the Cytoscape-shaped name the facade was bound with
 * (`tap`, `mouseover`) rather than the JointJS one underneath.
 */
export type GraphEvent = PointerEvent | ChangedEvent | ViewPortEvent;

/** A pointer event on a cell, or on blank paper when `cell` is null. */
export interface PointerEvent extends EventObject {
  kind: 'pointer';
}

/**
 * The graph gained, lost or altered cells.
 *
 * Coalesced to one per tick. JointJS reports cells one at a time, so loading
 * the demo graph announces 128 separate additions; what a consumer wants to
 * know is that the graph is now different, once.
 */
export interface ChangedEvent {
  kind: 'changed';
  nodes: number;
  links: number;
}

/** The paper was panned or zoomed. */
export interface ViewPortEvent {
  kind: 'viewport';
  viewPort: ViewPort;
}

/** Narrowing helpers, so subscribers filter without writing predicates. */
export const isPointer = (event: GraphEvent): event is PointerEvent => event.kind === 'pointer';
export const isChanged = (event: GraphEvent): event is ChangedEvent => event.kind === 'changed';
export const isViewPort = (event: GraphEvent): event is ViewPortEvent => event.kind === 'viewport';

/** Cytoscape event names mapped onto their JointJS paper equivalents. */
export const EVENT_ALIASES: Record<string, string> = {
  tap: 'pointerclick',
  click: 'pointerclick',
  dbltap: 'pointerdblclick',
  dblclick: 'pointerdblclick',
  cxttap: 'contextmenu',
  mouseover: 'mouseenter',
  mouseout: 'mouseleave',
  mousedown: 'pointerdown',
  mouseup: 'pointerup',
  grab: 'pointerdown',
  drag: 'pointermove',
  free: 'pointerup',
};

/**
 * The paper events published on the bus, as Cytoscape-shaped names.
 *
 * A fixed set, bound once, rather than bound lazily per `addEvent` call: a
 * stream nobody has subscribed to yet still has to carry what happens, or the
 * first subscriber would miss everything until a second one asked for it.
 *
 * `pointermove` is deliberately absent. It fires continuously while dragging
 * and nothing listens for it; a consumer that wants it can take `grab` and
 * read the paper directly.
 */
export const PUBLISHED: readonly string[] = [
  'tap',
  'dbltap',
  'cxttap',
  'mouseover',
  'mouseout',
  'mousedown',
  'mouseup',
];

/** The JointJS name a Cytoscape-shaped one is bound as. */
export const jointNameFor = (name: string): string => EVENT_ALIASES[name] ?? name;
