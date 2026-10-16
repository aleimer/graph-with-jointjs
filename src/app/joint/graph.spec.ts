import { dia } from '@joint/core';
import Graph from './graph';
import { FieldNode, GroupNode } from './nodes';
import { FlowLink } from './edges';
import { filter } from 'rxjs';
import { write } from './cell-state';
import { isChanged } from './events';
import { matches } from './selector';
import type { ElementDefinition } from './types';

const SEED: ElementDefinition[] = [
  { data: { id: 'ingest', label: 'Fetch' }, classes: 'terminal' },
  { data: { id: 'transform', label: 'Transform', parent: 'pipeline' } },
  { data: { id: 'validate', label: 'Validate', parent: 'pipeline' } },
  { data: { id: 'store', label: 'Store' } },
  { data: { id: 'e1', source: 'ingest', target: 'transform' } },
  { data: { id: 'e2', source: 'ingest', target: 'validate' } },
  { data: { id: 'e3', source: 'transform', target: 'store' } },
  { data: { id: 'e4', source: 'validate', target: 'store' } },
];

describe('selector', () => {
  const graph = new dia.Graph();
  const node = new GroupNode({ id: 'a' });
  write(node, 'classes', ['group', 'open']);
  write(node, 'data', { id: 'a', kind: 'batch', optional: false });
  graph.addCell(node);

  it('matches by kind, id and class', () => {
    expect(matches(node, 'node')).toBe(true);
    expect(matches(node, 'edge')).toBe(false);
    expect(matches(node, '#a')).toBe(true);
    expect(matches(node, '.group')).toBe(true);
    expect(matches(node, '.missing')).toBe(false);
  });

  it('matches compound parts, attributes and comma groups', () => {
    expect(matches(node, 'node.group[kind = batch]')).toBe(true);
    expect(matches(node, 'node.group[kind = stream]')).toBe(false);
    expect(matches(node, '[?optional]')).toBe(false);
    expect(matches(node, '[kind]')).toBe(true);
    expect(matches(node, 'edge, #a')).toBe(true);
  });

  it('splits an id from a class that follows it', () => {
    expect(matches(node, '#a.group')).toBe(true);
    expect(matches(node, '#a.missing')).toBe(false);
    expect(matches(node, '#b.group')).toBe(false);
  });

  it('rejects a selector it cannot parse instead of matching nothing', () => {
    expect(() => matches(node, 'node >>> edge')).toThrow();
  });

  it('rejects an empty part rather than matching everything', () => {
    // A stray comma used to compile to no tests at all, and no tests matched
    // every cell — so `remove('node,')` would have emptied the graph.
    expect(() => matches(node, 'node,')).toThrow();
    expect(() => matches(node, ',node')).toThrow();
    expect(() => matches(node, 'node, ,edge')).toThrow();
    expect(() => matches(node, '   ')).toThrow();
  });

  it('still treats a missing selector as a wildcard', () => {
    expect(matches(node)).toBe(true);
    expect(matches(node, '*')).toBe(true);
  });
});

