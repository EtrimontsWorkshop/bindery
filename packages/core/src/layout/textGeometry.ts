import type { StreamAngle } from '../text/types.js';
export type { StreamAngle } from '../text/types.js';

/**
 * Geometry shared by gap statistics (Z2), angular streams (Z3), and line
 * clustering (Z5) — MDD §5.1: angle from transform[1]/transform[2], rounded
 * to 90°; the "cross-axis" position is the axis PERPENDICULAR to the text
 * direction, not always Y.
 */

/** Text direction angle from transform [a,b,c,d,e,f], rounded to the nearest 90° bucket. */
export function computeStreamAngle(transform: readonly number[]): StreamAngle {
  const b = transform[1] ?? 0;
  const a = transform[0] ?? 0;
  const degrees = (Math.atan2(b, a) * 180) / Math.PI;
  const normalized = ((degrees % 360) + 360) % 360;
  const rounded = Math.round(normalized / 90) * 90;
  return (rounded % 360) as StreamAngle;
}

export interface AxisPositions {
  /** Position along the READING direction (increases in the direction text flows). */
  along: number;
  /** Position PERPENDICULAR to the text direction — the axis used for line clustering (Z5). */
  cross: number;
}

/**
 * The "same baseline" tolerance as a fraction of font size — NOT a rigid
 * constant (per the Step 5 brief: "a tolerance derived from font size, not a
 * constant"). Shared between Z2 (gap statistics), Z4 (word merging), and Z5
 * (line clustering), so all three agree on what counts as "the same line".
 */
const BASELINE_TOLERANCE_RATIO = 0.3;

export function baselineTolerance(fontSize: number): number {
  return Math.max(1, fontSize * BASELINE_TOLERANCE_RATIO);
}

export function fontSizeFromTransform(transform: readonly number[]): number {
  return Math.hypot(transform[0] ?? 0, transform[1] ?? 0) || 1;
}

/**
 * Projects an item's origin (e,f) onto the along/across axes of the text
 * direction. For 0°/180°: along=X, cross=Y. For 90°/270°: along=Y, cross=X
 * (rotated axis). The sign of `along` is flipped for 180°/270°, so it
 * increases in the reading direction.
 */
export function axisPositions(transform: readonly number[], angle: StreamAngle): AxisPositions {
  const x = transform[4] ?? 0;
  const y = transform[5] ?? 0;
  switch (angle) {
    case 0:
      return { along: x, cross: y };
    case 180:
      return { along: -x, cross: y };
    case 90:
      return { along: y, cross: x };
    case 270:
      return { along: -y, cross: x };
  }
}
