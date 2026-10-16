/**
 * Generates `public/graph.json` — the dairy supply-chain demo.
 *
 * The graph is big enough that hand-editing JSON gets error prone, so the
 * layout is described here as grid cells (col/row) and the file is generated.
 * Run it with `npm run demo:data` after editing.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Litres per cow per day — every flow volume in the demo derives from this. */
const LITRES_PER_COW = 24;
/** Herd multiplier: the farms run at commercial scale, not smallholding. */
const HERD_SCALE = 12;

/**
 * Columns where one stage of the chain ends and the next begins. Half a cell
 * of extra room is inserted at each, so the segments read as groups rather
 * than one continuous run of nodes. Half a cell is still a whole major grid
 * square, so everything stays on the grid.
 */
const SEGMENT_BREAKS = [2, 3, 6, 10, 11, 12, 13];
const column = (col) => col + SEGMENT_BREAKS.filter((brk) => col > brk).length * 0.5;
const round = (n) => Math.round(n);

const nodes = [];
const edges = [];
const positions = {};

/** @param {{id:string,label:string,col:number,row:number,type:string,parent?:string,classes?:string,data?:object}} spec */
function node({ id, label, col, row, type, parent, classes, data }) {
  nodes.push({
    group: 'nodes',
    type,
    data: { id, label, ...(parent ? { parent } : {}), ...data },
    ...(classes ? { classes } : {}),
  });
  positions[id] = { col: column(col), row };
}

/**
 * Fills in the `Ist` / `Plan` readout once the flows are known: a node's
 * actual is what flows out of it (or into it, for a sink), in tonnes per day,
 * and the plan is that rounded up to the nearest whole tonne.
 */
function addReadouts() {
  const out = new Map();
  const into = new Map();
  for (const { data } of edges) {
    out.set(data.source, (out.get(data.source) ?? 0) + (data.litres ?? 0));
    into.set(data.target, (into.get(data.target) ?? 0) + (data.litres ?? 0));
  }

  // A stable spread of headroom, so the gauges read differently from each
  // other instead of all sitting at 100%.
  const headroom = (id) => {
    let hash = 0;
    for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 997;
    return 1.1 + (hash % 60) / 100;
  };

  for (const element of nodes) {
    const { data } = element;
    if (data.isParent) continue;
    const litres = out.get(data.id) ?? into.get(data.id) ?? 0;
    const tonnes = litres / 1000;
    data.actual = Math.round(tonnes * 10) / 10;
    // Stores hold a few days' worth, so their capacity is not a daily figure.
    const factor = element.type === 'StorageNode' ? headroom(data.id) * 2.5 : headroom(data.id);
    data.plan = Math.max(1, Math.round(tonnes * factor));
    data.unit = 't';
  }
}

function group(id, label, data = {}) {
  nodes.push({ group: 'nodes', type: 'GroupNode', data: { id, label, isParent: true, ...data } });
}

function edge(source, target, data = {}) {
  edges.push({ group: 'edges', data: { id: `${source}__${target}`, source, target, ...data } });
}

// ---------------------------------------------------------------- farms ----
// Each farm is one company: its own pastures, stable and milking parlour.
const farms = [
  {
    id: 'brook',
    label: 'Hollow Brook Farm — Brook Dairy Co.',
    row: 0,
    owner: 'Brook Dairy Co.',
    pastures: [
      ['North Meadow', 120],
      ['Riverside Pasture', 85],
      ['Clover Hill', 140],
      ['Long Acre', 95],
    ],
  },
  {
    id: 'windmill',
    label: 'Windmill Dairy — Windmill Organics Ltd.',
    row: 5,
    owner: 'Windmill Organics Ltd.',
    organic: true,
    pastures: [
      ['Mill Field', 70],
      ['Orchard Ley', 55],
      ['Beacon Rise', 60],
    ],
  },
  {
    id: 'alpine',
    label: 'Alpine Co-op — Alpenmilch eG',
    row: 9,
    owner: 'Alpenmilch eG',
    organic: true,
    pastures: [
      ['Alpine Slope', 40],
      ['Summer Alp', 35],
    ],
  },
];

