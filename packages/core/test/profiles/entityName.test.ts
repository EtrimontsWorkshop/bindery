import { describe, expect, it } from 'vitest';
import { matchFontRoleCandidate } from '../../src/profiles/entityName.js';
import type { ProfileToken } from '../../src/profiles/types.js';
import type { FontRoleCandidatePattern } from '../../src/profiles/schema.js';

const PATTERN: FontRoleCandidatePattern = {
  kind: 'fontRoleCandidate',
  excludeRoles: ['body'],
  maxLength: 60,
  excludeRepeatedAcrossPages: true,
  excludeHyphenContinuations: true,
  requireFontKeys: [],
};

function tok(text: string, overrides: Partial<ProfileToken> = {}): ProfileToken {
  return { text, bbox: { minX: 0, maxX: 10, minY: 0, maxY: 10 }, fontRole: 'accent', page: 1, ...overrides };
}

describe('matchFontRoleCandidate — [KROK-18 Z3]', () => {
  it('lapie tekst o roli fontu innej niz wykluczona', () => {
    const tokens = [tok('Joshua Thomas', { fontRole: 'accent' })];
    expect(matchFontRoleCandidate(tokens, PATTERN)).toHaveLength(1);
  });

  it('odrzuca tekst o wykluczonej roli (body)', () => {
    const tokens = [tok('zwykle zdanie w tekscie', { fontRole: 'body' })];
    expect(matchFontRoleCandidate(tokens, PATTERN)).toHaveLength(0);
  });

  it('odrzuca tokeny bez znanej roli fontu (bezpieczny brak dzialania, nie falszywy kandydat)', () => {
    const tokens = [tok('coś', { fontRole: undefined })];
    expect(matchFontRoleCandidate(tokens, PATTERN)).toHaveLength(0);
  });

  it('[KROK-18 Z7, zmierzony na realnej ksiazce blad] odrzuca fontRole="unknown" tak samo jak brak roli — nie jest to "rola inna niz body"', () => {
    // Zmierzone wprost na str. 56 Zew Cthulhu: rzadki wariant fontu
    // ("ACaslonPro-Regular@9.5", za malo wystapien zeby buildInventory
    // pewnie go sklasyfikowal) dostawal 'unknown', nie 'body' — domyslny
    // `excludeRoles: ['body']` (§5.5 MDD) go przepuszczal jako "kandydata".
    const tokens = [tok('Prawa i lewa ręka są osobnymi istotami, które mają te same', { fontRole: 'unknown' })];
    expect(matchFontRoleCandidate(tokens, PATTERN)).toHaveLength(0);
  });

  it('odrzuca tekst dluzszy niz maxLength', () => {
    const tokens = [tok('x'.repeat(61), { fontRole: 'accent' })];
    expect(matchFontRoleCandidate(tokens, PATTERN)).toHaveLength(0);
  });

  it('[H2] odrzuca sam token dywizacji i token BEZPOSREDNIO po nim (kontynuacja wyrazu przenoszonego)', () => {
    const tokens = [tok('Praw', { fontRole: 'accent' }), tok('-', { fontRole: 'accent' }), tok('nik', { fontRole: 'accent' }), tok('Kolejny', { fontRole: 'accent' })];
    const matches = matchFontRoleCandidate(tokens, PATTERN);
    expect(matches.map((m) => m.text)).toEqual(['Praw', 'Kolejny']);
  });

  it('[H2, naglowek biegnacy] odrzuca tekst identyczny na >= 3 roznych stronach (np. tytul ksiazki w rogu kazdej strony)', () => {
    const tokens = [tok('nie czas na krzyk', { page: 10 }), tok('nie czas na krzyk', { page: 11 }), tok('nie czas na krzyk', { page: 12 }), tok('Joshua Thomas', { page: 10 })];
    const matches = matchFontRoleCandidate(tokens, PATTERN);
    expect(matches.map((m) => m.text)).toEqual(['Joshua Thomas']);
  });

  it('bez pola `page` (jedna strona naraz) excludeRepeatedAcrossPages nic nie odrzuca — bezpieczny brak dzialania', () => {
    const tokens = [tok('Głowa', { page: undefined }), tok('Głowa', { page: undefined })];
    expect(matchFontRoleCandidate(tokens, PATTERN)).toHaveLength(2);
  });

  it('[KROK-18 Z7, zmierzony na realnej ksiazce blad] odrzuca zdanie objasniajace konczace sie kropka, nawet o roli fontu != body i ponizej maxLength (str. 56, "Kawalki")', () => {
    // Zmierzone wprost: to zdanie (58 znakow) przeszlo filtr dlugosci I mialo
    // role fontu != 'body' (kursywa wstepu opisu), wiec zanim dodano ten
    // filtr, bylo "pewna" nazwa zamiast placeholdera — dokladnie przypadek,
    // przed ktorym S4 mialo chronic.
    const tokens = [tok('Prawa i lewa ręka są osobnymi istotami, które mają te same statystyki.')];
    expect(matchFontRoleCandidate(tokens, PATTERN)).toHaveLength(0);
  });

  it('nie odrzuca prawdziwych nazw (zaden realny cel w zmierzonej probce nie konczy sie kropka/wykrzyknikiem/pytajnikiem)', () => {
    const tokens = [tok('Joshua Thomas'), tok('Kolor z innego wszechświata'), tok('Doktor Lawrence Warwick')];
    expect(matchFontRoleCandidate(tokens, PATTERN)).toHaveLength(3);
  });

  it('[KROK-20 Z2, zmierzony na zywo blad] obcina koncowy przecinek z tekstu kandydata (str. 84 "nie czas na krzyk" — "Jacob Beaker," zlaczone z przecinkiem w jeden token, bo dalej w zdaniu idzie opis roli)', () => {
    const tokens = [tok('Jacob Beaker,')];
    const matches = matchFontRoleCandidate(tokens, PATTERN);
    expect(matches.map((m) => m.text)).toEqual(['Jacob Beaker']);
  });

  it('token skladajacy sie WYLACZNIE z przecinka jest odrzucany calkowicie, nie zamieniany na pusty kandydat', () => {
    const tokens = [tok(',')];
    expect(matchFontRoleCandidate(tokens, PATTERN)).toHaveLength(0);
  });

  describe('requireFontKeys — [KROK-29 Z3]', () => {
    it('puste (domyslne) -> zero zmiany zachowania wzgledem PATTERN bez tego pola', () => {
      const tokens = [tok('Joshua Thomas', { fontKey: 'Arial-Bold@12' })];
      expect(matchFontRoleCandidate(tokens, { ...PATTERN, requireFontKeys: [] })).toHaveLength(1);
    });

    it('niepuste -> DODATKOWO wymaga fontKey nalezacego do zbioru, ponad filtr roli', () => {
      const pattern = { ...PATTERN, requireFontKeys: ['Arial-Bold@12'] };
      const tokens = [
        tok('Joshua Thomas', { fontKey: 'Arial-Bold@12' }),
        tok('Inny kandydat, ta sama rola', { fontKey: 'Arial-Italic@9' }),
      ];
      const matches = matchFontRoleCandidate(tokens, pattern);
      expect(matches.map((m) => m.text)).toEqual(['Joshua Thomas']);
    });

    it('niepuste + brak fontKey na tokenie -> odrzucony (bezpieczny brak dzialania, nie falszywy kandydat)', () => {
      const pattern = { ...PATTERN, requireFontKeys: ['Arial-Bold@12'] };
      const tokens = [tok('Joshua Thomas', { fontKey: undefined })];
      expect(matchFontRoleCandidate(tokens, pattern)).toHaveLength(0);
    });
  });
});
