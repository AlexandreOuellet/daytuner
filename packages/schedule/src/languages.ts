// Language names for the audio and subtitle rules. The library keeps three-letter codes ("fra"); the file may say "French".

const NAMES: Record<string, string> = {
  english: 'eng', french: 'fra', german: 'deu', spanish: 'spa', italian: 'ita', portuguese: 'por', dutch: 'nld', swedish: 'swe',
  norwegian: 'nor', danish: 'dan', finnish: 'fin', polish: 'pol', czech: 'ces', hungarian: 'hun', romanian: 'ron', russian: 'rus',
  ukrainian: 'ukr', turkish: 'tur', greek: 'ell', hebrew: 'heb', arabic: 'ara', persian: 'fas', hindi: 'hin', tamil: 'tam',
  telugu: 'tel', urdu: 'urd', japanese: 'jpn', korean: 'kor', chinese: 'zho', mandarin: 'zho', cantonese: 'zho', thai: 'tha',
  vietnamese: 'vie', indonesian: 'ind', latin: 'lat',
};

/** "French" and "fra" both give "fra". Any other three-letter word is taken as a code; anything else is an error. */
export function languageCode(text: string): string {
  const t = text.trim().toLowerCase();
  if (NAMES[t]) return NAMES[t]!;
  if (/^[a-z]{3}$/.test(t)) return t;
  throw new Error(`"${text}" is not a language: write its name (French) or its three-letter code (fra)`);
}

/** The name to show for a code ("fra" gives "French"); the code itself when it has no name here. */
export function languageName(code: string): string {
  const hit = Object.entries(NAMES).find(([name, c]) => c === code && name !== 'mandarin' && name !== 'cantonese');
  return hit ? hit[0][0]!.toUpperCase() + hit[0].slice(1) : code;
}

/** Three-letter codes come in two sets for twenty languages (terminologic "fra", bibliographic "fre"); a library may use either. */
const VARIANTS: [string, string][] = [
  ['fra', 'fre'], ['deu', 'ger'], ['ces', 'cze'], ['ell', 'gre'], ['fas', 'per'], ['nld', 'dut'], ['ron', 'rum'], ['zho', 'chi'], ['isl', 'ice'],
  ['mkd', 'mac'], ['msa', 'may'], ['slk', 'slo'], ['bod', 'tib'], ['cym', 'wel'], ['hye', 'arm'], ['eus', 'baq'], ['mya', 'bur'], ['kat', 'geo'], ['sqi', 'alb'],
];

/** A code with its other spelling, if it has one: "fra" gives ["fra", "fre"], "eng" gives ["eng"]. A rule matches either. */
export function languageVariants(code: string): string[] {
  const c = code.toLowerCase();
  for (const [a, b] of VARIANTS) if (c === a || c === b) return [a, b];
  return [c];
}
