# JointJS playground (Angular 22)

A sandbox for evaluating [JointJS](https://docs.jointjs.com/) as a replacement for
Cytoscape. Angular 22 standalone + zoneless, `@joint/core` 4.3.3 (MPL-2.0, the free
open-source package — no commercial plugins).

```bash
npm start      # http://localhost:4200
npm run build
npm test
```

## Node types

An element names the class it wants, and that class carries its own appearance:

```json
{ "group": "nodes", "type": "FieldNode", "data": { "id": "brook-pasture-1", "herd": 120 } }
```

| Type | Used for |
| --- | --- |
| `FieldNode` | grazing fields |
| `FarmNode` | stables and milking parlours |
| `TransportNode` | truck routes, rail terminals, the train |
| `FacilityNode` | processing steps inside a production line |
| `StorageNode` | cold stores, maturing cellar, warehouse, labeling |
| `RetailNode` | shops, depots, the online store |
| `CustomerNode` | whoever drinks or eats it |
| `ByproductNode` | whey, buttermilk, the piggery |
| `GroupNode` | a compound node holding others |
| `TaskNode` | the fallback when no type is named |

Each lives in its own file under [nodes/](src/app/joint/nodes/) and extends
[`BaseNode`](src/app/joint/nodes/base-node.ts). A subclass declares three things and
nothing else:

```ts
export class FieldNode extends BaseNode {
  protected typeName() { return 'FieldNode'; }
  protected palette(): NodePalette { return { fill: '#ecfdf5', stroke: '#10b981' }; }
  protected icon(): string { return `<path d="…" />`; }   // 24×24 SVG
}
```

`BaseNode.html()` assembles those into the node's rendering and returns it as SVG — a
ring, a short code, the full name, the icon, and an actual/plan readout:

```html
<circle @selector="ring" />                     <!-- links attach here -->
<circle @selector="body" />
<text   @selector="code" />                     <!-- PAS -->
<text   @selector="label" />                    <!-- PASTEURISE -->
<svg    @selector="icon" viewBox="0 0 24 24" …>…</svg>
<line   @selector="divider" />
<text   @selector="actual" />  <line @selector="separator" />
<rect   @selector="planBox" /> <text @selector="plan" />
<text   @selector="actualCaption" /> <text @selector="unit" /> <text @selector="planCaption" />
```

`applyData()` fills the readout from the element's `data`: `code` (derived from the name
as its first three letters unless the data gives one), `actual`, `plan` and `unit`. In the
demo those are tonnes per day, computed by the generator from the flows in and out of
each node.

Links attach to the **ring**, not to the bounding box. `attachOffsetX(dy)` returns the
half-width of the outline that far from the node's middle — the circle's chord — and the
router puts each attachment there. `GroupNode` overrides it to return half its width,
since it is still a rectangle.

The `@selector` names are what `attrs` — and so the stylesheets, the label rename and the
weight scale — target afterwards. The string is turned into JointJS markup by `util.svg`,
which is a tagged template but only iterates its strings array, so a one-element array
works for markup built at runtime. Raw string markup would *not* work: JointJS 4 only
populates `root` in its selector map for string markup, so `attrs` would reach nothing.

Add a file, add it to the `nodeTypes` map in
[nodes/index.ts](src/app/joint/nodes/index.ts), and elements can ask for it by name.
`'playground.FieldNode'` resolves too, and an unknown name falls back to `TaskNode`
rather than throwing.

Icons are hand-drawn 24×24 SVG paths stroked in the type's own colour — a cow's face for
a field, a barn for a farm, a truck for transport, a factory for a processing step, a
crate for storage, a shopfront for retail, a person for a customer, a droplet for a
by-product.

Because the type carries the colour, the stylesheet in `graph.json` is down to what a type
cannot know on its own: per-instance modifiers (`node[?shared]`, `node[?organic]`) and
edge styling.

**Nodes have no ports.** Links attach to the node boundary, and a link is drawn by
hovering a node and dragging the connect handle on its right edge onto another node.

## Grid coordinates

Nodes are addressed by whole-number cells, not pixels: `{ col: 0, row: 0 }` is the
top-left cell and `{ col: 5, row: 2 }` is six columns across, three rows down.

