import {
  Component,
  OnChanges,
  DestroyRef,
  ChangeDetectionStrategy,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { isCollapsed } from '../joint/cell-state';
import Graph from '../joint/graph';
import { GroupNode } from '../joint/nodes';
import type { GraphMode } from '../joint/types';

/**
 * The toolbar.
 *
 * It holds a `Graph` and nothing else. Everything it shows it hears on the
 * bus, and everything it asks for it emits on the bus — so it can be dropped
 * beside any graph without its host wiring anything up, and the host does not
 * have to mirror graph state just to pass it back down.
 *
 * The two exceptions are outputs, and deliberately so: loading is the host's
 * business, because the host is what knows where the data comes from.
 */
@Component({
  selector: 'graph-controls',
  templateUrl: './graph-controls.html',
  styleUrl: './graph-controls.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GraphControls implements OnChanges {
  readonly graph = input.required<Graph>();

  /** Asked of the host: it owns the data source, so it owns reading from it. */
  readonly loadSaved = output<void>();
  readonly reloadSource = output<void>();

  readonly nodeCount = signal(0);
  readonly linkCount = signal(0);
  readonly zoomPercent = signal(100);

  readonly gridVisible = signal(true);
  readonly edgesHidden = signal(false);
  readonly valuesVisible = signal(true);

  /**
   * Reading or editing. Everything that changes the graph is hidden while
   * reading — a toolbar offering actions the mode does not allow is worse
   * than one that offers fewer.
   */
  readonly mode = signal<GraphMode>('view');
  readonly editing = computed(() => this.mode() === 'edit');

  readonly hasSelection = signal(false);
  readonly selectionIsGroup = signal(false);
  readonly selectionCollapsed = signal(false);
  readonly collapseLabel = computed(() => (this.selectionCollapsed() ? 'Expand' : 'Collapse'));

  private readonly destroyRef = inject(DestroyRef);
  private nextNodeIndex = 1;
  /** Remembered so the Values toggle can put the label back as it was. */
  private weightLabel = signal<unknown>(undefined);
  private bound = false;

  ngOnChanges(): void {
    // `input.required` is only satisfied once the host has a graph, and the
    // bus must be bound exactly once after that.
    if (this.bound) return;
    this.bound = true;
    this.bind();
  }

  // --- what it asks for --------------------------------------------------------

  toggleMode(): void {
    this.graph().eventbus.emit('mode:set', { mode: this.editing() ? 'view' : 'edit' });
  }

  addNode(): void {
    const graph = this.graph();
    const id = `step-${this.nextNodeIndex++}`;

    // Drop it in the first free row of column 0.
    const taken = new Set(Object.values(graph.gridPositions()).map((p) => p.row));
    let row = 0;
    while (taken.has(row)) row++;

    graph.addElements([
      { data: { id, label: `Step ${this.nextNodeIndex - 1}` }, position: { col: 0, row } },
    ]);
    graph.eventbus.emit('selection:set', { id });
  }

  deleteSelected(): void {
    this.graph().eventbus.emit('selection:delete');
  }

  toggleCollapse(): void {
    this.graph().eventbus.emit('selection:collapse');
  }

  arrange(): void {
    this.graph().eventbus.emit('layout:arrange');
  }

  zoomBy(step: number): void {
    // The clamp lives with the graph; the toolbar only says how far.
    this.graph().eventbus.emit('viewport:zoom', { by: step });
  }

  resetZoom(): void {
    this.graph().eventbus.emit('viewport:set', { pan: { x: 0, y: 0 }, zoom: 1 });
  }

  fit(): void {
    this.graph().eventbus.emit('viewport:fit');
  }

  toggleGrid(): void {
    this.gridVisible.update((visible) => !visible);
    this.graph().eventbus.emit('grid:show', { visible: this.gridVisible() });
  }

  toggleEdges(): void {
    this.edgesHidden.update((hidden) => !hidden);
    this.graph().eventbus.emit('filter:set', { filter: this.edgesHidden() ? 'node' : undefined });
  }

  toggleValues(): void {
    this.valuesVisible.update((visible) => !visible);

    const edges = this.graph().config.edges;
    const weight = edges?.weight;
    if (!weight) return;

    this.graph().eventbus.emit('config:set', {
      edges: {
        ...edges,
        weight: {
          ...weight,
          label: this.valuesVisible() ? (this.weightLabel() as typeof weight.label) : false,
        },
      },
    });
  }

  clear(): void {
    this.graph().eventbus.emit('cells:remove', { selector: '*' });
  }

  save(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.graph().toData()));
  }

  exportJson(): void {
    // Same shape as graph.json, so an export can be dropped straight back in.
    const blob = new Blob([JSON.stringify(this.graph().toData(), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'graph.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  // --- what it hears -----------------------------------------------------------

  private bind(): void {
    const graph = this.graph();
    const bus = graph.eventbus;
    const ref = this.destroyRef;

    bus
      .on('graph:changed')
      .pipe(takeUntilDestroyed(ref))
      .subscribe(({ nodes, links }) => {
        this.nodeCount.set(nodes);
        this.linkCount.set(links);
      });

    bus
      .on('viewport:moved')
      .pipe(takeUntilDestroyed(ref))
      .subscribe(({ viewPort }) => this.zoomPercent.set(Math.round(viewPort.zoom * 100)));

    bus
      .on('mode:changed')
      .pipe(takeUntilDestroyed(ref))
      .subscribe(({ mode }) => this.mode.set(mode));

    bus
      .on('selection:changed')
      .pipe(takeUntilDestroyed(ref))
      .subscribe(({ cell }) => {
        this.hasSelection.set(cell !== null);
        this.selectionIsGroup.set(cell instanceof GroupNode);
        this.selectionCollapsed.set(cell ? isCollapsed(cell) : false);
      });

    // The graph is already loaded by the time the toolbar is created, so its
    // opening state is read across rather than waited for.
    const { nodes, edges } = graph.data;
    this.nodeCount.set(nodes.length);
    this.linkCount.set(edges.length);
    this.zoomPercent.set(Math.round(graph.viewPort.zoom * 100));

    this.mode.set(graph.mode);

    const label = graph.config.edges?.weight?.label;
    this.weightLabel.set(label === false ? undefined : label);
    this.valuesVisible.set(Boolean(label));
  }
}

const STORAGE_KEY = 'jointjs-playground-graph';
