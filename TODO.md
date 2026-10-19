# Open tasks

What is known to be unfinished, and what was learned about each. Ordered by how
much it would change the answer to the question this sandbox exists to settle:
*can JointJS replace Cytoscape.js here?*

Reproduce any measurement below with `npm start` in one terminal and
`npm run check:routing` or `npm run bench:routing` in another.

---

## 1. Correctness after an interaction

### 1.1 A node dropped onto a route leaves it too close

`npm run check:routing -- --after-drag`

```
FAIL  Node clearance   brook-stable__brook-milkery is 56px from brook-pasture-1 (needs 120)
```

Dropping a node into the gap two others route through leaves the route 56px
away. Partly physical — the user put a node where there was only room for a
line — but the router should move the route rather than leave it grazing, or
say it cannot.

A drag of zero distance passes every check, so this is about the node being
somewhere new, not about re-routing as such.

### 1.2 Elbow routes do not reserve a corridor

`placeRuns` reserves a channel for every dog-leg and every centred fallback
run, and consults those reservations before placing the next. A one-bend elbow
reserves nothing and consults nothing, so a dog-leg can be placed straight
along an elbow's leg.

Once suspected of putting links far from a drag onto one centreline (14 pairs
around x=10200, after a drag or a collapse and expand). That turned out to be
the paper drawing stale routes: the model had them a lane apart all along.
`placeRuns` moved points the model shared, so the final set changed nothing
and fired no event. Fixed by giving the model its own copy.

---

## 2. Measurement that cannot be trusted yet

### 2.1 The crossing check is probably blind

`checkCrossings` reports **0 crossings** on a diagram where counting the
rendered path data by hand finds **19**. It works from `straightSegmentsOf`,
which filters out curve segments — and a crossing drawn by the `jumpover`
connector *is* a curve. If that is the cause, the check has been reporting
"0 crossings" all along by discarding exactly the crossings it is looking for.

**Fix this before touching crossing behaviour.** Optimising against a number
that does not match what is on screen is worse than not optimising.

---

## 3. Routing quality

### 3.1 A fan of links leaving one node interleaves instead of nesting

`truck-alpine__yogurt-1` turns up at x=2617 — the nearest gutter — while its
siblings turn at 2700 and 2775. It climbs the least but turns the earliest, so
its vertical cuts across their horizontals and its horizontal cuts back across
their verticals: 6 crossings on one link, of 19 in the diagram.

`gutters()` orders candidates nearest-the-source-first, on the reasoning that a
turn taken early is easier to follow. For a fan that is exactly wrong — the
link climbing least should turn last, so the fan nests.

**Tried and reverted.** Scoring each candidate gutter by how many already-placed
runs it would cross, nearest-first as the tie-break:

| | before | after |
| --- | --- | --- |
| crossings on that link | 6 | 2 |
| crossings in the diagram | 19 | 15 |
| overlap check | PASS | FAIL (36px) |
| crossings marked | PASS | FAIL (1 unmarked) |
| re-route | 113ms | 265ms |

The cost is not the scoring — capping the candidates examined changed nothing.
The gutters it picks create overlaps, and the repair pass then churns trying to
fix them. The crossing preference competes with the overlap constraint instead
of being subordinate to it, so `placeRuns` has to weigh crossings *within* what
the reservations allow. Depends on 2.1 to measure honestly.

### 3.2 `reduceCrossings()` is blind to fallback routes

It works on the idealised elbow model, so a link libavoid routed around an
obstacle — which looks nothing like its elbow — is invisible to it. Moot while
the diagram has no crossings the harness can see; see 2.1.

### 3.3 Unexplained bend-count drift

Changing `cellWidth` 600 -> 1200 -> 600 did not return the bend count to where
it started. Inherited, never chased. Suggests something is carried between
passes that should not be; the corridor-override leak fixed in 65e4356 was one
such thing and may not have been the only one.

---

## 4. Performance

### 4.1 libavoid is asked about every link and answers none

Measured on the dairy graph, at both 1x and 3x: the cascade resolves **every**
link — straight, one bend, or dog-leg — and libavoid's output is read for
**none** of them. It is still 84% of a routing pass.

```
npm run bench:routing
```

| scale | combined | custom (no libavoid) |
| --- | --- | --- |
| 61 nodes | 113ms | 29ms |
| 183 nodes | 839ms | 128ms |

Route the cascade first, and hand libavoid only what nothing else reaches.
Catch: its transaction routes every registered connector at once, so the
connector set has to be narrowed too, not just the call site.

This is **not** an argument for removing libavoid — on its own it passes 3 of
the 9 criteria (63 crossings, 70 bends over 66 links) and is the slowest of the
three. It is the only thing that draws a route the cascade cannot, and it
earned that on the whey lines. The argument is only for asking it less often.

### 4.2 Scaling is near-quadratic

Roughly O(n^1.8): 61 nodes 113ms, 122 nodes 390ms, 183 nodes 827ms. Almost all
of it is 4.1. The real dataset is expected to grow 2-3x, where `custom` lands
at 128ms — 8ms over budget — and `combined` at 839ms.

### 4.3 ~~The 120ms budget only covers half the question~~ — done

The budget is 300ms and derived: the pass is synchronous and blocks the
window, around 100ms a release still feels joined to its result, a second is
plainly noticed, and the dataset is expected to grow two or three times. At
120ms a 3x graph without libavoid in the hot path would have failed by 8ms,
reporting that the architecture does not scale when it does.

Drag smoothness is guarded by an invariant rather than a timing: `Drag left
alone` fails if any link other than the dragged node's own is redrawn while
the pointer is down. Verified by disabling the hold, which turns it red with
11 stray links.

---

## 5. Interface

### 5.1 The inspector should be a side menu that fades in

Stated direction: a panel that fades in when a node or edge is clicked, rather
than a column that appears. `graph-inspector` already renders nothing when
nothing is selected and already takes edges, so this is presentation: keep the
element mounted and transition it. `selection:changed` carries `{ cell }` and
`cell === null` is the cue to fade out.

### 5.2 Edit mode is deliberately unfinished

Parked. View mode is the focus; edit mode is what the toolbar was before the
split. Open questions when it is picked up: whether clicking a group in edit
mode selects it rather than collapsing it, and which of the toolbar's actions
belong to a selection rather than to the graph.

### 5.3 Links can be drawn in front of nodes

The router sets each link's `z` from its route length, because that decides
which of two links draws the bridge at a crossing. A long route lands around
z=400, above every node. Nothing looked wrong in review, but a label obscured
by a line would start here.

---

## 6. Project

### 6.1 `main` is behind

Everything since the first deploy sits on `develop`. `main` only moves when
asked, because a push there publishes the demo to GitHub Pages. The live site
is therefore older than the code.

### 6.2 Bundle size

The initial bundle is ~695kB and `angular.json` raises the warning budget to
800kB to accommodate it. A real app should lazy-load the diagram route.

### 6.3 Runner deprecation

`ubuntu-latest` migrates to Ubuntu 26 on 19 October 2026. Informational; CI
pins nothing that should care.
