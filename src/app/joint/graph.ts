import { dia, highlighters } from '@joint/core';
import { AvoidRouter } from './avoid-router';
import { classesOf, isCollapsed, read, write } from './cell-state';
import {
  GROUP_PADDING,
  LINK_CLEARANCE,
  MINOR_GRID,
  NODE_CLEARANCE,
  ZOOM_MAX,
  ZOOM_MIN,
} from './constants';
import { Groups } from './groups';
import { EventBus, POINTER_EVENTS, jointNameFor, pointerEventName } from './events';
import { installInteraction } from './interaction';
import { createPaper, drawGrid } from './paper';
import { matcher, matches } from './selector';
import { applyFilter, applyStylesheets, applyWeights } from './styling';
import { FlowLink, MANHATTAN_ROUTER } from './edges';
import { BaseNode, GroupNode, TaskNode, cellNamespace, nodeTypeFor } from './nodes';
import type {
  Config,
  EdgeDefinition,
  ElementDefinition,
  Event,
  EventObject,
  GraphData,
  GridPosition,
  GridSize,
  EdgeCollection,
  NodeCollection,
  NodeDefinition,
  ParentInput,
  Position,
  PositionInput,
  StylesheetStyle,
  ViewPort,
} from './types';

const DEFAULT_GRID: GridSize = { cellWidth: 220, cellHeight: 130 };

/** Highlighter id for the selection ring. */
const SELECTION_ID = 'selection';

function isGridPosition(position: PositionInput): position is GridPosition {
  return 'col' in position;
}

/**
 * Facade over JointJS, shaped like the existing Cytoscape `Graph` class:
 * every public method returns `this` so calls chain, elements go in as
 * `{ data: { id, ... } }` definitions, and styling/events/removal are driven by
 * string selectors.
 *
 * The adaptation points, where JointJS differs from Cytoscape in kind:
 *
 * - **Parents are embeds.** `addParents()` maps onto `parent.embed(child)`.
 *   JointJS lets you embed into any element, so a parent does not have to be
 *   declared before its children.
 * - **No stylesheet engine.** `registerStylesheets()` keeps the rules and
 *   `updateStyles()` applies them to matching cells; `style` keys are JointJS
 *   attribute paths (`'body/fill'`), not CSS-ish property names.
 * - **No collection type.** `NodeCollection` / `EdgeCollection` are plain
 *   arrays of cells.
 * - **Collapsing removes.** Descendants are stashed off-graph and re-added on
 *   expand, which is also how `remove()` / `restore()` work.
 */
export default class Graph {
  /**
   * The JointJS counterpart of `cy` — both halves are public on purpose.
   * `paper` is null for a model-only graph (see the constructor).
   */
  readonly paper: dia.Paper | null;
  readonly model: dia.Graph;

  viewPort: ViewPort = { pan: { x: 0, y: 0 }, zoom: 1 };

  /**
   * Where the DOM, JointJS and Angular meet.
   *
   * The graph announces on it — pointer events, a coalesced notice that the
   * model changed, viewport moves — and takes requests on it, which it
   * answers by calling the method that already does the work. The methods
   * stay public, so a programmatic caller keeps the chaining and the return
   * values.
   *
   * Subscribers handle their own teardown (`takeUntilDestroyed()` in a
   * component). `destroy()` ends the bus, so one that outlives the graph
   * completes rather than waiting.
   */
  readonly eventbus = new EventBus();

  /**
   * The cells on the graph, as Cytoscape's `cy.nodes()` / `cy.edges()` would
   * give them — read from the model rather than kept in step with it.
   *
   * Mirroring the model into a field meant rebuilding both arrays on every
   * `add` and `remove`, and JointJS fires those once per cell: loading the
   * demo graph rebuilt them 128 times to produce something only the toolbar
   * counts ever read. Reading on demand cannot go stale and cannot be
   * forgotten.
   *
   * Each read returns a fresh object, so hold the arrays rather than the
   * result if you mean to compare them.
   */
  get data(): { nodes: NodeCollection; edges: EdgeCollection } {
    return { nodes: this.model.getElements(), edges: this.model.getLinks() };
  }

