/**
 * The board document model: shape types, the `DocStore` interface, z-order
 * and tree rules. Nothing here depends on a sync library; the Yjs
 * implementation lives in `@niro/doc/yjs`, which only apps import.
 */
export {
  compareOrder,
  indexAbove,
  indexesAbove,
  indexesBelow,
  indexesBetween,
  isValidIndex,
  reorderStep,
  reorderToEnd,
} from "./order";
export {
  ASSET_ID,
  COLORS,
  type ColorName,
  DASHES,
  DEFAULT_COLOR,
  defaultHead,
  HEADS,
  holdsText,
  isContainer,
  isLinear,
  type LineDash,
  type LineHead,
  type LineThickness,
  MIN_SIZE,
  newShapeId,
  normalizeAngle,
  POINT_SCALE,
  PRESSURE_SCALE,
  REACTION_NAMES,
  REACTIONS,
  type ReactionName,
  type Reactions,
  reactionKey,
  readShape,
  SCHEMA_VERSION,
  SHAPE_TYPES,
  type Shape,
  type ShapeId,
  type ShapePatch,
  type ShapeType,
  THICKNESSES,
  USER_ID,
} from "./shape";
export type { DocStore, Origin, ShapeChange, TextEdit, Tx } from "./store";
export { effectiveParents } from "./tree";
