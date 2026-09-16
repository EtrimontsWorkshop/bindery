import { buildLayoutPage } from '../layoutHelpers.js';

/**
 * Gesty spis tresci z wypunktowaniem kropkowym (5+ kropek pod rzad) — testuje
 * Z1a (profil hierarchiczny nie sklejal odrebnych pozycji na gestych stronach,
 * KROK-5/6 naprawa) i wskazowke kropkowa (BlockKind:'table' po ciagu kropek).
 * Kazda pozycja na WLASNYM Y (jeden Tj) — nie testuje scalania fragmentow (to
 * juz pokrywa grupa B), tylko poprawna klasyfikacje i brak wyjatku na gestej
 * stronie.
 */
export function build(): Buffer {
  const chapters = [
    'Introduction',
    'Getting Started',
    'Chapter One The Beginning',
    'Chapter Two The Middle',
    'Chapter Three The End',
    'Appendix A Tables',
    'Appendix B Charts',
    'Appendix C Notes',
    'Glossary Of Terms',
    'Index Of Names',
    'Bibliography',
    'Acknowledgements',
  ];
  const lines = chapters.map((title, i) => ({
    text: `${title} ${'.'.repeat(20)} ${i + 1}`,
    x: 72,
    y: 700 - i * 20,
  }));
  return buildLayoutPage({ lines });
}
