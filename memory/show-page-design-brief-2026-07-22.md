# Burnthday show page — consolidated design pass (Alex + ChatGPT brief, 2026-07-22)

Review: https://stagelight-preview.burnthday-d3j.pages.dev/
Claude Code has final say on cleanest implementation; design intent must remain intact. Do not redesign; preserve two-column composition, dark concert-archive aesthetic, glass bars, typography, highlight strip, bento language.

## Locked changes (hero/action area)
- Desktop gutter between the two main columns: preferred final 56px ("increase by 24px from current" — NOTE: actual current is 64px; see session decision). Reduce progressively at narrower breakpoints.
- Move the circular prev/next arrows above the setlist up by 10px.
- Remove the outlined Photos button. nugs.net stays primary, Listen on Relisten secondary.
- Add "Show photos →" quiet tertiary link below Relisten: ~14px, ~60% white, 12px above. Clearly clickable, not competing.

## Hero image
- Reduce visible footprint ~4% (subtle); preserve subject scale/focal position.
- Replace hard left edge with ambient bleed: horizontal gradient mask ~100–120px wide on the left edge; 12–16px blur ONLY inside the transition zone (not the musician). Photograph dissolves into page background.

## Image behind the glass bars
- Faint continuation of hero image behind menu bar + breadcrumb: aligned ambient layer/pseudo-element, heavily darkened/softened, ~10–15% perceived, vertical fade. No recognizable second face/body — only teal/warm stage light. Preserve text/control contrast.

## Show navigation below highlights strip (the rail)
- Keep highlights strip. Sacramento, CA stays a FIXED pinned upcoming item (TONIGHT state), never moves while browsing.
- Show the TWO IMMEDIATELY PRECEDING shows relative to the active show (viewing 7/18 → 7/17 + 7/16; viewing 7/17 → 7/16 + 7/11). Rail updates only when selected show changes. No autoplay.
- When Sacramento becomes active, don't duplicate the pinned card.
- Hybrid treatment: Sacramento = the only full bento card. Historical shows = flatter rows with thin dividers (date, city, venue, arrow); faint surface on hover/focus only. If flat rows clash with the system, keep very light surfaces and make the pinned card more distinct.
- Motion: animate only the two historical rows on change. ~220ms, ~10px vertical, opacity, cubic-bezier(.22,1,.36,1), direction matches navigation, prefers-reduced-motion → swap/fade. No loops/springs/large slides.

## Responsive
- 56px gutter is desktop target only. Preserve action hierarchy on all breakpoints (Show photos → below Relisten). Historical rail vertical on mobile, upcoming visually separate. No horizontal overflow; bleed/ambient layers never reduce text contrast.

## Song possibilities section — marker layering correction only
- Overlapping marker colors = stacked physical strokes, NOT blended. Oldest show first, most recent last → black always on top. mix-blend-mode: normal; every color its own layer/element.
- Top stroke 1–2px thinner, offset ~2px vertically so older color peeks. Base stroke ~10px high, top ~7–8px.
- Animate strokes oldest→newest, 80–120ms delay between. Slight irregularity (2–4px start/width differences). Keep the key/explanation/animations otherwise unchanged.

## Explanatory list section below the song sheet
- Reduce gap sheet→explanations by ~40px; target 56–64px clear space.
- One hand-drawn white-ink arrow flourish between sheet and explanations, left side, pointing right. ~110–140px long irregular line, hand-drawn arrowhead, white ~65–75%, 2px stroke — ink, not marker.
- Inline SVG, two paths (line then head), stroke-dasharray/offset draw-on: ~350ms line then 120–160ms head, once on viewport entry (IO threshold ~0.35), reduced-motion → completed arrow. Reference paths:
  line: M4 19 C18 15 31 20 46 17 C61 14 72 21 88 17 C103 13 117 19 137 16 (dash 155)
  head: M126 7 C132 11 136 14 141 16 C136 20 132 24 127 29 (dash 48)
  width clamp(110px, 9vw, 140px); stroke-width 2; vector-effect non-scaling-stroke; easing cubic-bezier(.22,1,.36,1).
