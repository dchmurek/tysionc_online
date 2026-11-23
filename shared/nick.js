// Normalizacja nicków. Klucz nicku służy do sprawdzania unikalności:
// „Akuro”, „akuro”, „AKURO”, „Akúro” i „Aku-ro” dają ten sam klucz.
const ALLOWED = /^[\p{Script=Latin}0-9 _.\-]+$/u;

export function cleanNick(input) {
  return String(input ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function nickKey(input) {
  return cleanNick(input)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/ł/g, 'l').replace(/Ł/g, 'L')
    .toLowerCase()
    .replace(/[ _.\-]/g, '');
}

export function nickProblem(input) {
  const n = cleanNick(input);
  const len = [...n].length;
  if (len < 2) return 'Nick musi mieć co najmniej 2 znaki';
  if (len > 20) return 'Nick może mieć najwyżej 20 znaków';
  if (!ALLOWED.test(n)) return 'Nick może zawierać litery łacińskie (także polskie), cyfry, spację, kropkę, _ i -';
  if (nickKey(n).length < 2) return 'Nick musi zawierać co najmniej 2 litery lub cyfry';
  return null;
}