for (const farm of farms) {
  // Scale the herds once, here: every volume in the graph is derived from them.
  farm.pastures = farm.pastures.map(([label, herd]) => [label, herd * HERD_SCALE]);
  group(`${farm.id}-farm`, farm.label, { owner: farm.owner });

  farm.pastures.forEach(([label, herd], index) => {
    const id = `${farm.id}-pasture-${index + 1}`;
    node({
      id,
      label: `${label}`,
      col: 0,
      row: farm.row + index,
      type: 'FieldNode',
      parent: `${farm.id}-farm`,
      data: { herd, owner: farm.owner, ...(farm.organic ? { organic: true } : {}) },
    });
    edge(id, `${farm.id}-stable`, { mode: 'herd', litres: herd * LITRES_PER_COW });
  });

  farm.litres = farm.pastures.reduce((n, [, herd]) => n + herd * LITRES_PER_COW, 0);
  const middle = farm.row + Math.floor((farm.pastures.length - 1) / 2);
  const initial = farm.id[0].toUpperCase();
  node({
    id: `${farm.id}-stable`,
    label: 'Stable',
    col: 1,
    row: middle,
    type: 'FarmNode',
    parent: `${farm.id}-farm`,
    data: {
      code: `${initial}ST`,
      owner: farm.owner,
      places: farm.pastures.reduce((n, [, herd]) => n + herd, 0),
    },
  });
  node({
    id: `${farm.id}-milkery`,
    label: 'Milking parlour',
    col: 2,
    row: middle,
    type: 'FarmNode',
    parent: `${farm.id}-farm`,
    data: { code: `${initial}ML`, owner: farm.owner, litresPerDay: farm.litres },
  });
  edge(`${farm.id}-stable`, `${farm.id}-milkery`, { mode: 'herd', litres: farm.litres });
}

// ------------------------------------------------------------ transport ----
// Brook and Windmill go by truck to the rail terminal, then by train to the
// siding at the plant. Alpine is close enough to send a truck straight there.
node({ id: 'truck-brook', label: 'Truck route A', col: 3, row: 1, type: 'TransportNode', data: { code: 'TRA', mode: 'road', tonnes: 18 } });
node({ id: 'truck-windmill', label: 'Truck route B', col: 3, row: 6, type: 'TransportNode', data: { code: 'TRB', mode: 'road', tonnes: 12 } });
node({ id: 'truck-alpine', label: 'Truck route C (direct)', col: 3, row: 9, type: 'TransportNode', data: { code: 'TRC', mode: 'road', tonnes: 6 } });
node({ id: 'station-south', label: 'Südbahnhof terminal', col: 4, row: 3, type: 'TransportNode', data: { code: 'SBF', sidings: 3 } });
node({ id: 'milk-train', label: 'Milk train', col: 5, row: 3, type: 'TransportNode', data: { code: 'TRN', wagons: 9, litres: 240000 } });
node({ id: 'station-north', label: 'Plant siding', col: 6, row: 3, type: 'TransportNode', data: { code: 'SID', sidings: 2 } });

const litresOf = (id) => farms.find((f) => f.id === id).litres;
const RAIL_LITRES = litresOf('brook') + litresOf('windmill');
const ALPINE_RAW = 400; // goes straight to the farm shop, never entering the plant
const ALPINE_TO_PLANT = litresOf('alpine') - ALPINE_RAW;

edge('brook-milkery', 'truck-brook', { mode: 'bulk', litres: litresOf('brook') });
edge('windmill-milkery', 'truck-windmill', { mode: 'bulk', litres: litresOf('windmill') });
edge('alpine-milkery', 'truck-alpine', { mode: 'chilled', litres: litresOf('alpine') });
edge('truck-brook', 'station-south', { mode: 'bulk', litres: litresOf('brook') });
edge('truck-windmill', 'station-south', { mode: 'bulk', litres: litresOf('windmill') });
edge('station-south', 'milk-train', { mode: 'rail', litres: RAIL_LITRES });
edge('milk-train', 'station-north', { mode: 'rail', litres: RAIL_LITRES });