**A node is 300 × 300 — exactly one major grid square.** The grid is drawn by JointJS's
grid layer as a `doubleMesh`: a light mesh every 75px and a heavier line every 300, so
every node edge lands on a major line. The grid layer is transformed with the paper, so
the lines stay locked to the nodes while panning and zooming — an earlier version painted
the grid as a background image, which does not move with the content and made the grid
appear to slide underneath the diagram.

The cell pitch in the demo is 600 × 600, two major squares, so each node occupies one
square and leaves the next one free for routes to run through.

Half a cell of extra room is inserted wherever one stage of the chain ends and the next
begins (`SEGMENT_BREAKS` in the generator), so farms, transport, production, cooling,
channels and customers read as separate blocks. Half a cell is still a whole major grid
square, so the nodes stay on the grid.

```ts
graph.setConfig({ grid: { cellWidth: 220, cellHeight: 130 } });
graph.setNodePosition('store', { col: 5, row: 2 });
graph.toPixels({ col: 5, row: 2 }); // { x: 1100, y: 260 }
graph.toGrid({ x: 1140, y: 290 });  // { col: 5, row: 2 } — nearest cell
graph.gridPositions();              // { store: { col: 5, row: 2 }, … }
```

A node's position is the **top-left** of its cell. Dragging snaps to the nearest cell on
drop, so coordinates stay whole numbers. `{ x, y }` is still accepted anywhere a position
is taken, and passes through as raw pixels. The inspector shows the selected node's
column and row as editable number fields.

The visible grid is painted as a repeating background image rather than with JointJS's
`drawGrid`: the built-in mesh patterns derive both width and height from `gridSize`, so
they can only draw square cells.

## Demo data set

[public/graph.json](public/graph.json) is a dairy supply chain: 61 nodes and 66 edges
over fifteen grid columns, generated by
[tools/build-demo-data.mjs](tools/build-demo-data.mjs) (`npm run demo:data`) because
hand-editing JSON at that size gets error prone. Edit the generator, re-run it, then hit
**Reload JSON** in the app.

```
pastures → stable → parlour → truck → rail → siding → process steps → cooling → shared → channels → customers
   🐄         🏚️        🥛        🚛      🚂      🏗️        1→2→3→4         ❄️🧱        📦🏷️       🏪💻🏡       👨‍👩‍👧🎓
                                                                                              ↓
                                                                               🪣 whey / buttermilk → 🚛 → 🐖
```

- **Three farms, three companies** — Brook Dairy Co. (4 pastures), Windmill Organics Ltd.
  (3) and Alpenmilch eG (2). Each is a group holding its pastures, stable and milking
  parlour, with `data.owner` on every node.
- **Mixed transport** — Brook and Windmill truck to the Südbahnhof terminal, go by milk
  train, and arrive at the plant siding. Alpine is close enough to truck direct, and its
  raw milk also goes straight to the farm shop without entering the plant.
- **Four production lines**, each a group with numbered steps: bottling (pasteurise →
  homogenise → fill & cap), cheese (curdling → cut & drain → pressing → brine bath),
  yogurt (culture → incubate → cool & stir), butter (separation → churning → kneading).
- **Shared infrastructure** — a plant cold store and a third-party one (FrostLink AG),
  plus a shared warehouse and labeling line. `node[?shared]` dashes their borders.
- **By-products fall out of the bottom** — whey from the cheese line and buttermilk from
  the butter line drop to tanks two rows below everything else, then to a tanker and the
  piggery, drawn with dashed purple `edge[?waste]` lines.

`data.kind` drives colour per stage, `edge[mode = …]` the transport styling (thick blue
bulk, heavy slate rail, cyan chilled, dashed indigo parcel, purple counter), and
`[?seasonal]` dots the alpine summer route.

## Data file

Everything the diagram draws — nodes, edges and positions — lives in one file,
[public/graph.json](public/graph.json):

```jsonc
{
  "config": {
    "grid":      { "cellWidth": 260, "cellHeight": 120 },  // pixels per grid cell
    "positions": { "cheese-1": { "col": 7, "row": 2 } },   // where each node sits
    "edges":     { "bundle": true, "router": "avoid", "weight": { … } },
    "collapsed": []                                        // groups that start collapsed
  },
  "stylesheets": [ { "selector": "node[kind = pasture]", "style": { … } } ],
  "elements": [
    { "group": "nodes", "data": { "id": "cheese-1", "label": "1. Curdling vat",
                                  "kind": "production", "parent": "cheese-line" } },
    { "group": "edges", "data": { "id": "brook-pasture-1__brook-stable",
                                  "source": "brook-pasture-1", "target": "brook-stable",
                                  "mode": "herd", "litres": 2880 } }
  ]
}
```

