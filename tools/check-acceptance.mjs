/**
 * Checks the routing acceptance criteria against the running app.
 *
 *   npm start                  # in one terminal
 *   npm run check:routing      # in another
 *
 * Drives a headless Chrome over the DevTools Protocol, reads the rendered
 * geometry out of the SVG, and verifies:
 *
 *   1. Orthogonal routing     — only horizontal and vertical segments
 *   2. Collision avoidance    — no segment crosses a node it is not attached to
 *   3. Overlap avoidance      — no two links share a collinear stretch
 *   4. Crossings              — allowed, but every one is drawn with a jump
 *   5. Single bend            — one 90° turn per link, unless one cannot reach
 *   5. Dynamic calculation    — re-routing stays inside an interactive budget
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_URL = process.env['APP_URL'] ?? 'http://localhost:4200/';
const PORT = 9333;
const CHROME =
  process.env['CHROME'] ??
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
/**
 * How long the one routing pass after a node is put down may take.
 *
 * Routing is held during a drag and runs once on release, so every trigger is
 * now a discrete action rather than a stream of frames: there is no 60Hz
 * consumer to satisfy, and the frame budget that used to apply does not.
 *
 * What constrains it instead is that the pass is synchronous and blocks the
 * window. Around 100ms a release still feels joined to its result; a second is
 * where the freeze is plainly noticed. This sits between the two, with room
 * for the dataset to grow two or three times, which is what it is expected to
 * do — `npm run bench:routing` puts that at 128ms without libavoid in the hot
 * path and 839ms with it.
 */
const REROUTE_BUDGET_MS = 300;
/** Must match the router's `lane` option (Graph passes its grid spacing). */
const LANE = 75;
/** Must match the router's `shapeBufferDistance`. */
const NODE_CLEARANCE = 120;

/** Visible gap required between the drawn edges of two parallel links. */
const CLEARANCE = 20;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- the checks, run inside the page -----------------------------------------

/**
 * Everything below runs in the browser: it reads the rendered paths and node
 * boxes, which are in the same SVG user space, and measures them directly
 * rather than trusting the router.
 */
