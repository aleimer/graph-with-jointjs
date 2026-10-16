import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  OnDestroy,
  computed,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { dia, elementTools, highlighters, linkTools } from '@joint/core';
import { filter } from 'rxjs';
import { AvoidRouter } from '../joint/avoid-router';
import { dataOf, isCollapsed } from '../joint/cell-state';
import { isChanged, isPointer, isViewPort } from '../joint/events';
import { ZOOM_MAX, ZOOM_MIN } from '../joint/constants';
import Graph from '../joint/graph';
import { GroupNode } from '../joint/nodes';
import type {
  EdgeConfig,
  EdgeWeightLabel,
  GraphData,
  GridPosition,
  StylesheetStyle,
} from '../joint/types';

const SELECTION_ID = 'selection';
const STORAGE_KEY = 'jointjs-playground-graph';
/** Served from `public/`, so it is editable without touching any code. */
const DATA_URL = 'graph.json';

/** Stylesheet rules, matched by the selector language in `selector.ts`. */
const STYLES: StylesheetStyle[] = [
  { selector: '.terminal', style: { 'body/fill': '#eef2ff' } },
  { selector: 'edge[?optional]', style: { 'line/strokeDasharray': '5,3' } },
];

@Component({
  selector: 'app-diagram',
  templateUrl: './diagram.html',
  styleUrl: './diagram.scss',
  host: { '(document:keydown)': 'onKeydown($event)' },
})
export class Diagram implements AfterViewInit, OnDestroy {
  private readonly canvas = viewChild.required<ElementRef<HTMLDivElement>>('canvas');
  /** Ends the graph subscriptions with the component. */
  private readonly destroyRef = inject(DestroyRef);

  // JointJS lives outside Angular's world, so every piece of state the template
  // needs is mirrored into a signal from the graph/paper event handlers.
  // This app is zoneless (Angular 22 default): signal writes are what schedule
  // change detection, so a plain field assignment would not re-render.
  readonly nodeCount = signal(0);
  readonly linkCount = signal(0);
  readonly zoom = signal(1);
  readonly selectedLabel = signal<string | null>(null);
  readonly selectedJson = signal('');
  readonly selectedIsGroup = signal(false);
  readonly selectedCollapsed = signal(false);
  readonly gridVisible = signal(true);
  readonly edgesHidden = signal(false);
  readonly valuesVisible = signal(true);
  readonly selectedCol = signal(0);
  readonly selectedRow = signal(0);
  readonly zoomPercent = computed(() => Math.round(this.zoom() * 100));

  private graph!: Graph;
  /**
   * Remembered so the Values toggle can rebuild the edge config; the facade
   * keeps its own `config` private, as the Cytoscape original does.
   */
  private edgeConfig: EdgeConfig = {};
  private weightLabel: EdgeWeightLabel | undefined;
  private selected: dia.Element | null = null;
  private nextNodeIndex = 1;

  async ngAfterViewInit(): Promise<void> {
    // The WASM router has to be ready before any config asks for it. If it
    // cannot be fetched the graph still draws, falling back to the built-in
    // router, so a missing binary degrades instead of showing nothing.
    const [data] = await Promise.all([
      fetch(DATA_URL).then((response) => response.json() as Promise<GraphData>),
      AvoidRouter.load().catch((error: unknown) => {
        console.warn('[diagram] libavoid unavailable, using the manhattan router', error);
      }),
    ]);

    this.graph = new Graph(this.canvas().nativeElement);

    this.graph
      .registerStylesheets(data.stylesheets ?? STYLES)
      .setConfig(data.config ?? {})
      .addElements(data.elements)
      .addEvent({
        events: 'tap',
        selector: 'node',
        handler: ({ cell }) => this.select(cell as dia.Element),
      })
      .addEvent({
        events: 'tap',
        handler: ({ cell }) => {
          if (!cell) this.select(null);
        },
      })
      .render();

    this.edgeConfig = data.config?.edges ?? {};
    const label = this.edgeConfig.weight?.label;
    this.weightLabel = label === false ? undefined : label;
    this.valuesVisible.set(Boolean(label));

    this.bindGraphEvents();
    this.sync();
  }

