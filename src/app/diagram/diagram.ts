import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { dia, elementTools, linkTools } from '@joint/core';
import { AvoidRouter } from '../joint/avoid-router';

import { GraphControls } from '../graph-controls/graph-controls';
import { GraphInspector } from '../graph-inspector/graph-inspector';
import Graph from '../joint/graph';
import type { GraphData, StylesheetStyle } from '../joint/types';

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
  imports: [GraphControls, GraphInspector],
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
  /**
   * The graph, once it exists. A signal because the template has to wait for
   * it: the paper cannot be built until the canvas element is in the DOM.
   */
  protected readonly graph = signal<Graph | null>(null);


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

    const graph = new Graph(this.canvas().nativeElement);
    graph
      .registerStylesheets(data.stylesheets ?? STYLES)
      .setConfig(data.config ?? {})
      .addElements(data.elements)
      .render();

    this.bindHoverTools(graph);
    // Set last: the toolbar is created the moment this is non-null, and it
    // reads the graph's opening state across as it binds.
    this.graph.set(graph);
  }

  ngOnDestroy(): void {
    this.graph()?.destroy();
  }

  /**
   * Everything the component listens to, on one stream.
   *
   * `takeUntilDestroyed` ends these with the component; the graph completing
   * on `destroy()` would end them too, and either is enough.
   */
  /**
   * The hover tools, which belong to the canvas rather than to either panel:
   * they are drawn on the paper, over the cell the pointer is on.
   */
  private bindHoverTools(graph: Graph): void {
    const bus = graph.eventbus;
    const ref = this.destroyRef;

    bus
      .on('cell:mouseover')
      .pipe(takeUntilDestroyed(ref))
      .subscribe(({ view }) => this.addHoverTools(view));

    bus
      .on('cell:mouseout')
      .pipe(takeUntilDestroyed(ref))
      .subscribe(({ view }) => view?.removeTools());
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

  // --- selection -----------------------------------------------------------

  // --- the inspector -------------------------------------------------------

  load(): void {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) this.loadData(JSON.parse(raw) as GraphData);
  }

  /** Re-reads `public/graph.json`, discarding anything done since. */
  async reload(): Promise<void> {
    this.loadData((await fetch(DATA_URL).then((response) => response.json())) as GraphData);
  }

  private loadData(data: GraphData): void {
    const graph = this.graph();
    if (!graph) return;

    graph.select(null);
    graph.remove('*');
    if (data.stylesheets) graph.registerStylesheets(data.stylesheets);
    graph.setConfig(data.config ?? {}).addElements(data.elements).render();
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    // Don't swallow editing keys while the inspector input has focus.
    if (event.target instanceof HTMLInputElement) return;
    this.graph()?.eventbus.emit('selection:delete');
  }
}
