import { dia } from '@joint/core';
import { isCollapsed, read, write } from './cell-state';
import { GROUP_PADDING } from './constants';
import { FlowLink } from './edges';
import { GroupNode } from './nodes';

/** What a collapse took off the graph, waiting to be put back. */
interface Stashed {
  elements: dia.Element[];
  links: dia.Link[];
}

/**
 * Collapsing and expanding compound nodes.
 *
 * JointJS has no notion of a collapsed group, so this is built rather than
 * configured, and it is the only part of the facade that takes cells off the
 * graph and holds them. Three things happen at once and all three have to be
 * undone exactly:
 *
 * - the descendants come off the graph and into `stash`;
 * - edges that crossed the group's boundary are re-pointed at the group, with
 *   their original end recorded on the link;
 * - optionally, edges that now run between the same pair are folded into one
 *   carrying a `×n`, with the rest stored on the survivor.
 *
 * Holding the stash here, rather than beside the other bookkeeping in the
 * facade, is the point of the class: every path that can put a cell back —
 * expanding, restoring a removed cell, pruning an empty group — has to agree
 * about what is currently held, and they can only agree if there is one
 * place that knows.
 */
export class Groups {
  private stash = new Map<dia.Cell.ID, Stashed>();

  /**
   * `bundling` is read each time rather than captured, because the facade's
   * config can change between a collapse and the next one.
   */
  constructor(
    private readonly model: dia.Graph,
    private readonly bundling: () => boolean,
  ) {}

  /** Ids of every group currently collapsed. */
  collapsedIds(): string[] {
    return this.model.getElements().filter(isCollapsed).map((element) => String(element.id));
  }

  /** True while this group is holding children off the graph. */
  holds(id: dia.Cell.ID): boolean {
    return this.stash.has(id);
  }

  collapse(parents: dia.Element[]): void {
    for (const parent of parents) {
      if (isCollapsed(parent)) continue;

      const descendants = parent.getEmbeddedCells({ deep: true });
      const elements = descendants.filter((cell): cell is dia.Element => cell.isElement());
      if (!elements.length) continue;

      const inside = new Set<dia.Cell.ID>(elements.map((element) => element.id));
      const links = this.model
        .getLinks()
        .filter((link) => inside.has(link.source().id!) && inside.has(link.target().id!));

      this.redirectToParent(parent);
      if (this.bundling()) this.bundle(parent);

      this.stash.set(parent.id, { elements, links });
      this.model.removeCells([...links, ...elements]);

      write(parent, 'collapsed', true);
      write(parent, 'expandedSize', parent.size());
      parent.resize(GroupNode.COLLAPSED_SIZE.width, GroupNode.COLLAPSED_SIZE.height);
    }
  }

  expand(parents: dia.Element[]): void {
    for (const parent of parents) {
      const stashed = this.stash.get(parent.id);
      if (!isCollapsed(parent) || !stashed) continue;

      this.model.addCells([...stashed.elements, ...stashed.links]);
      // Removal cleared the embeds, so re-establish them from the stash.
      for (const element of stashed.elements) {
        if (!element.getParentCell()) parent.embed(element);
      }
      this.stash.delete(parent.id);

      write(parent, 'collapsed', false);
      const size = read(parent, 'expandedSize');
      if (size) parent.resize(size.width, size.height);

      this.restoreOriginalEndpoints(parent);
      parent.fitToChildren({ padding: GROUP_PADDING });
    }
  }

  /**
   * Takes a cell back under the group it belonged to, when that group is
   * collapsed. Returns true when the group absorbed it — the caller must then
   * not put it on the graph, or it would float beside a group that is not
   * showing its children.
   *
   * This is what `Graph.restore()` needs: a cell removed before its group
   * collapsed has no parent left to ask, since removing it unembedded it, so
   * the parent it had at the time is passed back in.
   */
  absorb(cell: dia.Cell, parentId: dia.Cell.ID | undefined): boolean {
    if (parentId === undefined) return false;
    const stashed = this.stash.get(parentId);
    if (!stashed) return false;

    if (cell.isElement()) stashed.elements.push(cell);
    else stashed.links.push(cell as dia.Link);
    return true;
  }

  /** Re-applies redirection for every collapsed group. */
  reapply(): void {
    for (const element of this.model.getElements()) {
      if (!isCollapsed(element)) continue;
      this.redirectToParent(element);
      if (this.bundling()) this.bundle(element);
    }
  }

  /**
   * Drops groups left with nothing in them. A collapsed group is not empty —
   * its children are in the stash — so it is spared.
   */
  pruneEmpty(): void {
    const empty = this.model
      .getElements()
      .filter(
        (element) =>
          element instanceof GroupNode &&
          !element.getEmbeddedCells().length &&
          !this.stash.has(element.id),
      );

    if (empty.length) this.model.removeCells(empty);
  }

  clear(): void {
    this.stash.clear();
  }

  /** Re-points edges crossing the parent boundary at the parent itself. */
  private redirectToParent(parent: dia.Element): void {
    const inside = new Set<dia.Cell.ID>(
      parent
        .getEmbeddedCells({ deep: true })
        .filter((cell) => cell.isElement())
        .map((cell) => cell.id),
    );
    if (!inside.size) return;

    for (const link of this.model.getLinks()) {
      const source = link.source();
      const target = link.target();
      const sourceInside = inside.has(source.id!);
      const targetInside = inside.has(target.id!);
      if (sourceInside === targetInside) continue; // internal or unrelated

      const redirect = read(link, 'redirect') ?? {};
      if (sourceInside) {
        write(link, 'redirect', { ...redirect, source });
        link.source({ id: parent.id });
      } else {
        write(link, 'redirect', { ...redirect, target });
        link.target({ id: parent.id });
      }
    }
  }

  /** Keeps one edge per direction between the same pair, stashing the rest. */
  private bundle(parent: dia.Element): void {
    const groups = new Map<string, dia.Link[]>();

    for (const link of this.model.getConnectedLinks(parent)) {
      const key = `${String(link.source().id)}->${String(link.target().id)}`;
      groups.set(key, [...(groups.get(key) ?? []), link]);
    }

    for (const links of groups.values()) {
      if (links.length < 2) continue;
      const [survivor, ...bundled] = links;

      write(survivor, 'bundled', bundled.map((link) => link.toJSON()));
      // Keep the survivor's own label; the count replaces it only while
      // bundled, and expanding has to put the original back.
      write(survivor, 'unbundledLabels', survivor.labels());
      survivor.labels([
        {
          attrs: {
            rect: { fill: '#ffffff', stroke: '#cbd5e1', strokeWidth: 1, rx: 4, ry: 4 },
            text: { text: `×${links.length}`, fill: '#475569', fontSize: 11 },
          },
          position: { distance: 0.5 },
        },
      ]);

      this.model.removeCells(bundled);
    }
  }

  /** Undoes `redirectToParent` and `bundle`. */
  private restoreOriginalEndpoints(parent: dia.Element): void {
    for (const link of this.model.getConnectedLinks(parent)) {
      const bundled = read(link, 'bundled');
      if (bundled?.length) {
        this.model.addCells(bundled.map((json) => new FlowLink(json)));
        write(link, 'bundled', undefined);
        link.labels(read(link, 'unbundledLabels') ?? []);
        write(link, 'unbundledLabels', undefined);
      }

      const redirect = read(link, 'redirect');
      if (!redirect) continue;

      if (redirect.source) link.source(redirect.source);
      if (redirect.target) link.target(redirect.target);
      write(link, 'redirect', undefined);
    }
  }
}
