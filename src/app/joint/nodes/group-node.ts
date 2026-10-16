import { shapes, util } from '@joint/core';
import { NODE_SIZE } from '../constants';

/**
 * A compound node: other nodes are embedded in it, and collapsing swaps it to
 * `COLLAPSED_SIZE` while its children are stashed off-graph.
 *
 * `z: -1` keeps the box behind the nodes it contains.
 */
export class GroupNode extends shapes.standard.Rectangle {
  static readonly COLLAPSED_SIZE = { width: NODE_SIZE, height: NODE_SIZE };

  /** Rectangular, so the full half-extent is available anywhere on an edge. */
  attachOffsetX(): number {
    return this.size().width / 2;
  }

  attachOffsetY(): number {
    return this.size().height / 2;
  }

  override defaults() {
    return util.defaultsDeep(
      {
        type: 'playground.GroupNode',
        // Same invisible docking group as the other node types.
        ports: {
          groups: {
            dock: {
              position: { name: 'absolute' },
              markup: [
                {
                tagName: 'circle',
                selector: 'portBody',
                attributes: { r: '1', opacity: '0', 'pointer-events': 'none' },
              },
              ],
            },
          },
          items: [],
        },
        size: { width: 420, height: 420 },
        z: -1,
        attrs: {
          body: {
            rx: 10,
            ry: 10,
            // A tinted panel, so a group reads as a region behind its
            // children rather than as another node. The per-group tint comes
            // from the stylesheet; this is the fallback.
            fill: '#f1f5f9',
            fillOpacity: 0.85,
            stroke: '#94a3b8',
            strokeWidth: 1.5,
            strokeDasharray: '6,4',
          },
          label: {
            textVerticalAnchor: 'top',
            textAnchor: 'start',
            x: 20,
            y: 18,
            fontFamily: 'Inter, system-ui, sans-serif',
            fontSize: 20,
            fontWeight: 600,
            fill: '#64748b',
          },
        },
      },
      super.defaults,
    );
  }
}