// ----------------------------------------------------------- production ----
// One group per line, each with its own process steps.
const lines = [
  {
    id: 'bottling',
    label: 'Bottling line',
    row: 0,
    share: 0.45,
    steps: [
      ['Pasteurise', { temp: '72°C / 15s' }],
      ['Homogenise', { pressure: '180 bar' }],
      ['Fill & cap', { format: '1 L PET' }],
    ],
  },
  {
    id: 'cheese',
    label: 'Cheese line',
    row: 2,
    share: 0.3,
    steps: [
      ['Curdling vat', { culture: 'mesophilic' }],
      ['Cut & drain', { yield: '10%' }],
      ['Pressing', { hours: 6 }],
      ['Brine bath', { hours: 24 }],
    ],
  },
  {
    id: 'yogurt',
    label: 'Yogurt line',
    row: 5,
    share: 0.15,
    steps: [
      ['Culture mixing', { strains: 2 }],
      ['Incubation', { hours: 7 }],
      ['Cool & stir', { temp: '4°C' }],
    ],
  },
  {
    id: 'butter',
    label: 'Butter line',
    row: 7,
    share: 0.1,
    steps: [
      ['Cream separation', { fat: '40%' }],
      ['Churning', { minutes: 45 }],
      ['Kneading & shaping', { format: '250 g' }],
    ],
  },
];

for (const line of lines) {
  group(`${line.id}-line`, line.label);
  const fromRail = round(RAIL_LITRES * line.share);
  const fromAlpine = round(ALPINE_TO_PLANT * line.share);
  line.input = fromRail + fromAlpine;
  // What leaves each step. Cheese drops hard once the whey is drained off;
  // butter does the same at the churn.
  const retention = { cheese: [1, 0.42, 0.18, 0.16], butter: [1, 0.3, 0.28] };
  const keep = retention[line.id] ?? line.steps.map((_, i) => 1 - i * 0.01);
  line.volumes = keep.map((factor) => round(line.input * factor));
  let previous = null;

  line.steps.forEach(([label, data], index) => {
    const id = `${line.id}-${index + 1}`;
    node({
      id,
      label: `${index + 1}. ${label}`,
      col: 7 + index,
      row: line.row,
      type: 'FacilityNode',
      parent: `${line.id}-line`,
      data: { code: `${line.id.slice(0, 2).toUpperCase()}${index + 1}`, step: index + 1, ...data },
    });
    // Each step loses a little to trim and cleaning; the cheese and butter
    // lines lose much more to whey and buttermilk, handled further down.
    if (previous) edge(previous, id, { mode: 'process', litres: line.volumes[index] });
    previous = id;
  });
  line.output = line.volumes[line.volumes.length - 1];

  // Raw milk arrives from the plant siding and the direct truck.
  edge('station-north', `${line.id}-1`, { mode: 'bulk', litres: fromRail });
  edge('truck-alpine', `${line.id}-1`, {
    mode: 'chilled',
    litres: fromAlpine,
    seasonal: line.id === 'cheese',
  });
}

// -------------------------------------------------------------- cooling ----
// Two cooling sites, one of them a third party, plus the cheese cellar.
node({ id: 'cold-plant', label: 'Cold store (plant)', col: 11, row: 0, type: 'StorageNode', data: { code: 'CLP', owner: 'Hollow Brook Creamery', pallets: 80 } });
node({ id: 'cold-3p', label: 'Cold store (3rd party)', col: 11, row: 5, type: 'StorageNode', data: { code: 'CL3', owner: 'FrostLink AG', pallets: 240, shared: true } });
node({ id: 'cellar', label: 'Maturing cellar', col: 11, row: 2, type: 'StorageNode', data: { weeks: 14 } });

const yielded = Object.fromEntries(lines.map((line) => [line.id, line.output]));
const yogurtSplit = round(yielded.yogurt / 2);

edge('bottling-3', 'cold-plant', { mode: 'chilled', litres: yielded.bottling });
edge('yogurt-3', 'cold-plant', { mode: 'chilled', litres: yogurtSplit });
edge('yogurt-3', 'cold-3p', { mode: 'chilled', litres: yielded.yogurt - yogurtSplit });
edge('cheese-4', 'cellar', { mode: 'process', litres: yielded.cheese });
edge('butter-3', 'cold-3p', { mode: 'chilled', litres: yielded.butter });

// ------------------------------------------------- shared storage/labels ----
node({ id: 'warehouse', label: 'Shared warehouse', col: 12, row: 2, type: 'StorageNode', data: { shared: true, owner: 'FrostLink AG' } });
node({ id: 'labeling', label: 'Labeling & packing', col: 12, row: 5, type: 'StorageNode', data: { shared: true, lines: 4 } });

const coldPlant = yielded.bottling + yogurtSplit;
const cold3p = yielded.yogurt - yogurtSplit + yielded.butter;
const FARM_SHOP_SHARE = 400;
const labeled = coldPlant + cold3p + yielded.cheese - FARM_SHOP_SHARE;