function collectGeometry() {
  const TOL = 1.5;

  /**
   * Walks the path commands rather than scraping number pairs: `jumpover`
   * emits arcs for both the rounded corners and the crossing hops, and their
   * parameter lists are not coordinate pairs.
   */
  const points = (d) => {
    const out = [];
    const re = /([MLACmlac])([^MLACQZmlacqz]*)/g;
    let m;
    while ((m = re.exec(d))) {
      const cmd = m[1].toUpperCase();
      const nums = (m[2].match(/-?[0-9.]+(?:e-?\d+)?/g) ?? []).map(Number);
      if (cmd === 'M' || cmd === 'L') {
        for (let i = 0; i + 1 < nums.length; i += 2) out.push({ x: nums[i], y: nums[i + 1], curve: false });
      } else if (cmd === 'A') {
        // rx ry rotation large-arc sweep x y
        for (let i = 0; i + 6 < nums.length; i += 7) out.push({ x: nums[i + 5], y: nums[i + 6], curve: true });
      } else if (cmd === 'C') {
        for (let i = 0; i + 5 < nums.length; i += 6) out.push({ x: nums[i + 4], y: nums[i + 5], curve: true });
      }
    }
    return out;
  };

  const nodes = [...document.querySelectorAll('.joint-element')].map((el) => {
    const body = el.querySelector('[joint-selector="body"]');
    const transform = el.getAttribute('transform') || '';
    const [, x, y] = transform.match(/translate\(\s*(-?[\d.]+)[ ,]\s*(-?[\d.]+)/) ?? [0, 0, 0];
    return {
      id: el.getAttribute('model-id'),
      x: +x,
      y: +y,
      width: +(body?.getAttribute('width') ?? 0),
      height: +(body?.getAttribute('height') ?? 0),
      isGroup: (el.getAttribute('class') || '').includes('groupnode'),
    };
  });

  const links = [...document.querySelectorAll('.joint-link')].map((el) => {
    // The visible stroke, not the first path: a JointJS link also carries an
    // invisible `wrapper` path with a fixed 10px width for pointer hits, and
    // measuring that reports every link as 10px wide.
    const path = el.querySelector('[joint-selector="line"]') ?? el.querySelector('path[d]');
    const d = path?.getAttribute('d') ?? '';
    const pts = points(d);
    // Both a rounded corner and a crossing hop are arcs. A hop leaves and
    // rejoins the same straight line, so its endpoints stay axis-aligned;
    // a corner's do not.
    let jumps = 0;
    for (let i = 1; i < pts.length; i++) {
      if (!pts[i].curve) continue;
      const dx = Math.abs(pts[i].x - pts[i - 1].x);
      const dy = Math.abs(pts[i].y - pts[i - 1].y);
      if (dx <= TOL || dy <= TOL) jumps++;
    }
    const width = parseFloat(path?.getAttribute('stroke-width') ?? '1') || 1;
    return { id: el.getAttribute('model-id'), d, points: pts, jumps, width };
  });

  return { nodes, links, tolerance: TOL };
}

// --- analysis, run here ------------------------------------------------------

const segmentsOf = (link) => {
  const out = [];
  for (let i = 1; i < link.points.length; i++) {
    const a = link.points[i - 1];
    const b = link.points[i];
    out.push({
      link: link.id,
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      // Only the arc itself is a curve: it runs from the previous point to the
      // arc command's endpoint. The straight run *into* a rounded corner has an
      // arc endpoint as its start, and must still be checked.
      curve: b.curve,
      width: link.width,
    });
  }
  return out;
};

/** Straight stretches only — corners and jumps are curves by design. */
const straightSegmentsOf = (link) => segmentsOf(link).filter((s) => !s.curve);

function checkOrthogonal(links, tol) {
  const bad = [];
  // A crossing hop is sized to clear the *widest* line it crosses, not the
  // link's own width, so that is what bounds how long a legitimate curve is.
  const widest = Math.max(...links.map((link) => link.width));
  for (const link of links) {
    for (const s of segmentsOf(link)) {
      const dx = Math.abs(s.x2 - s.x1);
      const dy = Math.abs(s.y2 - s.y1);
      if (dx <= tol || dy <= tol) continue; // horizontal or vertical: fine
      // Not axis-aligned. Only a rounded corner or a crossing hop may do that.
      // A hop has to clear the line it crosses, so its size scales with the
      // stroke; anything longer than that is a diagonal in disguise.
      // A hop spans twice its `size` along the line, and the chord of each
      // half-arc is measured here, so allow a little over 2x.
      const hop = (widest + s.width) / 2 + 8;
      if (s.curve && Math.hypot(dx, dy) <= Math.max(30, hop * 2.2)) continue;
      bad.push({ link: link.id, curve: s.curve, dx: +dx.toFixed(1), dy: +dy.toFixed(1), ...s });
    }
  }
  return { name: 'Orthogonal routing', detail: 'only horizontal/vertical segments', bad };
}

function checkNodeClearance(links, nodes, graph, required) {
  const boxes = nodes.filter((n) => !n.isGroup && n.width > 0);
  const bad = [];

  for (const link of links) {
    const ends = graph[link.id] ?? {};
    for (const s of straightSegmentsOf(link)) {
      for (const n of boxes) {
        if (n.id === ends.source || n.id === ends.target) continue;
        // Distance from the segment to the node's box, 0 when it overlaps.
        const dx = Math.max(n.x - Math.max(s.x1, s.x2), Math.min(s.x1, s.x2) - (n.x + n.width), 0);
        const dy = Math.max(n.y - Math.max(s.y1, s.y2), Math.min(s.y1, s.y2) - (n.y + n.height), 0);
        const gap = Math.hypot(dx, dy);
        if (gap < required) bad.push({ link: link.id, node: n.id, gap: Math.round(gap) });
      }
    }
  }
  return {
    name: 'Node clearance',
    detail: `routes stay ${required}px clear of nodes they pass`,
    bad,
  };
}

function checkNodeCollisions(links, nodes, graph) {
  const inset = 2;
  const boxes = nodes.filter((n) => !n.isGroup && n.width > 0);
  const bad = [];

  for (const link of links) {
    const ends = graph[link.id] ?? {};
    for (const s of straightSegmentsOf(link)) {
      for (const n of boxes) {
        if (n.id === ends.source || n.id === ends.target) continue;
        const left = n.x + inset;
        const right = n.x + n.width - inset;
        const top = n.y + inset;
        const bottom = n.y + n.height - inset;
        const sx1 = Math.min(s.x1, s.x2);
        const sx2 = Math.max(s.x1, s.x2);
        const sy1 = Math.min(s.y1, s.y2);
        const sy2 = Math.max(s.y1, s.y2);
        if (sx2 > left && sx1 < right && sy2 > top && sy1 < bottom) {
          bad.push({ link: link.id, node: n.id });
        }
      }
    }
  }
  return { name: 'Collision avoidance', detail: 'no segment crosses a foreign node', bad };
}

/**
 * Two parallel links must not visually collide. Comparing centrelines is not
 * enough once links are tens of pixels wide: lines nudged 16px apart overlap
 * heavily when they are 46px thick. What counts is the gap between their
 * drawn edges.
 */
function checkOverlaps(links, tol, clearance) {
  const all = links.flatMap(straightSegmentsOf);
  const bad = [];
  const overlap = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1);

  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      if (a.link === b.link) continue;

      const aVertical = Math.abs(a.x2 - a.x1) <= tol;
      const bVertical = Math.abs(b.x2 - b.x1) <= tol;
      if (aVertical !== bVertical) continue;

      // How far apart the two centrelines are, and how much of their length
      // actually runs side by side.
      const apart = aVertical ? Math.abs(a.x1 - b.x1) : Math.abs(a.y1 - b.y1);
      const along = aVertical
        ? overlap(Math.min(a.y1, a.y2), Math.max(a.y1, a.y2), Math.min(b.y1, b.y2), Math.max(b.y1, b.y2))
        : overlap(Math.min(a.x1, a.x2), Math.max(a.x1, a.x2), Math.min(b.x1, b.x2), Math.max(b.x1, b.x2));
      if (along <= 8) continue; // only touching, or not parallel at all

      const gap = apart - (a.width + b.width) / 2;
      if (gap < clearance) {
        bad.push({
          a: a.link,
          b: b.link,
          axis: aVertical ? 'x' : 'y',
          gap: Math.round(gap),
          apart: Math.round(apart),
          widths: [Math.round(a.width), Math.round(b.width)],
          at: Math.round(aVertical ? a.x1 : a.y1),
          sideBySide: Math.round(along),
        });
      }
    }
  }
  return {
    name: 'Overlap avoidance',
    detail: `parallel links keep a ${clearance}px gap between their edges`,
    bad,
  };
}

