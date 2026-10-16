import { BaseNode, type NodePalette } from './base-node';

/** A grazing field. Where the cows — and the milk — come from. */
export class FieldNode extends BaseNode {
  protected override typeName(): string {
    return 'FieldNode';
  }

  protected override palette(): NodePalette {
    return { fill: '#ecfdf5', stroke: '#10b981' };
  }

  /** A cow's face: ears, head, eyes, muzzle. */
  protected override icon(): string {
    return `<path d="M6.5 7.5C5 6.2 3.4 6 2.4 7.2c.3 1.7 1.5 2.7 3 2.9" />
      <path d="M17.5 7.5c1.5-1.3 3.1-1.5 4.1-.3-.3 1.7-1.5 2.7-3 2.9" />
      <path d="M5.4 10.5a6.6 6.6 0 0 1 13.2 0v2.6a6.6 6.6 0 0 1-13.2 0z" />
      <path d="M9.4 12.2h.01M14.6 12.2h.01" />
      <path d="M9.2 16.4a3.4 3.4 0 0 0 5.6 0" />`;
  }
}
