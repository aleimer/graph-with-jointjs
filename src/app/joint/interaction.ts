import { dia, mvc } from '@joint/core';
import { isCollapsed } from './cell-state';
import { GROUP_PADDING, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from './constants';
import { GroupNode } from './nodes';
import type { GridPosition, Position, PositionInput } from './types';

/**
 * What the facade has to supply for the interactions to do their work: the
 * grid conversion a dropped node is snapped with, and a way to report that
 * the viewport moved.
 */
export interface InteractionHooks {
  toGrid(position: Position): GridPosition;
  toPixels(position: PositionInput): Position;
  /** Called once a pan or zoom has settled, never while one is in progress. */
  onViewPortChange(): void;
}

/**
 * Drag to pan, wheel to zoom, drop to snap.
 *
 * None of this is part of the Cytoscape API the facade presents — it is what
 * the surface does under the pointer, and an application embedding the graph
 * may well want its own. Keeping it behind one call makes it something to
 * replace rather than something to edit around.
 *
 * Returns a teardown. The paper's own `off()` would catch these handlers too,
 * but only because it catches everything; unbinding what we bound means the
 * interactions can be swapped out while the graph stays up.
 */
export function installInteraction(paper: dia.Paper, hooks: InteractionHooks): () => void {
  const bound: [string, mvc.EventHandler][] = [];
  const on = (event: string, handler: mvc.EventHandler) => {
    bound.push([event, handler]);
    paper.on(event, handler);
  };

  // --- drag the blank paper to pan ------------------------------------------
  let origin: Position | null = null;
  let start = { tx: 0, ty: 0 };

  on('blank:pointerdown', (evt: dia.Event) => {
    origin = { x: evt.clientX ?? 0, y: evt.clientY ?? 0 };
    const current = paper.translate();
    start = { tx: current.tx, ty: current.ty };
  });

  on('blank:pointermove', (evt: dia.Event) => {
    if (!origin) return;
    paper.translate(
      start.tx + ((evt.clientX ?? 0) - origin.x),
      start.ty + ((evt.clientY ?? 0) - origin.y),
    );
  });

  const stopPanning = () => {
    if (!origin) return;
    origin = null;
    hooks.onViewPortChange();
  };
  on('blank:pointerup', stopPanning);
  on('cell:pointerup', stopPanning);

  // --- wheel to zoom, about the pointer -------------------------------------
  const zoomAt = (step: number, at: Position) => {
    const from = paper.scale().sx;
    const to = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, from + step));
    if (to === from) return;

    // Keep the point under the pointer where it is: scaling alone would pull
    // the diagram towards the origin.
    const { tx, ty } = paper.translate();
    paper.scale(to);
    paper.translate(tx - at.x * (to - from), ty - at.y * (to - from));
    hooks.onViewPortChange();
  };

  const onWheel = (evt: dia.Event, x: number, y: number, delta: number) => {
    evt.preventDefault();
    zoomAt(delta * ZOOM_STEP, { x, y });
  };
  on('blank:mousewheel', onWheel);
  on(
    'cell:mousewheel',
    (_view: dia.CellView, evt: dia.Event, x: number, y: number, delta: number) =>
      onWheel(evt, x, y, delta),
  );

  // --- dropping a node snaps it onto the grid -------------------------------
  on('element:pointerup', (view: dia.ElementView) => {
    const element = view.model;
    // A group is sized and placed by its children, so snapping it would fight
    // the fit that follows.
    if (!(element instanceof GroupNode)) {
      const { x, y } = hooks.toPixels(hooks.toGrid(element.position()));
      element.position(x, y);
    }

    const parent = element.getParentCell();
    if (parent?.isElement() && !isCollapsed(parent)) {
      (parent as dia.Element).fitToChildren({ padding: GROUP_PADDING });
    }
  });

  return () => {
    for (const [event, handler] of bound) paper.off(event, handler);
    bound.length = 0;
  };
}