  ngOnDestroy(): void {
    this.graph?.destroy();
  }

  /**
   * Everything the component listens to, on one stream.
   *
   * `takeUntilDestroyed` ends these with the component; the graph completing
   * on `destroy()` would end them too, and either is enough.
   */
  private bindGraphEvents(): void {
    const events = this.graph.events$.pipe(takeUntilDestroyed(this.destroyRef));

    // Coalesced: one notice per tick however many cells moved.
    events.pipe(filter(isChanged)).subscribe(({ nodes, links }) => {
      this.nodeCount.set(nodes);
      this.linkCount.set(links);
      this.syncSelection();
    });

    events.pipe(filter(isViewPort)).subscribe(({ viewPort }) => this.zoom.set(viewPort.zoom));

    events.pipe(filter(isPointer)).subscribe((event) => {
      if (event.type === 'mouseover') this.addHoverTools(event.view);
      if (event.type === 'mouseout') event.view?.removeTools();
    });
  }

  /** The tools shown while the pointer is over a cell. */
  private addHoverTools(view: dia.CellView | null): void {
    if (view instanceof dia.LinkView) {
      view.addTools(
        new dia.ToolsView({
          tools: [
            new linkTools.Vertices(),
            new linkTools.Segments(),
            new linkTools.TargetArrowhead(),
            new linkTools.Remove({ distance: 20 }),
          ],
        }),
      );
      return;
    }
    if (!(view instanceof dia.ElementView)) return;

    view.addTools(
      new dia.ToolsView({
        tools: [
          new elementTools.Boundary({ padding: 6 }),
          // Nodes have no ports, so this is how a link gets drawn: drag the
          // button on the right edge onto another node.
          new elementTools.Connect({
            x: '100%',
            y: '50%',
            offset: { x: 10, y: 0 },
            magnet: 'body',
          }),
          new elementTools.Remove({ x: '100%', y: 0, offset: { x: 2, y: -2 } }),
        ],
      }),
    );
  }

  /** Reads the whole state across, for the first paint and after a reload. */
  private sync(): void {
    const { nodes, edges } = this.graph.data;
    this.nodeCount.set(nodes.length);
    this.linkCount.set(edges.length);
    this.zoom.set(this.graph.viewPort.zoom);
    this.syncSelection();
  }

  private syncSelection(): void {
    // The selection may have been collapsed or removed out from under us.
    if (this.selected && !this.graph.model.getCell(this.selected.id)) {
      this.select(null);
      return;
    }
    this.refreshSelected();
  }

  // --- selection -----------------------------------------------------------

  private select(element: dia.Element | null): void {
    const { paper } = this.graph;

    if (this.selected && paper) {
      const previous = this.selected.findView(paper);
      if (previous) highlighters.mask.remove(previous, SELECTION_ID);
    }

    this.selected = element;
    this.refreshSelected();

    if (!element || !paper) return;
    const view = element.findView(paper);
    if (!view) return;
    highlighters.mask.add(view, { selector: 'body' }, SELECTION_ID, {
      padding: 4,
      attrs: { stroke: '#6366f1', strokeWidth: 2.5 },
    });
  }

  private refreshSelected(): void {
    const element = this.selected;
    this.selectedLabel.set(element ? String(element.attr('label/text') ?? '') : null);
    this.selectedIsGroup.set(element instanceof GroupNode);
    this.selectedCollapsed.set(element ? isCollapsed(element) : false);
    this.selectedJson.set(element ? JSON.stringify(dataOf(element), null, 2) : '');

    const cell = element ? this.graph.toGrid(element.position()) : { col: 0, row: 0 };
    this.selectedCol.set(cell.col);
    this.selectedRow.set(cell.row);
  }

