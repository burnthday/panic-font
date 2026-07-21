# Song Origins — data + design handoff

Handoff for the Burnthday.com build session. This describes the curated song-origins data (`data/source/song-origins-curated.json`) and a recommended way to render it. The **data is done**; the render/design is yours to take, adapt, or ignore.

## What the data is

48 net-new song origins, compiled from fan newsletters (Moon Times / The Panicle), band interviews (Spreadnet archive, JamBase, American Songwriter, Glide, a Colorado Music Hall of Fame speech), and everydaycompanion.com. Every claim is sourced. **Burnthday is the compiler, not a narrator** — entries lead with the source's own words, attributed; there is no ghostwritten voice-over. No em dashes anywhere (deliberate).

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
faq[ {q, a} ]                                     // pre-computed for FAQPage
```

24 of 48 lead with a verbatim attributed quote; the other 24 (mostly EC-sourced covers with no band quote located yet) carry structured facts + sources only. Spreadnet mailing-list transcripts have no canonical URL, so those `url`s are `null` on purpose — do not invent one.

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
