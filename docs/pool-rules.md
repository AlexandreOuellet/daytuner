# Pool rules: dynamic pools that DayTuner evaluates itself

Status: **built** (decisions below settled with the owner). Rules are written in the channel file or edited on the schedule page.

## Why

A pool today is either shows named by hand or a movie rule with only genre and length. A new show joins nothing until it is
added by name, and nothing can say "French films" or "comedies except X". The owner does not want DayTuner to depend on
Tunarr's own dynamic lists (smart collections). DayTuner therefore matches the rules itself, on every plan, against the
library's metadata. Tunarr is only where the metadata is read from.

## Where the metadata comes from

Tunarr keeps a search index of everything it has synced from Jellyfin (`POST /api/programs/search`, and
`GET /api/programs/facets/{field}` for the values of a field). Checked on the test copy, it holds for a movie: title, year,
rating (for example `PG-13`, `CA-14A`), genres, studios, tags, actors, directors, writers, duration; and for an episode the same
for its show and season (`grandparent.*`, `parent.*`). It also holds **`audioLanguages`** and **`subtitleLanguages`** as
three-letter codes (`eng`, `fra`, `und` for unknown), which can be filtered on but are not returned inside a search result.
So a language rule asks the index for the ids that match and DayTuner keeps those.

DayTuner never saves a rule into Tunarr and never reads a Tunarr collection. A Jellyfin direct connection would remove Tunarr as
the source too, but needs Jellyfin credentials and a second client; it is not part of this design (see open point 1).

## The rules

A pool names its members with **rules**. All conditions inside one rule must hold (and); the rules of a pool are joined (or).
A value that is a list means any of the list.

```yaml
pools:
  french:                       # movies in French, or with French subtitles
    movies:
      match:
        - { audio: fra }
        - { subtitles: fra }
  eighties_comedy:
    movies:
      match:
        - { genre: [Comedy], year: 1980-1989, rating: [G, PG, CA-G, CA-PG] }
      except:
        - { title: "Christmas" }          # a part of the title
        - { tag: horror }
      duration: "<=117m"
  sitcoms:                      # every show that is a comedy, plus one named by hand
    shows:
      - Columbo
      - match: { genre: Comedy, rating: [CA-G, CA-PG] }
        except: [ { show: The Office } ]
    episodes:
      seasons: 1-7              # season numbers; 0 is the specials
      specials: skip            # skip | include (default: include)
      duration: ">=18m"         # an episode's own length
      order: season             # season (default) | airdate
```

Fields a movie rule may use: `genre`, `year` (a number or a range `1980-1989`), `rating`, `studio`, `tag`, `actor`, `director`,
`title` (contains), `audio`, `subtitles`, `duration`. A show rule uses the same fields on the show itself (`title`, `genre`,
`year`, `rating`, `studio`, `tag`, `audio`, `subtitles`: a show matches when its episodes do). `except` takes the same rules and
removes what they match. A string with no rule keeps today's meaning (a show by title or `{show, id}`), so existing channel
files are unchanged.

`audio` and `subtitles` are language codes (`fra`, or the name `French`, which DayTuner turns into the code). A movie matches
`audio: fra` when **any** audio track is in that language, and `subtitles: fra` when any subtitle track is.

## When a rule is read

At every plan the rule is evaluated against the library as it is then (the calendar caches the library for 30 minutes). A show
that starts to match joins its pool. In an ordered pool of several shows, shows take turns in the order they are listed, and a
show found by a rule goes after the named ones, by title. Where a show's place is kept: see "an ordered show's place" in
[`planning-rules.md`](planning-rules.md); an arriving episode or show does not move any other show's place.

## Seeing what a rule matches

- `daytuner pool <channel | channel.yaml> [<pool>] [--all]` lists each pool: how many programs and hours, the shows of a pool of
  shows with their episode counts, and a sample of the movies or episodes (all of them with `--all`). It reads a channel file
  directly, so a rule can be tried before it is saved. A pool that cannot be read says why.
- The schedule page shows the same for each pool (counts, shows, a first 300 programs). A pool is turned into rules with "Edit
  as rules"; then each rule is a row of boxes (genre, year, rating, studio, tag, actor, director, title, audio and subtitle
  language, length), with "Always", "Any of these" and "Except" for movies, and named shows, shows by rule and the episode
  options for shows. Commas in a box mean any of. A rule with no condition is refused (it would match everything). A pool
  with a problem shows the reason in place of its count.
- The store remembers the programs each pool held at the last real plan. A plan that finds different ones says so in its
  warnings (`pool-changed`): "pool french: 3 joined (A; B; C), 1 left (D); it holds 41 now". A pool that more than doubles is a
  warning (check the rule). The first plan has nothing to compare with and says nothing.
- A pool that matches nothing stops the plan with a clear error (as a pool of a missing show always has).

## Suggestions in the rules editor (hard requirement, settled with the owner)

A box that takes a library value (genre, rating, studio, tag, actor, director, audio and subtitle language) offers what the
library has. While a box has focus, the values that contain the text typed after the last comma are listed under it; choosing
one puts it there. A value that is not in the library (ignoring case) is marked "not in the library" under the box, so a typo
(`Comdey`) shows before the pool is saved. A marked value can still be kept: the library may change. Where the values come from
(`GET /api/library`, cached one minute): genre, rating, studio, tag, actor, director from the movies and shows already read;
show genres also from the `grandparent.genres` facet (split at `;`); languages from the `audioLanguages` and
`subtitleLanguages` facets, shown as "French (fra)". `title`, `year` and `length` take free text and are not checked.

## Decisions settled with the owner

1. **Data source**: Tunarr's synced index. DayTuner does the matching; Tunarr is only read.
2. **Language**: `audio` and `subtitles` are separate conditions, each matching when any track is in the language; write both
   as separate rules for "either".
3. **A show found by a rule and also named** plays once, in the named entry's place.

## Notes on what was built

- A show's genres are empty in Tunarr's records for shows (Jellyfin keeps them on the episodes), so a show rule on `genre`
  and any language rule asks the index for the ids behind it (the shows with a matching episode). Movie genres are read
  from the movie.
- `title` matches a part of the title, ignoring case; `genre`, `rating`, `studio`, `tag`, `actor` and `director` match a whole
  value, ignoring case.
- `episodes.order: airdate` puts episodes with no known air date last.
- A rule is evaluated for movies each time the pool is read; the index lookups are asked once per read.
- Speed: the pages of a large search are read four at a time, the shows' episode lists six at a time, and the shows behind a
  genre or a language come from one facet call (the titles of the matching episodes' shows) instead of paging through every
  matching episode. When the facet may be cut short (it holds at most 100 values), is missing, or names a title no show has,
  DayTuner pages through the episodes as before; a title shared by two shows is settled with one small search. On the test copy
  a Comedy show rule went from 9.4 s to 1.3 s with the same shows. Reading all movies takes about 2.6 s.

## Not in this design

Writing rules back into Tunarr as collections, rules on playback state (watched or not), and ranking by popularity.
