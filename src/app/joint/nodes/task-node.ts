import { BaseNode, type NodePalette } from './base-node';

/** The generic node, used when an element names no type of its own. */
export class TaskNode extends BaseNode {
  protected override typeName(): string {
    return 'TaskNode';
  }

  protected override palette(): NodePalette {
    return { fill: '#ffffff', stroke: '#94a3b8' };
  }

  /** A plain rounded square. */
  protected override icon(): string {
    return `<rect x="4.6" y="4.6" width="14.8" height="14.8" rx="3.4" />
      <path d="M8.6 12h6.8" />`;
  }
}
