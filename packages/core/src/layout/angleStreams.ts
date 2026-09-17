import type { Diagnostic, StreamAngle } from '../text/types.js';
import { computeStreamAngle } from './textGeometry.js';

/**
 * Bucketing of text items by direction angle (Step 5 Z3, MDD §5.1).
 * MUST precede line clustering and word merging — rotated text
 * (up to 94% of items on a page, phase 0 Q6) breaks any histogram/geometry
 * computed without first separating out directions.
 */

export interface AngleStream<T> {
  angle: StreamAngle;
  /** The 0° bucket is the primary stream; the others are candidates for marginalia (MDD BlockKind). */
  isPrimary: boolean;
  items: T[];
}

export interface AngleGroupingResult<T> {
  streams: AngleStream<T>[];
  diagnostics: Diagnostic[];
}

/** A deviation from the nearest 90° bucket above this threshold is "unusual" (e.g. 45° — exactly between two buckets). */
const UNUSUAL_ANGLE_TOLERANCE_DEGREES = 15;

function rawAngleDegrees(transform: readonly number[]): number {
  const b = transform[1] ?? 0;
  const a = transform[0] ?? 0;
  const degrees = (Math.atan2(b, a) * 180) / Math.PI;
  return ((degrees % 360) + 360) % 360;
}

function angularDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 360 - d);
}

/**
 * Groups items by angle. An unusual angle (e.g. 45°) is NOT discarded — it is
 * assigned to the nearest 90° bucket and reported as a `Diagnostic` (once
 * per rounded raw angle value, so diagnostics aren't flooded with
 * duplicates from the same rotation).
 */
export function groupByAngle<T extends { transform: readonly number[] }>(
  items: readonly T[],
  pageNumber?: number,
): AngleGroupingResult<T> {
  const diagnostics: Diagnostic[] = [];
  const seenUnusualDegrees = new Set<number>();
  const buckets = new Map<StreamAngle, T[]>();

  for (const item of items) {
    const angle = computeStreamAngle(item.transform);
    const raw = rawAngleDegrees(item.transform);

    if (angularDistance(raw, angle) > UNUSUAL_ANGLE_TOLERANCE_DEGREES) {
      const roundedRaw = Math.round(raw);
      if (!seenUnusualDegrees.has(roundedRaw)) {
        seenUnusualDegrees.add(roundedRaw);
        diagnostics.push({
          severity: 'info',
          code: 'UNUSUAL_TEXT_ANGLE',
          params: { angle: roundedRaw, bucket: angle },
          ...(pageNumber !== undefined ? { pageNumber } : {}),
        });
      }
    }

    const bucket = buckets.get(angle) ?? [];
    bucket.push(item);
    buckets.set(angle, bucket);
  }

  const streams: AngleStream<T>[] = [...buckets.entries()]
    .map(([angle, bucketItems]) => ({ angle, isPrimary: angle === 0, items: bucketItems }))
    .sort((a, b) => a.angle - b.angle);

  return { streams, diagnostics };
}
