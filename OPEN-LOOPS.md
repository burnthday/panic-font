# Open loops — burnthday redesign

Unchecked items resurface at session start until cleared. Check the box or delete the line when done.

- [ ] 2026-07-22 — Song Index toolbar rethink: always-sortable columns, rarity as a checkbox, kill the pill overload; decide which stats belong on which pages (home vs Song Index vs Lyrics & Chords) and why (raised in: Alex's 7/22 late QA notes, "you need to consider this")
- [ ] 2026-07-22 — Tab fallback decision (Alex: "Remind me on the fillback"): songs without our 26 hosted tabs show a dash on Lyrics & Chords; option is a Songsterr tab-search fallback link per row like the Song Index MORE column (raised in: lyrics-hub rework flag, 7/22)
- [x] 2026-07-22 — Band FAQ images: Alex wants more image density on /faq/; hero + one inline break shipped, review whether more repo assets should go in (raised in: 7/22 FAQ feedback)
- [ ] 2026-07-22 — Sam Holt / Randall Bramblett specific sit-in date: woven in by role only, no sourced 2026 sit-in date found; add a concrete show if Alex supplies one (raised in: FAQ rework)
- [x] 2026-07-22 — Alex reviews round-2 checklist (~/Desktop/qa-pass-checklist.html) — "we'll continue tomorrow"
- [ ] 2026-07-22 — FAQ facts waiting on Alex: the "synth era" and the Sam Holt ~'99 "gear from a big band" interview were unverifiable from sources; add to the era history if Alex supplies a source or details (raised in: FAQ round 2)
- [ ] 2026-07-22 — Alex final pass on round-3 checklist (~/Desktop/qa-pass-checklist.html): NEW items + the no-feedback-yet sweep
- [ ] 2026-07-22 — Highlight-a-show rework (STILL-OPEN, advice on record) (Alex + advice given): add the upcoming show to the dropdown and exclude the last 4 shows from the list so sorting serves "panic pick 5" prediction; advised, awaiting Alex's call (raised in: Tour Stats QA)
- [x] 2026-07-22 — Nick stats section dedicated rework session: rebuilt 7/22 as predictive two-column feature (view/type/sortable headers, Heat model + walk-forward backtest in flight)
- [ ] 2026-07-22 — Sacramento 7/21 setlist: blocked on setlist.fm data (songs:[] in cache); hero art pre-wired via setlist-overrides; promote + verify 1-night path when songs land (raised in: hero rebuild)
- [ ] 2026-07-22 — Mobile sweep of the new hero (375px: pager, rail, ticker, stats panel, breadcrumb) before any ship
- [ ] 2026-07-22 — Handoff written: panic-font/memory/handoff-hero-architecture-2026-07-22.md (next session reads it first)
- [ ] 2026-07-22 — Shelf Watch photo permission: archival Thomas G. Smith images load from the band's gallery CDN; Alex confirms display permission before any production ship (raised in: shelf-watch rail build)
- [ ] 2026-07-22 — Video slider above Song Origins: planned, awaiting Alex's go + approved official-video list (raised in: round-6 batch)
- [ ] 2026-07-22 — Nick Heat model: Alex fan-eye review of the top-10 once backtest lands; add explicit exclusion list if any one-offs survive (raised in: Nick correction pass)
- [ ] 2026-07-22 — Mobile: 4-column song sheet wider than phone viewport (clamped, no visible pan) — fold into the dedicated mobile sweep (raised in: hero mobile fix)
- [ ] 2026-07-22 — Garrie separator PARKED (Alex): built + animated, pulled from above the board intro pending a future spot; design lives in ~/Desktop/garrie-separator.html and git history (35d8a22 era)
- [ ] 2026-07-23 — Poster graphics 2.5D pass (FUTURE SESSION, direction agreed with Alex): NO auto-vectorize (kills halftone/engraving texture), NO Blender 3D (uncanny + heavy). DO: layered exports from the original art pipeline (starfield/character/frame per graphic), animate backgrounds only (dot-drift, flame flicker, halftone breathe), 2-3 layer mouse-tilt parallax desktop-only, scroll draw-on reveal, CSS/light-canvas only, reduced-motion safe. Assets: ~/Desktop/burnthday graphics/ (about, rumors, song-origins, the-shelf, tour-in-review). Static right-of-title integration ships first (queued behind polish agent).
