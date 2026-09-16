import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { imageXObject, solidRgb } from '../images.js';

/**
 * Przypadek POZYTYWNY dla sciezki dowodowej "geometry" wykrywania masek (KROK-4
 * Z3) — w odroznieniu od images-overlapping, ktory sprawdza TYLKO brak falszywych
 * trafien. Dwa obrazy narysowane bezposrednio po sobie (Do, Do — bez posredniego
 * save/transform miedzy nimi), pod TA SAMA CTM, wiec bbox pokrywa sie w 100%
 * (>=95% progu) i roznica index wynosi 2 (<=3 progu okna). Trzeci, kontrolny
 * obraz jest daleko (duza roznica index, bez nakladania) i NIE powinien dostac
 * zadnego dowodu maski.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const underRef = imageXObject(writer, { width: 2, height: 2, rgb: solidRgb(2, 2, 200, 200, 200) });
  const overRef = imageXObject(writer, { width: 2, height: 2, rgb: solidRgb(2, 2, 20, 20, 20) });
  const controlRef = imageXObject(writer, { width: 2, height: 2, rgb: solidRgb(2, 2, 80, 160, 240) });

  const content = Buffer.from(
    'q 100 0 0 100 50 600 cm /Under1 Do /Over1 Do Q\n' + 'q 100 0 0 100 300 100 cm /Control1 Do Q\n',
    'latin1',
  );
  const contentRef = writer.addStreamObj('', content);

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict([pageRef]));
  writer.writeObj(
    pageRef,
    pageDict({
      parentRef: pagesRef,
      mediaBox: [0, 0, 612, 792],
      contentsRef: contentRef,
      resourcesInner: `/XObject << /Under1 ${underRef} 0 R /Over1 ${overRef} 0 R /Control1 ${controlRef} 0 R >>`,
    }),
  );

  return writer.finish(catalogRef);
}