/**
 * Attachment lanes are meant to sit on the node placement grid, so the
 * corridors leaving a node line up with the grid lines behind it.
 *
 * Only the lane axis is checked. The other coordinate follows the node's
 * outline — a round node is narrower away from its middle, so its attachment
 * x is wherever the ring is, not a grid multiple. Lanes are offered on a
 * quarter of the pitch, so busy nodes still land on the grid.
 */
function checkLaneAlignment(links, lane, tol) {
  const bad = [];
  const step = lane / 4;
  const onGrid = (v) => Math.abs(v / step - Math.round(v / step)) * step <= tol;

  for (const link of links) {
    // The full list, not just the straight points: the neighbour decides the
    // direction, and dropping a rounded corner would make it the point before
    // the corner, which sits on a different axis.
    const pts = link.points;
    if (pts.length < 2) continue;

    const ends = [
      ['start', pts[0], pts[1]],
      ['end', pts[pts.length - 1], pts[pts.length - 2]],
    ];
    for (const [where, end, next] of ends) {
      const horizontal = Math.abs(end.y - next.y) <= tol;
      const value = horizontal ? end.y : end.x;
      if (!onGrid(value)) {
        bad.push({ link: link.id, where, axis: horizontal ? 'y' : 'x', value: +value.toFixed(1) });
      }
    }
  }
  return {
    name: 'Lane-aligned ends',
    detail: `attachment lanes on the ${lane}px grid (down to a quarter lane)`,
    bad,
  };
}