  /**
   * The configuration as it stands, for a caller that needs to toggle one
   * part of it without keeping its own copy of the rest.
   */
  get config(): Readonly<Config> {
    return this._config;
  }

  /** The selected cell, or null. Set it with `select()`. */
  get selected(): dia.Cell | null {
    return this.selectedCell;
  }

  private _config: Config = {};
  private selectedCell: dia.Cell | null = null;
  private _styles: StylesheetStyle[] = [];
  /** True once `render()` has drawn; until then there is nothing to restyle. */
  private isRendered = false;
  private firstRender = true;
  /** Set when something the styles depend on has changed. */
  private styleDirty = false;
  /** True while a flush is already queued for the end of this tick. */
  private flushQueued = false;
  /** True while a `changed` notice is already queued for the end of this tick. */
  private changeQueued = false;
  /** Spacing of the light mesh; the major lines sit every `MAJOR_GRID`. */
  private gridSpacing = MINOR_GRID;
  private grid: GridSize = DEFAULT_GRID;

  /**
   * Cells taken out by `remove()`, waiting for `restore()`. The parent is
   * recorded alongside because removing a cell unembeds it: by the time it is
   * restored there is nothing left on the cell to say where it belonged.
   */
  private removedCells: { cell: dia.Cell; parent: dia.Cell.ID | undefined }[] = [];
  /** Set when `config.edges.router` is `'avoid'`. */
  private avoidRouter: AvoidRouter | null = null;
  /**
   * Collapsing, expanding, and the cells held off-graph while collapsed.
   * Built in the constructor: it needs the model, which does not exist yet
   * when the field initialisers run.
   */
  private readonly groups: Groups;
  /** Unbinds the pan/zoom/snap handlers; null for a model-only graph. */
  private uninstallInteraction: (() => void) | null = null;
  /** Subscriptions the facade opened on its own stream, for `addEvent`. */
  private readonly subscriptions: { unsubscribe(): void }[] = [];

  /**
   * Pass the element the diagram should render into. Omit it for a model-only
   * graph: every method still works except the ones that need a rendered
   * surface (grid, viewport, events), which become no-ops. That keeps the
   * class usable from unit tests and server-side code, where there is no SVG
   * geometry API to render against.
   */
  constructor(container?: HTMLElement | null) {
    this.model = new dia.Graph({}, { cellNamespace });
    // Read through rather than captured: the config can change between one
    // collapse and the next.
    this.groups = new Groups(this.model, () => this._config.edges?.bundle === true);

    // Cells can arrive without the facade being told: the Connect tool draws
    // a link straight into the model, and `addParents()` can mint a group.
    // Styling from the public methods alone left both unstyled. `add` fires
    // once per cell, so this marks and defers rather than restyling here —
    // 127 full restyles would be the cost of loading the demo graph.
    this.model.on('add', () => this.restyleSoon());
    // One notice per tick, not one per cell. JointJS reports cells singly, so
    // loading the demo graph would otherwise announce 128 separate changes to
    // say the one thing a consumer needs to hear.
    this.model.on('add remove change', () => this.announceChange());


    if (!container) {
      this.paper = null;
      return;
    }

    this.paper = createPaper(container, this.model, this.gridSpacing);

    this.uninstallInteraction = installInteraction(this.paper, {
      toGrid: (position) => this.toGrid(position),
      toPixels: (position) => this.toPixels(position),
      onViewPortChange: () => this.saveCurrentViewPort(),
    });
    this.publishPointerEvents();
    this.answerCommands();
    // Tapping selects, as Cytoscape does; tapping blank paper clears.
    this.subscriptions.push(
      this.eventbus.on('cell:tap').subscribe(({ cell }) => this.select(cell)),
    );
    this.renderGrid(true);
  }

  // --- public API ----------------------------------------------------------

  registerStylesheets(stylesheets: StylesheetStyle[]): this {
    this._styles = [...this._styles, ...stylesheets];
    this.restyle();
    return this;
  }

