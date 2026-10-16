import { dia } from '@joint/core';
import { isCollapsed } from './cell-state';
import type { RouteStrategy } from './types';
import { AvoidLib } from 'libavoid-js';

/**
 * Orthogonal link routing backed by libavoid (the Adaptagrams router, compiled
 * to WASM as `libavoid-js`). JointJS's own `manhattan` router routes each link
 * in isolation, so parallel links stack on top of each other; libavoid keeps a
 * model of every obstacle and every connector at once, and nudges segments that
 * would otherwise overlap apart.
 *
 * Usage: `await AvoidRouter.load()` once, then construct one per graph. Routes
 * are written back as plain link vertices, so serialising the graph needs no
 * knowledge of this class.
 *
 * Endpoints are plain points rather than libavoid connection pins. Pins looked
 * like the better fit, but once obstacles are deleted and moved in the same
 * session some of them lose their pins, and libavoid then quietly falls back to
 * routing from the node's centre — which draws diagonals. Points are recomputed
 * from the model before every routing pass instead, which is cheap and cannot
 * drift out of sync.
 */

export interface AvoidRouterOptions {
  /** Clearance kept between a route and any obstacle. */
  shapeBufferDistance?: number;
  /** Gap to keep between the drawn edges of two neighbouring links. */
  clearance?: number;
  /** Gap between parallel segments that would otherwise overlap. */
  idealNudgingDistance?: number;
  /** Which halves of the routing cascade are in play. Defaults to `combined`. */
  strategy?: RouteStrategy;
  /**
   * The grid pitch attachment points snap to. Links leave and enter a node on
   * grid lines, and turn one lane clear of it, so the corridors line up with
   * the grid the nodes are placed on. Halved as needed when a node has more
   * links on one edge than there are lanes.
   */
  lane?: number;
}

/**
 * `libavoid-js` is beta and its bundled `.d.ts` does not match the WASM build
 * (routing flags live under `RouterFlag` at runtime but are declared top-level,
 * and C++ default arguments are not exposed). The binding is therefore treated
 * as untyped, with the narrow types below describing what this file touches.
 */
type Avoid = any;
type AvoidObstacle = unknown;
type AvoidConn = {
  displayRoute(): { size(): number; at(i: number): { x: number; y: number } };
  setSourceEndpoint(end: unknown): void;
  setDestEndpoint(end: unknown): void;
};

export class AvoidRouter {
  /** Loads the WASM binary. Safe to call repeatedly; only the first loads. */
  static async load(wasmUrl = 'libavoid.wasm'): Promise<void> {
    if (AvoidLib.avoidLib) return;
    await AvoidLib.load(wasmUrl);
  }

  static get isLoaded(): boolean {
    return Boolean(AvoidLib.avoidLib);
  }

  private readonly avoid: Avoid;
  private readonly router: Avoid;
  private readonly obstacles = new Map<dia.Cell.ID, AvoidObstacle>();
  private readonly connectors = new Map<dia.Cell.ID, AvoidConn>();
  /** Per-link attachment points, keyed `<linkId>|source` / `<linkId>|target`. */
  private attachments = new Map<string, Attachment>();
  /** The lanes each end could move to, for the conflict repair pass. */
  private laneChoices = new Map<string, LaneChoice>();
  /** The ends sharing each node edge, in lane order. */
  private edgeGroups: string[][] = [];
  /**
   * Corridor changes made by the repair pass. Attachments are rebuilt from
   * scratch on every routing pass, so a repair has to be recorded here or the
   * next pass simply undoes it.
   */
  private readonly corridorOverrides = new Map<string, number>();
  private readonly buffer: number;
  private readonly lane: number;
  private readonly clearance: number;
  /** Which halves of the cascade are in play. See `RouteStrategy`. */
  private readonly strategy: RouteStrategy;
  private frame: number | null = null;
  /** Set while a drag is in progress; routing waits for it to be let go. */
  private held = false;
  /** Routing passes run since this router was built. */
  private passCount = 0;
  /** A change arrived while held, so a pass is owed once it is released. */
  private owed = false;
  /** Links drawn straight while their node is being dragged. */
  private previewing: dia.Link[] = [];
  private destroyed = false;
  /** True when obstacles/connectors were added but not yet routed. */
  private pending = false;
  /** Straight runs of fallback routes waiting to be put in a gutter. */
  private runs: {
    a: dia.Point;
    b: dia.Point;
    path: dia.Point[];
    ends: (dia.Cell.ID | undefined)[];
    across: Axis;
    from: number;
    to: number;
    was: number;
    width: number;
    choices: number[];
  }[] = [];

  /** Links whose vertices are re-set once their runs have been placed. */
  private centred: { link: dia.Link; vertices: dia.Point[]; options: dia.Cell.Options }[] = [];

  /** Runs already placed in a gutter during this routing pass. */
  private channels: {
    axis: Axis;
    at: number;
    from: number;
    to: number;
    width: number;
  }[] = [];

  constructor(
    private readonly graph: dia.Graph,
    options: AvoidRouterOptions = {},
  ) {
    if (!AvoidRouter.isLoaded) {
      throw new Error('AvoidRouter.load() must be awaited before constructing a router.');
    }
    const Avoid: Avoid = AvoidLib.getInstance();
    this.avoid = Avoid;
    this.buffer = options.shapeBufferDistance ?? 16;
    this.lane = options.lane ?? 75;
    this.clearance = options.clearance ?? 12;
    this.strategy = options.strategy ?? 'combined';

    // Embind exposes enum members as objects; the Router constructor takes a
    // raw bitfield, so the numeric `.value` is required here (the routing
    // parameter and option setters do take the enum objects).
    this.router = new Avoid.Router(Avoid.RouterFlag.OrthogonalRouting.value);
    this.router.setRoutingParameter(Avoid.RoutingParameter.shapeBufferDistance, this.buffer);
    this.router.setRoutingParameter(
      Avoid.RoutingParameter.idealNudgingDistance,
      options.idealNudgingDistance ?? 16,
    );
    // Prefer fewer corners, and make crossings expensive so routes go around.
    this.router.setRoutingParameter(Avoid.RoutingParameter.segmentPenalty, 50);
    this.router.setRoutingParameter(Avoid.RoutingParameter.crossingPenalty, 400);
    this.router.setRoutingParameter(Avoid.RoutingParameter.anglePenalty, 0);
    // Sharing a path with another connector costs nothing by default, so
    // libavoid happily lays two routes on the same centreline and leaves the
    // nudging stage to tell them apart — which it cannot always do. Making it
    // expensive is what pushes competing links onto genuinely different routes.
    this.router.setRoutingParameter(Avoid.RoutingParameter.fixedSharedPathPenalty, 1000);
    // The nudging options are what stop parallel links from overlapping.
    // The shape-connected segments are deliberately excluded: their position
    // is already decided by the attachment lane, and letting libavoid nudge
    // them puts a small jog between the lane and the first bend.
    this.router.setRoutingOption(Avoid.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes, false);
    this.router.setRoutingOption(Avoid.RoutingOption.nudgeOrthogonalTouchingColinearSegments, true);
    this.router.setRoutingOption(Avoid.RoutingOption.penaliseOrthogonalSharedPathsAtConnEnds, true);
    // Two links into the same node would otherwise share their whole approach
    // corridor; this is what pulls them apart.
    this.router.setRoutingOption(Avoid.RoutingOption.nudgeSharedPathsWithCommonEndPoint, true);
    this.router.setRoutingOption(Avoid.RoutingOption.performUnifyingNudgingPreprocessingStep, true);

    this.listen();
    this.routeAll();
  }

  destroy(): void {
    this.destroyed = true;
    this.corridorOverrides.clear();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.graph.off(undefined, undefined, this);
    this.obstacles.clear();
    this.connectors.clear();
    this.router.delete?.();
  }

  /** Builds every obstacle and connector, then routes. */
  /**
   * How many routing passes have run.
   *
   * Reported so that "routing does not run while a node is being dragged"
   * can be checked as the invariant it is, rather than inferred from whether
   * anything on screen moved — a pass that happens to change nothing would
   * leave no trace to find.
   */
  get passes(): number {
    return this.passCount;
  }

  routeAll(): void {
    for (const element of this.graph.getElements()) this.addObstacle(element);
    for (const link of this.graph.getLinks()) this.addConnector(link);
    this.process();
  }

  // --- graph wiring --------------------------------------------------------

  private listen(): void {
    this.graph.on(
      'add',
      (cell: dia.Cell) => {
        if (cell.isElement()) this.addObstacle(cell as dia.Element);
        else this.addConnector(cell as dia.Link);
        this.schedule();
      },
      this,
    );

    this.graph.on(
      'remove',
      (cell: dia.Cell) => {
        this.removeCell(cell);
        this.schedule();
      },
      this,
    );

    this.graph.on(
      'change:position change:size',
      (cell: dia.Cell) => {
        if (!cell.isElement()) return;
        this.updateObstacle(cell as dia.Element);
        this.schedule();
      },
      this,
    );

    this.graph.on(
      'change:source change:target',
      (cell: dia.Cell, _value: unknown, opt: { avoidRouter?: boolean } = {}) => {
        // Anchors written by this router are not a real endpoint change.
        if (!cell.isLink() || opt.avoidRouter) return;
        this.addConnector(cell as dia.Link);
        this.schedule();
      },
      this,
    );
  }