edge('cold-plant', 'warehouse', { mode: 'chilled', litres: coldPlant });
edge('cold-3p', 'warehouse', { mode: 'chilled', litres: cold3p });
edge('cellar', 'warehouse', { mode: 'chilled', label: '14 wks', litres: yielded.cheese });
edge('warehouse', 'labeling', { mode: 'internal', litres: labeled });

// ------------------------------------------------------------- channels ----
const channels = [
  ['supermarket', 'Supermarket DC', 0, { stores: 48 }],
  ['grocers', 'City Grocers', 2, { stores: 6 }],
  ['online', 'Online shop', 5, { subscriptions: 2300 }],
  ['farmshop', 'Farm shop', 7, { onSite: true }],
  ['cafe', 'Café wholesale', 9, { accounts: 34 }],
];
for (const [id, label, row, data] of channels) {
  node({ id, label, col: 13, row, type: 'RetailNode', parent: 'channels', data });
}
group('channels', 'Sales channels');

// How the labeled output is split between the sales channels.
const share = { supermarket: 0.55, grocers: 0.2, online: 0.17, cafe: 0.08 };
edge('labeling', 'supermarket', { mode: 'chilled', litres: round(labeled * share.supermarket) });
edge('labeling', 'grocers', { mode: 'chilled', litres: round(labeled * share.grocers) });
edge('labeling', 'online', { mode: 'parcel', litres: round(labeled * share.online) });
edge('labeling', 'cafe', { mode: 'chilled', litres: round(labeled * share.cafe) });
edge('warehouse', 'farmshop', { mode: 'chilled', litres: FARM_SHOP_SHARE });
// Raw milk never enters the plant: it goes from the farm straight to the shop.
edge('truck-alpine', 'farmshop', { mode: 'chilled', label: 'raw', litres: ALPINE_RAW });

// ------------------------------------------------------------ customers ----
const customers = [
  ['cust-family', 'Family household', 0],
  ['cust-chef', 'Restaurant chef', 2],
  ['cust-student', 'Student flat', 5],
  ['cust-local', 'Village local', 7],
  ['cust-barista', 'Barista', 9],
];
for (const [id, label, row] of customers) {
  node({ id, label, col: 14, row, type: 'CustomerNode' });
}

// One household or venue is a rounding error next to the bulk flows, which is
// the point: the sqrt scale keeps these readable instead of hairline thin.
edge('supermarket', 'cust-family', { mode: 'counter', litres: 14 });
edge('supermarket', 'cust-student', { mode: 'counter', litres: 6 });
edge('grocers', 'cust-chef', { mode: 'counter', litres: 90 });
edge('grocers', 'cust-family', { mode: 'counter', litres: 11 });
edge('online', 'cust-student', { mode: 'parcel', label: 'weekly box', litres: 4 });
edge('online', 'cust-family', { mode: 'parcel', litres: 9 });
edge('farmshop', 'cust-local', { mode: 'counter', litres: 7 });
edge('farmshop', 'cust-chef', { mode: 'counter', litres: 45 });
edge('cafe', 'cust-barista', { mode: 'counter', litres: 120 });

// ----------------------------------------------------------- by-products ----
// The waste line hangs off the bottom: whey and buttermilk fall out of the
// cheese and butter lines and are trucked to the piggery.
node({ id: 'whey-tank', label: 'Whey tank', col: 9, row: 9, type: 'ByproductNode', data: { litresPerDay: 9000 } });
node({ id: 'buttermilk-tank', label: 'Buttermilk tank', col: 9, row: 11, type: 'ByproductNode', data: { litresPerDay: 2200 } });
node({ id: 'whey-tanker', label: 'By-product tanker', col: 11, row: 10, type: 'ByproductNode', data: { mode: 'road' } });
node({ id: 'piggery', label: 'Piggery', col: 13, row: 10, type: 'ByproductNode', data: { pigs: 400 } });

// Whatever each step drops is what the by-product line carries.
const cheeseLine = lines.find((l) => l.id === 'cheese');
const butterLine = lines.find((l) => l.id === 'butter');
const wheyDrain = cheeseLine.volumes[0] - cheeseLine.volumes[1];
const wheyPress = cheeseLine.volumes[1] - cheeseLine.volumes[2];
const buttermilk = butterLine.volumes[0] - butterLine.volumes[1];