  addElements(elements: ElementDefinition[]): this {
    const nodes = elements.filter(
      (element): element is NodeDefinition =>
        element.group === 'nodes' || !('source' in element.data),
    );
    const edges = elements.filter(
      (element): element is EdgeDefinition =>
        element.group === 'edges' || 'source' in element.data,
    );

    this.addNodes(nodes);
    this.addEdges(edges);

    const parents: Record<string, string> = {};
    for (const node of nodes) {
      if (node.data.parent) parents[node.data.id] = node.data.parent;
    }
    if (Object.keys(parents).length) this.addParents(parents);

    // New edges may point into an already collapsed group.
    this.groups.reapply();
    this.restyle();
    return this;
  }

  /**
   * Cytoscape-style event binding. `events` is a space-separated list and may
   * use Cytoscape names (`tap`, `mouseover`) or JointJS ones (`pointerclick`).
   * A `selector` filters by cell; omit it to also receive blank-paper events.
   */
  addEvent({ events, selector, handler }: Event): this {
    const wanted = new Set(events.split(/\s+/).filter(Boolean));
    const test = matcher(selector);

    // Kept for the Cytoscape-shaped call sites, but it is now a filter over
    // `events$` rather than its own binding. The subscription is held so
    // `destroy()` can end it: the original had no way to unsubscribe at all.
    const names = POINTER_EVENTS.filter((name) => wanted.has(name)).map(pointerEventName);
    if (!names.length) return this;

    this.subscriptions.push(
      this.eventbus.onAny(...names).subscribe(({ payload }) => {
        // A selector asks about cells, so blank paper only reaches a handler
        // that did not ask for one.
        if (payload.cell ? !test(payload.cell) : Boolean(selector)) return;
        handler(payload);
      }),
    );

    return this;
  }

  render(): this {
    this.setPosition();
    this.isRendered = true;
    this.restyle();

    if (this.firstRender) {
      this.initialExpandCollapse();
      this.firstRender = false;
    }

    this.groups.reapply();
    this.groups.pruneEmpty();

    return this.fit();
  }

  destroy(): this {
    this.selectedCell = null;
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.subscriptions.length = 0;
    // Ending the bus ends every outside subscription too, so one that
    // outlives the graph stops rather than waiting on a stream nothing will
    // feed again.
    this.eventbus.destroy();

    this.avoidRouter?.destroy();
    this.avoidRouter = null;
    this.uninstallInteraction?.();
    this.uninstallInteraction = null;
    // Paper registers document-level listeners; this is not optional.
    this.paper?.off();
    this.model.off();
    this.paper?.remove();
    this.model.clear();
    this.groups.clear();
    this.removedCells = [];
    this.isRendered = false;
    this.styleDirty = false;
    return this;
  }

  addParents(parents: ParentInput): this {
    const byParent = new Map<string, string[]>();

    if (Array.isArray(parents)) {
      for (const parent of parents) {
        byParent.set(parent.id, [...(byParent.get(parent.id) ?? []), ...parent.children]);
        const existing = this.model.getCell(parent.id);
        if (existing && parent.label) existing.attr('label/text', parent.label);
      }
    } else {
      for (const [child, parent] of Object.entries(parents)) {
        byParent.set(parent, [...(byParent.get(parent) ?? []), child]);
      }
    }

    for (const [parentId, childIds] of byParent) {
      let parent = this.model.getCell(parentId) as dia.Element | undefined;
      if (!parent) {
        parent = new GroupNode({ id: parentId });
        parent.attr('label/text', parentId);
        this.model.addCell(parent);
      }

      const children = childIds
        .map((id) => this.model.getCell(id))
        .filter((cell): cell is dia.Element => Boolean(cell) && cell.isElement());

      if (children.length) parent.embed(children);
      if (!isCollapsed(parent)) parent.fitToChildren({ padding: GROUP_PADDING });
    }

    return this;
  }

  remove(selector: string): this {
    const cells = this.model.getCells().filter((cell) => matches(cell, selector));
    for (const cell of cells) {
      this.removedCells.push({ cell, parent: cell.getParentCell()?.id });
    }
    this.model.removeCells(cells);
    return this;
  }