Nodes and edges share one `elements` array, told apart by `group`. Positions are **not**
on the nodes: they live in `config.positions`, keyed by node id, as grid cells. Everything
else about a node or edge goes in its `data` bag, which is what the selectors, the
stylesheets and the weight scale read.

**The file is generated** by [tools/build-demo-data.mjs](tools/build-demo-data.mjs), so
edit the generator and run `npm run demo:data` — editing `graph.json` by hand works for a
quick experiment but the next generator run overwrites it.

The graph loads from [public/graph.json](public/graph.json) at startup — edit it and hit
**Reload JSON**, no code change needed. `Export` and `Save` write the same shape, so an
export drops straight back in:

```json
{
  "config": {
    "grid": { "cellWidth": 220, "cellHeight": 130 },
    "positions": { "ingest": { "col": 0, "row": 2 }, "store": { "col": 5, "row": 2 } },
    "edges": { "bundle": true },
    "collapsed": []
  },
  "elements": [
    { "group": "nodes", "data": { "id": "ingest", "label": "Fetch data" }, "classes": "terminal" },
    { "group": "nodes", "data": { "id": "transform", "label": "Transform", "parent": "pipeline" } },
    { "group": "edges", "data": { "id": "e1", "source": "ingest", "target": "transform" } }
  ]
}
```

`data.parent` creates the group implicitly, `classes` and `data` keys drive the stylesheet
selectors, and `config.collapsed` lists groups that should start collapsed.

## Link thickness

`config.edges.weight` scales each link's stroke width from a numeric field in its `data`:

```json
"edges": { "weight": { "field": "litres", "min": 1.5, "max": 11, "scale": "sqrt" } }
```

`scale` is `quantile` by default: the values are sorted and split into `steps` equally
sized groups, each drawn at one width. Use it whenever the values span orders of
magnitude. The demo's flows run from 48 L to 1.5M L, and on any continuous scale
(`linear`, `sqrt`, `log`) everything below the trunk lines lands within a few pixels of
each other — a 6,000 L flow comes out nearly as thick as a 30,000 L one. Five classes
instead give each group of links a width you can tell apart at a glance.

`linear`, `sqrt` and `log` map the value itself onto the range, and are the right answer
only when the values sit within an order or two of each other.

The scale is applied after the stylesheets, so it wins over any `strokeWidth` they set;
links with no value for the field keep the width they already had.

Add `label` to print the value on the link as well:

```json
"weight": { "field": "litres", "min": 1.5, "max": 11, "scale": "sqrt",
            "label": { "unit": " L", "compact": true } }
```

`compact` shortens 15000 to `15k`. The label is tagged internally and updated in place, so
re-running the styles never duplicates it, and a link's own text label (`whey`, `14 wks`)
survives alongside it. The **Values** button in the toolbar toggles the labels off when
they crowd the view — they are legible from about 70% zoom upward.

