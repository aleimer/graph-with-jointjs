import { BaseNode, type NodePalette } from './base-node';

/** A leg of the journey — a truck route, a rail terminal, a train.
 * Drawn as a dashed pill so it reads as movement rather than a place. */
export class TransportNode extends BaseNode {
  protected override typeName(): string {
    return 'TransportNode';
  }

  protected override palette(): NodePalette {
    return { fill: '#ffffff', stroke: '#64748b' };
  }

  /** Dashed and heavily rounded, so movement reads differently to a place. */
  override defaults() {
    const defaults = super.defaults();
    const body = (defaults as { attrs: { body: Record<string, unknown> } }).attrs.body;
    body['rx'] = 28;
    body['ry'] = 28;
    body['strokeDasharray'] = '5,4';
    return defaults;
  }

  /** A truck: box body, cab, two wheels. */
  protected override icon(): string {
    return `<path d="M2.6 6.8h10.6v9.4H2.6z" />
      <path d="M13.2 10.1h3.6l3.6 3.4v2.7h-7.2z" />
      <circle cx="6.6" cy="18.2" r="1.8" />
      <circle cx="16.4" cy="18.2" r="1.8" />`;
  }
}
