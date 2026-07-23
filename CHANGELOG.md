# Changelog

What changed on the site, newest first. Append-only: corrections go in a new entry,
never by editing an old one. One line per meaningful change with its commit.

## 2026-07-23 evening (PUBLISHED)

### Changed
- **Second production deploy of the day: the mobile pass.** 20 commits merged to
  main (`bd666e5`), deploy run 30038180716 green in 3m34s; live verify 200 on
  home, /songs/, /archive/; drawer markup confirmed live.
- **Mobile Sort & Filter drawer** replaces the stacked control walls under 600px
  on Tour Stats and the Nick section — one button, slide-in sheet, scrim, Esc/X
  (`49ceb56`, `299cff0`). Desktop unchanged.
- **Nick preview drops the 0-100 Heat number** — rows read Song + plain-language
  "why now"; ordering unchanged (`eba4f4f`). Renaming the remaining Heat label to
  a real likelihood (bustout-excluded) is specced in memory/mobile-qa-2026-07-23.md.
- **Subpage decks + meta descriptions rewritten in Alex's voice** (`4d49298`,
  `50a53b4`, `f3c8018`): Tour In Review ("The Write-Up Years", computed 2008-2016
  span), Song Origins, Shelf (200-show rule rethink stated in the deck), Rumors
  (stale "2017" meta killed), About (June 2007), FAQ (internal working-note meta
  replaced), Songs/Albums/Lyrics/Archive.

### Fixed
- **Rig modal stacking** — video heading / YouTube pill / Athens strip painted over
  the open popup; modal now portals to body so its z-index wins (`299cff0`).
- **Mobile horizontal rock** — sheet-scrawl bleed inflated the page to 385px and
  the fixed section-nav stretched to match; both back to 375 (`b02844f`).
- **Header hamburger seated on the right rail** at phone widths (`b02844f`).
- **Archive junk removed with 301 insurance** — backdated marker workbench + three
  untitled Entry-N drafts excluded from the build; each crawler-known URL 301s to
  where its content lives; legacy-URL parity 300/300 (`866b8d5`, `0279570`, `db93d47`).

## 2026-07-23 (PUBLISHED)

### Changed
- **The stagelight branch is live on burnthday.com.** 288 commits merged to main
  (`a30e9f3`), deploy run 30027816046 green, home and `/shelf/updates/` both 200.
  Gate at merge: 677/677 site + 50/50 production.

### Fixed
- **Rig captions sourced before publish.** Premier Guitar's Widespread Panic Rig
  Rundown documents the Crown XLS power amps ("with a spare"), the Orange 4x12
  ("run in stereo"), the Ernie Ball volume pedal and the battered Boss tuner as
  **Jimmy Herring's** rig, not as gear independently confirmed on Nick's stage.
  Those four hotspots now carry the dashed "From Jimmy's rig" tag rather than
  "Confirmed / seen on stage" - which is the story the modal header already tells,
  HALF-JIMMY / HALF-MIKEY. Two unsupported clauses were cut: "loaded with Tone
  Tubby ceramics" (PG ties those speakers to Herring's dry cab; the video calls
  this cabinet Mikey's, and joining the two is an inference) and "SAT BASS scrawled
  on top" (a stage-photo read, in neither video). (`58d453d`)

## 2026-07-23 (rig videos live)

### Added
- **Rig popup video slots filled.** Both official Widespread Panic walkthroughs
  now embed in the Nick's Rig popup via the yt-lite facade: "What's the deal
  with Nick's guitar?" (Guitar Review — Zoel on "Amber", h9Weuskqsvw) and "Nick
  Johnson's Rig Rundown with Guitar Tech Joel Byron" (5x4gVol4iIM). Correction
  to the prior entry: the guitar-review tech is Zoel, not Zel.

## 2026-07-23 (nick's rig rundown)

### Added
- **Nick's Rig popup on the homepage.** "Explore the rig →" pill on the Nick
  bento art opens a modal in the site's cmdk/glass style: the rig illustration
  with 13 tappable hotspots (each opens a short caption card — gear name, the
  story, confirmed vs carried-over-from-Jimmy tag), a legend, and video slots
  for the two tech walkthroughs (Zel's guitar review, Joel's Red Rocks rig
  rundown) that render only once their YouTube ids are filled in.

## 2026-07-23 (transitions)

### Fixed
- **Hero transition stutter, root cause found and measured.** Since `1682da7`
  (2:27am) every hero view was kept in layout invisibly so slot heights would be
  intrinsic from first paint. That left 87 invisible view subtrees and 6,591
  elements — about a quarter of the entire page — inside the hero's layout. A
  forced layout pass measured **11.4ms median / 28ms worst**, against **1.3ms**
  without them. The 60fps frame budget is 16.7ms, so layout alone was consuming
  the frame. Now only the longest few views per slot stay in layout to hold the
  height; the rest are `display:none`. After: 15 views, 796 elements, **5.0ms**.
  Verified the original load-shift bug did not return by revealing every view in
  all three slots — none exceeds its reserved height. (`hero layout fix`)
- Living poster now pauses its animation loop when off-screen or the tab is
  hidden. It had been redrawing ~1.5M canvas pixels every frame from load onward
  with no stop condition. (`living poster gating`)

## 2026-07-23 (later)

### Reverted
- The blanket `main > *` stacking rule is BACK. Its removal earlier tonight
  (`3d8598b`) was verified for layout only — painted geometry and paint order
  across ten pages, all identical — but never for motion, and it landed in the same
  window Alex reported transitions stopped being smooth. Removing `z-index` from
  every section changes which elements the browser gives their own compositing
  layer, which can genuinely affect animation. Restored rather than defended.
  Re-attempt only with a real frame-rate measurement in a real browser. (`1fde74c`)

### Still open
- Motion regression not yet isolated. Two candidates remain: the living-poster
  canvases (`1ec3a0c`, see below) and something not yet identified. An independent
  technical review was requested; it declined to name a culprit without frame-rate
  data, and agreed on exactly one concrete point — the rAF loop should pause when
  off-screen or when the tab is hidden.

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
