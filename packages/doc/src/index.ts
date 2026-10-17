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
  isValidIndex,
  reorderStep,
  reorderToEnd,
} from "./order";
export {
  COLORS,
  type ColorName,
  DEFAULT_COLOR,
  holdsText,
  MIN_SIZE,
  newShapeId,
  normalizeAngle,
  readShape,
  SCHEMA_VERSION,
  SHAPE_TYPES,
  type Shape,
  type ShapeId,
  type ShapePatch,
  type ShapeType,
} from "./shape";
export type { DocStore, Origin, ShapeChange, TextEdit, Tx } from "./store";
export { effectiveParents } from "./tree";
