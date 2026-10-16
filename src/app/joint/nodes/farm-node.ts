import { BaseNode, type NodePalette } from './base-node';

/** A farm building: stable, milking parlour, farm tank. */
export class FarmNode extends BaseNode {
  protected override typeName(): string {
    return 'FarmNode';
  }

  protected override palette(): NodePalette {
    return { fill: '#fefce8', stroke: '#ca8a04' };
  }

  /** A barn: pitched roof, door, hayloft line. */
  protected override icon(): string {
    return `<path d="M3.5 10.2 12 5.2l8.5 5v9.6h-17z" />
      <path d="M9.2 19.8v-5.4h5.6v5.4" />
      <path d="M3.5 13.6h17" />`;
  }
}
