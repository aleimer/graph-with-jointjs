import { BaseNode, type NodePalette } from './base-node';

/** Something that falls out of the process — whey, buttermilk, the piggery
 * that eats them. */
export class ByproductNode extends BaseNode {
  protected override typeName(): string {
    return 'ByproductNode';
  }

  protected override palette(): NodePalette {
    return { fill: '#fdf4ff', stroke: '#a855f7' };
  }

  /** A droplet — what drains off the line. */
  protected override icon(): string {
    return `<path d="M12 3.4c0 0 6.2 6.6 6.2 10.2a6.2 6.2 0 0 1-12.4 0C5.8 10 12 3.4 12 3.4z" />
      <path d="M9.4 14.2a2.6 2.6 0 0 0 2.6 2.6" />`;
  }
}