  /**
   * Stops routing until `resume()`.
   *
   * A drag moves a node on every frame, and a full pass costs far more than a
   * frame, so routing during one does not keep up: the diagram stutters and
   * the routes trail the pointer. Nothing about a route is interesting until
   * the node is put down, so the pass waits for that.
   *
   * The links on `element` are drawn straight from dock to dock meanwhile —
   * their docks move with the node, so leaving the old vertices in place
   * would bend them around corners that are no longer there.
   */
  suspend(element?: dia.Element): void {
    this.held = true;
    if (!element || this.previewing.length) return;

    const options = { avoidRouter: true } as dia.Cell.Options;
    for (const link of this.graph.getConnectedLinks(element, { deep: true })) {
      link.set('vertices', [], options);
      this.previewing.push(link);
    }
  }

  /**
   * Routes again, and catches up on anything that changed while held.
   *
   * Releases fully rather than unwinding one `suspend()` at a time. A hold
   * that is never released stops the diagram routing for the rest of the
   * session, and a pointer let go outside the window is all it would take;
   * routing once more than necessary is the cheaper mistake.
   */
  resume(): void {
    if (!this.held) return;
    this.held = false;
    this.previewing = [];
    if (!this.owed) return;
    this.owed = false;
    this.schedule();
  }