describe('Graph facade', () => {
  let graph: Graph;

  const linkById = (id: string) => graph.model.getCell(id) as dia.Link;
  const pipeline = () => graph.model.getCell('pipeline') as dia.Element;

  beforeEach(() => {
    // Model-only: jsdom implements no SVG geometry API, so there is no paper.
    // Everything asserted here lives in the model anyway.
    graph = new Graph();
    graph.addElements(SEED);
  });

  afterEach(() => graph.destroy());

  it('renders each node type from its own html()', () => {
    graph.addElements([
      { type: 'FieldNode', data: { id: 'meadow', label: 'North Meadow', actual: 2.9, plan: 3 } },
    ]);
    const field = graph.model.getCell('meadow') as FieldNode;

    // The class writes SVG; `@selector` names are what attrs target afterwards.
    expect(field.html()).toContain('@selector="body"');
    expect(field.html()).toContain('@selector="icon"');

    // ...and that markup is what the model carries.
    const markup = field.get('markup') as { selector?: string }[];
    const selectors = markup.map((node) => node.selector);
    expect(selectors).toEqual(
      expect.arrayContaining(['ring', 'body', 'code', 'label', 'icon', 'actual', 'plan']),
    );

    // One major grid square.
    expect(field.size()).toEqual({ width: 300, height: 300 });
  });

  it('fills the readout from the element data', () => {
    graph.addElements([
      { type: 'FacilityNode', data: { id: 'pas', label: 'Pasteurise', actual: 39, plan: 42 } },
      { type: 'FacilityNode', data: { id: 'coded', label: 'Cut & drain', code: 'CUT' } },
    ]);

    const pasteurise = graph.model.getCell('pas');
    // The code is derived from the name unless the data names one.
    expect(pasteurise.attr('code/text')).toBe('PAS');
    expect(pasteurise.attr('label/text')).toBe('PASTEURISE');
    expect(pasteurise.attr('actual/text')).toBe('39');
    expect(pasteurise.attr('plan/text')).toBe('42');
    expect(pasteurise.attr('unit/text')).toBe('[t]');

    expect(graph.model.getCell('coded').attr('code/text')).toBe('CUT');
    // No plan in the data leaves the box empty rather than showing a zero.
    expect(graph.model.getCell('coded').attr('plan/text')).toBe('');
  });

  it('builds the node class named by the element type', () => {
    graph.addElements([
      { type: 'FieldNode', data: { id: 'meadow', label: 'North Meadow' } },
      { type: 'playground.FieldNode', data: { id: 'ley', label: 'Orchard Ley' } },
      { type: 'NoSuchNode', data: { id: 'mystery', label: 'Mystery' } },
    ]);

    expect(graph.model.getCell('meadow')).toBeInstanceOf(FieldNode);
    // Fully qualified names resolve too...
    expect(graph.model.getCell('ley')).toBeInstanceOf(FieldNode);
    // ...and an unknown type falls back rather than throwing.
    expect(graph.model.getCell('mystery')).toBeDefined();
    expect(graph.model.getCell('mystery')).not.toBeInstanceOf(FieldNode);
  });

  it('creates a group for a referenced parent and embeds its children', () => {
    expect(pipeline()).toBeInstanceOf(GroupNode);
    expect(pipeline().getEmbeddedCells().map((cell) => String(cell.id)).sort()).toEqual([
      'transform',
      'validate',
    ]);
    // 4 seeded nodes + the `pipeline` group, which nothing declared explicitly.
    expect(graph.data.nodes.length).toBe(5);
    expect(graph.data.edges.length).toBe(4);
  });

  it('redirects crossing edges to the group on collapse and restores them on expand', () => {
    graph.collapse([pipeline()]);

    // Children are off the graph, the four edges survive re-pointed at the group.
    expect(graph.model.getCell('transform')).toBeUndefined();
    expect(graph.model.getLinks().length).toBe(4);
    expect(String(linkById('e1').target().id)).toBe('pipeline');
    expect(String(linkById('e3').source().id)).toBe('pipeline');
    // Untouched end stays put.
    expect(String(linkById('e3').target().id)).toBe('store');

    graph.expand([pipeline()]);

    expect(graph.model.getCell('transform')).toBeDefined();
    expect(pipeline().getEmbeddedCells().length).toBe(2);
    expect(String(linkById('e1').target().id)).toBe('transform');
    expect(String(linkById('e3').source().id)).toBe('transform');
  });

  it('keeps edges that are internal to the group out of the collapsed view', () => {
    graph.addElements([{ data: { id: 'inner', source: 'transform', target: 'validate' } }]);
    expect(graph.model.getLinks().length).toBe(5);

    graph.collapse([pipeline()]);
    expect(graph.model.getCell('inner')).toBeUndefined();

    graph.expand([pipeline()]);
    expect(graph.model.getCell('inner')).toBeDefined();
  });

  it('bundles co-directed edges when configured, and unbundles on expand', () => {
    graph.setConfig({ edges: { bundle: true } });
    graph.collapse([pipeline()]);

    // e1+e2 (ingest→group) and e3+e4 (group→store) each collapse into one.
    expect(graph.model.getLinks().length).toBe(2);
    const survivor = graph.model.getLinks()[0];
    expect(survivor.labels()[0].attrs?.['text']?.['text']).toBe('×2');

    graph.expand([pipeline()]);
    expect(graph.model.getLinks().length).toBe(4);
  });

  it('restores a bundled edge label after expanding', () => {
    graph.addElements([
      { data: { id: 'labelled', source: 'transform', target: 'store', label: 'whey' } },
    ]);
    graph.setConfig({ edges: { bundle: true } });

    const labelText = (link: dia.Link) => link.labels()[0]?.attrs?.['text']?.['text'];
    expect(labelText(linkById('labelled'))).toBe('whey');

    graph.collapse([pipeline()]);
    graph.expand([pipeline()]);

    // The count label is gone and the original is back, not lost to bundling.
    expect(labelText(linkById('labelled'))).toBe('whey');
  });

  it('hides filtered cells rather than removing them', () => {
    graph.render();
    graph.setConfig({ filter: 'node' });

    expect(linkById('e1').attr('root/display')).toBe('none');
    expect(graph.model.getCell('ingest').attr('root/display')).toBeFalsy();
    expect(graph.model.getLinks().length).toBe(4);

    graph.setConfig({ filter: undefined });
    expect(linkById('e1').attr('root/display')).toBeFalsy();
  });

  it('applies stylesheet rules by selector', () => {
    graph
      .registerStylesheets([
        { selector: '.terminal', style: { 'body/fill': '#eef2ff' } },
        { selector: 'edge', style: { 'line/stroke': '#dc2626' } },
      ])
      .render();

    expect(graph.model.getCell('ingest').attr('body/fill')).toBe('#eef2ff');
    expect(graph.model.getCell('store').attr('body/fill')).not.toBe('#eef2ff');
    expect(linkById('e1').attr('line/stroke')).toBe('#dc2626');
  });

  it('removes and restores by selector', () => {
    graph.remove('#store');
    expect(graph.model.getCell('store')).toBeUndefined();

    graph.restore('#store');
    expect(graph.model.getCell('store')).toBeDefined();
  });

  it('converts between grid cells and pixels', () => {
    graph.setConfig({ grid: { cellWidth: 200, cellHeight: 100 } });

    expect(graph.toPixels({ col: 5, row: 2 })).toEqual({ x: 1000, y: 200 });
    expect(graph.toPixels({ col: 0, row: 0 })).toEqual({ x: 0, y: 0 });
    // Pixels pass through untouched.
    expect(graph.toPixels({ x: 17, y: 42 })).toEqual({ x: 17, y: 42 });
    // Snapping rounds to the nearest *half* cell: whole cells are a blunt
    // step once a cell is several hundred pixels across.
    expect(graph.toGrid({ x: 1040, y: 160 })).toEqual({ col: 5, row: 1.5 });
    expect(graph.toGrid({ x: 1090, y: 140 })).toEqual({ col: 5.5, row: 1.5 });
  });

  it('places nodes from grid positions and reports them back', () => {
    graph.setConfig({
      grid: { cellWidth: 200, cellHeight: 100 },
      positions: { ingest: { col: 3, row: 1 }, store: { col: 6, row: 4 } },
    });
    graph.setPosition();

    expect((graph.model.getCell('ingest') as dia.Element).position()).toEqual({ x: 600, y: 100 });
    expect(graph.gridPositions()['ingest']).toEqual({ col: 3, row: 1 });
    expect(graph.gridPositions()['store']).toEqual({ col: 6, row: 4 });
  });

  it('moves a single node to a cell', () => {
    graph.setConfig({ grid: { cellWidth: 100, cellHeight: 50 } });
    graph.setNodePosition('store', { col: 2, row: 3 });

    expect((graph.model.getCell('store') as dia.Element).position()).toEqual({ x: 200, y: 150 });
  });

  it('exports data that can be loaded straight back', () => {
    graph.setConfig({ grid: { cellWidth: 200, cellHeight: 100 } });
    graph.setNodePosition('ingest', { col: 4, row: 2 });

    const data = graph.toData();
    expect(data.config?.positions?.['ingest']).toEqual({ col: 4, row: 2 });
    expect(data.elements.filter((e) => e.group === 'nodes').length).toBe(5);
    expect(data.elements.filter((e) => e.group === 'edges').length).toBe(4);

    const reloaded = new Graph();
    reloaded.setConfig(data.config ?? {}).addElements(data.elements).render();
    expect(reloaded.gridPositions()['ingest']).toEqual({ col: 4, row: 2 });
    reloaded.destroy();
  });

  it('scales link thickness by a weight field', () => {
    graph.addElements([
      { data: { id: 'small', source: 'ingest', target: 'store', litres: 100 } },
      { data: { id: 'big', source: 'store', target: 'ingest', litres: 10000 } },
    ]);
    graph.setConfig({ edges: { weight: { field: 'litres', min: 3, max: 10, scale: 'linear' } } });
    graph.render();

    // Ends of the domain pin to the configured range...
    expect(linkById('small').attr('line/strokeWidth')).toBe(3);
    expect(linkById('big').attr('line/strokeWidth')).toBe(10);
    // ...and a link with no value keeps the node type's default of 2.
    expect(linkById('e1').attr('line/strokeWidth')).toBe(2);
  });

  it('gives each quantile of the values its own width', () => {
    // Values spanning orders of magnitude: on a continuous scale the first
    // four would all sit within a pixel or two of the minimum.
    graph.addElements([
      { data: { id: 'a', source: 'ingest', target: 'store', litres: 6 } },
      { data: { id: 'b', source: 'store', target: 'ingest', litres: 30 } },
      { data: { id: 'c', source: 'ingest', target: 'validate', litres: 900 } },
      { data: { id: 'd', source: 'validate', target: 'ingest', litres: 40000 } },
    ]);
    graph.setConfig({
      edges: { weight: { field: 'litres', min: 10, max: 40, scale: 'quantile', steps: 4 } },
    });
    graph.render();

    const width = (id: string) => linkById(id).attr('line/strokeWidth');
    // 6 and 30 are a world apart in rank even though they are a whisker apart
    // next to 40000, so they get their own classes.
    expect(width('a')).toBe(10);
    expect(width('b')).toBe(20);
    expect(width('c')).toBe(30);
    expect(width('d')).toBe(40);
  });

  it('uses a sqrt curve so a 100x flow is not 100x thicker', () => {
    graph.addElements([
      { data: { id: 'a', source: 'ingest', target: 'store', litres: 100 } },
      { data: { id: 'b', source: 'store', target: 'ingest', litres: 2500 } },
      { data: { id: 'c', source: 'ingest', target: 'validate', litres: 10000 } },
    ]);
    graph.setConfig({ edges: { weight: { field: 'litres', min: 0, max: 10, scale: 'sqrt' } } });
    graph.render();

    // sqrt puts 2500 at (50-10)/(100-10) = 0.44 of the range, not the 0.24 a
    // linear scale would give it.
    expect(linkById('a').attr('line/strokeWidth')).toBe(0);
    expect(linkById('b').attr('line/strokeWidth')).toBe(4.4);
    expect(linkById('c').attr('line/strokeWidth')).toBe(10);
  });

  it('prints the weight on the link and updates it in place', () => {
    graph.addElements([{ data: { id: 'flow', source: 'ingest', target: 'store', litres: 15000 } }]);
    graph.setConfig({ edges: { weight: { field: 'litres', label: { unit: ' L' } } } });
    graph.render();

    const labelsOf = (id: string) => linkById(id).labels();
    const textOf = (id: string) => labelsOf(id)[0]?.attrs?.['text']?.['text'];
    expect(textOf('flow')).toBe('15k L');

    // Re-running the styles must update the label, not append another.
    graph.render();
    expect(labelsOf('flow').length).toBe(1);

    // Turning labels off removes it again.
    graph.setConfig({ edges: { weight: { field: 'litres', label: false } } });
    expect(labelsOf('flow').length).toBe(0);
  });

  it('keeps a data label alongside the weight label', () => {
    graph.addElements([
      { data: { id: 'flow', source: 'ingest', target: 'store', litres: 900, label: 'whey' } },
    ]);
    graph.setConfig({ edges: { weight: { field: 'litres', label: { unit: ' L' } } } });
    graph.render();

    const texts = linkById('flow')
      .labels()
      .map((label) => label.attrs?.['text']?.['text']);
    expect(texts).toContain('whey');
    expect(texts).toContain('900 L');
  });

  it('holds a cell restored into a collapsed group until it expands', () => {
    // Removing a cell unembeds it, so by the time it is restored there is
    // nothing on the cell to say where it belonged. Put back on the graph
    // regardless, it stood beside a group that was not showing its children
    // and stayed orphaned from it for good.
    graph.remove('#transform');
    graph.collapse([pipeline()]);
    graph.restore('#transform');

    expect(graph.model.getCell('transform')).toBeUndefined();
    expect(pipeline().get('collapsed')).toBe(true);

    graph.expand([pipeline()]);

    expect(graph.model.getCell('transform')).toBeDefined();
    expect(pipeline().getEmbeddedCells().length).toBe(2);
  });

  it('re-embeds a restored cell when its group is open', () => {
    graph.remove('#transform');
    expect(pipeline().getEmbeddedCells().length).toBe(1);

    graph.restore('#transform');

    const transform = graph.model.getCell('transform') as dia.Element;
    expect(String(transform.getParentCell()?.id)).toBe('pipeline');
    expect(pipeline().getEmbeddedCells().length).toBe(2);
  });

  it('leaves a stashed cell alone when remove() cannot see it', () => {
    // `remove()` works on what is on the graph, and a collapsed group's
    // children are not. Expanding brings them back untouched.
    graph.collapse([pipeline()]);
    graph.remove('#transform');
    graph.expand([pipeline()]);

    expect(graph.model.getCell('transform')).toBeDefined();
    expect(pipeline().getEmbeddedCells().length).toBe(2);
  });

  it('round-trips a collapsed group through remove() and restore()', () => {
    graph.collapse([pipeline()]);
    graph.remove('#pipeline');
    expect(graph.model.getCell('pipeline')).toBeUndefined();

    graph.restore('#pipeline');
    graph.expand([pipeline()]);

    expect(graph.model.getCell('transform')).toBeDefined();
    expect(pipeline().getEmbeddedCells().length).toBe(2);
  });

  it('styles a link the paper drew, not only ones added through the facade', async () => {
    // The Connect tool adds a FlowLink straight to the model. Restyling only
    // from the facade's own methods left it at the default grey, with no
    // weight band, until something else happened to trigger a restyle.
    graph
      .registerStylesheets([{ selector: 'edge', style: { 'line/stroke': '#dc2626' } }])
      .render();

    const drawn = new FlowLink({ id: 'drawn', source: { id: 'ingest' }, target: { id: 'store' } });
    graph.model.addCell(drawn);

    await Promise.resolve();
    expect(drawn.attr('line/stroke')).toBe('#dc2626');
  });

  it('styles a group that addParents() created on the fly', async () => {
    graph
      .registerStylesheets([{ selector: 'node', style: { 'body/fill': '#123456' } }])
      .render();

    graph.addParents({ store: 'late-group' });

    await Promise.resolve();
    expect(graph.model.getCell('late-group').attr('body/fill')).toBe('#123456');
  });

  it('restyles once for a batch, not once per cell', async () => {
    graph.render();
    graph.setConfig({ edges: { weight: { field: 'litres' } } });

    // Counted at the source. Every indirect proxy for "a restyle happened"
    // also catches something else: the model is asked for its links by the
    // change announcement too, and for its cells by JointJS itself while
    // cells are being added.
    const inner = graph as unknown as { updateStyles(): void };
    const original = inner.updateStyles.bind(graph);
    let passes = 0;
    inner.updateStyles = () => {
      passes++;
      original();
    };

    graph.addElements([
      { data: { id: 'n1' } },
      { data: { id: 'n2' } },
      { data: { id: 'n3' } },
      { data: { id: 'x1', source: 'n1', target: 'n2', litres: 5 } },
      { data: { id: 'x2', source: 'n2', target: 'n3', litres: 50 } },
    ]);
    await Promise.resolve();

    expect(passes).toBe(1);
  });

  it('delivers pointer events to handlers that asked for them', () => {
    const seen: string[] = [];
    graph.addEvent({ events: 'tap', selector: 'node', handler: (e) => seen.push(`node:${e.cell?.id}`) });
    graph.addEvent({ events: 'tap', handler: (e) => seen.push(`any:${e.cell?.id ?? 'blank'}`) });
    graph.addEvent({ events: 'dbltap', handler: () => seen.push('dbl') });

    const tap = (cell: dia.Cell | null) =>
      graph.events$.next({
        kind: 'pointer',
        type: 'tap',
        cell,
        view: null,
        paper: null as unknown as dia.Paper,
        originalEvent: null,
        position: { x: 0, y: 0 },
      });

    tap(graph.model.getCell('store'));
    tap(linkById('e1'));
    tap(null);

    // A selector asks about cells, so the blank tap reaches only the handler
    // that did not give one, and the edge reaches neither `node` nor `dbltap`.
    expect(seen).toEqual(['node:store', 'any:store', 'any:e1', 'any:blank']);
  });

  it('coalesces model changes into one announcement', async () => {
    const counts: number[] = [];
    graph.events$.pipe(filter(isChanged)).subscribe((e) => counts.push(e.nodes));

    graph.addElements([
      { data: { id: 'c1' } },
      { data: { id: 'c2' } },
      { data: { id: 'c3' } },
    ]);
    await Promise.resolve();

    // Four seeded nodes, the group addParents() made for them, and three
    // more — announced once rather than once per cell.
    expect(counts).toEqual([8]);
  });

  it('ends its stream on destroy so subscribers do not outlive it', () => {
    let completed = false;
    graph.events$.subscribe({ complete: () => (completed = true) });

    graph.destroy();

    expect(completed).toBe(true);
  });

  it('round-trips the viewport', () => {
    graph.setViewPort({ pan: { x: 40, y: -20 }, zoom: 1.5 });
    graph.saveCurrentViewPort();

    expect(graph.viewPort).toEqual({ pan: { x: 40, y: -20 }, zoom: 1.5 });
  });
});