/** True when no segment of this polyline enters a foreign node's buffer. */
function pathIsClear(points, boxes, ends, pad) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const sx1 = Math.min(a.x, b.x);
    const sx2 = Math.max(a.x, b.x);
    const sy1 = Math.min(a.y, b.y);
    const sy2 = Math.max(a.y, b.y);

    for (const n of boxes) {
      if (n.id === ends.source || n.id === ends.target) continue;
      if (
        sx2 > n.x - pad &&
        sx1 < n.x + n.width + pad &&
        sy2 > n.y - pad &&
        sy1 < n.y + n.height + pad
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Whether this link could have been drawn with a single bend.
 *
 * Asked of the two L-routes between the docks it actually has — out
 * horizontally and then vertically, or the other way round — against nodes
 * padded by the same clearance the router keeps. So "possible" here means
 * what it meant when the router chose, rather than a looser standard the
 * router could never have met.
 */
function singleBendReaches(link, boxes, graph, pad) {
  const pts = link.points ?? [];
  if (pts.length < 2) return true;

  const from = pts[0];
  const to = pts[pts.length - 1];
  const ends = graph[link.id] ?? {};

  return [
    { x: to.x, y: from.y },
    { x: from.x, y: to.y },
  ].some((corner) => pathIsClear([from, corner, to], boxes, ends, pad));
}

/**
 * Counts direction changes. A rounded corner is one bend even though it is
 * drawn as two straight runs and an arc between them, so bends are counted
 * from the straight runs' orientations rather than from the point list.
 *
 * The criterion is one bend *where possible*, so a link is only at fault for
 * a second bend when a single one could have reached. A link that has to get
 * round a node in the way needs the detour, and reporting it would be
 * reporting the router for doing its job — which is worse than useless,
 * because a check that fails on correct output stops being read.
 */
function checkBends(links, nodes, graph, tol, allowed, pad) {
  const boxes = nodes.filter((n) => !n.isGroup && n.width > 0);
  const bad = [];
  let total = 0;
  let detours = 0;

  for (const link of links) {
    const runs = [];
    for (const s of straightSegmentsOf(link)) {
      if (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 2) continue;
      const vertical = Math.abs(s.x2 - s.x1) <= tol;
      if (!runs.length || runs[runs.length - 1] !== vertical) runs.push(vertical);
    }

    const bends = Math.max(0, runs.length - 1);
    total += bends;
    if (bends <= allowed) continue;

    // One extra bend is a dog-leg: out of the source, along a clear gutter,
    // and in. More than that is the fallback router, and is reported whether
    // or not a single bend was on.
    if (bends === allowed + 1 && !singleBendReaches(link, boxes, graph, pad)) {
      detours++;
      continue;
    }
    bad.push({ link: link.id, bends, singleBendWasPossible: singleBendReaches(link, boxes, graph, pad) });
  }

  return {
    name: 'Single bend',
    detail:
      `${total} bends over ${links.length} links, at most ${allowed} each` +
      ` (+${detours} second bends where one could not reach)`,
    bad,
  };
}

/**
 * No two links may dock at the same point on a node: two links leaving one
 * place read as a single link.
 */
function checkUniqueDocks(ends) {
  const byPoint = new Map();
  const bad = [];

  for (const { link, where, x, y } of ends) {
    const key = `${Math.round(x / 3)}:${Math.round(y / 3)}`;
    const seen = byPoint.get(key);
    if (seen) bad.push({ a: seen, b: `${link}|${where}`, at: [Math.round(x), Math.round(y)] });
    else byPoint.set(key, `${link}|${where}`);
  }
  return { name: 'Docks unshared', detail: `${ends.length} docking points, all distinct`, bad };
}

function checkCrossings(links, tol) {
  const all = links.flatMap(straightSegmentsOf);
  let crossings = 0;

  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      if (a.link === b.link) continue;
      const aVertical = Math.abs(a.x2 - a.x1) <= tol;
      const bVertical = Math.abs(b.x2 - b.x1) <= tol;
      if (aVertical === bVertical) continue;

      const v = aVertical ? a : b;
      const h = aVertical ? b : a;
      // Inclusive bounds: `jumpover` splits a path at each crossing, so the
      // crossing point is a segment *endpoint* and a strict test misses it.
      const withinV = Math.min(v.y1, v.y2) - tol <= h.y1 && h.y1 <= Math.max(v.y1, v.y2) + tol;
      const withinH = Math.min(h.x1, h.x2) - tol <= v.x1 && v.x1 <= Math.max(h.x1, h.x2) + tol;
      if (withinV && withinH) crossings++;
    }
  }

  const jumps = links.reduce((n, link) => n + link.jumps, 0);
  // `jumpover` splits a path around each crossing it draws, so a crossing it
  // handled leaves no two straight segments intersecting. What this counts is
  // therefore exactly the crossings that were *not* marked — which must be 0.
  const bad = crossings > 0 ? [{ unmarked: crossings }] : [];
  return {
    name: 'Crossings marked',
    detail: `${jumps} crossings drawn as jumps, ${crossings} left unmarked`,
    bad,
  };
}

