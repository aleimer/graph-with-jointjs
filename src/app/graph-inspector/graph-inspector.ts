import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnChanges,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { dia } from '@joint/core';
import { dataOf } from '../joint/cell-state';
import Graph from '../joint/graph';
import { GroupNode } from '../joint/nodes';
import type { GridPosition } from '../joint/types';

/**
 * The panel describing whatever is selected.
 *
 * Like the toolbar, it holds a `Graph` and nothing else: it hears
 * `selection:changed` and renders what arrives. Nothing tells it what is
 * selected and nothing has to be told when it changes something — the graph
 * announces, and both panels hear the same thing without knowing about each
 * other.
 */
@Component({
  selector: 'graph-inspector',
  templateUrl: './graph-inspector.html',
  styleUrl: './graph-inspector.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GraphInspector implements OnChanges {
  readonly graph = input.required<Graph>();

  readonly label = signal<string | null>(null);
  readonly json = signal('');
  readonly isGroup = signal(false);
  /** False for an edge, which has no place on the grid to show. */
  readonly isNode = signal(false);
  readonly col = signal(0);
  readonly row = signal(0);

  private readonly destroyRef = inject(DestroyRef);
  private selected: dia.Cell | null = null;
  private bound = false;

  ngOnChanges(): void {
    if (this.bound) return;
    this.bound = true;
    this.bind();
  }

  /** Renames in place. The model is the label's only home. */
  rename(value: string): void {
    this.label.set(value);
    this.selected?.attr('label/text', value);
  }

  /** The selected cell, for the template's benefit. */
  private element(): dia.Element | null {
    return this.selected?.isElement() ? (this.selected as dia.Element) : null;
  }

  /** Moves the selected node to a grid cell typed into the panel. */
  move(axis: 'col' | 'row', value: string): void {
    const element = this.element();
    if (!element) return;

    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return;

    const position: GridPosition = {
      col: axis === 'col' ? parsed : this.col(),
      row: axis === 'row' ? parsed : this.row(),
    };
    this.graph().eventbus.emit('node:move', { id: String(element.id), position });
  }

  private bind(): void {
    const bus = this.graph().eventbus;
    const ref = this.destroyRef;

    bus
      .on('selection:changed')
      .pipe(takeUntilDestroyed(ref))
      .subscribe(({ cell }) => {
        this.selected = cell;
        this.show();
      });

    // A collapse, a drag or a move changes what is on show without changing
    // which cell is selected.
    bus.on('graph:changed').pipe(takeUntilDestroyed(ref)).subscribe(() => this.show());
  }

  private show(): void {
    const cell = this.selected;
    const element = this.element();

    // An edge's label lives on its own label list, not on a `label` attribute.
    const text = !cell
      ? null
      : element
        ? String(element.attr('label/text') ?? '')
        : String(dataOf(cell)['label'] ?? cell.id);

    this.label.set(text);
    this.isNode.set(element !== null);
    this.isGroup.set(cell instanceof GroupNode);
    this.json.set(cell ? JSON.stringify(dataOf(cell), null, 2) : '');

    const at = element ? this.graph().toGrid(element.position()) : { col: 0, row: 0 };
    this.col.set(at.col);
    this.row.set(at.row);
  }
}
