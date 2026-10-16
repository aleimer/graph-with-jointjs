import { BaseNode, type NodePalette } from './base-node';

/** Whoever actually drinks or eats the stuff. */
export class CustomerNode extends BaseNode {
  protected override typeName(): string {
    return 'CustomerNode';
  }

  protected override palette(): NodePalette {
    return { fill: '#fff1f2', stroke: '#f43f5e' };
  }

  /** A person: head and shoulders. */
  protected override icon(): string {
    return `<circle cx="12" cy="8" r="3.4" />
      <path d="M4.8 20.2a7.2 7.2 0 0 1 14.4 0" />`;
  }
}
