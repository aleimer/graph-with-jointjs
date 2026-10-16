import { dia } from '@joint/core';
import { Observable, Subject, filter, map } from 'rxjs';
import type { Config, EventObject, GridPosition, ViewPort } from './types';

/**
 * The events the graph carries, and what each one says.
 *
 * Two directions share one map. Names beginning `cell:`, `graph:` and
 * `viewport:` are the graph announcing what happened; the rest are asked of
 * it, and the facade answers them by calling the method that already does
 * the work. The methods stay public, so a programmatic caller keeps the
 * chaining and the return values; the bus is how the UI reaches them without
 * holding the graph's API in its hands.
 */
export interface GraphEvents {
  // --- announced by the graph ------------------------------------------------
  'cell:tap': PointerEvent;
  'cell:dbltap': PointerEvent;
  'cell:cxttap': PointerEvent;
  'cell:mouseover': PointerEvent;
  'cell:mouseout': PointerEvent;
  'cell:mousedown': PointerEvent;
  'cell:mouseup': PointerEvent;

  /**
   * The graph gained, lost or altered cells.
   *
   * Coalesced to one per tick. JointJS reports cells one at a time, so
   * loading the demo graph would otherwise announce 128 separate additions to
   * say the one thing a consumer needs to hear.
   */
  'graph:changed': ChangedEvent;

  /** The paper was panned or zoomed, however it was asked for. */
  'viewport:moved': ViewPortEvent;

  /**
   * What is selected, or null for nothing.
   *
   * Only the cell travels. Everything a consumer wants to show about it — a
   * label, whether it is a group, the data bag — is on the cell already, and
   * a payload that repeated them would be one more thing to keep in step.
   */
  'selection:changed': { cell: dia.Cell | null };

  // --- asked of the graph ----------------------------------------------------
  'viewport:zoom': { by?: number; to?: number };
  'viewport:fit': void;
  'viewport:set': ViewPort;
  'grid:show': { visible: boolean };
  'filter:set': { filter: Config['filter'] };
  'config:set': Config;
  'node:move': { id: string; position: GridPosition };
  'cells:remove': { selector: string };
  'layout:arrange': void;
  'selection:set': { id: string | null };
  'selection:delete': void;
  'selection:collapse': void;
}

/** A pointer event on a cell, or on blank paper when `cell` is null. */
export interface PointerEvent extends EventObject {
  cell: dia.Cell | null;
  view: dia.CellView | null;
}

export interface ChangedEvent {
  nodes: number;
  links: number;
}

export interface ViewPortEvent {
  viewPort: ViewPort;
}

/** One emission, as it travels. */
interface Envelope {
  name: keyof GraphEvents;
  payload: unknown;
}

/**
 * The graph's event bus.
 *
 * Owned by the facade and reached as `graph.eventbus`, so there is one place
 * the DOM, JointJS and Angular meet rather than three that disagree. It is
 * deliberately thin: a typed `emit`, a typed `on`, and a stream of everything
 * for a consumer that wants to watch the lot.
 */
export class EventBus {
  private readonly stream = new Subject<Envelope>();

  /** Every emission, in order. For logging, devtools, or a catch-all. */
  readonly all$: Observable<Envelope> = this.stream.asObservable();

  /**
   * Announces an event, or asks for a command.
   *
   * The payload is optional exactly when the event declares none, so
   * `emit('viewport:fit')` is as valid as `emit('grid:show', { visible })`.
   */
  emit<K extends keyof GraphEvents>(
    name: K,
    ...payload: GraphEvents[K] extends void ? [] : [GraphEvents[K]]
  ): void {
    if (this.stream.closed) return;
    this.stream.next({ name, payload: payload[0] });
  }

  /** One event's stream, typed by its name. */
  on<K extends keyof GraphEvents>(name: K): Observable<GraphEvents[K]> {
    return this.stream.pipe(
      filter((envelope) => envelope.name === name),
      map((envelope) => envelope.payload as GraphEvents[K]),
    );
  }

  /**
   * Several events at once, for a consumer that treats them alike — the
   * pointer events being the case that asks for it.
   */
  onAny<K extends keyof GraphEvents>(
    ...names: K[]
  ): Observable<{ name: K; payload: GraphEvents[K] }> {
    const wanted = new Set<keyof GraphEvents>(names);
    return this.stream.pipe(
      filter((envelope) => wanted.has(envelope.name)),
      map((envelope) => ({ name: envelope.name as K, payload: envelope.payload as GraphEvents[K] })),
    );
  }

  /**
   * Ends the bus. Subscribers complete rather than waiting on a stream
   * nothing will feed again.
   */
  destroy(): void {
    this.stream.complete();
  }
}

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
 * The pointer events the bus carries, as Cytoscape-shaped names.
 *
 * A fixed set, bound once, rather than bound lazily per `addEvent` call: a
 * stream has to carry what happens whether or not anyone has subscribed yet,
 * or the first subscriber changes what the second one sees.
 *
 * `pointermove` is deliberately absent. It fires continuously while dragging
 * and nothing listens for it; a consumer that wants it can take `mousedown`
 * and read the paper directly.
 */
export const POINTER_EVENTS = [
  'tap',
  'dbltap',
  'cxttap',
  'mouseover',
  'mouseout',
  'mousedown',
  'mouseup',
] as const;

export type PointerEventName = (typeof POINTER_EVENTS)[number];

/** `tap` → `cell:tap`, the name it travels under. */
export const pointerEventName = (name: PointerEventName) => `cell:${name}` as const;

/** The JointJS name a Cytoscape-shaped one is bound as. */
export const jointNameFor = (name: string): string => EVENT_ALIASES[name] ?? name;