  /**
   * Puts back what `remove()` took out.
   *
   * A cell whose group has collapsed in the meantime goes back into that
   * group's stash rather than onto the graph. Adding it to the graph would
   * leave it standing next to a group that is not showing its children, and
   * expanding afterwards would not pick it up — it would stay orphaned for
   * the rest of the session.
   */
  restore(selector: string): this {
    const restoring = this.removedCells.filter((entry) => matches(entry.cell, selector));
    if (!restoring.length) return this;

    this.removedCells = this.removedCells.filter((entry) => !restoring.includes(entry));

    const onGraph = restoring.filter((entry) => !this.groups.absorb(entry.cell, entry.parent));
    this.model.addCells(onGraph.map((entry) => entry.cell));

    // Removal unembedded them; an expanded parent takes its child back.
    for (const { cell, parent } of onGraph) {
      if (parent === undefined || !cell.isElement()) continue;
      const element = this.model.getCell(parent);
      if (element?.isElement() && !isCollapsed(element)) (element as dia.Element).embed(cell);
    }

    this.restyle();
    return this;
  }

  /**
   * Selects a cell, or clears the selection with null.
   *
   * The facade owns this because more than one consumer needs it — a toolbar
   * enabling its buttons, an inspector showing what is chosen — and a
   * selection kept in one of them is invisible to the others. Cytoscape owns
   * selection too, so the shape is the one being mirrored.
   */
  select(cell: dia.Cell | null): this {
    if (cell === this.selectedCell) return this;

    this.highlight(this.selectedCell, false);
    this.selectedCell = cell;
    this.highlight(cell, true);

    this.eventbus.emit('selection:changed', { cell });
    return this;
  }

  saveCurrentViewPort(): this {
    if (!this.paper) return this;
    const { tx, ty } = this.paper.translate();
    this.viewPort = { pan: { x: tx, y: ty }, zoom: this.paper.scale().sx };
    this.eventbus.emit('viewport:moved', { viewPort: this.viewPort });
    return this;
  }

  setViewPort(viewPort: ViewPort): this {
    this.viewPort = viewPort;
    this.paper?.scale(viewPort.zoom);
    this.paper?.translate(viewPort.pan.x, viewPort.pan.y);
    this.eventbus.emit('viewport:moved', { viewPort });
    return this;
  }

  setConfig(config: Config): this {
    this._config = { ...this._config, ...config };
    if (config.grid) {
      this.grid = config.grid;
      this.renderGrid(true);
    }
    if (config.edges?.router !== undefined) this.useRouter(config.edges.router);
    if (this.isRendered) this.setPosition();
    this.restyle();
    return this;
  }

  /** Grid cell → pixels. `{ col: 5, row: 2 }` with a 220×130 grid → 1100,260. */
  toPixels(position: PositionInput): Position {
    if (!isGridPosition(position)) return position;
    return { x: position.col * this.grid.cellWidth, y: position.row * this.grid.cellHeight };
  }

  /**
   * Pixels → the nearest grid cell, in halves.
   *
   * Cells are wide enough that snapping to whole ones is a blunt instrument,
   * and a half cell is still a whole number of major grid squares, so nodes
   * stay on the grid either way.
   */
  toGrid(position: Position): GridPosition {
    const snap = (value: number, cell: number) => Math.round((value / cell) * 2) / 2;
    return {
      col: snap(position.x, this.grid.cellWidth),
      row: snap(position.y, this.grid.cellHeight),
    };
  }

  /** Where every node sits right now, in grid coordinates. */
  gridPositions(): Record<string, GridPosition> {
    const positions: Record<string, GridPosition> = {};
    for (const element of this.model.getElements()) {
      positions[String(element.id)] = this.toGrid(element.position());
    }
    return positions;
  }

  /** Moves a node to a grid cell. */
  setNodePosition(id: string, position: PositionInput): this {
    const element = this.model.getCell(id) as dia.Element | undefined;
    if (!element) return this;

    const { x, y } = this.toPixels(position);
    element.position(x, y);

    const parent = element.getParentCell();
    if (parent?.isElement() && !isCollapsed(parent)) {
      (parent as dia.Element).fitToChildren({ padding: GROUP_PADDING });
    }
    return this;
  }

