import { dia, g } from '@joint/core';
import { isCollapsed } from './cell-state';
import { GROUP_PADDING, MAJOR_GRID, NODE_GAP } from './constants';
import { FlowLink } from './edges';
import { BaseNode, GroupNode, cellNamespace } from './nodes';

/** The paper's own background, and the colour the grid is drawn onto. */
export const PAPER_BACKGROUND = '#f8fafc';

/** The light mesh, and the heavy line every `MAJOR_GRID`. */
const GRID_COLOURS = { minor: '#eef2f7', major: '#cbd5e1' };

/**
 * Builds the JointJS paper.
 *
 * This is one block on purpose. It is where every decision about how the
 * diagram behaves while it is being edited is made — what may be embedded in
 * what, which connections are legal, where a link's line stops — and reading
 * them together is the only way to see the rules as a set. Spread through the
 * facade they would each look like a detail.
 *
 * It is also the file to open first when migrating: everything here is a
 * JointJS concept with no counterpart in the Cytoscape API the facade
 * presents.
 */
export function createPaper(
  container: HTMLElement,
  model: dia.Graph,
  gridSize: number,
): dia.Paper {
  return new dia.Paper({
    el: container,
    model,
    cellViewNamespace: cellNamespace,
    width: '100%',
    height: '100%',
    gridSize,
    background: { color: PAPER_BACKGROUND },
    interactive: { linkMove: false },
    linkPinning: false,
    snapLinks: { radius: 24 },
    markAvailable: true,
    embeddingMode: true,
    frontParentOnly: false,
    findParentBy: 'bbox',

    // Any node goes into a group, but not another group, and only a group
    // takes one. A drag lifts a child out and drops it back only if this
    // says yes, so leaving a kind out is how it loses its group.
    validateEmbedding: (childView, parentView) =>
      parentView.model instanceof GroupNode && childView.model instanceof BaseNode,

    // Once in a group, a node stays in it: a drag stops at the group's inner
    // edge rather than carrying it out.
    restrictTranslate: (elementView) => childArea(elementView.model) ?? false,

    defaultLink: () => new FlowLink(),

    // The router puts each link's anchor on the node's outline already, so
    // the line starts there — pulled back by `offset` so it stops just short
    // of the ring instead of touching it. Computing a boundary intersection
    // would instead land it on the inner circle, inside the ring.
    defaultConnectionPoint: { name: 'anchor', args: { offset: NODE_GAP } },

    // Without ports, links are drawn with the Connect tool that appears on
    // hover rather than by dragging a port. One edge per ordered pair.
    validateConnection: (sourceView, _sourceMagnet, targetView) => {
      if (sourceView === targetView) return false;
      const source = sourceView.model.id;
      const target = targetView.model.id;
      return !model
        .getLinks()
        .some((link) => link.source().id === source && link.target().id === target);
    },

    highlighting: {
      connecting: {
        name: 'stroke',
        options: { padding: 4, attrs: { stroke: '#6366f1', strokeWidth: 2 } },
      },
    },
  });
}

/**
 * Where `element` may sit inside its group: the group's box less the padding
 * it is fitted with, so a child held there never makes it grow. Null for a
 * node outside a group, which may go anywhere.
 */
export function childArea(element: dia.Element): g.Rect | null {
  const parent = element.getParentCell();
  if (!(parent instanceof GroupNode) || isCollapsed(parent)) return null;
  const { top, left, right, bottom } = GROUP_PADDING;
  const box = parent.getBBox();
  return new g.Rect(
    box.x + left,
    box.y + top,
    box.width - left - right,
    box.height - top - bottom,
  );
}

/**
 * Draws the coordinate grid.
 *
 * This uses JointJS's grid layer rather than a background image: the grid
 * layer is transformed with the paper, so the lines stay locked to the nodes
 * while panning and zooming. A background image does not move with the
 * content, which makes the grid appear to slide underneath the diagram.
 */
export function drawGrid(paper: dia.Paper, spacing: number, visible: boolean): void {
  paper.setGridSize(spacing);
  paper.setGrid(
    visible
      ? {
          name: 'doubleMesh',
          args: [
            { color: GRID_COLOURS.minor, thickness: 1 },
            { color: GRID_COLOURS.major, thickness: 1, scaleFactor: MAJOR_GRID / spacing },
          ],
        }
      : false,
  );
  paper.drawBackground({ color: PAPER_BACKGROUND });
}