- No additional arrows/labels/marks.

## Shelf, Purgatory, Woodshed cards
- Fake setlists visible ABOVE and BELOW the cards (the flourish). Move card group up 72px desktop. 72–96px visible setlist above card tops; don't crop at top.
- Blur/opacity tiers: behind cards ~5–6px blur @ 10–12%; above cards ~1.5–2px @ 20–24%; below cards clearest ~0.75–1.25px @ 24–28%.
- Legible below (real titles): West Virginia, Stir It Up, Sympathy for the Devil, Havin' a Ball, Ball of Confusion.
- Dark vertical gradient over artwork but don't erase the upper band. No other decoration/animation. Preserve card click → overlay behavior.

## Dork stats section (Tour stats)
- Remove the outer accordion completely (always open; no chevron, no collapsed state).
- Compact intro row, outside any card: title "Dork stats" (left) + three short secondary lines (right on desktop, stacked below on mobile):
  "Every song played this tour, how often it shows up, and how long it has been gone."
  "Highlight any show to mark its songs in the table."
  "Filter, sort, and open the full list when you want the whole rabbit hole."
- Summary stats: replace four metric bentos with ONE horizontal rail — four equal columns, thin vertical dividers, one subtle outer surface, ~88–96px tall desktop. Same values/labels.
- Tonight's Odds: stays its own accordion, closed by default. Title "Tonight's odds"; "Sacramento, CA" smaller secondary line/after quiet separator. Right side of closed bar: quiet inline preview of REAL top three predictions, format "Top picks  <Song> <score> · <Song> <score> · <Song> <score>" (no pills/cards). Chevron far right. Narrow screens: "<top> <score> · +2 more" or hide. Open → full list.
- Toolbar: Highlight a show (single-select) | 20–24px gap | All/Originals/Covers segmented | rename Not played → "Not played this tour" | Rarity multi-select | compact "Find a song" search at right end. No desktop sort dropdown. When non-obvious filters active: one compact applied-filter row with removable chips + "Clear all".
- Sorting: in column headers; active column+direction visible; inactive icons on hover/focus; click active header toggles asc/desc; one active sort; mobile compact Sort-by menu for hidden columns.
- List: 6–8 rows default. Bottom control "Explore all 159 songs" (computed count) / "Show fewer". Reuse actual Tour Stats behavior, NO virtualization. Expanded: bounded scroll ~65–72vh, sticky filters, sticky semantic table header, normal scrolling (no hover requirement), sticky Show fewer never covering focused row, subtle scrollbar/bottom fade/partial row for discoverability. Mobile: existing responsive pattern.
- Semantic table (not cards); headers one line; keep recent-show color bar per song; show selected show's color in the Highlight control; sticky control never obscures keyboard focus.

## Official video break — "From the stage"
- Insert AFTER Dork stats, BEFORE Shelf Watch. Heading "From the stage"; support line "Official videos from Widespread Panic."
- One featured 16:9 video (~2/3 row) + two smaller stacked in remaining third. Mobile: swipe rail or stack per existing patterns. Existing border/radius/type/hover language; compact; three videos.
- Selection priority: (1) tied to active show/city/venue/tour, (2) recent official live performance, (3) archival deep cut. [SESSION NOTE: video list requires Alex-approved official videos — never invented.]
- Thumbnails only (no iframes by default). Click → official YouTube in existing modal pattern or new tab. No autoplay. Show title, show/date when known, duration. Quiet link below: "More from Widespread Panic on YouTube →".

## Acceptance criteria (abridged)
Same Burnthday page, more resolved; better column breathing room; arrows sit naturally; primary/secondary/tertiary actions clear; no hard hero seam; only faint stage color behind glass; Sacramento stationary while history rows update; smooth animated rows w/ reduced-motion; stable desktop/tablet/mobile; summarize changes + intentional deviations.
