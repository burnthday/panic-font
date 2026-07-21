# Song Origins — data + design handoff

Handoff for the Burnthday.com build session. This describes the curated song-origins data (`data/source/song-origins-curated.json`) and a recommended way to render it. The **data is done**; the render/design is yours to take, adapt, or ignore.

## What the data is

51 net-new song origins, compiled from fan newsletters (Moon Times / The Panicle), band interviews (Spreadnet archive, JamBase, American Songwriter, Glide, a Colorado Music Hall of Fame speech), and everydaycompanion.com. Every claim is sourced. **Burnthday is the compiler, not a narrator** — entries lead with the source's own words, attributed; there is no ghostwritten voice-over. No em dashes anywhere (deliberate).

It is a **net-new supplement** to the Facebook-sourced `song-origins.json` (the existing 40), cross-checked for zero title/slug collisions. Merge both when rendering `/song-origins/`.

## Per-origin schema

```
title, slug, type ("Original"|"Cover"), isCover,
performedBy, composer, originalArtist,          // MusicComposition.composer / byArtist
aliases[], albums[{name, year}], albumArt,       // /assets/archive-media/*-cover.jpg when a WSP release
firstPlayed (ISO), firstPlayedDisplay, timesPlayed,
summary,                                          // plain-language; use for <meta description> + OG
quotes[ {text, speaker, speakerRole, source, sourceDate, url} ],
notes,                                            // factual, optional
sources[ {label, publisher, url} ], sameAs[],     // authority links
clusters[ {type, label, slug} ],                  // type ∈ type|writer|album|theme
related[ {slug, title, why} ],                    // sibling origins with a reason
faq[ {q, a} ],                                    // pre-computed for FAQPage
kind                                              // "story" | "fact" | "trivia" — see below
```

**`kind`** tells the site how much to show: `story` (21 — leads with a real narrative; give it a full write-up), `fact` (25 — a sourced writer/album/context note; a compact card), `trivia` (5 — a deep-cut confirmation like the unreleased "Burned Faceless"; a one-liner). Don't dress a one-line fact up as a saga.

## Band FAQ

`data/source/band-faq.json` is a separate band-level FAQ (13 questions a new fan asks: the name origin, what happened to Houser, how they formed, first release, starter albums, etc.). Answers are the site's own plain copy, sourced where the fact came from the archive; entries flagged `"verify": true` are general knowledge to confirm before publishing. Render as a FAQ page + schema.org `FAQPage` JSON-LD — high-value for "who is Widespread Panic" / "what happened to Michael Houser" search intent.

26 of 51 lead with a verbatim attributed quote; the other 25 (mostly EC-sourced covers with no band quote located yet) carry structured facts + sources only. Spreadnet mailing-list transcripts have no canonical URL, so those `url`s are `null` on purpose — do not invent one.

## SEO / structured data (this is the point)

