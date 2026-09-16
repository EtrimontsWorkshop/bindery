import type { StreamAngle } from '../text/types.js';
export type { StreamAngle } from '../text/types.js';

/**
 * Geometria wspolna dla statystyki odstepow (Z2), strumieni katowych (Z3) i
 * klastrowania w linie (Z5) — MDD §5.1: kat z transform[1]/transform[2],
 * zaokraglony do 90°; pozycja "cross-axis" to os PROSTOPADLA do kierunku
 * tekstu, nie zawsze Y.
 */

/** Kat kierunku tekstu z transform [a,b,c,d,e,f], zaokraglony do najblizszego kubelka 90°. */
export function computeStreamAngle(transform: readonly number[]): StreamAngle {
  const b = transform[1] ?? 0;
  const a = transform[0] ?? 0;
  const degrees = (Math.atan2(b, a) * 180) / Math.PI;
  const normalized = ((degrees % 360) + 360) % 360;
  const rounded = Math.round(normalized / 90) * 90;
  return (rounded % 360) as StreamAngle;
}

export interface AxisPositions {
  /** Pozycja wzdluz kierunku CZYTANIA (rosnie w kierunku plyniecia tekstu). */
  along: number;
  /** Pozycja PROSTOPADLA do kierunku tekstu — os klastrowania w linie (Z5). */
  cross: number;
}

/**
 * Tolerancja "ta sama linia bazowa" jako uamek rozmiaru fontu — NIE stala
 * sztywna (brief KROK-5: "tolerancja pochodna od rozmiaru fontu, nie stala").
 * Wspoldzielona miedzy Z2 (statystyka odstepow), Z4 (scalanie wyrazow) i Z5
 * (klastrowanie w linie), zeby wszystkie trzy zgadzaly sie co do tego, co
 * liczy sie jako "ta sama linia".
 */
const BASELINE_TOLERANCE_RATIO = 0.3;

export function baselineTolerance(fontSize: number): number {
  return Math.max(1, fontSize * BASELINE_TOLERANCE_RATIO);
}

export function fontSizeFromTransform(transform: readonly number[]): number {
  return Math.hypot(transform[0] ?? 0, transform[1] ?? 0) || 1;
}

/**
 * Rzutuje poczatek itemu (e,f) na osie wzdluz/w poprzek kierunku tekstu.
 * Dla 0°/180°: along=X, cross=Y. Dla 90°/270°: along=Y, cross=X (os obrocona).
 * Znak `along` odwrocony dla 180°/270°, zeby rosl w kierunku czytania.
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
