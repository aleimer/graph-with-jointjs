import { shapes } from '@joint/core';
import { ByproductNode } from './byproduct-node';
import { CustomerNode } from './customer-node';
import { FacilityNode } from './facility-node';
import { FarmNode } from './farm-node';
import { FieldNode } from './field-node';
import { GroupNode } from './group-node';
import { RetailNode } from './retail-node';
import { StorageNode } from './storage-node';
import { TaskNode } from './task-node';
import { TransportNode } from './transport-node';
import { FlowLink } from '../edges';

/**
 * Every node type an element can ask for by name. An element's `type` in
 * graph.json is looked up here, so adding a type under `nodes/` means adding
 * it to this map — and nothing else.
 */
export const nodeTypes = {
  ByproductNode,
  CustomerNode,
  FacilityNode,
  FarmNode,
  FieldNode,
  GroupNode,
  RetailNode,
  StorageNode,
  TaskNode,
  TransportNode,
};

export type NodeTypeName = keyof typeof nodeTypes;

/**
 * The namespace `graph.fromJSON()` resolves `type` strings against. A type
 * missing from here is silently dropped when a saved graph is deserialised.
 */
export const cellNamespace = {
  ...shapes,
  playground: { ...nodeTypes, FlowLink },
};

/** Resolves `'FieldNode'` or `'playground.FieldNode'` to its class. */
export function nodeTypeFor(name: string | undefined) {
  if (!name) return undefined;
  const short = name.startsWith('playground.') ? name.slice('playground.'.length) : name;
  return nodeTypes[short as NodeTypeName];
}

export { BaseNode } from './base-node';
export { ByproductNode } from './byproduct-node';
export { CustomerNode } from './customer-node';
export { FacilityNode } from './facility-node';
export { FarmNode } from './farm-node';
export { FieldNode } from './field-node';
export { GroupNode } from './group-node';
export { RetailNode } from './retail-node';
export { StorageNode } from './storage-node';
export { TaskNode } from './task-node';
export { TransportNode } from './transport-node';

/** Convenience factory, handy outside the facade (tests, seeds). */
export function createTask(label: string, x: number, y: number): TaskNode {
  const node = new TaskNode();
  node.position(x, y);
  node.attr('label/text', label);
  return node;
}