  /** Moves the selected node to a grid cell typed into the inspector. */
  moveSelected(axis: 'col' | 'row', value: string): void {
    const element = this.selected;
    if (!element) return;

    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return;

    const position: GridPosition = {
      col: axis === 'col' ? parsed : this.selectedCol(),
      row: axis === 'row' ? parsed : this.selectedRow(),
    };
    this.graph.setNodePosition(String(element.id), position);
    this.refreshSelected();
  }

  // --- toolbar actions -----------------------------------------------------

  addNode(): void {
    const id = `step-${this.nextNodeIndex++}`;
    // Drop it in the first free row of column 0.
    const taken = new Set(Object.values(this.graph.gridPositions()).map((p) => p.row));
    let row = 0;
    while (taken.has(row)) row++;

    this.graph.addElements([
      { data: { id, label: `Step ${this.nextNodeIndex - 1}` }, position: { col: 0, row } },
    ]);
    this.select(this.graph.model.getCell(id) as dia.Element);
  }

  renameSelected(value: string): void {
    this.selectedLabel.set(value);
    this.selected?.attr('label/text', value);
  }

  deleteSelected(): void {
    const element = this.selected;
    if (!element) return;
    this.select(null);
    this.graph.remove(`#${element.id}`);
  }

  toggleCollapse(): void {
    const element = this.selected;
    if (!element) return;
    if (isCollapsed(element)) this.graph.expand([element]);
    else this.graph.collapse([element]);
    this.refreshSelected();
  }

  toggleGrid(): void {
    this.gridVisible.update((visible) => !visible);
    this.graph.renderGrid(this.gridVisible());
  }

  /** Turns the per-edge weight labels on and off. */
  toggleValues(): void {
    this.valuesVisible.update((visible) => !visible);
    const weight = this.edgeConfig.weight;
    if (!weight) return;
    this.edgeConfig = {
      ...this.edgeConfig,
      weight: { ...weight, label: this.valuesVisible() ? this.weightLabel : false },
    };
    this.graph.setConfig({ edges: this.edgeConfig });
  }

  /** Shows what `Config.filter` does: hide everything that isn't a node. */
  toggleEdges(): void {
    this.edgesHidden.update((hidden) => !hidden);
    this.graph.setConfig({ filter: this.edgesHidden() ? 'node' : undefined });
  }

  arrange(): void {
    // Dropping the saved positions makes setPosition() lay everything out.
    this.graph.setConfig({ positions: {} }).setPosition();
    this.fit();
  }

  fit(): void {
    this.graph.fit();
    this.sync();
  }

  zoomBy(step: number): void {
    const { zoom, pan } = this.graph.viewPort;
    this.graph.setViewPort({ pan, zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom + step)) });
    this.sync();
  }

  resetZoom(): void {
    this.graph.setViewPort({ pan: { x: 0, y: 0 }, zoom: 1 });
    this.sync();
  }

  clear(): void {
    this.select(null);
    this.graph.remove('*');
  }

  save(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.graph.toData()));
  }

  load(): void {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) this.loadData(JSON.parse(raw) as GraphData);
  }

  /** Re-reads `public/graph.json`, discarding anything done since. */
  async reload(): Promise<void> {
    this.loadData((await fetch(DATA_URL).then((response) => response.json())) as GraphData);
  }

  private loadData(data: GraphData): void {
    this.select(null);
    this.graph.remove('*');
    if (data.stylesheets) this.graph.registerStylesheets(data.stylesheets);
    this.graph.setConfig(data.config ?? {}).addElements(data.elements).render();
    this.sync();
  }

  exportJson(): void {
    // Same shape as graph.json, so an export can be dropped straight back in.
    const blob = new Blob([JSON.stringify(this.graph.toData(), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'graph.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    // Don't swallow editing keys while the inspector input has focus.
    if (event.target instanceof HTMLInputElement) return;
    this.deleteSelected();
  }
}
