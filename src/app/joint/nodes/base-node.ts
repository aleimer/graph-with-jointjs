import { dia, shapes, util } from '@joint/core';
import { NODE_SIZE } from '../constants';

/** Fill and stroke for a node type. The icon takes the stroke colour. */
export interface NodePalette {
  fill: string;
  stroke: string;
}

/**
 * Parses an SVG string into JointJS markup. `@selector="body"` in the string
 * becomes the selector that `attrs` (and so the stylesheets) target, which is
 * why node markup is written as SVG text rather than hand-built JSON.
 *
 * `util.svg` is a tagged template, but it only iterates the strings array, so
 * a one-element array works for markup built at runtime.
 */
export function markupFromSvg(markup: string): dia.MarkupJSON {
  return util.svg([markup] as unknown as TemplateStringsArray);
}

/** Shown on the gauge when a node is running past its maximum. */
const OVER_CAPACITY = '#ef4444';

/** `Pasteurise` → `PAS`. Used when an element declares no code of its own. */
function deriveCode(label: string): string {
  const letters = label.replace(/[^\p{L}\p{N}]/gu, '');
  return letters.slice(0, 3).toUpperCase();
}

function formatValue(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '–';
  if (Math.abs(value) >= 10000) return `${Math.round(value / 1000)}k`;
  return String(Math.round(value));
}

/**
 * Shared geometry and layout for every node type: a ring, a short code, the
 * full name, an icon, and an actual/plan readout along the bottom.
 *
 * A subclass supplies three things — its `typeName()`, its `palette()` and its
 * `icon()`. Everything else comes from `html()` here, so the types stay a few
 * lines each and cannot drift apart visually.
 */
export abstract class BaseNode extends shapes.standard.Rectangle {
  /** Exactly one major grid square. */
  static readonly SIZE = { width: NODE_SIZE, height: NODE_SIZE };
  /** Outer edge of the ring: where links attach. */
  static readonly RADIUS = 146;

  protected abstract typeName(): string;
  protected abstract palette(): NodePalette;

  /** 24×24 SVG for this node type, stroked in the palette colour. */
  protected abstract icon(): string;

  /**
   * The node's rendering. Returns SVG; `@selector` marks the parts that
   * `attrs` can reach afterwards.
   */
  html(): string {
    const { stroke } = this.palette();

    return `
      <circle @selector="ring" />
      <path @selector="gauge" />
      <circle @selector="body" />
      <text @selector="code" />
      <text @selector="label" />
      <svg
        @selector="icon"
        x="120" y="122" width="60" height="60"
        viewBox="0 0 24 24"
        fill="none"
        stroke="${stroke}"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >${this.icon()}</svg>
      <line @selector="divider" />
      <text @selector="actual" />
      <line @selector="separator" />
      <rect @selector="planBox" />
      <text @selector="plan" />
      <text @selector="actualCaption" />
      <text @selector="unit" />
      <text @selector="planCaption" />
    `;
  }

  /**
   * The horizontal half-width available `dy` above or below the centre, used
   * to put link attachments on the ring rather than on the bounding box.
   */
  attachOffsetX(dy: number): number {
    const { RADIUS } = BaseNode;
    if (Math.abs(dy) >= RADIUS) return 0;
    return Math.sqrt(RADIUS * RADIUS - dy * dy);
  }

  /** The same, for links docking on the top or bottom edge. */
  attachOffsetY(dx: number): number {
    return this.attachOffsetX(dx);
  }

  /**
   * The headline number. Normally what the node puts through; a store instead
   * reports how much room it has left.
   */
  protected headline(data: Record<string, unknown>): { value: unknown; caption: string } {
    return { value: data['actual'], caption: 'Current' };
  }

  /** Fills in the readout from the element's `data` bag. */
  applyData(data: Record<string, unknown>): void {
    const label = String(data['label'] ?? this.id);
    const max = data['plan'];
    const { value, caption } = this.headline(data);

    this.attr('code/text', String(data['code'] ?? deriveCode(label)));
    this.attr('label/text', label.toUpperCase());
    this.attr('actual/text', formatValue(value));
    this.attr('actualCaption/text', caption);
    this.attr('unit/text', `[${String(data['unit'] ?? 't')}]`);
    this.attr('plan/text', max === undefined ? '' : formatValue(max));

    this.applyGauge(data['actual'], max);
  }

  /**
   * Draws the ring as a gauge: the arc sweeps clockwise from twelve o'clock
   * through `actual / max` of the circle, so how full a node is reads from
   * across the diagram without looking at the numbers.
   */
  protected applyGauge(actual: unknown, max: unknown): void {
    const used = typeof actual === 'number' ? actual : 0;
    const capacity = typeof max === 'number' && max > 0 ? max : 0;
    const ratio = capacity > 0 ? used / capacity : 0;

    this.attr('gauge/d', BaseNode.arc(Math.min(ratio, 1)));
    // Over capacity is the one case worth shouting about.
    this.attr('gauge/stroke', ratio > 1 ? OVER_CAPACITY : this.palette().stroke);
  }