  private schedule(): void {
    if (this.destroyed || this.frame !== null) return;
    if (this.held) {
      this.owed = true;
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.process();
    });
  }

  // --- obstacles -----------------------------------------------------------

  /**
   * Groups are deliberately not obstacles: their children live inside them, so
   * a route that avoids the group box could never reach them.
   */
  private isObstacle(element: dia.Element): boolean {
    return !element.getEmbeddedCells().length && !isCollapsed(element);
  }

  /**
   * libavoid asserts if an obstacle is deleted or moved while its own add is still
   * queued, so anything mutating existing geometry flushes the queue first.
   */
  private flush(): void {
    if (!this.pending) return;
    this.router.processTransaction();
    this.pending = false;
  }

  private rectangleFor(element: dia.Element): unknown {
    const Avoid: Avoid = this.avoid;
    const { x, y, width, height } = element.getBBox();
    return new Avoid.Rectangle(new Avoid.Point(x, y), new Avoid.Point(x + width, y + height));
  }

  private addObstacle(element: dia.Element): void {
    const Avoid: Avoid = this.avoid;
    if (this.obstacles.has(element.id)) return this.updateObstacle(element);
    if (!this.isObstacle(element)) return;

    this.obstacles.set(element.id, new Avoid.ShapeRef(this.router, this.rectangleFor(element)));
    this.pending = true;
  }

  private updateObstacle(element: dia.Element): void {
    const obstacle = this.obstacles.get(element.id);
    if (!obstacle) return this.addObstacle(element);

    this.flush();
    // An element that just gained children stops being an obstacle.
    if (!this.isObstacle(element)) {
      this.removeCell(element);
      return;
    }
    // The C++ default for `first_move` is not exposed, so pass it explicitly.
    this.router.moveShape_poly(obstacle, this.rectangleFor(element), false);
  }

  private removeCell(cell: dia.Cell): void {
    const obstacle = this.obstacles.get(cell.id);
    const connector = this.connectors.get(cell.id);
    if (obstacle || connector) this.flush();

    if (obstacle) {
      this.router.deleteShape(obstacle);
      this.obstacles.delete(cell.id);
    }
    if (connector) {
      this.router.deleteConnector(connector);
      this.connectors.delete(cell.id);
    }
  }

  // --- connectors ----------------------------------------------------------

  /**
   * Spreads the links attached to each node along the edge they leave by, so
   * no two of them dock at the same point.
   *
   * Without this every link attaches at the node's centre: libavoid then runs
   * them all down one corridor, which both overlaps them and slants the first
   * segment away from the centre. One lane per link keeps each route separate
   * and its entry axis-aligned.
   */
  private computeAttachments(): void {
    const boxOf = (id: dia.Cell.ID | undefined) => {
      if (id === undefined) return null;
      const element = this.graph.getCell(id) as dia.Element | undefined;
      return element?.isElement() ? element.getBBox() : null;
    };

    type Box = { x: number; y: number; width: number; height: number };
    interface Slot {
      key: string;
      side: Side;
      box: Box;
      /** Where the far end of the link sits, along this edge's axis. */
      towards: number;
      /** How far the node's outline reaches, measured along the dock axis. */
      outline: (offset: number) => number;
      /** How thick this link is drawn, so its lane can be wide enough. */
      width: number;
      /**
       * True when the link really runs dead straight, with no bend at all, and
       * so has a claim on the middle of the edge. Lining up is not enough:
       * another node can sit between the two ends.
       */
      centred: boolean;
    }

    const widthOf = (link: dia.Link) => {
      const width = link.attr('line/strokeWidth');
      return typeof width === 'number' && width > 0 ? width : 2;
    };

    /**
     * How far the node's outline reaches from its middle, in the direction the
     * link leaves. A round node is narrower away from its centre line, so a
     * lane 100px up docks closer in than one at the middle.
     */
    const outlineOf = (id: dia.Cell.ID | undefined, box: Box, side: Side) => {
      const element = id === undefined ? undefined : this.graph.getCell(id);
      const node = element as unknown as {
        attachOffsetX?: (dy: number) => number;
        attachOffsetY?: (dx: number) => number;
      };
      if (HORIZONTAL[side]) {
        return typeof node?.attachOffsetX === 'function'
          ? (dy: number) => node.attachOffsetX!(dy)
          : () => box.width / 2;
      }
      return typeof node?.attachOffsetY === 'function'
        ? (dx: number) => node.attachOffsetY!(dx)
        : () => box.height / 2;
    };

    const byEdge = new Map<string, Slot[]>();

    for (const link of this.graph.getLinks()) {
      const source = link.source();
      const target = link.target();
      const sourceBox = boxOf(source.id);
      const targetBox = boxOf(target.id);
      if (!sourceBox || !targetBox) continue;

      const centre = (box: Box) => ({
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
      });
      const from = centre(sourceBox);
      const to = centre(targetBox);
      const dx = to.x - from.x;
      const dy = to.y - from.y;

      // One bend means the two ends must dock on perpendicular axes: the link
      // leaves sideways and arrives from above or below, or the other way
      // round. Nodes in line with each other dock head-on and need no bend.
      //
      // Which of the two it is follows the flow: a link leaves by the right or
      // the bottom and arrives at the left or the top. For the usual
      // left-to-right, top-to-bottom graph that is what the geometry picks
      // anyway; it only differs for a link that doubles back.
      const inRow = Math.abs(dy) < 1;
      const inColumn = Math.abs(dx) < 1;
      const endIds = [source.id, target.id];

      // Lining up does not make a link straight: another node can sit between
      // the two ends, and then the link has to go around it. Only a link that
      // can really run dead straight has a claim on the middle of the edge —
      // one that cannot would hold the middle while its neighbour sat offset
      // beside it, an asymmetry paid for a straight run that never happens.
      const straight = (inRow || inColumn) && this.isClear([from, to], endIds);

      let sourceSide: Side;
      let targetSide: Side;

      if (inRow && straight) {
        sourceSide = dx >= 0 ? 'right' : 'left';
        targetSide = OPPOSITE[sourceSide];
      } else if (inColumn && straight) {
        sourceSide = dy >= 0 ? 'bottom' : 'top';
        targetSide = OPPOSITE[sourceSide];
      } else {
        // Two ways to turn the corner. Prefer the one that follows the link's
        // dominant direction, but take the other if the first would run the
        // elbow through a node.
        const outFirst: [Side, Side] = [dx >= 0 ? 'right' : 'left', dy >= 0 ? 'top' : 'bottom'];
        const downFirst: [Side, Side] = [dy >= 0 ? 'bottom' : 'top', dx >= 0 ? 'left' : 'right'];
        const [first, second] =
          Math.abs(dx) >= Math.abs(dy) ? [outFirst, downFirst] : [downFirst, outFirst];

        const corner = ([side]: [Side, Side]) =>
          HORIZONTAL[side] ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
        const viable = (variant: [Side, Side]) =>
          this.isClear([from, corner(variant), to], endIds);

        if (viable(first)) {
          [sourceSide, targetSide] = first;
        } else if (viable(second)) {
          [sourceSide, targetSide] = second;
        } else {
          // Neither single bend gets through, so the link needs two: out of
          // the source, along a clear gutter, and into the target. Which pair
          // of docks allows that depends on where the gutters are, so ask
          // before committing — docking a link for a detour that then cannot
          // be drawn is worse than either, because it leaves the fallback
          // router working against the docks instead of with them.
          //
          // A link that drops much further than it travels (the waste lines
          // falling out of the production rows) is a drop, and gets the
          // top-to-bottom pair first; anything else is a traverse.
          // Two nodes in the same column have no sideways direction to
          // prefer, and docking the far end on the *opposite* side would send
          // the link across the node it is arriving at to reach it. Same side
          // at both ends instead: out, along the gutter, and back in the way
          // it came. Either side will do, so both are offered.
          const flat = Math.abs(dx) < 1;
          const plumb = Math.abs(dy) < 1;

          const upright: [Side, Side][] = plumb
            ? [
                ['bottom', 'bottom'],
                ['top', 'top'],
              ]
            : [[dy >= 0 ? 'bottom' : 'top', dy >= 0 ? 'top' : 'bottom']];
          const sideways: [Side, Side][] = flat
            ? [
                ['right', 'right'],
                ['left', 'left'],
              ]
            : [[dx >= 0 ? 'right' : 'left', dx >= 0 ? 'left' : 'right']];

          const drop = Math.abs(dy) >= Math.abs(dx) * DROP_RATIO;
          const order = drop ? [...upright, ...sideways] : [...sideways, ...upright];

          [sourceSide, targetSide] =
            order.find(([side]) =>
              this.canDogLeg(HORIZONTAL[side] ? 'x' : 'y', from, to, endIds, OUTWARD[side]),
            ) ?? order[0];
        }
      }

      const slots: [dia.Cell.ID | undefined, Slot][] = [
        [source.id, {
          key: `${link.id}|source`,
          side: sourceSide,
          box: sourceBox,
          towards: HORIZONTAL[sourceSide] ? to.y : to.x,
          outline: outlineOf(source.id, sourceBox, sourceSide),
          width: widthOf(link),
          centred: straight,
        }],
        [target.id, {
          key: `${link.id}|target`,
          side: targetSide,
          box: targetBox,
          towards: HORIZONTAL[targetSide] ? from.y : from.x,
          outline: outlineOf(target.id, targetBox, targetSide),
          width: widthOf(link),
          centred: straight,
        }],
      ];

      for (const [nodeId, slot] of slots) {
        const edge = `${String(nodeId)}|${slot.side}`;
        byEdge.set(edge, [...(byEdge.get(edge) ?? []), slot]);
      }
    }

    const attachments = new Map<string, Attachment>();
    this.edgeGroups = [];
    for (const slots of byEdge.values()) {
      // Ordering by the far end stops lanes crossing each other at the node.
      const ordered = [...slots].sort((a, b) => a.towards - b.towards);
      const { box, side, outline } = ordered[0];
      const along = HORIZONTAL[side] ? box.height : box.width;
      // The widest link on this edge sets how close the lanes may sit. Links
      // running dead straight are left out of the allocation: they take the
      // middle of the edge, which is the only lane that keeps them unbent.
      // Only one link can have the middle of an edge. If several line up with
      // this node, the straightest one keeps it and the rest take lanes —
      // otherwise they would all leave from the same point.
      const centred = ordered.find((slot) => slot.centred);
      const spread = ordered.filter((slot) => slot !== centred);
      const pitch = Math.max(...ordered.map((slot) => slot.width)) + this.clearance;
      // The centred link already holds the middle, so the others are given
      // spare lanes and everything within a lane pitch of the middle is taken
      // out — a neighbouring lane would sit right against the centred link.
      const extra = centred ? 2 : 0;
      // No bias: the lanes sit centred and evenly spread on the edge, which is
      // what a node is expected to look like. Lanes that clash with another
      // node's are moved afterwards by the repair passes, which can see the
      // routed geometry — biasing every node up front to dodge those clashes
      // just left every edge looking lopsided.
      const allocation = this.lanesFor(along, spread.length + extra, outline, pitch);
      const clear = centred
        ? allocation.filter((lane) => Math.abs(lane - along / 2) >= pitch)
        : allocation;
      const spreadLanes = clear.length >= spread.length ? clear : allocation;
      // Hand each link the free lane nearest to where it actually arrives
      // from, rather than the next one in order.
      //
      // Taking them in order looks the same until one link holds the centre:
      // the centre is then cut out of the list, and a link approaching from
      // below can be handed a lane above it — so it crosses the straight link
      // on its way in, and has to be bridged over it for no reason.
      const claimed = new Set<number>();
      const laneOf = (slot: Slot) => {
        if (slot === centred) return along / 2;
        const arrivesAt = HORIZONTAL[side] ? slot.towards - box.y : slot.towards - box.x;
        const ideal = Math.max(0, Math.min(along, arrivesAt));

        let best: number | undefined;
        for (const lane of spreadLanes) {
          if (claimed.has(lane)) continue;
          if (best === undefined || Math.abs(lane - ideal) < Math.abs(best - ideal)) best = lane;
        }
        if (best === undefined) best = spreadLanes[spread.indexOf(slot)] ?? along / 2;
        claimed.add(best);
        return best;
      };

      // Remembered so a conflicting link can be moved to another lane later,
      // and so two links on one edge can trade lanes to undo a crossing.
      for (const slot of ordered) {
        this.laneChoices.set(slot.key, { lanes: allocation, box, side, outline });
      }
      this.edgeGroups.push(ordered.map((slot) => slot.key));

      ordered.forEach((slot, index) => {
        const lane = laneOf(slot);
        const outward = OUTWARD[side];
        // Sit on the node's own outline, not on its bounding box.
        const reach = outline(lane - along / 2);
        const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

        attachments.set(slot.key, {
          x: HORIZONTAL[side] ? middle.x + outward.x * reach : box.x + lane,
          y: HORIZONTAL[side] ? box.y + lane : middle.y + outward.y * reach,
          outward,
          docked: true,
          laneIndex: index,
          approach: 0,
        });
      });
    }

    // Spread the approach corridors.
    //
    // Every link docking on one side of a node would otherwise turn at the
    // same distance from it, so two links heading for different nodes in the
    // same column run down the identical line. libavoid will not separate
    // them — its nudging only moves segments attached to a *shape*, and these
    // attach to a fixed point — so the corridor is ours to choose. Taking it
    // from the lane at the far end gives links that share a source (or a
    // target) different corridors, while staying a whole number of lanes out.
    for (const link of this.graph.getLinks()) {
      const source = attachments.get(`${link.id}|source`);
      const target = attachments.get(`${link.id}|target`);
      if (!source || !target) continue;
      // Both lane indices, so two links that happen to share one still differ.
      source.approach = (source.laneIndex + target.laneIndex) % APPROACH_CORRIDORS;
      target.approach = (target.laneIndex + source.laneIndex * 2) % APPROACH_CORRIDORS;
    }

    for (const [key, approach] of this.corridorOverrides) {
      const attachment = attachments.get(key);
      if (attachment) attachments.set(key, { ...attachment, approach });
    }

    this.attachments = attachments;
    this.straightenAligned();
    this.separateCorridors();
    this.reduceCrossings();
    this.repairHeavyCrossers();
    this.enforceUniqueDocks();
  }

  /**
   * Trades lanes between two links on the same node edge when that removes a
   * crossing.
   *
   * Lanes are handed out in the order the links' far ends sit along the edge's
   * axis, which is usually crossing-free — but not when the two links leave at
   * different angles, and every crossing costs a bridge to draw. Swapping the
   * pair is the whole fix, so this just tries each adjacent pair and keeps the
   * swaps that help.
   */
  private reduceCrossings(): void {
    for (let pass = 0; pass < REPAIR_PASSES; pass++) {
      let improved = false;

      for (const group of this.edgeGroups) {
        for (let i = 0; i + 1 < group.length; i++) {
          const before = this.crossingCount();
          this.swapLanes(group[i], group[i + 1]);
          if (this.crossingCount() < before) {
            improved = true;
          } else {
            this.swapLanes(group[i], group[i + 1]);
          }
        }
      }
      if (!improved) return;
    }
  }

  /**
   * Re-docks the links that cross the most others.
   *
   * Swapping neighbours on one edge fixes a crossing between two links, but
   * not a link that cuts across the diagram and collects bridges all the way.
   * For those the lane that matters may be at either end, so this tries every
   * lane on both, keeps whichever leaves the diagram with the fewest
   * crossings overall, and moves on to the next worst.
   */
  private repairHeavyCrossers(): void {
    for (let pass = 0; pass < REPAIR_PASSES; pass++) {
      const worst = this.heaviestCrosser();
      if (!worst) return;

      const best = { total: this.crossingCount(), key: '', lane: 0 };
      const original = new Map<string, Attachment>();

      for (const which of ['source', 'target'] as const) {
        const key = `${worst}|${which}`;
        const choice = this.laneChoices.get(key);
        const attachment = this.attachments.get(key);
        if (!choice || !attachment) continue;
        original.set(key, { ...attachment });

        for (const lane of choice.lanes) {
          this.placeOnLane(key, choice, lane);
          const total = this.crossingCount();
          if (total < best.total) {
            best.total = total;
            best.key = key;
            best.lane = lane;
          }
          this.attachments.set(key, { ...original.get(key)! });
        }
      }

      if (!best.key) return;
      const choice = this.laneChoices.get(best.key);
      if (choice) this.placeOnLane(best.key, choice, best.lane);
    }
  }

  /** The link crossing the most others, if any crosses more than two. */
  private heaviestCrosser(): dia.Cell.ID | null {
    const runs = this.currentRuns();
    const tally = new Map<dia.Cell.ID, number>();

    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const a = runs[i];
        const b = runs[j];
        if (a.link === b.link || a.run.vertical === b.run.vertical) continue;
        const v = a.run.vertical ? a.run : b.run;
        const h = a.run.vertical ? b.run : a.run;
        if (!(v.from < h.at && h.at < v.to && h.from < v.at && v.at < h.to)) continue;
        tally.set(a.link, (tally.get(a.link) ?? 0) + 1);
        tally.set(b.link, (tally.get(b.link) ?? 0) + 1);
      }
    }

    let worst: dia.Cell.ID | null = null;
    let most = 2; // two crossings is not worth re-docking a link for
    for (const [link, count] of tally) {
      if (count > most) {
        most = count;
        worst = link;
      }
    }
    return worst;
  }

  /**
   * Guarantees no two links dock at the same point on a node.
   *
   * Every earlier pass can land one link's dock on another's: straightening
   * moves an end onto its partner's lane, and the repair passes pick lanes by
   * what they fix rather than by what is free. A shared dock makes two links
   * leave a node from exactly the same place, which reads as one link. This
   * runs last and moves any duplicate to the nearest lane nobody is using.
   */
  private enforceUniqueDocks(): void {
    const byNode = new Map<dia.Cell.ID, string[]>();

    for (const link of this.graph.getLinks()) {
      for (const which of ['source', 'target'] as const) {
        const end = which === 'source' ? link.source() : link.target();
        if (end.id === undefined) continue;
        const key = `${link.id}|${which}`;
        if (!this.attachments.get(key)?.docked) continue;
        byNode.set(end.id, [...(byNode.get(end.id) ?? []), key]);
      }
    }

    for (const keys of byNode.values()) {
      const taken: { x: number; y: number }[] = [];

      for (const key of keys) {
        const attachment = this.attachments.get(key);
        if (!attachment) continue;

        const clashes = (point: { x: number; y: number }) =>
          taken.some((other) => Math.hypot(other.x - point.x, other.y - point.y) < 2);

        if (!clashes(attachment)) {
          taken.push({ x: attachment.x, y: attachment.y });
          continue;
        }

        const choice = this.laneChoices.get(key);
        if (!choice) continue;

        // Nearest free lane on the same edge, so the route barely changes.
        const along = HORIZONTAL[choice.side] ? choice.box.height : choice.box.width;
        const current = HORIZONTAL[choice.side]
          ? attachment.y - choice.box.y
          : attachment.x - choice.box.x;
        const ordered = [...choice.lanes].sort(
          (a, b) => Math.abs(a - current) - Math.abs(b - current),
        );

        for (const lane of ordered) {
          this.placeOnLane(key, choice, lane);
          const moved = this.attachments.get(key)!;
          if (!clashes(moved)) break;
        }
        void along;
        const settled = this.attachments.get(key)!;
        taken.push({ x: settled.x, y: settled.y });
      }
    }
  }

  /** Exchanges the positions of two ends docked on the same edge. */
  private swapLanes(a: string, b: string): void {
    const first = this.attachments.get(a);
    const second = this.attachments.get(b);
    if (!first || !second) return;
    this.attachments.set(a, { ...first, x: second.x, y: second.y });
    this.attachments.set(b, { ...second, x: first.x, y: first.y });
  }

  /** How many times one link's route crosses another's. */
  private crossingCount(): number {
    const runs = this.currentRuns();
    let crossings = 0;

    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const a = runs[i].run;
        const b = runs[j].run;
        if (runs[i].link === runs[j].link || a.vertical === b.vertical) continue;
        const v = a.vertical ? a : b;
        const h = a.vertical ? b : a;
        if (v.from < h.at && h.at < v.to && h.from < v.at && v.at < h.to) crossings++;
      }
    }
    return crossings;
  }

  /**
   * Makes a link between two aligned nodes run dead straight.
   *
   * Only one link per edge can hold the middle lane, so a second link between
   * nodes in the same row is handed a lane of its own and ends up with a bend
   * of a few dozen pixels at each end — shorter than the arrowhead, and read
   * as a kink rather than a turn. Copying one end's lane to the other removes
   * the bend entirely, which is what `MIN_BEND` is really asking for: no bend
   * at all is better than one too short to see.
   *
   * The copied lane may land on another link's, which `separateCorridors`
   * then sorts out — straightness is tried first, not forced.
   */
  private straightenAligned(): void {
    for (const link of this.graph.getLinks()) {
      const source = this.attachments.get(`${link.id}|source`);
      const target = this.attachments.get(`${link.id}|target`);
      if (!source?.docked || !target?.docked) continue;

      const horizontal = source.outward.x !== 0 && target.outward.x !== 0;
      const vertical = source.outward.y !== 0 && target.outward.y !== 0;
      if (!horizontal && !vertical) continue; // perpendicular: a real bend

      const offset = horizontal
        ? Math.abs(source.y - target.y)
        : Math.abs(source.x - target.x);
      if (offset === 0 || offset > MIN_BEND) continue;

      // Pull the target onto the source's lane — but only when that really
      // leaves the link straight. A link that has to detour around a node in
      // between keeps all of its bends either way, so copying the lane buys
      // nothing and costs the gap between this dock and its neighbour's.
      const pulled = horizontal
        ? { ...target, y: source.y }
        : { ...target, x: source.x };
      if (!this.isClear([source, pulled], [link.source().id, link.target().id])) continue;

      this.attachments.set(`${link.id}|target`, pulled);
    }
  }

  /**
   * Moves links off each other's corridors.
   *
   * Lanes are handed out one node edge at a time, so nothing stops two nodes
   * from giving adjacent lanes to links whose runs then travel side by side —
   * a thin link disappears inside a wide one. This pass looks at the finished
   * routes, finds runs that overlap, and tries the other lanes available to
   * the thinner of the two until the overlap goes away.
   */
  private separateCorridors(): void {
    for (let pass = 0; pass < REPAIR_PASSES; pass++) {
      const conflicts = this.findConflicts();
      if (!conflicts.length) return;

      let improved = false;
      for (const { key, link } of conflicts) {
        const choice = this.laneChoices.get(key);
        const attachment = this.attachments.get(key);
        if (!choice || !attachment) continue;

        const before = this.conflictCount();
        const original = { ...attachment };

        for (const lane of choice.lanes) {
          this.placeOnLane(key, choice, lane);
          if (this.conflictCount() < before) {
            improved = true;
            break;
          }
          this.attachments.set(key, { ...original });
        }
        if (improved) break;
        void link;
      }
      if (!improved) return;
    }
  }

  /** Puts one end on a given lane, keeping it on the node's outline. */
  private placeOnLane(key: string, choice: LaneChoice, lane: number): void {
    const attachment = this.attachments.get(key);
    if (!attachment) return;
    const { box, side, outline } = choice;
    const along = HORIZONTAL[side] ? box.height : box.width;
    const reach = outline(lane - along / 2);
    const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    this.attachments.set(key, {
      ...attachment,
      x: HORIZONTAL[side] ? middle.x + attachment.outward.x * reach : box.x + lane,
      y: HORIZONTAL[side] ? box.y + lane : middle.y + attachment.outward.y * reach,
    });
  }

  /**
   * Looks at the routes as drawn and moves a link off a corridor it shares.
   * Returns true when something moved, so the caller can route again.
   */
  private repairRendered(): boolean {
    const runs: { key: string; link: dia.Cell.ID; run: Run }[] = [];

    for (const link of this.graph.getLinks()) {
      const source = this.attachments.get(`${link.id}|source`);
      const target = this.attachments.get(`${link.id}|target`);
      if (!source?.docked || !target?.docked) continue;

      const points = [source, ...((link.vertices() ?? []) as dia.Point[]), target];
      const raw = link.attr('line/strokeWidth');
      const width = typeof raw === 'number' && raw > 0 ? raw : 2;

      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const vertical = Math.abs(b.x - a.x) < 1;
        if (!vertical && Math.abs(b.y - a.y) >= 1) continue; // diagonal: skip
        // Attribute the run to whichever end is nearer, since that is the
        // lane that can be moved to shift it.
        const nearSource = i <= points.length / 2;
        runs.push({
          key: `${link.id}|${nearSource ? 'source' : 'target'}`,
          link: link.id,
          run: {
            vertical,
            at: vertical ? a.x : a.y,
            from: vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x),
            to: vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x),
            width,
          },
        });
      }
    }

    // The worst offender first: the longest stretch of shared corridor.
    let worst: { key: string; overlap: number } | null = null;
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const a = runs[i];
        const b = runs[j];
        if (a.link === b.link || a.run.vertical !== b.run.vertical) continue;

        const apart = Math.abs(a.run.at - b.run.at);
        if (apart >= (a.run.width + b.run.width) / 2 + this.clearance) continue;
        const along = Math.min(a.run.to, b.run.to) - Math.max(a.run.from, b.run.from);
        if (along <= 8) continue;

        const thinner = a.run.width <= b.run.width ? a : b;
        if (!worst || along > worst.overlap) worst = { key: thinner.key, overlap: along };
      }
    }
    if (!worst) return false;

    const attachment = this.attachments.get(worst.key);
    if (!attachment) return false;

    // Shift the approach corridor first. For a link that libavoid had to route
    // around something, the lane along the node's edge barely moves the long
    // runs — the corridor it turns into is what they share, and that steps a
    // whole lane at a time.
    if (attachment.approach < APPROACH_CORRIDORS - 1) {
      const approach = attachment.approach + 1;
      this.corridorOverrides.set(worst.key, approach);
      this.attachments.set(worst.key, { ...attachment, approach });
      return true;
    }

    // Corridors exhausted: fall back to moving along the node's edge.
    const choice = this.laneChoices.get(worst.key);
    if (!choice || choice.lanes.length < 2) return false;

    const along = HORIZONTAL[choice.side] ? choice.box.height : choice.box.width;
    const current = HORIZONTAL[choice.side]
      ? attachment.y - choice.box.y
      : attachment.x - choice.box.x;
    const furthest = choice.lanes.reduce((best, lane) =>
      Math.abs(lane - current) > Math.abs(best - current) ? lane : best,
    );
    if (Math.abs(furthest - current) < 1) return false;

    void along;
    this.placeOnLane(worst.key, choice, furthest);
    return true;
  }

  /** Every link's run geometry under the current attachments. */
  private currentRuns(): { link: dia.Cell.ID; key: string; run: Run }[] {
    const out: { link: dia.Cell.ID; key: string; run: Run }[] = [];

    for (const link of this.graph.getLinks()) {
      const source = this.attachments.get(`${link.id}|source`);
      const target = this.attachments.get(`${link.id}|target`);
      if (!source?.docked || !target?.docked) continue;

      const bend = this.elbow(source, target);
      if (!bend) continue;
      const points = [source, ...bend, target];
      const width = (() => {
        const w = link.attr('line/strokeWidth');
        return typeof w === 'number' && w > 0 ? w : 2;
      })();

      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const vertical = Math.abs(b.x - a.x) < 1;
        // The run belongs to whichever end's lane decides its position.
        const key = i === 1 ? `${link.id}|source` : `${link.id}|target`;
        out.push({
          link: link.id,
          key,
          run: {
            vertical,
            at: vertical ? a.x : a.y,
            from: vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x),
            to: vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x),
            width,
          },
        });
      }
    }
    return out;
  }

  private conflictCount(): number {
    return this.findConflicts().length;
  }

  /** Ends whose run sits on top of another link's, thinnest first. */
  private findConflicts(): { key: string; link: dia.Cell.ID }[] {
    const runs = this.currentRuns();
    const found: { key: string; link: dia.Cell.ID; width: number }[] = [];

    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const a = runs[i];
        const b = runs[j];
        if (a.link === b.link || a.run.vertical !== b.run.vertical) continue;

        const apart = Math.abs(a.run.at - b.run.at);
        const needed = (a.run.width + b.run.width) / 2 + this.clearance;
        if (apart >= needed) continue;
        const along = Math.min(a.run.to, b.run.to) - Math.max(a.run.from, b.run.from);
        if (along <= 8) continue;

        // Move the thinner one: it is the one being hidden.
        const thinner = a.run.width <= b.run.width ? a : b;
        found.push({ key: thinner.key, link: thinner.link, width: thinner.run.width });
      }
    }
    found.sort((x, y) => x.width - y.width);
    return found.map(({ key, link }) => ({ key, link }));
  }

  /**
   * Offsets along a node's edge for `count` links.
   *
   * Lanes are offered at a quarter of the grid pitch and kept only where the
   * node has enough outline to attach to — on a round node the lanes near the
   * ends would sit on a sliver, or outside the circle entirely. Links then take
   * every `stride`-th lane rather than adjacent ones, so that two thick links
   * clear each other instead of merging into one band.
   */
  private lanesFor(
    extent: number,
    count: number,
    outline: (offset: number) => number,
    minPitch: number,
  ): number[] {
    const step = this.lane / 4;
    const fullest = outline(0) || 1;

    /** The quarter-lane positions whose dock still sits this far out. */
    const slots = (reach: number) => {
      const out: number[] = [];
      for (let v = 0; v <= extent + 0.5; v += step) {
        const lane = Math.min(v, extent);
        if (outline(lane - extent / 2) >= fullest * reach) out.push(lane);
      }
      return out;
    };

    // A lane is only usable where the outline still reaches most of the way
    // out. On a round node the outline falls away towards the ends of an
    // edge, so a lane out there docks high up the side: two links leaving the
    // bottom would appear to leave from the flanks, at different heights,
    // rather than from the bottom.
    //
    // A crowded edge has to give somewhere, though, and it must not be the
    // spacing: lanes closer than their links are wide draw two lines on top
    // of each other, which is a failure, where a dock a little further round
    // is a blemish. So the band is widened until it can hold the links at
    // their proper pitch, and only a band that still cannot takes the
    // narrower stride below.
    const wanted = (count - 1) * Math.max(1, Math.ceil(minPitch / step)) + 1;
    let available: number[] = [];
    for (const reach of OUTLINE_REACH) {
      const widened = slots(reach);
      if (!widened.length) continue;
      available = widened;
      if (widened.length >= wanted) break;
    }

    if (!available.length) {
      return Array.from({ length: count }, (_, i) => (extent * (i + 1)) / (count + 1));
    }
    if (count === 1) return [available[Math.floor(available.length / 2)]];

    let stride = Math.max(1, Math.ceil(minPitch / step));
    while ((count - 1) * stride + 1 > available.length && stride > 1) stride--;

    const span = (count - 1) * stride + 1;
    const slack = Math.max(0, available.length - span);
    // Centre the block of lanes on the edge.
    const first = Math.floor(slack / 2);
    const lanes = Array.from({ length: count }, (_, i) => available[first + i * stride]);

    // More links than the edge can hold even one lane apart: spread them over
    // the usable span instead.
    if (lanes.some((lane) => lane === undefined)) {
      const low = available[0];
      const high = available[available.length - 1];
      return Array.from({ length: count }, (_, i) => low + ((high - low) * i) / (count - 1));
    }
    return lanes;
  }

  /** Where a link end attaches, and which way it leaves the node. */
  private endpointSpec(link: dia.Link, which: 'source' | 'target'): Attachment | null {
    const attachment = this.attachments.get(`${link.id}|${which}`);
    if (attachment) return attachment;

    const end = which === 'source' ? link.source() : link.target();
    if (end.id === undefined) {
      const point = end as { x?: number; y?: number };
      return point.x === undefined
        ? null
        : {
            x: point.x,
            y: point.y ?? 0,
            outward: { x: 0, y: 0 },
            docked: false,
            laneIndex: 0,
            approach: 0,
          };
    }

    const element = this.graph.getCell(end.id) as dia.Element | undefined;
    if (!element?.isElement()) return null;

    const bbox = element.getBBox();
    return {
      x: bbox.x + bbox.width / 2,
      y: bbox.y + bbox.height / 2,
      outward: { x: 0, y: 0 },
      docked: false,
      laneIndex: 0,
      approach: 0,
    };
  }

  /**
   * A point sitting exactly on a node's edge counts as being inside it, and
   * libavoid then routes from the node's *centre* instead — which is only
   * invisible while the route leaves sideways. Pushing the endpoint clear of
   * the node's buffer keeps the route anchored where the port actually is.
   */
  private connEnd(link: dia.Link, which: 'source' | 'target'): unknown | null {
    const spec = this.endpointSpec(link, which);
    if (!spec) return null;
    const Avoid: Avoid = this.avoid;
    // Clear of the node's bounding box by one lane, so the first bend lands on
    // a grid line even though the attachment itself is on the round outline.
    const element = this.graph.getCell(
      (which === 'source' ? link.source() : link.target()).id!,
    ) as dia.Element | undefined;
    const bbox = element?.isElement() ? element.getBBox() : null;
    if (!bbox || !spec.docked) return new Avoid.ConnEnd(new Avoid.Point(spec.x, spec.y));

    // Clear of the node's bounding box, then out by this link's own corridor
    // so it does not share one with its neighbours. Whole lanes, so the bend
    // still lands on the grid.
    //
    // Two lanes minimum: the arrowhead and its gap eat into the final stub,
    // and a stub shorter than the head leaves the arrow pointing along the
    // segment before it instead of into the node.
    const clear = this.lane * (2 + spec.approach);
    const middle = { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
    const x = spec.outward.x
      ? middle.x + spec.outward.x * (bbox.width / 2 + clear)
      : spec.x;
    const y = spec.outward.y
      ? middle.y + spec.outward.y * (bbox.height / 2 + clear)
      : spec.y;
    return new Avoid.ConnEnd(new Avoid.Point(x, y));
  }

  private addConnector(link: dia.Link): void {
    const Avoid: Avoid = this.avoid;
    if (this.connectors.has(link.id)) this.removeCell(link);

    const source = this.connEnd(link, 'source');
    const target = this.connEnd(link, 'target');
    if (!source || !target) return;

    const connector = new Avoid.ConnRef(this.router, source, target);
    // Be explicit rather than relying on the router's default connector type.
    connector.setRoutingType(Avoid.ConnType.ConnType_Orthogonal.value);
    this.connectors.set(link.id, connector);
    this.pending = true;
  }

  /** Endpoints follow their elements, so they are re-read before each pass. */
  private refreshEndpoints(): void {
    this.computeAttachments();

    for (const [id, connector] of this.connectors) {
      const link = this.graph.getCell(id) as dia.Link | undefined;
      if (!link) continue;

      const source = this.connEnd(link, 'source');
      const target = this.connEnd(link, 'target');
      if (!source || !target) continue;
      connector.setSourceEndpoint(source);
      connector.setDestEndpoint(target);
    }

    this.syncPorts();
  }

  /**
   * Writes the computed attachments onto the nodes as ports.
   *
   * The lane a link docks at is a property of the graph, not a drawing detail,
   * so it lives in the model: each end gets a port at its lane and the link
   * points at it. JointJS then derives the anchor itself, and the port travels
   * with the node and survives serialisation. The ports have no markup, so
   * none of this shows.
   */
  private syncPorts(): void {
    const options = { avoidRouter: true } as dia.Cell.Options;
    const wanted = new Map<dia.Cell.ID, Map<string, dia.Point>>();

    for (const link of this.graph.getLinks()) {
      for (const which of ['source', 'target'] as const) {
        const attachment = this.attachments.get(`${link.id}|${which}`);
        const end = which === 'source' ? link.source() : link.target();
        if (!attachment?.docked || end.id === undefined) continue;

        const element = this.graph.getCell(end.id) as dia.Element | undefined;
        if (!element?.isElement()) continue;
        const origin = element.position();

        const ports = wanted.get(end.id) ?? new Map<string, dia.Point>();
        ports.set(`${link.id}-${which}`, {
          x: attachment.x - origin.x,
          y: attachment.y - origin.y,
        });
        wanted.set(end.id, ports);
      }
    }

    for (const [id, ports] of wanted) {
      const element = this.graph.getCell(id) as dia.Element;
      for (const [portId, at] of ports) {
        const args = { x: Math.round(at.x), y: Math.round(at.y) };
        if (element.hasPort(portId)) {
          element.portProp(portId, 'args', args, options);
        } else {
          element.addPort({ id: portId, group: 'dock', args }, options);
        }
      }
    }

    for (const link of this.graph.getLinks()) {
      for (const which of ['source', 'target'] as const) {
        const attachment = this.attachments.get(`${link.id}|${which}`);
        const end = which === 'source' ? link.source() : link.target();
        if (!attachment?.docked || end.id === undefined) continue;
        const port = `${link.id}-${which}`;
        if (end.port === port) continue;
        link.prop(which, { id: end.id, port }, options);
      }
    }
  }

  /** @deprecated superseded by {@link syncPorts}; kept out of the flow. */
  private anchorToUnused(link: dia.Link, which: 'source' | 'target'): void {
    const attachment = this.attachments.get(`${link.id}|${which}`);
    if (!attachment) return;

    const id = (which === 'source' ? link.source() : link.target()).id;
    const element = id === undefined ? undefined : (this.graph.getCell(id) as dia.Element);
    if (!element?.isElement()) return;

    const bbox = element.getBBox();
    link.prop(
      `${which}/anchor`,
      {
        name: 'modelCenter',
        args: {
          dx: Math.round(attachment.x - (bbox.x + bbox.width / 2)),
          dy: Math.round(attachment.y - (bbox.y + bbox.height / 2)),
        },
      },
      { avoidRouter: true } as dia.Cell.Options,
    );
  }

  // --- routing -------------------------------------------------------------

  private process(rerouting = false): void {
    if (this.destroyed || !this.connectors.size) return;
    this.passCount++;

    // A corridor override repairs one layout. Carried into the next it forces
    // a link into a corridor chosen for geometry that has since moved, and
    // because the repair pass can only add overrides, never drop them, they
    // pile up: every drag left the diagram a little worse than it found it,
    // including in corners nothing had been dragged near. They belong to the
    // pass that made them, so a fresh pass starts without them — but a repair
    // of the pass in progress keeps what that pass just decided.
    if (!rerouting) this.corridorOverrides.clear();

    this.refreshEndpoints();
    // Routing every link through libavoid and then discarding the result is
    // most of the cost of a pass, so `custom` does not ask.
    if (this.strategy !== 'custom') this.router.processTransaction();
    this.pending = false;

    this.channels = [];
    this.runs = [];
    this.centred = [];
    for (const [id, connector] of this.connectors) {
      const link = this.graph.getCell(id) as dia.Link | undefined;
      if (link) this.applyRoute(link, connector);
    }

    // The fallback routes are drawn where libavoid put them first, then their
    // long runs are moved into gutters together, so that the runs with the
    // least room to move get the pick.
    this.placeRuns();
    for (const { link, vertices, options } of this.centred) {
      link.set('vertices', [...vertices], options);
    }

    // Repair against what was actually drawn, not against the idealised
    // elbows. A link that libavoid had to route around an obstacle ends up
    // nothing like its elbow, and those are exactly the ones that end up
    // sharing a corridor — so one more pass with the real geometry.
    if (!rerouting && this.repairRendered()) {
      this.process(true);
      return;
    }

    this.sizeJumps();
  }

  /**
   * A right-angled way around when no router can find one: out to the side,
   * across at the midpoint between the two ends, then in to the target.
   */
  private static detour(from: dia.Point, to: dia.Point, gap = 40): dia.Point[] {
    const middle = Math.round((from.y + to.y) / 2);
    return [
      { x: from.x + gap, y: from.y },
      { x: from.x + gap, y: middle },
      { x: to.x - gap, y: middle },
      { x: to.x - gap, y: to.y },
    ];
  }

  /**
   * Replaces a diagonal first or last segment with a right-angled pair.
   *
   * libavoid nudges the segment next to an endpoint into its own lane, but the
   * endpoint itself is a fixed point, so it joins the two with a diagonal. The
   * corner goes in on the docking axis: a link leaving sideways runs straight
   * out of the node first, then turns.
   */
  private static squareOff(
    points: dia.Point[],
    source: Attachment | null,
    target: Attachment | null,
  ): dia.Point[] {
    const slanted = (a: dia.Point, b: dia.Point) =>
      Math.abs(a.x - b.x) > 0.5 && Math.abs(a.y - b.y) > 0.5;
    const corner = (from: dia.Point, to: dia.Point, horizontal: boolean) =>
      horizontal ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
    const out = [...points];

    if (source?.docked && out.length >= 2 && slanted(out[0], out[1])) {
      out.splice(1, 0, corner(out[0], out[1], source.outward.x !== 0));
    }
    const last = out.length - 1;
    if (target?.docked && out.length >= 2 && slanted(out[last], out[last - 1])) {
      out.splice(last, 0, corner(out[last], out[last - 1], target.outward.x !== 0));
    }
    return out;
  }

  /**
   * The single-bend route between two docked ends, or null when one bend
   * cannot reach: the ends must be on perpendicular axes, or already in line.
   */
  private elbow(source: Attachment, target: Attachment): dia.Point[] | null {
    const sourceHorizontal = source.outward.x !== 0;
    const targetHorizontal = target.outward.x !== 0;

    if (sourceHorizontal === targetHorizontal) {
      // Head-on: a straight line, no bend at all — but only if they line up.
      const aligned = sourceHorizontal
        ? Math.abs(source.y - target.y) < 1
        : Math.abs(source.x - target.x) < 1;
      return aligned ? [] : null;
    }

    return [
      sourceHorizontal
        ? { x: target.x, y: source.y }
        : { x: source.x, y: target.y },
    ];
  }

  /**
   * The clear bands between the rows or columns of nodes, as positions on the
   * `across` axis: x values between the columns, or y values between the rows.
   *
   * A route that has to turn should turn in a gap, not alongside a node, so
   * the candidates are the middles of the gaps between the occupied bands —
   * ordered by how close they are to `preferFrom`, since a turn taken early
   * is easier to follow than one taken halfway across the diagram.
   */
  private gutters(across: Axis, preferFrom: number): number[] {
    const bands = this.graph
      .getElements()
      .filter((element) => !element.getEmbeddedCells().length)
      .map((element) => {
        const box = element.getBBox();
        return across === 'x'
          ? { from: box.x, to: box.x + box.width }
          : { from: box.y, to: box.y + box.height };
      })
      .sort((a, b) => a.from - b.from);

    const merged: { from: number; to: number }[] = [];
    for (const band of bands) {
      const last = merged[merged.length - 1];
      if (last && band.from <= last.to) last.to = Math.max(last.to, band.to);
      else merged.push({ ...band });
    }

    const middles: number[] = [];
    for (let i = 1; i < merged.length; i++) {
      const gap = merged[i].from - merged[i - 1].to;
      // The gap is measured between the nodes themselves, so the room a route
      // needs is counted once here rather than twice: the middle of the gap
      // has to clear the buffer on both sides, and be at least a lane wide so
      // the run lands somewhere the grid can hold it.
      if (gap < Math.max(this.lane, 2 * this.buffer)) continue;
      middles.push(Math.round((merged[i - 1].to + merged[i].from) / 2));
    }
    return middles.sort((a, b) => Math.abs(a - preferFrom) - Math.abs(b - preferFrom));
  }

  /**
   * Records the straight runs of a fallback route that could be moved into a
   * gutter, to be placed once every route is known.
   *
   * libavoid keeps its distance from a node and then runs flat along that
   * distance, so a route squeezing past a node sits hard against the buffer
   * rather than in the gap. Two routes passing either side of the same node
   * then read as a pair clinging to it instead of as two corridors using the
   * space between the columns. Moving a run onto a gutter costs nothing — the
   * bends stay where they are, only their shared coordinate changes — and it
   * puts the run on the grid with the same room on both sides.
   *
   * Only an interior run may move: one that ends on a dock would drag the
   * link off its port. Only a long one is worth moving, since a short jog
   * would only stretch its neighbours.
   */
  private collectRuns(
    points: dia.Point[],
    source: Attachment | null,
    target: Attachment | null,
    ends: (dia.Cell.ID | undefined)[],
    width: number,
  ): void {
    const path = [
      ...(source?.docked ? [{ x: source.x, y: source.y }] : []),
      ...points,
      ...(target?.docked ? [{ x: target.x, y: target.y }] : []),
    ];
    const offset = source?.docked ? 1 : 0;

    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (i + offset === 0 || i + 1 + offset === path.length - 1) continue;

      const vertical = Math.abs(a.x - b.x) < 1;
      const flat = Math.abs(a.y - b.y) < 1;
      if (vertical === flat) continue; // a point, or a diagonal: not a run

      const across: Axis = vertical ? 'x' : 'y';
      const along: Axis = vertical ? 'y' : 'x';
      const from = Math.min(a[along], b[along]);
      const to = Math.max(a[along], b[along]);
      if (to - from < MIN_CORRIDOR * this.lane) continue;

      const was = a[across];
      // Which gutters this run could reach at all, ignoring for now whether
      // another run has taken them: that is what decides who chooses first.
      const choices: number[] = [];
      for (const at of this.gutters(across, was)) {
        // Centring is a nudge, not a reroute: a run that cannot find room
        // nearby stays where the fallback router put it rather than taking a
        // long way round to reach a free gutter.
        if (Math.abs(at - was) > MAX_RECENTRE * this.lane) break;
        a[across] = at;
        b[across] = at;
        if (this.isClear(path, ends)) choices.push(at);
        a[across] = was;
        b[across] = was;
      }
      if (!choices.length) continue;

      this.runs.push({ a, b, path, ends, across, from, to, was, width, choices });
    }
  }

  /**
   * Puts every collected run in a gutter, the most hemmed-in run first.
   *
   * Gutters are claimed as runs are placed, so whoever is placed first gets
   * the pick. In the order the links happen to be created that is nobody in
   * particular, and a run with somewhere else to go can take the only gutter
   * that another run could have used. Taking the most hemmed-in run first
   * puts that right: a run with one place left takes it, and the runs with
   * alternatives fit around what is left.
   */
  private placeRuns(): void {
    const taken = (run: (typeof this.runs)[number], at: number) =>
      this.channels.some(
        (used) =>
          used.axis === run.across &&
          Math.abs(used.at - at) < (used.width + run.width) / 2 + this.clearance &&
          Math.min(used.to, run.to) - Math.max(used.from, run.from) > 8,
      );

    const pending = [...this.runs];
    while (pending.length) {
      // Whichever run has the fewest places left open to it goes next. Asked
      // afresh each time rather than once at the start, because every
      // placement closes a gutter for somebody: a run with two choices and a
      // run with three are not equally stuck once they lose one each.
      let index = 0;
      let free: number[] = [];
      for (let i = 0; i < pending.length; i++) {
        const open = pending[i].choices.filter((at) => !taken(pending[i], at));
        if (i === 0 || open.length < free.length) {
          index = i;
          free = open;
        }
      }

      const [run] = pending.splice(index, 1);
      const { a, b, across } = run;
      for (const at of free) {
        a[across] = at;
        b[across] = at;
        if (this.isClear(run.path, run.ends)) {
          this.channels.push({
            axis: across,
            at,
            from: run.from,
            to: run.to,
            width: run.width,
          });
          break;
        }
        a[across] = run.was;
        b[across] = run.was;
      }
    }
  }

  /**
   * Whether a dog-leg across `across` could join these two points at all.
   *
   * Asked while the docks are still being chosen, so it works from the node
   * centres rather than from lanes that do not exist yet: it is a question
   * about the gaps between the nodes, and the lane a link ends up on moves it
   * by less than a gutter is wide.
   */
  private canDogLeg(
    across: Axis,
    from: dia.Point,
    to: dia.Point,
    ends: (dia.Cell.ID | undefined)[],
    outward?: dia.Point,
  ): boolean {
    // Which way the link leaves decides which gutters are even on the way.
    // Normally that is simply where the target lies, but two nodes in the
    // same column give no answer at all — there the dock being considered is
    // the one that knows, so it is asked.
    const heading = outward?.[across] || Math.sign(to[across] - from[across]);

    return this.gutters(across, from[across]).some((at) => {
      if (heading !== 0 && (at - from[across]) * heading <= 0) return false;
      const bends =
        across === 'x'
          ? [{ x: at, y: from.y }, { x: at, y: to.y }]
          : [{ x: from.x, y: at }, { x: to.x, y: at }];
      return this.isClear([from, ...bends, to], ends);
    });
  }

  /**
   * A two-bend route that runs out of the source, along a free gutter, and
   * into the target. Returns the bends, or null when no gutter works.
   *
   * Both ends have to be docked on the same axis for this shape to exist: two
   * sideways docks turn in a vertical gutter between columns, two upright
   * docks in a horizontal gutter between rows. The second case is what the
   * waste lines need — they drop several rows and have to cross the rows in
   * between, so the jog belongs in the gap between two rows.
   */
  private dogLeg(
    source: Attachment,
    target: Attachment,
    ends: (dia.Cell.ID | undefined)[],
    width: number,
  ): dia.Point[] | null {
    const sideways = source.outward.x !== 0 && target.outward.x !== 0;
    const upright = source.outward.y !== 0 && target.outward.y !== 0;
    if (!sideways && !upright) return null;

    // The gutter runs across the link's travel: a sideways pair turns in a
    // vertical gutter, an upright pair in a horizontal one.
    const across: Axis = sideways ? 'x' : 'y';
    const along: Axis = sideways ? 'y' : 'x';

    const from = Math.min(source[along], target[along]);
    const to = Math.max(source[along], target[along]);
    const heading = source.outward[across];

    const bends: dia.Point[] = sideways
      ? [
          { x: 0, y: source.y },
          { x: 0, y: target.y },
        ]
      : [
          { x: source.x, y: 0 },
          { x: target.x, y: 0 },
        ];
    const [a, b] = bends;
    const path = [source, a, b, target];

    // Every place this link could turn, best first — but not which one it
    // gets. That is settled once every route is known, so a link with a
    // choice does not take the only gutter another link could have used.
    const choices: number[] = [];
    for (const centre of this.gutters(across, source[across])) {
      // The gutter has to be on the way, not behind either end.
      if ((centre - source[across]) * heading <= 0) continue;

      // Several links can share a wide gutter, so the lanes either side of
      // its middle count as places of their own.
      for (const offset of CHANNEL_OFFSETS) {
        const at = centre + offset * this.lane;
        a[across] = at;
        b[across] = at;
        if (this.isClear(path, ends)) choices.push(at);
      }
    }
    if (!choices.length) return null;

    a[across] = choices[0];
    b[across] = choices[0];
    this.runs.push({ a, b, path, ends, across, from, to, was: choices[0], width, choices });
    return bends;
  }

  /** True when no node other than the route's own two sits on it. */
  private isClear(points: dia.Point[], endIds: (dia.Cell.ID | undefined)[]): boolean {
    const ends = new Set(endIds);
    const boxes = this.graph
      .getElements()
      .filter((element) => !ends.has(element.id) && !element.getEmbeddedCells().length)
      .map((element) => element.getBBox());

    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const left = Math.min(a.x, b.x);
      const right = Math.max(a.x, b.x);
      const top = Math.min(a.y, b.y);
      const bottom = Math.max(a.y, b.y);

      for (const box of boxes) {
        // The obstacle buffer is included so a route does not grind along an
        // edge it technically misses.
        const pad = this.buffer;
        if (
          right > box.x - pad &&
          left < box.x + box.width + pad &&
          bottom > box.y - pad &&
          top < box.y + box.height + pad
        ) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Sizes each link's crossing hop to the line it has to hop over.
   *
   * `jumpover` takes one size per link, and sizing it from the link's own
   * width leaves a thin line hopping a wide band with an arc that disappears
   * inside it. What the arc has to clear is the *other* line, so each link is
   * measured against the widest link it actually crosses.
   */
  private sizeJumps(): void {
    const links = this.graph.getLinks();
    const routes = new Map<dia.Cell.ID, { points: dia.Point[]; width: number }>();

    for (const link of links) {
      const source = this.attachments.get(`${link.id}|source`);
      const target = this.attachments.get(`${link.id}|target`);
      if (!source || !target) continue;
      const vertices = (link.vertices() ?? []) as dia.Point[];
      const width = link.attr('line/strokeWidth');
      routes.set(link.id, {
        points: [source, ...vertices, target],
        width: typeof width === 'number' && width > 0 ? width : 2,
      });
    }

    const widest = new Map<dia.Cell.ID, number>();
    const entries = [...routes.entries()];

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [idA, a] = entries[i];
        const [idB, b] = entries[j];
        if (!AvoidRouter.routesCross(a.points, b.points)) continue;
        widest.set(idA, Math.max(widest.get(idA) ?? 0, b.width));
        widest.set(idB, Math.max(widest.get(idB) ?? 0, a.width));
      }
    }

    // Order the links by how long they are.
    //
    // `jumpover` only ever bridges links that come earlier in the graph's link
    // order, and that order follows `z`. Giving the longer route the higher
    // `z` puts the bridge on it and leaves the shorter link running straight,
    // which is easier to follow — a short hop interrupted by an arc reads as
    // two separate edges.
    for (const [id, route] of routes) {
      const link = this.graph.getCell(id) as dia.Link;
      let length = 0;
      for (let i = 1; i < route.points.length; i++) {
        const a = route.points[i - 1];
        const b = route.points[i];
        length += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      }
      link.set('z', Math.round(length / 10), { avoidRouter: true } as dia.Cell.Options);
    }

    for (const [id, route] of routes) {
      const crossed = widest.get(id) ?? 0;
      // Half of each line, plus a margin, so the hop clears both strokes —
      // but capped. Two wide bands crossing would otherwise want a bridge
      // bigger than the lines themselves, which stops reading as a bridge and
      // starts reading as a detour.
      const size = crossed > 0 ? Math.min(34, Math.round((crossed + route.width) / 2 + 8)) : 8;
      const link = this.graph.getCell(id) as dia.Link;
      link.set(
        'connector',
        { name: 'jumpover', args: { size, jump: 'arc', radius: 8 } },
        { avoidRouter: true } as dia.Cell.Options,
      );
    }
  }

  /** True when a horizontal run of one route meets a vertical run of the other. */
  private static routesCross(a: dia.Point[], b: dia.Point[]): boolean {
    const runs = (points: dia.Point[]) => {
      const out: { x1: number; y1: number; x2: number; y2: number; vertical: boolean }[] = [];
      for (let i = 1; i < points.length; i++) {
        const p = points[i - 1];
        const q = points[i];
        out.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, vertical: Math.abs(q.x - p.x) < 1 });
      }
      return out;
    };

    for (const s of runs(a)) {
      for (const t of runs(b)) {
        if (s.vertical === t.vertical) continue;
        const v = s.vertical ? s : t;
        const h = s.vertical ? t : s;
        const withinV = Math.min(v.y1, v.y2) < h.y1 && h.y1 < Math.max(v.y1, v.y2);
        const withinH = Math.min(h.x1, h.x2) < v.x1 && v.x1 < Math.max(h.x1, h.x2);
        if (withinV && withinH) return true;
      }
    }
    return false;
  }

  private applyRoute(link: dia.Link, connector: AvoidConn): void {
    const route = connector.displayRoute();
    const points: dia.Point[] = [];
    for (let i = 0; i < route.size(); i++) {
      const point = route.at(i);
      points.push({ x: Math.round(point.x), y: Math.round(point.y) });
    }
    if (points.length < 2) return;
    const options = { avoidRouter: true } as dia.Cell.Options;

    // The offset endpoints are real bends and must stay in the path; a centre
    // endpoint is inside its node, so that one is dropped and JointJS trims
    // the segment at the boundary instead.
    const source = this.endpointSpec(link, 'source');
    const target = this.endpointSpec(link, 'target');
    // Prefer a single bend. libavoid's route is the fallback for the links
    // where one bend would cut through a node.
    if (this.strategy !== 'avoid' && source?.docked && target?.docked) {
      const ends = [link.source().id, link.target().id];

      const bend = this.elbow(source, target);
      if (bend && this.isClear([source, ...bend, target], ends)) {
        link.set('router', { name: 'normal' }, options);
        link.set('vertices', bend, options);
        return;
      }

      // One bend cannot get through: turn down a gutter instead. Still only
      // two bends, and both in gaps between columns.
      const raw = link.attr('line/strokeWidth');
      const detour = this.dogLeg(
        source,
        target,
        ends,
        typeof raw === 'number' && raw > 0 ? raw : 2,
      );
      if (detour) {
        link.set('router', { name: 'normal' }, options);
        link.set('vertices', detour, options);
        this.centred.push({ link, vertices: detour, options });
        return;
      }
    }

    if (this.strategy === 'custom') {
      // Nothing reached, and no fallback router to ask. An explicit detour is
      // drawn rather than a diagonal, so what the cascade cannot do is
      // visible as a shape instead of as a line through a node.
      if (source && target) {
        link.set('router', { name: 'normal' }, options);
        link.set('vertices', AvoidRouter.detour(source, target), options);
      }
      return;
    }

    const stroke = link.attr('line/strokeWidth');
    let vertices = AvoidRouter.squareOff(points, source, target).map((point) => ({ ...point }));
    this.collectRuns(
      vertices,
      source,
      target,
      [link.source().id, link.target().id],
      typeof stroke === 'number' && stroke > 0 ? stroke : 2,
    );
    if (!source?.docked) vertices = vertices.slice(1);
    if (!target?.docked) vertices = vertices.slice(0, -1);

    // libavoid occasionally gives up and returns the two endpoints unchanged —
    // seen on a U-turn between nodes in the same column, where the ports face
    // away from each other. The built-in router gives up on those too, so draw
    // an explicit detour rather than let the link render as a diagonal.
    if (!vertices.length && source && target && source.y !== target.y && source.x !== target.x) {
      link.set('router', { name: 'normal' }, options);
      link.set('vertices', AvoidRouter.detour(source, target), options);
      return;
    }

    // `normal` draws straight segments between the vertices, which is exactly
    // the polyline libavoid computed. `avoidRouter: true` keeps the resulting
    // change event from re-entering the router.
    link.set('router', { name: 'normal' }, options);
    link.set('vertices', vertices, options);
    // The runs in these vertices may still move when every route is known, so
    // the link is noted for a second, final set.
    this.centred.push({ link, vertices, options });
  }
}

