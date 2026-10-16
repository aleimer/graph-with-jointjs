import { BaseNode, type NodePalette } from './base-node';

/** A processing step inside a production line. */
export class FacilityNode extends BaseNode {
  protected override typeName(): string {
    return 'FacilityNode';
  }

  protected override palette(): NodePalette {
    return { fill: '#eff6ff', stroke: '#3b82f6' };
  }

  /** A factory: stepped roofline, windows, a chimney. */
  protected override icon(): string {
    return `<path d="M3.4 19.8V10l5 3.1V10l5 3.1V8.2l7.2 4.3v7.3z" />
      <path d="M7.4 19.8v-3.2M12 19.8v-3.2M16.6 19.8v-3.2" />
      <path d="M6 7.4V4.2" />`;
  }
}