// --- CDP plumbing ------------------------------------------------------------

async function connect() {
  const profile = mkdtempSync(join(tmpdir(), 'routing-check-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      `--remote-debugging-port=${PORT}`,
      '--window-size=1600,1000',
      `--user-data-dir=${profile}`,
      APP_URL,
    ],
    { stdio: 'ignore' },
  );

  let target;
  for (let i = 0; i < 30 && !target; i++) {
    await wait(1000);
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
      target = list.find((t) => t.type === 'page' && t.url.startsWith(APP_URL.slice(0, 21)));
    } catch {
      /* chrome is still starting */
    }
  }
  if (!target) throw new Error(`no page at ${APP_URL} — is the dev server running?`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));

  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const msgId = ++id;
      pending.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.result?.exceptionDetails) {
      throw new Error(JSON.stringify(res.result.exceptionDetails.exception?.description));
    }
    return res.result?.result?.value;
  };

  return {
    evaluate,
    close: () => {
      ws.close();
      chrome.kill();
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* windows keeps a handle on the profile for a moment */
      }
    },
  };
}

// --- run ---------------------------------------------------------------------

const page = await connect();
try {
  await page.evaluate('new Promise((r) => setTimeout(r, 9000))');

  // `--after-drag` checks the criteria against a graph that has been
  // interacted with, not just one that has finished loading. A route is only
  // as correct as it stays once a node has been moved.
  if (process.argv.includes('--after-drag')) {
    const moved = await page.evaluate(`(() => {
      const node = [...document.querySelectorAll('.joint-element')].find(
        (el) => !/-farm$|-line$|channels/.test(el.getAttribute('model-id') ?? ''),
      );
      const box = node.getBoundingClientRect();
      const from = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
      const fire = (type, at, target) =>
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...at }));

      fire('mousedown', from, node);
      // Delivered back to back, the way a pointer does, so the router is
      // asked to keep up rather than given a pause between each step.
      const pause = ${Number(process.env['DRAG_STEP_MS'] ?? 0)};
      const stepX = ${Number(process.env['DRAG_X'] ?? 8)};
      const stepY = ${Number(process.env['DRAG_Y'] ?? 6)};
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      return (async () => {
        for (let i = 1; i <= 30; i++) {
          fire('mousemove', { clientX: from.clientX + i * stepX, clientY: from.clientY + i * stepY }, document);
          if (pause) await wait(pause);
        }
        fire('mouseup', { clientX: from.clientX + 30 * stepX, clientY: from.clientY + 30 * stepY }, document);
        return node.getAttribute('model-id');
      })();
    })()`);
    // Long enough for every queued re-route to have run out.
    await page.evaluate('new Promise((r) => setTimeout(r, 3000))');
    console.log(`  (dragged ${moved} first)`);
  }

  const geometry = await page.evaluate(`(${collectGeometry.toString()})()`);
  const { nodes, links, tolerance } = geometry;

  // Link endpoints, so a segment touching its own node is not a collision.
  const ends = await page.evaluate(`(() => {
    const out = {};
    document.querySelectorAll('.joint-link').forEach((el) => {
      const id = el.getAttribute('model-id');
      out[id] = { source: null, target: null };
    });
    return out;
  })()`);

  // Resolved against the app URL rather than concatenated onto it: APP_URL
  // may carry a query string, and `...?routing=custom` + `graph.json` asks
  // for a file that does not exist and gets index.html back.
  const data = await fetch(new URL('graph.json', APP_URL)).then((r) => r.json());
  for (const element of data.elements) {
    if (element.group !== 'edges') continue;
    ends[element.data.id] = { source: element.data.source, target: element.data.target };
  }

  // 5. Dynamic calculation, and that a drag is left alone.
  //
  // Two things, from the same drags. Routing is held while the pointer is
  // down and runs once on release, so the pass after the drop is what the
  // budget is about — and that no pass runs *during* the drag is an
  // invariant, checked by counting rather than by watching for movement. A
  // pass that happened to change nothing would leave nothing to watch.
  //
  // A leaf and a group, because they are dragged by different machinery: a
  // group carries its children, and each of them reports a move of its own.
  //
  // The clock starts at the release, since that is when the work begins.
  const dragAndCount = (id) =>
    page.evaluate(`(async () => {
      const node = document.querySelector('[model-id="${id}"]');
      if (!node) throw new Error('not rendered: ${id}');
      const passes = () => globalThis.graph?.routingPasses ?? -1;

      const box = node.getBoundingClientRect();
      // A group is grabbed by its edge; its middle belongs to its children.
      const from = { clientX: box.left + 14, clientY: box.top + 14 };
      const to = { clientX: from.clientX + 90, clientY: from.clientY + 60 };
      const fire = (type, at, target) =>
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...at }));

      const before = passes();
      fire('mousedown', from, node);
      // Several frames, so a per-frame re-route would have every chance to run.
      for (let i = 1; i <= 5; i++) {
        fire('mousemove', { clientX: from.clientX + (i * 90) / 5, clientY: from.clientY + (i * 60) / 5 }, document);
        await new Promise((r) => requestAnimationFrame(r));
      }
      const during = passes() - before;

      const start = performance.now();
      fire('mouseup', to, document);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { during, after: passes() - before, timing: Math.round(performance.now() - start) };
    })()`);

  const leaf = nodes.find((n) => !n.isGroup && n.width > 0);
  const group = nodes.find((n) => n.isGroup && n.width > 0);
  if (!leaf) throw new Error('no leaf node to drag');

  const drags = [];
  for (const node of [leaf, group].filter(Boolean)) {
    drags.push({ id: node.id, ...(await dragAndCount(node.id)) });
  }
  if (drags.some((d) => d.during < 0)) {
    throw new Error('globalThis.graph is missing — is the app in development mode?');
  }

  const timing = drags[0].timing;
  const busy = drags.filter((d) => d.during > 0);

  const results = [
    checkOrthogonal(links, tolerance),
    checkNodeCollisions(links, nodes, ends),
    checkNodeClearance(links, nodes, ends, NODE_CLEARANCE),
    checkOverlaps(links, tolerance, CLEARANCE),
    checkLaneAlignment(links, LANE, tolerance),
    checkBends(links, nodes, ends, tolerance, 1, NODE_CLEARANCE),
    checkUniqueDocks(
      links.flatMap((link) => {
        const pts = link.points;
        if (pts.length < 2) return [];
        return [
          { link: link.id, where: 'source', x: pts[0].x, y: pts[0].y },
          { link: link.id, where: 'target', x: pts[pts.length - 1].x, y: pts[pts.length - 1].y },
        ];
      }),
    ),
    checkCrossings(links, tolerance),
    {
      name: 'Dynamic calculation',
      detail: `re-route + paint in ${timing}ms after the drop (budget ${REROUTE_BUDGET_MS}ms)`,
      bad: timing > REROUTE_BUDGET_MS ? [{ timing }] : [],
    },
    {
      name: 'Drag left alone',
      detail:
        `no routing while the pointer is down, over a leaf and a group` +
        ` (${drags.map((d) => `${d.id}: ${d.during} during, ${d.after} after`).join('; ')})`,
      bad: busy.map((d) => ({ dragged: d.id, passesDuringDrag: d.during })),
    },
  ];

  // `--json` is for tools/bench-routing.mjs, which reads these rather than
  // scraping the table below.
  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify({
        nodes: nodes.length,
        links: links.length,
        timing,
        budget: REROUTE_BUDGET_MS,
        results: results.map((r) => ({ name: r.name, pass: r.bad.length === 0, detail: r.detail })),
      }),
    );
    page.close();
    process.exit(results.some((r) => r.bad.length) ? 1 : 0);
  }

  console.log(`\n  ${links.length} links, ${nodes.length} nodes\n`);
  let failed = 0;
  for (const result of results) {
    const ok = result.bad.length === 0;
    if (!ok) failed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${result.name.padEnd(22)} ${result.detail}`);
    for (const entry of result.bad.slice(0, 4)) {
      console.log(`          ${JSON.stringify(entry)}`);
      const id = entry.link ?? entry.a;
      const link = links.find((l) => l.id === id);
      if (process.env['VERBOSE'] && link) console.log(`            d=${link.d.slice(0, 220)}`);
    }
    if (result.bad.length > 5) console.log(`          …and ${result.bad.length - 5} more`);
  }
  console.log('');
  process.exitCode = failed ? 1 : 0;
} finally {
  page.close();
}