type Side = 'left' | 'right' | 'top' | 'bottom';

/** Which sides dock along the node's vertical edges. */
const HORIZONTAL: Record<Side, boolean> = {
  left: true,
  right: true,
  top: false,
  bottom: false,
};

const OPPOSITE: Record<Side, Side> = {
  left: 'right',
  right: 'left',
  top: 'bottom',
  bottom: 'top',
};

/** Unit vector pointing out of the node, per side. */
const OUTWARD: Record<Side, { x: number; y: number }> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

/** The entry of `values` nearest `target`. */
function closestTo(values: number[], target: number): number | undefined {
  return values.reduce<number | undefined>(
    (best, value) =>
      best === undefined || Math.abs(value - target) < Math.abs(best - target) ? value : best,
    undefined,
  );
}

/**
 * The shortest leg worth drawing. A bend with a leg below this reads as a
 * kink, so such a route is straightened instead.
 */
const MIN_BEND = 120;

/**
 * How much further a link must fall than it travels before its detour is
 * treated as a drop and docked top-to-bottom. Below this it is a traverse,
 * and turning it upright only sends it out across the row it is leaving.
 */
const DROP_RATIO = 2;

/** Which coordinate a measurement is taken on. */
type Axis = 'x' | 'y';

/**
 * How far a run may be moved, in lanes, to find a gutter. One node pitch:
 * enough to step into the gutter on the other side of the column it is
 * passing, not enough to cross the diagram looking for room.
 */
