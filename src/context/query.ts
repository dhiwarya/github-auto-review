// What to look up in a repo's context for one PR: the words that describe the change.

const STOP = new Set(
  `the and for with that this from into over under when then than they them their there have has had not are was were been being will would should
  could can may might must does did done doing about above after again all also any because before between both but each few more most other some such
  only own same too very what which while who whom why how its our your you use used using add added adds adding fix fixed fixes fixing update updated
  updates remove removed change changed changes make makes made new old get set let var const function return returns import export default class
  extends implements interface type enum public private protected static async await null undefined true false void string number boolean object
  array any unknown never else switch case break continue try catch finally throw throws new typeof instanceof index main test tests spec src lib app
  dist build node modules file files path paths name names value values data item items list error errors result results props state self none
  json yaml yml md tsx jsx ts js py go rb java`.split(/\s+/),
);

// camelCase, snake_case and kebab-case names, split into their words.
const parts = (word: string) => word.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);

export interface QueryInput {
  title: string;
  issues: string[]; // linked issue titles
  files: string[];
  addedLines: string[]; // the lines the PR adds
}

export function queryTerms(input: QueryInput, max = 40): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const t = raw.toLowerCase();
    if (t.length < 3 || t.length > 40 || /^\d+$/.test(t) || STOP.has(t) || seen.has(t)) return;
    seen.add(t);
    terms.push(t);
  };
  const addWords = (text: string) => {
    for (const word of text.match(/[A-Za-z_][A-Za-z0-9_-]{2,}/g) ?? []) {
      const pieces = parts(word);
      if (pieces.length > 1 && pieces.length <= 4) add(pieces.join('')); // the whole name, as docs may write it
      for (const p of pieces) add(p);
    }
  };

  addWords(input.title);
  for (const issue of input.issues) addWords(issue);
  for (const file of input.files) addWords(file.replace(/\.[^./]+$/, ''));

  // Names the change introduces or touches most often.
  const counts = new Map<string, number>();
  for (const line of input.addedLines) {
    for (const word of line.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? []) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const frequent = [...counts.entries()].filter(([w]) => !STOP.has(w.toLowerCase())).sort((a, b) => b[1] - a[1]).slice(0, 30);
  for (const [word] of frequent) addWords(word);

  return terms.slice(0, max);
}