  /** An arc of `ratio` of the ring, clockwise from the top. */
  private static arc(ratio: number): string {
    const { SIZE, RADIUS } = BaseNode;
    const r = RADIUS - 8;
    const cx = SIZE.width / 2;
    const cy = SIZE.height / 2;
    if (ratio <= 0) return '';
    // A full sweep cannot be one arc: start and end would coincide.
    if (ratio >= 1) {
      return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`;
    }
    const angle = ratio * 2 * Math.PI;
    const x = cx + r * Math.sin(angle);
    const y = cy - r * Math.cos(angle);
    return `M ${cx} ${cy - r} A ${r} ${r} 0 ${ratio > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
  }

  // `defaults` is a method rather than a plain object on purpose: it returns a
  // fresh object per instance, so nested values cannot leak between nodes.
  override defaults() {
    const { fill, stroke } = this.palette();
    const caption = {
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: 15,
      fill: '#64748b',
      textAnchor: 'middle',
      textVerticalAnchor: 'middle',
    };

    return util.defaultsDeep(
      {
        type: `playground.${this.typeName()}`,
        size: { ...BaseNode.SIZE },
        markup: markupFromSvg(this.html()),
        // One port group, positioned absolutely: the router works out where
        // each link should dock and creates a port there. They are drawn with
        // no markup — the docking points are structure, not decoration.
        ports: {
          groups: {
            dock: {
              position: { name: 'absolute' },
              // JointJS rejects empty port markup, so the port is a circle
              // with no radius and no opacity: present in the model, invisible
              // on screen, and ignored by the pointer.
              markup: [
                {
                tagName: 'circle',
                selector: 'portBody',
                attributes: { r: '1', opacity: '0', 'pointer-events': 'none' },
              },
              ],
            },
          },
          items: [],
        },
        attrs: {
          ring: {
            cx: 'calc(w/2)',
            cy: 'calc(h/2)',
            r: BaseNode.RADIUS - 8,
            fill: 'none',
            stroke: '#e2e8f0',
            strokeWidth: 16,
          },
          gauge: {
            fill: 'none',
            stroke,
            strokeWidth: 16,
            strokeLinecap: 'butt',
          },
          body: {
            cx: 'calc(w/2)',
            cy: 'calc(h/2)',
            r: BaseNode.RADIUS - 22,
            fill,
            stroke,
            strokeWidth: 2.5,
          },
          code: {
            x: 'calc(w/2)',
            y: 76,
            textAnchor: 'middle',
            textVerticalAnchor: 'middle',
            fontFamily: 'Inter, system-ui, sans-serif',
            fontSize: 38,
            fontWeight: 700,
            fill: '#0f172a',
          },
          label: {
            x: 'calc(w/2)',
            y: 106,
            textAnchor: 'middle',
            textVerticalAnchor: 'middle',
            fontFamily: 'Inter, system-ui, sans-serif',
            fontSize: 15,
            letterSpacing: 0.5,
            fill: '#475569',
            textWrap: { width: 200, height: 20, ellipsis: true },
          },
          divider: {
            x1: 66,
            y1: 190,
            x2: 'calc(w-66)',
            y2: 190,
            stroke: '#334155',
            strokeWidth: 1.5,
          },
          actual: {
            x: 112,
            y: 216,
            textAnchor: 'middle',
            textVerticalAnchor: 'middle',
            fontFamily: 'Inter, system-ui, sans-serif',
            fontSize: 32,
            fontWeight: 700,
            fill: '#0f172a',
          },
          separator: { x1: 150, y1: 199, x2: 150, y2: 233, stroke: '#334155', strokeWidth: 2 },
          planBox: {
            x: 164,
            y: 199,
            width: 76,
            height: 34,
            rx: 18,
            ry: 18,
            fill: '#ffffff',
            stroke: '#334155',
            strokeWidth: 1.5,
          },
          plan: {
            x: 202,
            y: 216,
            textAnchor: 'middle',
            textVerticalAnchor: 'middle',
            fontFamily: 'Inter, system-ui, sans-serif',
            fontSize: 24,
            fontWeight: 600,
            fill: '#0f172a',
          },
          actualCaption: { ...caption, x: 112, y: 248, text: 'Current' },
          unit: { ...caption, x: 150, y: 248 },
          planCaption: { ...caption, x: 202, y: 248, text: 'Max' },
        },
      },
      super.defaults,
    );
  }
}
