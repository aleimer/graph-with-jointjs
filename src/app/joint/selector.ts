import { dia } from '@joint/core';
import { classesOf, dataOf } from './cell-state';

/**
 * A small subset of the Cytoscape selector language, enough to keep stylesheet
 * rules, event delegation and remove/restore calls readable:
 *
 *   `*`                every cell          `node`, `edge`   by kind
 *   `#id`              by id               `.class`         by class
 *   `[key]`            data key present    `[?key]`         data key truthy
 *   `[key = value]`    equality            `[key != value]` inequality
 *
 * Parts combine (`node.group[?collapsed]`) and comma-separated groups are OR'd
 * (`node, edge`). Anything unsupported throws rather than silently matching
 * nothing — a typo in a selector is otherwise invisible, and a selector that
 * quietly matches everything is worse than one that matches nothing: it is
 * what `remove()` and `config.filter` are handed.
 *
 * An id may not contain `.`, because `#id.class` has to split into the two.
 */

type Matcher = (cell: dia.Cell) => boolean;

const TOKEN =
  /\s*(?:(\*)|#([\w:-]+)|\.([\w-]+)|\[([^\]]*)\]|(node|edge))\s*/y;

const ATTRIBUTE = /^\s*(\?)?([\w.-]+)\s*(?:(!?=)\s*(.*?))?\s*$/;

const cache = new Map<string, Matcher>();

function attributeMatcher(body: string): Matcher {
  const parsed = ATTRIBUTE.exec(body);
  if (!parsed) throw new Error(`Unsupported attribute selector: [${body}]`);
  const [, truthy, key, operator, rawValue] = parsed;

  if (truthy) return (cell) => Boolean(dataOf(cell)[key]);
  if (!operator) return (cell) => dataOf(cell)[key] !== undefined;

  const value = rawValue.replace(/^['"]|['"]$/g, '');
  return (cell) => {
    const actual = dataOf(cell)[key];
    const equal = String(actual) === value;
    return operator === '=' ? equal : !equal;
  };
}

function compilePart(part: string): Matcher {
  // An empty part is a stray comma, not a wildcard. Left to fall through it
  // would compile to no tests at all, and no tests means every cell matches —
  // so `remove('node,')` would empty the graph.
  if (!part) throw new Error('Empty selector: a stray comma, or nothing but whitespace');

  const tests: Matcher[] = [];
  TOKEN.lastIndex = 0;

  while (TOKEN.lastIndex < part.length) {
    const start = TOKEN.lastIndex;
    const token = TOKEN.exec(part);
    if (!token || TOKEN.lastIndex === start) {
      throw new Error(`Unsupported selector: "${part}"`);
    }
    const [, any, id, className, attribute, kind] = token;

    if (any) continue;
    if (id) tests.push((cell) => String(cell.id) === id);
    else if (className) tests.push((cell) => classesOf(cell).includes(className));
    else if (attribute !== undefined) tests.push(attributeMatcher(attribute));
    else if (kind === 'node') tests.push((cell) => cell.isElement());
    else tests.push((cell) => cell.isLink());
  }

  if (!tests.length) return () => true;
  return (cell) => tests.every((test) => test(cell));
}

/** Compiles (and caches) a selector into a predicate. */
export function matcher(selector?: string): Matcher {
  if (!selector || selector === '*') return () => true;

  const cached = cache.get(selector);
  if (cached) return cached;

  const parts = selector.split(',').map((part) => compilePart(part.trim()));
  const compiled: Matcher = parts.length === 1 ? parts[0] : (cell) => parts.some((p) => p(cell));

  cache.set(selector, compiled);
  return compiled;
}

export function matches(cell: dia.Cell, selector?: string): boolean {
  return matcher(selector)(cell);
}
