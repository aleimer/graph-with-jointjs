/**
 * The numbers shared by the facade, the node classes and the router.
 *
 * They are here rather than next to whichever file happened to need them
 * first because they are not independent: the grid pitch is the node size,
 * the router's lane is the light mesh, and a change to one that is not a
 * change to the other puts the nodes off the grid.
 */

/** A node is a square, one grid cell across. */
export const NODE_SIZE = 300;

/** One node wide. Nodes line up with the heavy grid lines at this pitch. */
export const MAJOR_GRID = NODE_SIZE;

/**
 * The light mesh between the heavy lines, and the lane the router snaps link
 * attachments to — the same spacing, so a dock lands on a line a reader can
 * see.
 */
export const MINOR_GRID = MAJOR_GRID / 4;

/** Gap left between a link's end and the node it docks at. */
export const NODE_GAP = 16;

/**
 * How far a route must stay from a node it is only passing. The gutter
 * between columns is one node wide, so this can be generous — a line grazing
 * a node reads as if it were attached to it.
 */
export const NODE_CLEARANCE = 120;

/**
 * Gap kept between the drawn edges of two links running side by side. Sized
 * against the thickest links rather than a fixed few pixels: next to a 46px
 * line, a 12px gap still reads as one band.
 */
export const LINK_CLEARANCE = 24;

/**
 * How far the diagram may be zoomed, and by how much per wheel notch. Shared
 * because the wheel and the toolbar buttons have to agree on the limits, or
 * one of them can leave the other with nothing to do.
 */
export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 2.5;
export const ZOOM_STEP = 0.1;

/** Room a group leaves around its children. The top takes the group's label. */
export const GROUP_PADDING = { top: 64, left: 36, right: 36, bottom: 36 };