  /** The inverse of loading `graph.json`: elements plus grid positions. */
  toData(): GraphData {
    const elements: ElementDefinition[] = this.model.getCells().map((cell) => {
      const definition: Record<string, unknown> = {
        group: cell.isElement() ? 'nodes' : 'edges',
        data: read(cell, 'data') ?? { id: cell.id },
      };
      const classes = classesOf(cell);
      if (classes.length) definition['classes'] = classes;
      return definition as unknown as ElementDefinition;
    });

    return {
      elements,
      config: {
        positions: this.gridPositions(),
        grid: this.grid,
        collapsed: this.groups.collapsedIds(),
      },
      stylesheets: this._styles,
    };
  }

  /** Applies `config.positions`; anything unplaced gets the next free cell. */
  setPosition(): this {
    const positions = this._config.positions ?? {};
    let slot = 0;

    for (const element of this.model.getElements()) {
      const saved = positions[String(element.id)];
      if (saved) {
        const { x, y } = this.toPixels(saved);
        element.position(x, y);
        continue;
      }
      // Embedded cells move with their parent, so only place the roots.
      if (element.getParentCell()) continue;
      const { x, y } = this.toPixels({ col: slot % 4, row: Math.floor(slot / 4) });
      element.position(x, y);
      slot++;
    }

    for (const element of this.model.getElements()) {
      if (element instanceof GroupNode && !isCollapsed(element)) {
        element.fitToChildren({ padding: GROUP_PADDING });
      }
    }

    return this;
  }

  /**
   * Draws the coordinate grid. The major lines are one node wide (300px), with
   * a lighter mesh at a quarter of that.
   *
   * This uses JointJS's grid layer rather than a background image: the grid
   * layer is transformed with the paper, so the lines stay locked to the nodes
   * while panning and zooming. A background image does not move with the
   * content, which makes the grid appear to slide underneath the diagram.
   */
  renderGrid(visible = true): this {
    if (this.paper) drawGrid(this.paper, this.gridSpacing, visible);
    return this;
  }

  /** Frames the whole graph. The Cytoscape original leaned on `cy.fit()`. */
  fit(): this {
    if (!this.paper || !this.model.getElements().length) return this;
    this.paper.transformToFitContent({
      padding: 40,
      minScale: 0.3,
      maxScale: 1.5,
      useModelGeometry: true,
    });
    return this.saveCurrentViewPort();
  }

  collapse(nodes: NodeCollection): this {
    this.groups.collapse(nodes);
    this.restyle();
    return this;
  }

  expand(nodes: NodeCollection): this {
    this.groups.expand(nodes);
    this.restyle();
    return this;
  }

  // --- internals -----------------------------------------------------------

  /**
   * Switches link routing. `avoid` hands routing to libavoid, which needs the
   * WASM module loaded first; without it we stay on the built-in router rather
   * than throwing, so the diagram still draws.
   */
  private useRouter(kind: 'manhattan' | 'avoid'): void {
    if (kind === 'avoid' && !this.paper) return;

    if (kind === 'manhattan') {
      this.avoidRouter?.destroy();
      this.avoidRouter = null;
      // Hand the links back to the built-in router.
      for (const link of this.model.getLinks()) {
        link.set('router', MANHATTAN_ROUTER);
        link.set('vertices', []);
      }
      return;
    }

    if (this.avoidRouter) return;
    if (!AvoidRouter.isLoaded) {
      console.warn('[graph] edges.router is "avoid" but AvoidRouter.load() was never awaited.');
      return;
    }
    // Routes have to clear each other by more than the widest line, or thick
    // links nudged apart by a few pixels still overlap on screen.
    const widest = this._config.edges?.weight?.max ?? 10;
    this.avoidRouter = new AvoidRouter(this.model, {
      shapeBufferDistance: NODE_CLEARANCE,
      idealNudgingDistance: Math.round(widest + LINK_CLEARANCE),
      clearance: LINK_CLEARANCE,
      // Attachments snap to the same grid the nodes are placed on.
      lane: this.gridSpacing,
    });
  }

