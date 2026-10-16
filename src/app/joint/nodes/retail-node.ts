import { BaseNode, type NodePalette } from './base-node';

/** A sales channel: a shop, a depot, the online store. */
export class RetailNode extends BaseNode {
  protected override typeName(): string {
    return 'RetailNode';
  }

  protected override palette(): NodePalette {
    return { fill: '#f5f3ff', stroke: '#8b5cf6' };
  }

  /** A shopfront: awning, window, door. */
  protected override icon(): string {
    return `<path d="M4.2 9.6h15.6v10.2H4.2z" />
      <path d="M2.8 9.6 4.6 4.8h14.8l1.8 4.8z" />
      <path d="M9.4 19.8v-5.6h5.2v5.6" />`;
  }
}