edge('cheese-2', 'whey-tank', { waste: true, label: 'whey', litres: wheyDrain });
edge('cheese-3', 'whey-tank', { waste: true, litres: wheyPress });
edge('butter-2', 'buttermilk-tank', { waste: true, label: 'buttermilk', litres: buttermilk });
edge('whey-tank', 'whey-tanker', { waste: true, litres: wheyDrain + wheyPress });
edge('buttermilk-tank', 'whey-tanker', { waste: true, litres: buttermilk });
edge('whey-tanker', 'piggery', { waste: true, mode: 'road', litres: wheyDrain + wheyPress + buttermilk });

// ---------------------------------------------------------------- styles ----
const stylesheets = [
  // Node colours live in the node classes under `src/app/joint/nodes/`.
  // What is left here is what the type alone cannot know: the tint of each
  // group, per-instance modifiers, and edge colour.
  //
  // Edges are solid throughout. A dash pattern on a 120px band renders as a
  // comb of teeth rather than a dashed line, so the mode is carried by colour
  // alone.
  { selector: '#brook-farm', style: { 'body/fill': '#fefce8' } },
  { selector: '#windmill-farm', style: { 'body/fill': '#fefce8' } },
  { selector: '#alpine-farm', style: { 'body/fill': '#fefce8' } },
  { selector: '#bottling-line', style: { 'body/fill': '#eff6ff' } },
  { selector: '#cheese-line', style: { 'body/fill': '#eff6ff' } },
  { selector: '#yogurt-line', style: { 'body/fill': '#eff6ff' } },
  { selector: '#butter-line', style: { 'body/fill': '#eff6ff' } },
  { selector: '#channels', style: { 'body/fill': '#f5f3ff' } },

  { selector: 'node[?shared]', style: { 'body/strokeDasharray': '6,3' } },
  { selector: 'node[?organic]', style: { 'body/strokeWidth': 2.5 } },

  { selector: 'edge[mode = herd]', style: { 'line/stroke': '#10b981', 'line/targetMarker/fill': '#10b981' } },
  { selector: 'edge[mode = bulk]', style: { 'line/stroke': '#0ea5e9', 'line/targetMarker/fill': '#0ea5e9' } },
  { selector: 'edge[mode = rail]', style: { 'line/stroke': '#475569', 'line/targetMarker/fill': '#475569' } },
  { selector: 'edge[mode = chilled]', style: { 'line/stroke': '#06b6d4', 'line/targetMarker/fill': '#06b6d4' } },
  { selector: 'edge[mode = process]', style: { 'line/stroke': '#3b82f6', 'line/targetMarker/fill': '#3b82f6' } },
  { selector: 'edge[mode = parcel]', style: { 'line/stroke': '#6366f1', 'line/targetMarker/fill': '#6366f1' } },
  { selector: 'edge[mode = counter]', style: { 'line/stroke': '#8b5cf6', 'line/targetMarker/fill': '#8b5cf6' } },
  { selector: 'edge[?waste]', style: { 'line/stroke': '#a855f7', 'line/targetMarker/fill': '#a855f7' } },
];

addReadouts();

const data = {
  config: {
    // A node is 300x300 — one major grid square. The cell pitch is two of
    // those, so every node sits on a major square with an empty one beside and
    // below it for routes to run in.
    // Square cells: a node fills one major grid square and leaves the next
    // free for routes. Half-cell steps are available for placement, which is
    // how the gaps between chain segments are made.
    grid: { cellWidth: 600, cellHeight: 600 },
    // Thickness carries volume: litres per day, square-rooted so a flow a
    // hundred times bigger reads as ten times thicker instead of swamping it.
    edges: {
      bundle: true,
      router: 'avoid',
      // Five width classes rather than a continuous scale: the volumes span
      // four orders of magnitude, and on a continuous scale everything below
      // the trunk lines ends up the same thickness.
      weight: {
        field: 'litres',
        min: 8,
        max: 56,
        scale: 'quantile',
        steps: 5,
        label: { unit: ' L', compact: true },
      },
    },
    collapsed: [],
    positions,
  },
  stylesheets,
  elements: [...nodes, ...edges],
};

const out = fileURLToPath(new URL('../public/graph.json', import.meta.url));
writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
console.log(
  `wrote ${out}: ${nodes.length} nodes (${nodes.filter((n) => n.data.isParent).length} groups), ${edges.length} edges`,
);