  /**
   * Binds the paper events the bus carries, once.
   *
   * A fixed set rather than one binding per `addEvent` call: a stream has to
   * carry what happens whether or not anyone has subscribed yet, or the first
   * subscriber changes what the second one sees.
   */
  private publishPointerEvents(): void {
    const paper = this.paper;
    if (!paper) return;

    for (const name of POINTER_EVENTS) {
      const jointName = jointNameFor(name);
      const on = pointerEventName(name);

      paper.on(
        `cell:${jointName}`,
        (view: dia.CellView, evt: dia.Event, x: number, y: number) => {
          this.eventbus.emit(on, {
            type: name,
            cell: view.model,
            view,
            paper,
            originalEvent: evt,
            position: { x, y },
          });
        },
      );

      paper.on(`blank:${jointName}`, (evt: dia.Event, x: number, y: number) => {
        this.eventbus.emit(on, {
          type: name,
          cell: null,
          view: null,
          paper,
          originalEvent: evt,
          position: { x, y },
        });
      });
    }
  }

  /**
   * Answers the requests made on the bus.
   *
   * Each one calls the public method that already does the work, so there is
   * one implementation and the bus is a way in rather than a second API. A
   * command the facade cannot serve alone — adding a node needs an id, and
   * collapsing needs to know what is selected — is not here: the caller that
   * has that context is the one that must assemble it.
   */
  private answerCommands(): void {
    const bus = this.eventbus;

    this.subscriptions.push(
      bus.on('viewport:zoom').subscribe(({ by, to }) => {
        const { pan, zoom } = this.viewPort;
        const next = to ?? zoom + (by ?? 0);
        this.setViewPort({ pan, zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)) });
      }),
      bus.on('viewport:set').subscribe((viewPort) => this.setViewPort(viewPort)),
      bus.on('viewport:fit').subscribe(() => this.fit()),
      bus.on('grid:show').subscribe(({ visible }) => this.renderGrid(visible)),
      bus.on('filter:set').subscribe(({ filter }) => this.setConfig({ filter })),
      bus.on('config:set').subscribe((config) => this.setConfig(config)),
      bus.on('node:move').subscribe(({ id, position }) => this.setNodePosition(id, position)),
      bus.on('cells:remove').subscribe(({ selector }) => this.remove(selector)),
      bus.on('selection:set').subscribe(({ id }) => {
        this.select(id === null ? null : (this.model.getCell(id) ?? null));
      }),
      bus.on('selection:delete').subscribe(() => {
        const cell = this.selectedCell;
        if (!cell) return;
        this.select(null);
        this.model.removeCells([cell]);
      }),
      bus.on('selection:collapse').subscribe(() => {
        const cell = this.selectedCell;
        if (!cell?.isElement()) return;
        const element = cell as dia.Element;
        if (isCollapsed(element)) this.expand([element]);
        else this.collapse([element]);
        // Collapsing changes what the cell is, not which cell it is, so the
        // selection stands — but anyone showing it has to hear about it.
        this.eventbus.emit('selection:changed', { cell });
      }),
      bus.on('layout:arrange').subscribe(() => {
        // Dropping the saved positions makes setPosition() lay everything out.
        this.setConfig({ positions: {} }).setPosition();
        this.fit();
      }),
    );
  }

  /** Draws or removes the selection ring. */
  private highlight(cell: dia.Cell | null, on: boolean): void {
    const paper = this.paper;
    if (!cell || !paper) return;

    const view = cell.findView(paper);
    if (!view) return;

    if (!on) {
      highlighters.mask.remove(view, SELECTION_ID);
      return;
    }
    highlighters.mask.add(view, { selector: 'body' }, SELECTION_ID, {
      padding: 4,
      attrs: { stroke: '#6366f1', strokeWidth: 2.5 },
    });
  }

  /** Announces that the model changed, once for this tick. */
  private announceChange(): void {
    if (this.changeQueued) return;
    this.changeQueued = true;

    queueMicrotask(() => {
      this.changeQueued = false;
      // The selection may have been collapsed or removed out from under us.
      if (this.selectedCell && !this.model.getCell(this.selectedCell.id)) this.select(null);
      const { nodes, edges } = this.data;
      this.eventbus.emit('graph:changed', { nodes: nodes.length, links: edges.length });
    });
  }

  /**
   * Marks the styles stale and applies them, if there is anything to apply
   * them to yet.
   *
   * Every facade method that can change what a cell should look like calls
   * this. Before the first `render()` it only marks: styling an undrawn graph
   * is work thrown away, and `render()` flushes what has accumulated.
   */
  private restyle(): void {
    this.styleDirty = true;
    if (this.isRendered) this.flushStyles();
  }

  /**
   * The same, for changes the facade learns about from the model rather than
   * from one of its own methods.
   *
   * Deferred to the end of the tick because the model reports cells one at a
   * time: a batch of a hundred marks the styles stale a hundred times and is
   * flushed once. A facade call that restyles synchronously in the meantime
   * simply leaves this one nothing to do.
   */
  private restyleSoon(): void {
    this.styleDirty = true;
    if (!this.isRendered || this.flushQueued) return;

    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      this.flushStyles();
    });
  }

  /** Applies the pending style work, if there is any. */
  private flushStyles(): void {
    if (!this.styleDirty) return;
    this.styleDirty = false;
    this.updateStyles();
  }

  /**
   * The three passes that turn configuration into drawn attributes, in the
   * order that defines their precedence: a measured width beats a declared
   * one, and hiding survives both.
   */
  private updateStyles(): void {
    const cells = this.model.getCells();
    applyStylesheets(cells, this._styles);

    const weight = this._config.edges?.weight;
    if (weight) applyWeights(this.model.getLinks(), weight);

    applyFilter(cells, this._config.filter);
  }

  private addNodes(elements: NodeDefinition[]): void {
    const parentIds = new Set(
      elements.map((element) => element.data.parent).filter(Boolean) as string[],
    );

    const cells = elements
      .filter((element) => !this.model.getCell(element.data.id))
      .map((element) => {
        // A node referenced as someone's parent has to be a group, whatever
        // type it asked for.
        const isGroup = parentIds.has(element.data.id) || element.data['isParent'] === true;
        const NodeType = isGroup ? GroupNode : (nodeTypeFor(element.type) ?? TaskNode);
        // Widened to dia.Element: the union of node classes confuses the
        // overloads on `set`.
        const node: dia.Element = new NodeType({ id: element.data.id });

        write(node, 'data', element.data);
        if (element.classes) write(node, 'classes', element.classes);
        node.attr('label/text', element.data.label ?? element.data.id);
        if (element.position) {
          const { x, y } = this.toPixels(element.position);
          node.position(x, y);
        }
        // The node type owns its readout; the facade just hands over the data.
        if (node instanceof BaseNode) node.applyData(element.data);
        return node;
      });

    if (cells.length) this.model.addCells(cells);
  }

  private addEdges(elements: EdgeDefinition[]): void {
    const cells = elements
      .filter((element) => {
        const id = element.data.id ?? `${element.data.source}->${element.data.target}`;
        return !this.model.getCell(id);
      })
      .map((element) => {
        const { source, target, label } = element.data;
        const link = new FlowLink({
          id: element.data.id ?? `${source}->${target}`,
          source: { id: source },
          target: { id: target },
        });
        write(link, 'data', element.data);
        if (element.classes) write(link, 'classes', element.classes);
        if (label) link.appendLabel({ attrs: { text: { text: label } } });
        return link;
      });

    if (cells.length) this.model.addCells(cells);
  }

  private initialExpandCollapse(): void {
    const ids = this._config.collapsed ?? [];
    if (!ids.length) return;

    const nodes = ids
      .map((id) => this.model.getCell(id))
      .filter((cell): cell is dia.Element => Boolean(cell) && cell.isElement());

    this.collapse(nodes);
  }

}

export type {
  Config,
  EdgeDefinition,
  EdgeCollection,
  ElementDefinition,
  Event,
  EventHandler,
  EventObject,
  GraphData,
  GridPosition,
  GridSize,
  NodeCollection,
  NodeDefinition,
  Position,
  PositionInput,
  StylesheetStyle,
  ViewPort,
} from './types';
