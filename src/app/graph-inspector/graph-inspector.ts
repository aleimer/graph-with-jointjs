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
  readonly col = signal(0);
  readonly row = signal(0);

  private readonly destroyRef = inject(DestroyRef);
  private selected: dia.Element | null = null;
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

  /** Moves the selected node to a grid cell typed into the panel. */
  move(axis: 'col' | 'row', value: string): void {
    const element = this.selected;
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
        // Only elements for now: the panel's fields are a label and a grid
        // cell, and a link has neither.
        this.selected = cell?.isElement() ? (cell as dia.Element) : null;
        this.show();
      });

    // A collapse, a drag or a move changes what is on show without changing
    // which cell is selected.
    bus.on('graph:changed').pipe(takeUntilDestroyed(ref)).subscribe(() => this.show());
  }

  private show(): void {
    const element = this.selected;

    this.label.set(element ? String(element.attr('label/text') ?? '') : null);
    this.isGroup.set(element instanceof GroupNode);
    this.json.set(element ? JSON.stringify(dataOf(element), null, 2) : '');

    const cell = element ? this.graph().toGrid(element.position()) : { col: 0, row: 0 };
    this.col.set(cell.col);
    this.row.set(cell.row);
  }
}
