// The channel's tags: a CSV of `genre,file`, one row per tag, kept in the channel file (docs/run-slots.md, "Genre of an item").
// An item is matched by its file name without the extension, which is how Tunarr titles a local file.

export interface TagIndex {
  /** The tags of an item, by its title (the file name without its extension). Empty when it has none. */
  tagsOf(title: string): string[];
  /** Every tag in the file. */
  all: ReadonlySet<string>;
}

/** Titles and file names match ignoring case, spacing and the extension. */
const key = (s: string): string =>
  s.replace(/\.[A-Za-z0-9]{2,4}$/, '').replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();

/** The rows of a CSV, with quoted fields and doubled quotes, `\n` or `\r\n` line ends. */
function rowsOf(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (quoted) throw new Error('a quoted field is not closed');
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

/** Reads the CSV. Throws a message that says which row is wrong. */
export function parseTagsCsv(text: string): TagIndex {
  const rows = rowsOf(text);
  const head = rows[0]?.map((h) => h.trim().toLowerCase());
  if (!head || head.length !== 2 || head[0] !== 'genre' || head[1] !== 'file') throw new Error('the tags CSV must start with the header "genre,file"');
  const byTitle = new Map<string, string[]>();
  const all = new Set<string>();
  rows.slice(1).forEach((r, i) => {
    if (r.length !== 2 || r[0]!.trim() === '' || r[1]!.trim() === '') throw new Error(`tags CSV row ${i + 2} needs a genre and a file`);
    const tag = r[0]!.trim();
    const k = key(r[1]!);
    const list = byTitle.get(k) ?? [];
    if (!list.includes(tag)) list.push(tag);
    byTitle.set(k, list);
    all.add(tag);
  });
  return { tagsOf: (title) => byTitle.get(key(title)) ?? [], all };
}

export const emptyTagIndex: TagIndex = { tagsOf: () => [], all: new Set() };

/** True when any of `wanted` is one of `have`, ignoring case. */
export const hasAnyTag = (have: readonly string[], wanted: readonly string[]): boolean => {
  const w = new Set(wanted.map((t) => t.trim().toLowerCase()));
  return have.some((t) => w.has(t.trim().toLowerCase()));
};
