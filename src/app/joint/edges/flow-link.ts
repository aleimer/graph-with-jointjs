import { dia, shapes, util } from '@joint/core';
import { NODE_GAP } from '../constants';

/**
 * JointJS's built-in router, used by default and as the fallback when
 * libavoid cannot find an orthogonal route.
 *
 * Groups must not be obstacles: their children live inside them, so a router
 * that avoids the group box cannot reach them and gives up, drawing straight
 * through everything instead.
 */
export const MANHATTAN_ROUTER = {
  name: 'manhattan',
  args: { padding: 18, excludeTypes: ['playground.GroupNode'], step: 10 },
};

/** The edge between two nodes. */
export class FlowLink extends shapes.standard.Link {
  override defaults() {
    return util.defaultsDeep(
      {
        type: 'playground.FlowLink',
        router: MANHATTAN_ROUTER,
        // Crossings are allowed but have to be unambiguous: `jumpover` hops
        // one line over the other at every crossing, so a crossing can never
        // be mistaken for a junction. `radius` keeps the 90° corners rounded.
        connector: { name: 'jumpover', args: { size: 7, jump: 'arc', radius: 8 } },
        attrs: {
          line: {
            stroke: '#64748b',
            strokeWidth: 2,
            targetMarker: { type: 'path', d: 'M 10 -5 0 0 10 5 Z', fill: '#64748b', stroke: 'none' },
          },
        },
      },
      super.defaults,
    );
  }
}

/**
 * Sizes a link's band, and the arrowhead that ends it.
 *
 * The head has to grow with the band: an arrowhead narrower than the line it
 * terminates reads as a pennant, and one no longer than it is wide reads as a
 * flat wedge. Roughly 2:1 length to half-width is what reads as an arrow, and
 * both are clamped so a hairline still has a visible head and the heaviest
 * band does not end in a dart the size of a node.
 */
export function setBandWidth(link: dia.Link, width: number): void {
  link.attr('line/strokeWidth', width);

  // Measured back from the tip.
  const reach = Math.min(96, Math.max(18, width * 1.9));
  const half = Math.min(48, Math.max(11, width * 0.85));

  // The marker's +x axis runs *backward* along the line, so a triangle drawn
  // from the tip at the origin sits inside the band and a wide band simply
  // buries it. Putting the base on the origin and the apex at negative x
  // instead sets the whole head beyond the line's end, where nothing can
  // cover it.
  link.attr('line/targetMarker', {
    type: 'path',
    d: `M 0 ${-half} ${-reach} 0 0 ${half} Z`,
    stroke: 'none',
  });

  // Stop the line where the arrowhead starts.
  //
  // `marker-end` puts the head's tip on the path's last point, and the line is
  // stroked right up to that same point — so a band wider than the head's
  // taper buries it, leaving a blunt end with two wings behind it. Pulling the
  // line back by the head's length lets the taper show, and the extra gap
  // keeps the tip clear of the node.
  link.prop(
    'target/connectionPoint',
    { name: 'anchor', args: { offset: Math.round(reach + NODE_GAP) } },
    { avoidRouter: true } as dia.Cell.Options,
  );
}