Emit JSON-LD per origin page:
- **MusicComposition** — `name`, `composer` (or `byArtist` for covers), `recordedAs`/album from `albums[]`, `sameAs` from `sameAs[]`.
- **Quotation** per `quotes[]` — `text`, `creator` = speaker, `citation` = source (+ `url` when present).
- **VideoObject** for any live/official clip you wire (e.g. Aunt Avis' Billy Bob Thornton video).
- **FAQPage** — straight from `faq[]` ("Who wrote…", "Is it a cover…", "When first played…"). High-value for "who wrote ___" search intent.

## Pillar + cluster architecture

- **Pillar:** `/song-origins/` — "The Story Behind Every Widespread Panic Song."
- **Clusters** (each a page grouping + interlinking members; slugs already in `clusters[]`):
  - **By writer** (entity authority, the SEO win): `jerry-joseph-songs`, `bloodkin-songs`, `vic-chesnutt-songs`, `michael-houser-songs`, `junior-kimbrough-songs`, `todd-nance-songs`.
  - **By album:** `album-*` (tie into the existing album pages).
  - **By theme/place:** `colorado-songs` (Postcard, Bear's Gone Fishin', Surprise Valley — the Bear/Red Rocks thread), `new-orleans-songs`, `mississippi-songs`, `early-athens`, `herring-era`, `instrumentals`.
  - **By type:** `widespread-panic-originals`, `covers`.
- Each origin links up to its clusters + pillar and across to `related[]`. Clusters link to siblings. That mesh = topical authority.

## Internal linking

Each origin should link to: the on-site **song page** (lyrics / chords / Songsterr tabs / live-history already exist there — match by title/slug; don't re-derive those URLs here), the **album page**, its **clusters**, its **related[]**, and its **Moon Times / Panicle mentions** (see `newsletters.json`). Setlist pages should link down into stories.

## Design cues (take or leave)

Prototype: `design/prototypes/song-origin-page.html` (Postcard). Notable moves:
- **Attribution as a marker-color pill**, colored by band member (Schools = blue `#286e9e`, JB = red `#d4514f`, Houser = green `#2d7c52`) — makes the board's dry-erase color system mean something site-wide. No "— Name" dash lines.
- **Artifact-first images:** the real object when it exists (the postcard, the Space Baby 45 label, a poster), else the `albumArt` cover, else a Panic-Hand typographic card. Alt text = `summary` (doubles as ImageObject / OG card). The existing 40 also carry Facebook images.
- **Action bar:** Listen (Spotify/Apple) · live YouTube · Lyrics · Chords/Tabs · Every-time-played.
- **Homepage:** a "Story Behind the Songs" strip near the bottom (rotating featured origin), and deep-link the board's song rows into their story + lyrics.

## Merge / wiring notes

- `loadSongOrigins()` in `build.mjs` currently reads only `song-origins.json`; append the curated entries (all net-new, dedupe by slug).
- The current `renderSongOriginPage()` hardcodes an "Original Facebook post" link — render from the structured fields instead (quotes as attributed blockquotes with source links) and emit the JSON-LD above.
- Cross-linking already works by normalized title (`originsByTitle`); curated titles match `catalog.csv`.

## Acknowledgments

The file carries an `acknowledgments[]` field. Ethan Ice contributed the Relix (Oct/Nov 2003) "Southeast of Eden" scans that sourced the seven Ball-era origins (Fishing, Papa Johnny Road, Nebulous, Travelin' Man, Tortured Artist, Meeting of the Waters, Counting Train Cars). Surface a "special thanks" credit where these render.

## Porch Songs (Mikey-era tour context)

`data/source/porch-songs.json` (run `npm run import:porch-songs`) is the band's own "Porch Songs" archival-release series — 27 specific historic shows, mostly 1991–2002, 13 of them with real highlight notes ("first ever 'Bear's Gone Fishin'," "the very first 'Don't Tell the Band,' sit-ins by the Dickinson brothers…"). Each entry: title, volume, year, date (ISO where known), venue, `highlights`, `sourceUrl` (links back to the official band page), and a `listen` link (Relisten / archive.org). Use it to **decorate Tour-in-Review**, especially the sparse pre-2002 years: show the band's highlight note + a listen link, and cross-link to origins for songs that debuted that show. Curation + attribution, not republication — full text stays on the band's site.

## Tour posters

`data/source/tour-posters.json` (run `npm run import:tour-posters`) is one commissioned print per tour (58 of them, 1993 onward, ~28 Mikey-era), harvested from the band's official poster archive sitemap. NOT the per-show gig posters (there are ~780 of those). Each entry: `year`, `tour`, `season`, `artist`, `image` (the band's S3 URL), `sourceUrl`. Use one per tour on Tour-in-Review. IMPORTANT: poster art is © the credited artists (Chris Bilheimer, Chuck Sperry, Jeff Wood, JT Lucchesi, Marq Spusta, David Welker, Nate Duval, …) — always display with the artist credit and a link back to the official page; never present the art as unattributed.
