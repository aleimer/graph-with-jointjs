import { BaseNode, type NodePalette } from './base-node';

/** Cold store, maturing cellar, warehouse, labeling line. */
export class StorageNode extends BaseNode {
  protected override typeName(): string {
    return 'StorageNode';
  }

  protected override palette(): NodePalette {
    return { fill: '#ecfeff', stroke: '#06b6d4' };
  }

  /**
   * A store reports the room it has left rather than its throughput: what you
   * want to know about a cold store is whether anything else will fit.
   */
  protected override headline(data: Record<string, unknown>): {
    value: unknown;
    caption: string;
  } {
    const used = data['actual'];
    const capacity = data['plan'];
    if (typeof used !== 'number' || typeof capacity !== 'number') {
      return { value: used, caption: 'Free' };
    }
    return { value: Math.max(0, capacity - used), caption: 'Free' };
  }

  /** A crate seen in three-quarter view. */
  protected override icon(): string {
    return `<path d="M12 3.6 20.4 8v8l-8.4 4.4L3.6 16V8z" />
      <path d="M3.6 8 12 12.4 20.4 8" />
      <path d="M12 12.4v8" />`;
  }
}