const MAX_RECENTRE = 8;

/**
 * How long a straight run has to be, in lanes, before it counts as a corridor
 * worth centring in a gutter. Shorter than this it is a jog between two
 * bends, and moving it would only stretch its neighbours.
 */
const MIN_CORRIDOR = 2;

/**
 * How far out a node's outline must still reach for a lane to dock there, as
 * a fraction of its fullest. Tried in order: the first band wide enough to
 * hold the edge's links at their proper spacing wins, so a quiet edge keeps
 * its docks near the middle and only a crowded one spreads round the flanks.
 */
const OUTLINE_REACH = [0.78, 0.72, 0.66, 0.6];

/** Lane offsets tried inside a gutter, middle first. */
const CHANNEL_OFFSETS = [0, 1, -1, 2, -2];

/** How many times the repair pass may move a link before giving up. */
const REPAIR_PASSES = 6;

interface LaneChoice {
  lanes: number[];
  box: { x: number; y: number; width: number; height: number };
  side: Side;
  outline: (offset: number) => number;
}

interface Run {
  vertical: boolean;
  /** x for a vertical run, y for a horizontal one. */
  at: number;
  from: number;
  to: number;
  width: number;
}

/** How many distinct approach corridors links may turn into. */
const APPROACH_CORRIDORS = 3;

interface Attachment {
  x: number;
  y: number;
  /** Unit vector pointing out of the node; zero when not docked. */
  outward: { x: number; y: number };
  /** False for a bare point or an element with no computed lane. */
  docked: boolean;
  /** Which lane along the edge this link took. */
  laneIndex: number;
  /** How many lanes out from the node this link turns. */
  approach: number;
}