In the demo the field is litres per day, which runs from 4 (a student's weekly box) to
15,000 (the milk train), and every volume derives from `LITRES_PER_COW` in the generator.

Open work is tracked in [TODO.md](TODO.md), with what was measured about each.

## Routing acceptance criteria

`npm run check:routing` drives the running app in headless Chrome, reads the rendered
geometry out of the SVG and verifies each criterion against what is actually drawn —
not against what the router claims. Start the dev server first.

`npm run bench:routing` runs that harness repeatedly: once per routing strategy, at
each size asked for. It tiles the demo data to make a bigger graph, so the question
"does this still hold at three times the size, and what does each half of the router
cost" is one command rather than an afternoon.

```
npm run bench:routing                            # 1x, 2x, 3x by all three strategies
npm run bench:routing -- --scales=1,3
npm run bench:routing -- --strategies=combined,custom
```

It writes over `public/graph.json` while it runs and puts the original back afterwards,
including when a run fails part way.

```
  66 links, 61 nodes

  PASS  Orthogonal routing     only horizontal/vertical segments
  PASS  Collision avoidance    no segment crosses a foreign node
  PASS  Overlap avoidance      no two links share a collinear stretch
  PASS  Grid-aligned ends      attachments snap to the 75px grid
  PASS  Crossings marked       90 crossings drawn as jumps, 0 left unmarked
  PASS  Dynamic calculation    re-route + paint in 133ms after the drop (budget 300ms)
  PASS  Drag left alone        0 links other than the dragged node's redrawn while the pointer was down
```

| Criterion | How it is met |
| --- | --- |
| Arrows run only horizontally and vertically; direction changes are 90° bends; no diagonals | libavoid in `OrthogonalRouting` mode; the checker measures every straight segment and allows a curve only where it is a rounded corner or a crossing hop (≤30px) |
| Arrows must not run through nodes; obstacles are detected and routed around | every non-group node is a libavoid obstacle; routes keep `NODE_CLEARANCE` (60px) from any node they merely pass, which the checker measures as a distance rather than just an intersection |
| Two arrows must not lie on the same routing segment; competing paths take alternative routes | each link gets its own attachment lane on the node edge (see below), plus libavoid's nudging; the checker measures the gap between the *drawn edges* of every pair of parallel segments and requires 20px |
| Crossings are allowed but must be unambiguous | the `jumpover` connector hops one line over the other at every crossing |
| Routing causes no noticeable delay, and stays performant with many arrows | routing is held while a node is dragged and runs once when it is put down: a full pass costs far more than a frame, so routing during a drag cannot keep up. Dragging a node a second's worth took 2368ms and thirteen passes before, and 243ms and none after. The link being dragged is drawn straight from dock to dock meanwhile |

### Where a link bends

Tried in order, so the simplest route that works is the one drawn:

1. **Straight** — aligned nodes, centre to centre, no bend.
2. **One bend** — the two ends dock on perpendicular axes and the corner falls out of the
   geometry. There is no freedom here: the corner sits where the two docks put it.
3. **A dog-leg through a gutter** — when no single bend gets past a node, both ends dock
   on the same axis and the link turns in a clear band between two columns, or between
   two rows. Still two bends, but in a gap we choose rather than wherever a router
   happens to land. Gutters are tried nearest-the-source first, so a turn is taken early
   rather than halfway across the diagram, and several links sharing one gutter step
   apart by a lane each (`CHANNEL_OFFSETS`) instead of stacking.

   Which pair of docks the link gets is decided by asking whether that dog-leg can be
   drawn at all (`canDogLeg`), before the docks are fixed. A link that falls much
   further than it travels — the whey and buttermilk lines dropping out of the
   production rows — is a drop and is offered the top-to-bottom pair first; anything
   else is a traverse and is offered the sideways pair first. Committing to docks for a
   detour that then turns out to be undrawable is the worst of both, because the
   fallback router then works against the docks instead of with them.
4. **libavoid** — the fallback when even that fails.

`config.edges.strategy` picks which halves are in play, and `?routing=avoid`
or `?routing=custom` overrides it for a single load so the three can be
compared on the same data. On the dairy graph the cascade resolves every one
of the 66 links — 31 straight, 20 with one bend, 15 dog-legs — and libavoid's
output is read for none of them.

| | combined | custom (no libavoid) | avoid (libavoid only) |
| --- | --- | --- | --- |
| Acceptance checks passed | 9 of 9 | 9 of 9 | 3 of 9 |
| Crossings | 0 | 0 | 63, 3 unmarked |
| Bends over 66 links | 49 | 49 | 70 |
| Re-route, 61 nodes | 112ms | **31ms** | 226ms |
| Re-route, 183 nodes | 839ms | **128ms** | — |

libavoid still earns its place as a fallback for layouts the cascade cannot
reach, and nothing here says to remove it. What the numbers say is that
routing every link through it and then discarding the result costs most of a
pass: `combined` and `custom` draw the same diagram, and one of them is six
and a half times faster at three times the size.

A gutter is measured between the nodes themselves, not between their buffers. With
300px nodes 300px apart and 120px of clearance each side, padding both bands first
leaves 60px and rejects every gap in the diagram; the middle of that same gap is 150px
clear of either column and perfectly usable.

### Which run goes in which gutter

A gutter is wide enough for one corridor, and more links want one than there are gaps,
so the choice cannot be made link by link. Routing is therefore two passes.

The first picks each link's shape and records the straight runs that could move: a
dog-leg contributes the leg it turns on, and a libavoid route contributes any long
interior run — libavoid keeps its distance from a node and then runs flat along that
distance, so its routes sit hard against the buffer rather than in the gap. Two of
them passing either side of one node then read as a pair clinging to it rather than as
two corridors using the space. Moving such a run costs nothing: the bends stay where
they are and only their shared coordinate changes. A run keeps the list of every
gutter it could reach — within `MAX_RECENTRE`, since centring is a nudge and not a
reroute — but not yet which one it gets.

The second pass (`placeRuns`) hands them out, each time taking the run with the fewest
places still open to it. Asked afresh at every step rather than once at the start:
every placement closes a gutter for somebody, and a run with two choices and a run
with three are not equally stuck once they have each lost one. On the dairy graph that
is what separates the two whey lines — CH2 has only the gap between BU2 and BU3, so it
takes it; CH3 is then down to the gap right of BU3; and YO3's line to the cold plant,
which could have taken that same gap, is left with the one by the cellar, which suits
it better anyway.

### Docking rules

In order, each one overriding the looser ones below it:

1. **Nodes that really do run straight dock centre to centre.** A link between two nodes
   in the same row or column runs dead straight, with no bend. Only one link per edge can
   hold the centre; a second aligned link is pulled onto its partner's lane instead
   (`MIN_BEND`), because no bend at all beats a bend too short to read.

   Both halves of that rule ask whether the straight run is actually clear, not merely
   whether the two nodes line up. A third node can sit between them — CH3 and WHE share a
   column with YO3 and BU3 in the way — and such a link bends however it is docked. Left
   ungated it would still claim the centre, and its neighbour on the same edge would sit
   offset beside it: one dock centred, one not, for a straight run that never happens.
   Gated, both fall into the ordinary allocation and come out symmetric.
2. **Each link gets the free lane nearest where it arrives from.** Handing lanes out in
   order looks the same until one link holds the centre — the centre is then cut out of
   the list and a link approaching from below can be handed a lane above it, crossing the
   straight link on the way in and needing a bridge for no reason.
3. **Two links never share a dock.** `enforceUniqueDocks()` runs last and moves any
   duplicate to the nearest free lane; the harness checks it.
4. **Lanes sit on the grid, centred and evenly spread** along the edge, spaced by the
   width of the links using them.
5. **Only the middle of an edge is used.** A lane is usable where the outline still
   reaches 78% of its full extent — on a round node the outline falls away towards the
   ends, and a lane out there docks high up the side, so two links leaving the bottom
   would appear to leave from the flanks at different heights.

### Attachment lanes

Links do not attach at a node's centre. `computeAttachments()` groups the links at each
node by the edge they use, orders them by where their far end sits, and gives each one its
own lane along that edge. The link's JointJS anchor is pinned to the same lane.

This is what makes the overlap criterion pass. With every link attached at the centre,
libavoid has to run them all down one corridor — they overlap for hundreds of pixels, and
the first segment slants away from the centre toward wherever the nudging put the
corridor. The first run of the checker failed on exactly that, 35 times over.

**Lanes sit on the node placement grid, and are spaced by how thick the links are.**
`lanesFor()` offers lanes down the edge at a quarter of the grid pitch, keeps only those
where the node actually has an outline to attach to, then takes every *n*-th one so that
consecutive links clear each other by `LINK_CLEARANCE` (24px) — rather than taking
adjacent lanes and letting thick links merge into one band. A link also turns one full
lane clear of the node before heading off, so its first bend is on a grid line too.

Width is what makes this necessary. Two 30px links one quarter-lane (18.75px) apart
overlap; the same two links three lanes apart have a 26px gap. The same reasoning sets
libavoid's `idealNudgingDistance` for the corridors between nodes: it is the widest link
plus the clearance, not a fixed few pixels.

`nudgeOrthogonalSegmentsConnectedToShapes` is deliberately **off**. The segment leaving a
node is already positioned by its lane, and letting libavoid nudge it as well puts a small
jog between the lane and the first bend — which shows up as a slanted segment.

Two details are needed for the ends to land exactly on the grid: the link's anchor is
pinned to the lane (otherwise JointJS draws from the node centre and slants the first
segment), and `defaultConnectionPoint` carries no offset (a 2px gap would put every
endpoint 2px off the grid).

## Link routing

Links are routed by [libavoid](https://www.adaptagrams.org/) (`libavoid-js`, the
Adaptagrams router compiled to WASM), selected with `config.edges.router = 'avoid'`.
JointJS's built-in `manhattan` router plans each link alone, so parallel links stack on
top of each other and links through a dense graph give up and draw straight through
everything. libavoid holds every obstacle and every connector at once and nudges
overlapping segments apart. Routes come back as plain link vertices, so nothing else in
the stack needs to know about it.

Three things that are easy to get wrong, all commented in
[avoid-router.ts](src/app/joint/avoid-router.ts):

- **A point on a shape's edge counts as inside it.** libavoid then routes from the
  shape's *centre* instead of the point you gave it. That stays invisible while routes
  leave sideways and shows up as a diagonal the moment one leaves vertically, so
  endpoints are pushed clear of the shape's buffer and kept as real bends in the path.
- **Groups must not be obstacles** — their children live inside them, so a route that
  avoids the group box can never reach them.
- **Deleting or moving a shape with its own add still queued trips an assertion**, so the
  transaction is flushed before any geometry is mutated.

Set `config.edges.router` to `'manhattan'` to switch back to the built-in router and
compare. `AvoidRouter.load()` must be awaited before the config asks for `avoid`; if the
WASM cannot be fetched the app logs a warning and stays on the built-in router.

## The `Graph` facade

[src/app/joint/graph.ts](src/app/joint/graph.ts) is deliberately shaped like the existing
Cytoscape facade: same member list, same chainable `this` returns, same
`{ data: { id, ... } }` element definitions and string selectors. Swapping the engine
should be mostly a matter of changing the import.

```ts
const graph = new Graph(container)
  .registerStylesheets([{ selector: '.terminal', style: { 'body/fill': '#eef2ff' } }])
  .setConfig({ positions, edges: { bundle: true }, collapsed: ['pipeline'] })
  .addElements([
    { data: { id: 'ingest', label: 'Fetch' }, classes: 'terminal' },
    { data: { id: 'transform', label: 'Transform', parent: 'pipeline' } },
    { data: { id: 'e1', source: 'ingest', target: 'transform' } },
  ])
  .addEvent({ events: 'tap', selector: 'node', handler: ({ cell }) => select(cell) })
  .render();
```

| File | Contents |
| --- | --- |
| [joint/graph.ts](src/app/joint/graph.ts) | The facade — paper setup, elements, parents, collapse/expand, edge redirection, styles, viewport |
| [joint/types.ts](src/app/joint/types.ts) | `Config`, `Event`, `ElementDefinition`, `StylesheetStyle`, … |
| [graph-controls/](src/app/graph-controls/) | The toolbar, and the view/edit toggle. Holds a `Graph` and nothing else: it hears what it shows and emits what it wants |
| [graph-inspector/](src/app/graph-inspector/) | The panel describing the selection. Same shape: one `Graph`, no inputs or outputs |
| [joint/events.ts](src/app/joint/events.ts) | `EventBus` and the typed `GraphEvents` map behind `graph.eventbus` — what the graph announces, and what can be asked of it |
| [joint/groups.ts](src/app/joint/groups.ts) | Collapse/expand: the stash, edge redirection and co-directed bundling |
| [joint/styling.ts](src/app/joint/styling.ts) | Stylesheets, the weight scale and the filter — in the order their precedence depends on |
| [joint/paper.ts](src/app/joint/paper.ts) | The `dia.Paper` setup: what may be embedded, which connections are legal, the grid layer |
| [joint/interaction.ts](src/app/joint/interaction.ts) | Drag to pan, wheel to zoom, drop to snap — behind one call, so it can be replaced |
| [joint/cell-state.ts](src/app/joint/cell-state.ts) | Everything the facade stores on a cell — `data`, `classes`, `collapsed`, and the collapse bookkeeping — declared once |
| [joint/constants.ts](src/app/joint/constants.ts) | The numbers the facade, the nodes and the router all have to agree on |
| [joint/selector.ts](src/app/joint/selector.ts) | The selector subset (`node`, `#id`, `.class`, `[key = value]`, `[?key]`, commas) |
| [joint/nodes/](src/app/joint/nodes/) | One file per node type, plus the `cellNamespace` barrel |
| [joint/edges/](src/app/joint/edges/) | `flow-link.ts` — the edge type and the fallback router |
| [joint/graph.spec.ts](src/app/joint/graph.spec.ts) | Behavioural tests for the above |
| [joint/avoid-router.ts](src/app/joint/avoid-router.ts) | libavoid (WASM) orthogonal routing |
| [diagram/](src/app/diagram/) | A thin Angular component driving the facade |
| [tools/build-demo-data.mjs](tools/build-demo-data.mjs) | Generates the demo `graph.json` |

### Cytoscape → JointJS, concept by concept

| Cytoscape | Here | Note |
| --- | --- | --- |
| `cy` (Core) | `graph.model` + `graph.paper` | JointJS splits model from view. `paper` is null in model-only mode. |
| `ElementDefinition` | same shape | `data.parent` still declares compound membership. |
| Compound parents | `parent.embed(child)` | Any element can be a parent; it need not exist before its children. |
| Stylesheets | `registerStylesheets()` + `updateStyles()` | No style engine in JointJS — rules are applied to matching cells. `style` keys are attribute paths (`'body/fill'`). |
| Selectors | `selector.ts` | A documented subset, not the full language. Unparseable selectors throw rather than matching nothing. |
| `NodeCollection` | `dia.Element[]` | No collection type; plain arrays. |
| `cy.on('tap', sel, fn)` | `addEvent({ events, selector, handler })` | Cytoscape event names are aliased (`tap`→`pointerclick`, `mouseover`→`mouseenter`, …). |
| `expand-collapse` ext. | `collapse()` / `expand()` | Hand-rolled: descendants are stashed off-graph, crossing edges re-pointed at the group, co-directed edges optionally bundled with a `×n` label. |
| `cy.fit()`, pan/zoom | `fit()`, `setViewPort()`, `saveCurrentViewPort()` | `viewPort` is `{ pan, zoom }`, as before. |
| `layout` extensions | `setPosition()` | Reads `config.positions` (grid cells); anything unplaced gets the next free cell. For real auto-layout add `@joint/layout-directed-graph` (dagre, also MPL). |
| `node.position()` px | `toPixels()` / `toGrid()` / `setNodePosition()` | Positions are grid cells by default — see above. |
| `cy.json()` | `toData()` | Emits the `graph.json` shape: elements + config with grid positions. |

### Deviations worth knowing

- **`constructor(container?)`** — omitting the container gives a model-only graph. The
  paper-dependent methods become no-ops. This is what the tests use, and it is what you
  would need for SSR.
- **Additions to the original member list:** `fit()`, `toPixels()`, `toGrid()`,
  `gridPositions()`, `setNodePosition()`, `toData()`, and the private `syncData()` /
  `collapsedIds()` / `gridImage()`. Everything else matches.
- **Collapsing removes cells** from the graph rather than hiding them, and `expand()`
  re-adds and re-embeds them. Hold references through the facade, not to cells directly.
- **`filter` hides, it does not remove** — filtered cells get `root/display: none`, so
  clearing the filter brings them straight back.

## What you can try in the app

Connect out→in ports (self-links, in→in and duplicates are rejected), drag a node onto a
dashed group to embed it, select a group and **Collapse** to watch its crossing edges
redirect onto it and bundle into `×n`, **Edges** to see `config.filter`, **Arrange** to
re-run `setPosition()`, and Save/Load/Export for persistence. `Delete`/`Backspace` removes
the selection. The inspector panel only appears once something is selected.

## Angular-specific notes

- **Zoneless change detection.** Angular 22 is zoneless by default and JointJS events fire
  outside Angular entirely. Mirror anything the template reads into a `signal` from inside
  the handler — a plain field assignment updates the value but never re-renders.
- **`cellViewNamespace` / `cellNamespace` are mandatory** with custom shapes, or
  `fromJSON` silently drops them.
- **`defaults` as a method, not an object.** `Element.define()` stores `defaults` as a
  shared object, so nested values like `ports.items` leak between instances. The shapes
  here return a fresh object from `defaults()` instead.
- **`paper.remove()` in `ngOnDestroy`** (the facade's `destroy()` does it) — paper
  registers document-level listeners.
- **No stylesheet.** JointJS 4 dropped `joint.css`; everything is SVG attributes.
- **Bundle size.** `@joint/core` is ~400 kB raw / ~110 kB transferred, so the production
  budget in `angular.json` is raised to 800 kB. Lazy-load the diagram route in a real app.
- **Tests need a shim.** jsdom has no SVG geometry API and JointJS disables Vectorizer
  entirely when `window.SVGAngle` is missing; [src/test-setup.ts](src/test-setup.ts)
  declares it. Anything needing real geometry (text measurement, screen CTMs) has to be
  tested in a browser.
- **Not included (JointJS+ commercial only):** selection rectangles, snaplines,
  paper-scroller, halo, stencil, inspector, expand/collapse. Everything above is
  hand-rolled on the open-source core.
