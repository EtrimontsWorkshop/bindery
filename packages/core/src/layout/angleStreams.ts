import type { Diagnostic, StreamAngle } from '../text/types.js';
import { computeStreamAngle } from './textGeometry.js';

/**
 * Kubelkowanie itemow tekstowych po kacie kierunku (KROK-5 Z3, MDD §5.1).
 * MUSI poprzedzac klastrowanie w linie i scalanie wyrazow — tekst obrocony
 * (do 94% itemow na stronie, faza 0 Q6) rozwala histogram/geometrie liczona
 * bez wczesniejszego rozdzielenia kierunkow.
 */

export interface AngleStream<T> {
  angle: StreamAngle;
  /** Kubelek 0° to strumien podstawowy; pozostale sa kandydatami na marginalia (MDD BlockKind). */
  isPrimary: boolean;
  items: T[];
}

export interface AngleGroupingResult<T> {
  streams: AngleStream<T>[];
  diagnostics: Diagnostic[];
}

/** Odchylenie od najblizszego kubelka 90° powyzej tego progu jest "nietypowe" (np. 45° — dokladnie posrodku dwoch kubelkow). */
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
 * Grupuje itemy po kacie. Kat nietypowy (np. 45°) NIE jest odrzucany — jest
 * przypisany do najblizszego kubelka 90° i zglaszany jako `Diagnostic` (raz
 * per zaokraglona wartosc surowego kata, zeby nie zalewac diagnostyki
 * duplikatami z tej samej rotacji).
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
