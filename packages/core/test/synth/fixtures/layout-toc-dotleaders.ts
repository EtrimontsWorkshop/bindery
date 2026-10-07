import { buildLayoutPage } from '../layoutHelpers.js';

/**
 * A dense table of contents with dot leaders (5+ dots in a row) — tests gap-based word merging and
 * the dot-leader hint (BlockKind:'table' after a run of dots). Each entry on its OWN Y (one Tj) —
 * doesn't test fragment merging (the word-merge tests cover that), only the correct classification
 * and no exception on a dense page.
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
