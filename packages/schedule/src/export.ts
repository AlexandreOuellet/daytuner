// Writing a channel file back out with the library's ids next to every title, so it keeps pointing at the same
// shows and movies if one is renamed. The text is edited in place, so the owner's comments and layout stay.

import { isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml';
import { parseScheduleFile } from './file.js';
import { ResolveError, same, type LibrarySource } from './resolve.js';

/** One title found in the library, or an error that says what is wrong (none, or more than one). */
function only<T extends { id: string; title: string }>(found: T[], what: string, title: string): T {
  if (found.length === 0) throw new ResolveError(`there is no ${what} titled "${title}"`);
  if (found.length > 1) throw new ResolveError(`there is more than one ${what} titled "${title}" (${found.map((f) => f.id).join(', ')}); give the one you mean an id by hand`);
  return found[0]!;
}

/**
 * The same channel file with `id` added beside every show and movie title that has none. A title with an id is left
 * as it is. Throws when a title is not in the library or is shared by two.
 */
export async function addIds(text: string, source: Pick<LibrarySource, 'movies' | 'shows'>): Promise<string> {
  parseScheduleFile(text); // refuse a file that does not parse
  const doc: Document = parseDocument(text);
  const shows = await source.shows();
  const movies = await source.movies();
  const showId = (title: string): string => only(shows.filter((s) => same(s.title, title)), 'show', title).id;

  const pools = doc.get('pools');
  if (isMap(pools)) {
    for (const pool of pools.items) {
      const list = isMap(pool.value) ? pool.value.get('shows', true) : undefined;
      if (!isSeq(list)) continue;
      list.items = list.items.map((item) => {
        if (isScalar(item) && typeof item.value === 'string') return doc.createNode({ show: item.value, id: showId(item.value) });
        if (isMap(item) && !item.has('id')) item.set('id', showId(String(item.get('show'))));
        return item;
      });
    }
  }
  const exceptions = doc.get('exceptions');
  if (isSeq(exceptions)) {
    for (const e of exceptions.items) {
      const play = isMap(e) ? e.get('play', true) : undefined;
      if (!isMap(play) || play.has('id')) continue;
      if (play.has('show')) play.set('id', showId(String(play.get('show'))));
      else if (play.has('movie')) play.set('id', only(movies.filter((m) => same(m.title, String(play.get('movie')))), 'movie', String(play.get('movie'))).id);
    }
  }
  return String(doc);
}
