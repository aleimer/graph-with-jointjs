/**
 * Measures how routing scales, and what each half of it contributes.
 *
 *   npm start                                  # in one terminal
 *   npm run bench:routing                      # in another
 *   npm run bench:routing -- --scales=1,2,3
 *   npm run bench:routing -- --strategies=combined,custom
 *
 * For every scale it tiles `public/graph.json` that many times, and for every
 * strategy it runs the acceptance harness against the running app and records
 * what passed and how long a re-route took. The original data file is put
 * back afterwards, including when a run fails part way.
 *
 * Copies are stacked vertically with a row of clearance, so they share the
 * same columns. That is what growth looks like on a supply chain — more
 * production lines beside the ones already there — and it keeps the gutters
 * contended. Tiling sideways would hand each copy an empty region of its own
 * and flatter the router.
 *
 * The three strategies, as `RouteStrategy` defines them:
 *
 *   combined  straight, then one bend, then a dog-leg, then libavoid
 *   custom    the same cascade with libavoid withheld
 *   avoid     libavoid alone, with the cascade skipped
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DATA = fileURLToPath(new URL('../public/graph.json', import.meta.url));
const BACKUP = `${DATA}.bench-backup`;
const HARNESS = fileURLToPath(new URL('./check-acceptance.mjs', import.meta.url));
const APP = process.env['APP_URL'] ?? 'http://localhost:4200/';

/** Time given to the dev server to serve the rewritten data file. */
const SETTLE_MS = 4000;

const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const scales = argOf('scales', '1,2,3').split(',').map(Number);
const strategies = argOf('strategies', 'combined,custom,avoid').split(',');

/** Writes `copies` tiled copies of the original data over `public/graph.json`. */
function tile(base, copies) {
  if (copies === 1) return base;

  const positions = base.config.positions ?? {};
  const pitch = Math.ceil(Math.max(...Object.values(positions).map((p) => p.row ?? 0))) + 2;

  const elements = [...base.elements];
  const allPositions = { ...positions };
  const collapsed = [...(base.config.collapsed ?? [])];

  for (let k = 1; k < copies; k++) {
    const tag = (id) => `c${k}-${id}`;

    for (const element of base.elements) {
      const data = { ...element.data, id: tag(element.data.id) };
      if (data.source) data.source = tag(data.source);
      if (data.target) data.target = tag(data.target);
      if (data.parent) data.parent = tag(data.parent);
      elements.push({ ...element, data });
    }
    for (const [id, at] of Object.entries(positions)) {
      allPositions[tag(id)] = { col: at.col, row: (at.row ?? 0) + k * pitch };
    }
    for (const id of base.config.collapsed ?? []) collapsed.push(tag(id));
  }

  return { ...base, elements, config: { ...base.config, positions: allPositions, collapsed } };
}

/** Runs the harness once and returns what it measured. */
function measure(strategy) {
  const url = new URL(APP);
  url.searchParams.set('routing', strategy);

  const run = spawnSync(process.execPath, [HARNESS, '--json'], {
    env: { ...process.env, APP_URL: url.href },
    encoding: 'utf8',
    maxBuffer: 1 << 24,
  });

  const line = (run.stdout ?? '').trim().split('\n').pop();
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(
      `harness gave no result for ${strategy}. Is the dev server up?\n${run.stderr || run.stdout}`,
    );
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

const original = readFileSync(DATA, 'utf8');
copyFileSync(DATA, BACKUP);
const rows = [];

try {
  for (const copies of scales) {
    writeFileSync(DATA, `${JSON.stringify(tile(JSON.parse(original), copies), null, 2)}\n`);
    await wait(SETTLE_MS);

    for (const strategy of strategies) {
      const result = measure(strategy);
      const passed = result.results.filter((r) => r.pass).length;
      rows.push({
        scale: `${copies}x`,
        strategy,
        nodes: result.nodes,
        links: result.links,
        passed: `${passed}/${result.results.length}`,
        ms: result.timing,
        failed: result.results.filter((r) => !r.pass).map((r) => r.name),
      });
      const last = rows[rows.length - 1];
      console.log(
        `  ${last.scale.padEnd(4)} ${strategy.padEnd(9)} ` +
          `${String(last.nodes).padStart(4)} nodes  ${String(last.links).padStart(4)} links  ` +
          `${last.passed.padEnd(5)} checks  ${String(last.ms).padStart(5)}ms`,
      );
    }
  }
} finally {
  writeFileSync(DATA, original);
  if (existsSync(BACKUP)) rmSync(BACKUP);
}

console.log('\n  scale  strategy    nodes  links  checks   re-route');
console.log('  ' + '-'.repeat(52));
for (const r of rows) {
  console.log(
    `  ${r.scale.padEnd(6)} ${r.strategy.padEnd(11)} ${String(r.nodes).padStart(5)}  ` +
      `${String(r.links).padStart(5)}  ${r.passed.padStart(6)}   ${String(r.ms).padStart(5)}ms` +
      (r.failed.length ? `   failed: ${r.failed.join(', ')}` : ''),
  );
}
console.log('');
