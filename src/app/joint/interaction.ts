import { dia, mvc } from '@joint/core';
import { isCollapsed } from './cell-state';
import { GROUP_PADDING, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from './constants';
import { GroupNode } from './nodes';
import { childArea } from './paper';
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
  /** A node is being dragged; routing should wait for it to be put down. */
  onDragStart(element: dia.Element): void;
  onDragEnd(): void;
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

  // --- a drag leaves a faded copy where the node started -------------------
  // Only a picture: a clone of what is drawn, with nothing behind it in the
  // model, so the node itself is still what JointJS drags and drops. Its
  // links stay behind with the copy, routed as they were, and the real ones
  // are hidden until the drop: a link stretching after the pointer is drawn
  // straight and rerouted on release, which is a jump worth not showing.
  let ghosts: Element[] = [];
  let hidden: SVGElement[] = [];
  const clearGhosts = () => {
    for (const ghost of ghosts) ghost.remove();
    for (const el of hidden) el.style.visibility = '';
    ghosts = [];
    hidden = [];
  };

  // Copies go straight under what is dragged, in the order they are made, so
  // it always passes over them — a group's backdrop included — while a
  // child's copies stay above the group it sits in.
  let behind: Element | null = null;
  const leaveGhost = (cell: dia.Cell, opacity: number) => {
    const original = cell.findView(paper)?.el;
    const layer = original?.parentNode;
    if (!original || !layer) return null;
    const ghost = original.cloneNode(true) as Element;
    // Nameless, so nothing that looks a cell up by id or class finds it.
    ghost.removeAttribute('model-id');
    ghost.removeAttribute('id');
    ghost.setAttribute('class', 'drag-ghost');
    ghost.setAttribute('opacity', String(opacity));
    ghost.setAttribute('pointer-events', 'none');
    layer.insertBefore(ghost, behind?.parentNode === layer ? behind : original);
    ghosts.push(ghost);
    return original;
  };

  // Registered ahead of the routing hold below, which straightens these
  // links: the copies have to be taken while they still have their routes.
  on('element:pointerdown', (view: dia.ElementView) => {
    clearGhosts();
    behind = view.el;
    const children = view.model.getEmbeddedCells({ deep: true }).filter((c) => c.isElement());
    // A group is drawn apart from its children and the links between them,
    // so they are copied too: backdrop, then links, then nodes on top.
    const links = paper.model.getConnectedLinks(view.model, { deep: true, includeEnclosed: true });
    leaveGhost(view.model, 0.35);
    for (const link of links) {
      const original = leaveGhost(link, 1);
      if (!original) continue;
      original.style.visibility = 'hidden';
      hidden.push(original);
    }
    for (const child of children) leaveGhost(child, 0.35);
  });
  on('element:pointerup', clearGhosts);

  // --- a drag holds routing until it is over --------------------------------
  on('element:pointerdown', (view: dia.ElementView) => hooks.onDragStart(view.model));

  // --- dropping a node snaps it onto the grid -------------------------------
  on('element:pointerup', (view: dia.ElementView) => {
    const element = view.model;
    // A group is sized and placed by its children, so snapping it would fight
    // the fit that follows.
    if (!(element instanceof GroupNode)) {
      let { x, y } = hooks.toPixels(hooks.toGrid(element.position()));
      // The nearest cell can be over a group's edge; take the one inside.
      const area = childArea(element);
      if (area) {
        const step = paper.options.gridSize ?? 1;
        const { width, height } = element.size();
        if (x < area.x) x += step;
        else if (x + width > area.x + area.width) x -= step;
        if (y < area.y) y += step;
        else if (y + height > area.y + area.height) y -= step;
      }
      element.position(x, y);
    }

    const parent = element.getParentCell();
    if (parent?.isElement() && !isCollapsed(parent)) {
      (parent as dia.Element).fitToChildren({ padding: GROUP_PADDING });
    }

    // Last, so the one pass that follows sees the snapped position and the
    // resized parent rather than routing twice.
    hooks.onDragEnd();
  });

  return () => {
    clearGhosts();
    for (const [event, handler] of bound) paper.off(event, handler);
    bound.length = 0;
  };
}
