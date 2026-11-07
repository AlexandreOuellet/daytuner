// Chapters cost one request per program (about 0.4 s in Tunarr), and they hardly ever change. This wraps a
// library source so that chapters already read are taken from the store instead. An entry is used only while the
// program's length is the same as when it was read and it is younger than the lifetime below.

import type { LibrarySource } from '@daytuner/schedule';
import type { Clock } from '@daytuner/engine';
import type { Store } from '@daytuner/store';

/** How long a cached chapter list is trusted: 30 days. Chapters are added when the library is scanned again. */
export const CHAPTER_CACHE_LIFETIME_MS = 30 * 86_400_000;

export function cachedSource<S extends LibrarySource>(source: S, store: Store, clock: Clock): S {
  const inner = source.chapters?.bind(source);
  if (!inner) return source;
  const wrapped = Object.create(source) as S;
  wrapped.chapters = async (programId: string, duration: number) => {
    const now = clock.now();
    const hit = store.cachedChapters(programId, duration, now - CHAPTER_CACHE_LIFETIME_MS);
    if (hit) return hit;
    const fresh = await inner(programId, duration);
    store.cacheChapters(programId, duration, fresh, now);
    return fresh;
  };
  return wrapped;
}
