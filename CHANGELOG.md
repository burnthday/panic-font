# Changelog

What changed on the site, newest first. Append-only: corrections go in a new entry,
never by editing an old one. One line per meaningful change with its commit.

## 2026-07-23

### Fixed
- Song links on the homepage were dead. Shelf Watch cards and the ticker pointed at
  `/songs/<slug>/` (the Song Index) instead of `/song/<slug>/`, where the 698 song
  pages actually live — 312 broken links. (`5082dc1`, guard in `45164cb`)
- Song Index filter dropdown painted *behind* the song list, and the sticky search
  and column bars were transparent enough to read rows through. (`8a63da8`)
- Nick songbook rows carried the same fact two or three times (per-song overdue
  line, all-time plays, cadence inside Gap, "shows ago" under dates, HOT/WARM
  words). One fact per cell now; tier still reads through the Heat number's
  colour. (`8a63da8`)
- The blanket `main > *` stacking rule is gone. It forced position and stacking on
  every section of every page and had caused five separate reported bugs. The hero
  echo now sits behind content on its own. Verified by diffing painted geometry and
  paint order across ten pages before and after: nine identical, the tenth differed
  only in a 1px hidden skip link the rule had been mispositioning. (`3d8598b`)

### Changed
- Every "half-way" link removed sitewide. Songsterr *search* links in the Song
  Index Links column and on every song page's Learn It row now deep-link the song's
  own Everyday Companion page; Lyrics & Chords gained the same for 628 songs.
  A guard fails the build if a search URL comes back. (`5082dc1`, `7934bea`)
- Song Index toolbar: the eight-option Rarity dropdown became one "Rare and up"
  checkbox — the Rarity column already sorted, so the menu duplicated it. (`7934bea`)
- The Shelf page shows only current state; every dated update moved, word for word,
  to `/shelf/updates/` with a quiet link. Nick's six-song preview reads
  Song · Why now · Heat. (`20f1a81`)
- Hero date-pager arrows keep their 30px look but take a 44px touch target.

### Added
- Sitewide dead-link sweep in QA: every internal link and image across all 1,224
  built pages must resolve. Zero broken at time of writing. (`45164cb`)
- Living-poster pieces on the homepage Nick panel and the Song Origins header —
  animated starfield and effect canvases. NOT from this session; landed in
  `1ec3a0c`. See the note below. (`1ec3a0c`)

### Known issue — under investigation
- **Motion smoothness after `1ec3a0c`.** The two living-poster canvases (878×878
  each, ~1.5M pixels) run a `requestAnimationFrame` loop with no off-screen or
  tab-hidden gating, so they redraw continuously whether or not they are visible.
  That is a plausible cause of site-wide animation stutter and is the newest change
  on the branch. Not yet confirmed with a real frame-rate measurement: the embedded
  preview pane freezes animation timers, so smoothness can only be judged in a real
  browser. Owner: the poster/subpage session that shipped it.
