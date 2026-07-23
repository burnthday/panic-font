# Handoff — Burnthday hero architecture + QA rounds (2026-07-22)

## Open loops — swept from the FULL conversation first

- (a) **Threads opened, never closed:** Sacramento setlist promotion (blocked on data — see below). Highlight-a-show rework (advice given, no go from Alex). Tab fallback on Lyrics & Chords (option named, no decision). "Flip through setlists" → BUILT (date pager). Nick stats dedicated session → PARTIAL (two-column layout shipped; the deeper labels/filters/sort rethink Alex asked for was never fully revisited). FAQ images beyond the two Alex provided — he said "I can help fill the rest in," nothing arrived yet.
- (b) **Questions asked, unanswered:** highlight-a-show go/no-go; tab-fallback call. Nothing else pending.
- (c) **Said I'd do, didn't:** nothing outstanding — round-4 checklist and this handoff were the session's last items.
- (d) **Goal evolution:** began as "QA batch fixes across pages" (breadcrumbs, footer, song index, FAQ) → pivoted mid-session, deliberately and with Alex, into a full **homepage hero architecture rebuild** → hero is now the centerpiece: dedicated full-bleed section, per-show views, date pager, fixed 4-slot rail, tinted stage light. The original QA-fix stream all landed along the way. Do not present the hero work as scope drift — Alex drove it.

## Why this exists

Session ran ~2 days, heavy token burn (Alex: "we have burned a week of tokens in two days" — respect that; work surgically, verify via DOM probes not repeated screenshots). Pausing at a natural seam: hero architecture DONE and verified; next work is data-gated (Sacramento) or new scope (mobile pass).

## The goal

Keep tightening toward "ship it" (production deploy HELD — the word must come from Alex in his current message). Nearest deliverables: Alex's round-4 checklist feedback; Sacramento-as-hero the moment its setlist exists; mobile sweep; greenlit queue items.

## Confirmed facts (do NOT re-derive)

- Repo `/Users/alex/claude/panic-font`. Branch `claude/project-status-4jp3e7` → auto-deploys the **dev preview only**: https://stagelight-preview.burnthday-d3j.pages.dev (Cloudflare account mouraalexander bb75082c). Production burnthday.com untouched.
- Build `node scripts/build.mjs` → dist/. Gate `npm run qa` — **524/524 site + 50/50 production green at handoff**. Changed guarded markup ⇒ update `scripts/qa-site.mjs` at EQUAL strength, never weaken.
- Git flow: `git pull --ff-only` → edit → build → qa → commit (surgical adds only) → `git pull --rebase` → push. Parallel sessions share the branch.
- Nearly everything is in **`scripts/build.mjs`** (~15k lines: render fns + CSS templates + inline scripts). Guards in `scripts/qa-site.mjs`.
- **Sacramento 7/21 has NO setlist data**: cache entry exists with `songs: []`; no SETLISTFM_API_KEY in this env. [HISTORICAL] The daily Action `setlistfm-sync.yml` populates it automatically once setlist.fm has it. NEVER invent a setlist.
- Sacramento hero art ALREADY WIRED via `data/source/setlist-overrides-2026.json` (image …4276.jpg, bgImage …4728.jpg, credit Andy Tennille; LA 7/23 carries …3703.jpg). Build merges overrides onto posted AND unposted shows (`loadShowOverrides` in `loadSourceData`; tonight-preview merge in `buildSiteData`).
- Verified stream links (band's own posts): nugs.net/widespreadpanic · twitch.tv/widespreadpanichq (free audio) · youtube.com/user/WidespreadPanicMusic. A guard now ASSERTS these in the upcoming view (the old "no Twitch" guard was deliberately flipped — Alex requested the links).
- The embedded preview pane throttles rAF/timers — animations look broken in probes but are fine in real browsers; every interactive fix already uses rAF+timeout fallbacks. Verify with DOM state, not screenshots (screenshot-scroll desyncs constantly).

## Architecture decisions — Alex-approved this session (WHY included; don't reopen unless the WHY changes; nothing is final until shipped)

- **Hero = dedicated `<section class="home-hero">`, never the .show-entry feed card.** WHY: card reuse leaked chrome (border/chevron); Alex: "you have forced the rails instead of creating a unique hero section." Full-bleed per-view blurred bg layers, sharp framed photo top-right, strict 50/50 2×2 grid (identity centered vs photo / setlist below the image line vs ticker+rail), nothing crosses the center gutter, no horizontal dividers on the left — alignment separates.
- **Rail = four FIXED slots**: context ×2 (content-fade refills only), latest show pinned third, TONIGHT pinned fourth; the active view's card carries the red ring (shelf-watch language) instead of hiding. WHY: hiding/reordering/FLIP caused jumping + phantom-4th-card bugs; fixed slots ended the class. Meta ships as JSON `#hero-card-meta`; slots `data-card-slot="a|b|latest"`.
- **Date pager** ‹ › + "N of 29" above the date: walks ALL posted shows chronologically + tonight, WRAPS at both ends, ArrowLeft/Right wired. Every posted show is a server-rendered hero view (lazy assets except featured).
- **Upcoming show is a hero view, not an external link**: stream links + data-driven "On the table" paragraph (`computeOnTheTable`: last-100 regulars ≥2× past usual gap — "Cosmic Confidante runs about every 11 shows and it's been 32"). Real data only.
- **Song stats = in-place expansion** in the photo slot (not a modal — Alex's call), rarity symbol per song, shimmer-ring button (18s orbiting glint, cursor-tracking on hover, reduced-motion static).
- **Ticker**: borderless slow crawl (46s doubled track, hover-pause), carries pulls + ≥30-show gaps + live debuts + editorial notes; lineup boilerplate stays as the setlist footnote; rarity glyphs tinted per tier.
- **Type/voice**: sentence case headlines; ALL-CAPS only for mono micro-labels. `.link-quiet` for tertiary actions — use sparingly. Taste anchors: Stripe/Ramp/Linear (no decorative dividers; benefit-driven 4-col explainers with bold lead words; two-tone intro sentences).
- **Board intro**: one dynamic two-tone sentence ("…for tonight's/tomorrow's/Friday's/next week's show at City's Venue."), stats line deleted, stage-light beam tinted from the hero photo (runtime canvas sample → `--hero-glow`, taint-safe fallback).
- **Parked, one-line restores in code:** Newsletters page, The Almanac. Sheet key de-bentoed: bold sentence + four marker CIRCLES ("1 show ago"…"4 shows ago", date+city below). Marker canon: Black/Blue/Green/Red = 1/2/3/4 shows ago (Alex's sheet).
- **Footer**: "Burnthday's Panic Spread Sheet" 19px, 17px links, no caps on Privacy/Site by Gnarlywhal. Nav: no wordmark, no Get Tickets (mega-menu keeps its CTA).
- **[HISTORICAL] Anti-fabrication is the hard line**: every band fact sourced this session (JoJo/T Lavitz, Brute = whole band + Vic, Bonnaroo count is 6 not 8, spelling is Garrie **Vereen**, Nick/AIM story corrected against Alex's memory per ARTS ATL: the Jimmy lessons never happened). Unverifiable (synth era, Sam Holt '99 gear interview) = omitted and flagged, never written.

## What's NOT done

1. **Sacramento → featured hero** [BLOCKED on setlist data]. When songs land (daily sync or Alex paste), it becomes posted[0] automatically — verify the 1-night-stop path (rail context should become 7/18 + 7/17; upcoming becomes LA 7/23 with the 3703 thumbnail).
2. **Mobile pass** — responsive rules exist; no dedicated phone sweep yet.
3. **Highlight-a-show rework** [awaiting go]: advice on record — pin "Next show" atop the dropdown as a prediction lens; exclude last-4 shows (they're already the color rails).
4. **Tab fallback** on Lyrics & Chords [awaiting call]: Songsterr-search link vs dash.
5. **FAQ**: more images (Alex supplies); synth-era + Sam Holt facts need sources from Alex.
6. **Nick stats deeper rethink** — two-col shipped; the full "labels, filters, sort" dedicated pass Alex requested is still open.
7. **Song-page "Every performance"** — reworked earlier but Alex never re-confirmed after his LISTEN-arrow complaint; re-check on his pass.

## Tools available

Bash, build+qa scripts, preview pane (launch config `burnthday-dist`, port 4321 — throttling caveat above), `gh` authed, WebSearch/WebFetch for fact verification. No SETLISTFM_API_KEY locally [DEV-ONLY: exists as a repo Action secret]. NEVER use Alex's 1Password (standing rule).

## Constraints

Alex is not a coder: show rendered results (`show <file>` → his Chrome) and plain-English status; he reviews via screenshots and gives batched feedback. Production deploy needs "ship it"/"deploy" in his CURRENT message. Never fabricate band facts or setlists. No AI attribution in client-facing output. Token discipline: direct edits over agent fan-outs unless scope demands; DOM probes over screenshot loops.

## Failure modes from this session (do not repeat)

- Reusing an existing component (setlist card) as the hero with CSS overrides → chrome leaked, two rebuild rounds. Dedicated components for dedicated roles.
- Blanket CSS rules (`main > *:not(...)`) silently out-specified component rules — now THREE times (breadcrumb lost sticky). The exact trap: `body.stagelight main > *:not(.hero-echo)…` and `body.stagelight main > .home-nav {position:sticky}` were tied on specificity, sticky won by source order. Adding ANOTHER `:not()` to the blanket (e.g. `:not(.bento-panel)`) raises its specificity one notch, tips the race, and flattens the breadcrumb to `position:relative`. FIX IN PLACE: the blanket now also excludes `:not(.home-nav)`. NEVER add a `:not()` to that blanket without also confirming every self-positioning child (`.home-nav`, `.bento-panel`, `.hero-echo`) is excluded. Do not "fix" a breadcrumb shift with `scrollbar-gutter`/viewport hacks — that was a wrong-diagnosis detour that got reverted.
- Moving/hiding card lists → jump bugs. Keep the fixed-slot model.
- Timer-raced animations broke under frame throttling → always rAF + timeout fallback; release locks unconditionally.
- An agent added images beyond Alex's explicit list (Wikimedia trio, Posse banner) — all ripped out. Only place assets Alex names.
- Ordering assumption (pager array is oldest-first, rail thinks newest-first) put January shows in the rail. Check array direction at every consumer.

## Session-start reading order

1. This file. 2. `OPEN-LOOPS.md` (repo root). 3. `git log --oneline -25` for the narrative. 4. On demand in `scripts/build.mjs`: renderHomeHero/renderHeroView (~8560+), hero CSS (~13070+), hero interaction script renderHeroModalScript (~7095+). 5. Alex's checklist state: `~/Desktop/qa-pass-checklist.html` (round 4).

## Suggested order of work

1. Alex's round-4 checklist feedback — fix flagged items first (his cadence is screenshot-driven batches).
2. Check `data/source/setlistfm-cache.json` for 2026-07-21 songs; if present, verify the automatic Sacramento hero promotion end-to-end.
3. Mobile sweep at 375px: pager, rail stack, ticker, stats panel, breadcrumb.
4. Whichever queued decision Alex greenlights.

## Session close ritual

Commit + push branch (auto-deploys preview), reconcile OPEN-LOOPS.md checkboxes, add a dated line here if the architecture moves again.

---

## CHECKPOINT 2026-07-22 (late) — consolidated design pass shipped

Everything below is BUILT, verified against painted output, and on the preview branch (QA 587/587 + 50/50 at last push, commit a2f744c):

- **Hero:** photo −4% with 110px left-edge dissolve; Photos chip → quiet "Show photos →" tertiary; pager up 10px; glass bars faint-stage-color only; gutter INTENTIONALLY kept 64px (brief's 56 assumed wrong baseline; Alex approved).
- **Rail:** two immediately-preceding shows (run-mates INCLUDED — supersedes the earlier no-run-mates rule, Alex approved) as flat divider rows w/ 220ms direction-aware motion; Sacramento the lone pinned bento.
- **Song sheet:** strikes = stacked physical strokes, black (most recent) on top, 12px base, slight tilt/jitter, staggered draw.
- **Four Garrie ink arrows** (traced from Alex's scans: wave→open V + pressure stroke, unique tilts, left→right gesture stagger) leading the four explanation columns; sheet→explanations gap ~58px.
- **Bento scrawl:** three focus zones; columns are BOTTOM-ANCHORED — position with margin-BOTTOM, not margin-top (a margin-top "fix" was a silent no-op); tuned to 2 titles above cards, 1 great below.
- **Dork stats** (renamed from Tour stats, anchors unchanged): always open, intro row, single stats rail, Tonight's odds closed w/ live top-3 teaser, Find-a-song, applied-filter chips + Clear all, bounded 68vh expand.
- **Nick stats:** predictive two-column feature; Heat model (two-stage eligibility+ranking) validated by walk-forward backtest (Top-5 95%, MRR .724, beats both baselines); tool: scripts/nick-model-backtest.mjs [DEV-ONLY].
- **Shelf Watch:** editorial photo rail, 6 Thomas G. Smith archival photos w/ facial-focus crops [photo display permission = Alex's pre-production call].

STILL OPEN: "From the stage" video section (awaiting Alex's sign-off on Gradle/Smokestack/Rig-Rundown trio, IDs in chat + build sheet); Alex's round-7 review pass (build sheet ~/Desktop/qa-pass-checklist.html has the tracker); Nick top-10 fan-eye review; mobile sweep; Sacramento setlist still songs:[] in cache; production deploy HELD.

## CHECKPOINT 2026-07-23 (early AM) — live queue, exact state

IN FLIGHT: Opus agent restructuring the hero in scripts/build.mjs (hero-left/right column wrappers killing the -61px viewport-fragile pull, photo back in bento frame, breadcrumb hidden until body.nav-hidden then slides into header strip, 88px gutter, rail refill idempotency fix). On completion: verify at 1280x900 AND 1280x700, push.

THEN INLINE (quick, in order):
1. Song Index /songs/ rows render 5 cells in a 6-col grid — Links cell missing from the row template ("Tab" link folded into sr-plays), all columns misaligned. Find the song-index row renderer, restore the 6th cell. Page stays up.
2. Tour stats headline .ds-lead: max-width 50% -> 65% (should wrap 3 lines), keep/ensure padding below (40px), desktop only.
3. Shrink the gap between .bento-region and the Tour stats headline slightly.
4. LOAD-SHIFT BUG (Alex report, desktop): setlist drops after page load — lockStage runs in requestAnimationFrame AFTER first paint, then grows slots to tallest-view min-heights. FIX: call lockStage() synchronously at script execution (before first paint), plus re-run once on document.fonts.ready. One-line timing change in renderHeroModalScript.
5. Hero background breathing (Alex approved direction): idle animation on the hero atmosphere — blurred bg wash scale 1.35->~1.385 over ~20s alternate; --hero-glow radial opacity breathing a few % over ~8s (offset phase); .hero-brush same slow breath. Transform/opacity only, reduced-motion still.
6. From-the-stage header: .fs-head align-items flex-start -> center (drop .fs-yt margin-top 6px) so the YouTube button vertically centers with the headline.

THEN POLISH AGENT (Opus, full spec agreed with Alex):
- Athens strip: attach baseline to footer top edge (zero gap, slight crop), KILL the gradient fill -> solid quiet ink + subtle animated brand-color tie-dye clipped to LEFT side of text only (Webflow steal, shelf-number restraint), scroll-reveal once, reduced-motion seated.
- Community cards (Song Origins / Lyrics & Chords): taller, DELETE eyebrow+headline+subheadline (one line each only), replace circular arrow with our bc-open rounded-square quarter-turn arrow. STANDING RULE from Alex: he hates eyebrow+headline+subheadline stacks — never build them.
- Full-page rhythm audit: one spacing scale between sections, unified two-tone headlines, left-rail alignment, consistent card padding, measured before/after values. Portfolio-grade bar.

STANDING: Alex mandates Opus agents for all sizable builds (token conservation). Production HELD (mobile sweep + photo-permission gates). Build sheet = ~/Desktop/qa-pass-checklist.html. Preview = stagelight-preview.burnthday-d3j.pages.dev. QA was 605/605+50/50 pre-agent.

---

# SESSION CLOSE 2026-07-23 — final state, full sweep, and the failure log

## Goal reconciliation
Session goal (evolved, Alex-driven): round-4 feedback → full design campaign (hero, rail, sheets, Nick, Shelf Watch, Dork/Tour stats, videos, footer, transitions, fonts) + Sacramento content promotion. **MET** for everything built and verified. **Overall ship: PARTIAL** — production still gated on Alex's mobile sweep + photo-permission call. QA at close: 613/613 site + 50/50 production, all pushed to the preview branch.

## What Alex is still waiting on / open items (swept from the FULL conversation)
1. Alex's Round-9 re-review on the build sheet (~/Desktop/qa-pass-checklist.html has autosaving notes + a copy-all button) — INCLUDES cold-load confirmation of the setlist fix (structural grid-stacking; 4th and final attempt).
2. Mobile sweep — Alex's hard gate before any production ship. Never done.
3. Photo display permission (Tennille/Timmermans, band CDN) — Alex's call before production.
4. Poster/subpage-design session RUNNING independently (Alex started the chip). It owns: unified subpage headers, poster placement, living-poster pilot.
5. DAILY CONTENT OPS: after each show run `npm run postshow` then `gh workflow run setlistfm-sync.yml --ref claude/project-status-4jp3e7` (scheduled sync runs on MAIN only — the branch needs manual dispatch), then build/qa/push. LA 7/23 played tonight — needs this tomorrow.
6. Old open loops still live in OPEN-LOOPS.md: Song Index toolbar rethink, highlight-a-show, tab fallback, FAQ sources/images, shelf-taxonomy rethink (parked, rec on file), Garrie separator (parked), video "From the stage" — actually SHIPPED (single cinematic); loop closed below.

## THE FAILURE LOG — every break we fought, and the fix (do not repeat)
1. **Blanket `main > *:not(...)` stacking rule — FOUR strikes** (breadcrumb flattened twice, bento popups rendered inline, subpage sticky stacks collapsed). BREAK: adding any `:not()` raises its specificity and silently beats component rules. FIX: never touch the blanket; repair with matching-specificity explicit selectors. The rule is a landmine — consider dismantling it entirely in a quiet session.
2. **`display:grid/flex` overrides the `hidden` attribute.** BREAK: 312 "hidden" Nick rows all painted (ranks 213+). FIX: explicit `[hidden]{display:none}` beside any display rule — EXCEPT the hero slots, where we now deliberately invert it (see 3).
3. **JS height-locking vs progressive paint — took FOUR attempts.** BREAKS: rAF-after-paint grew slots late; fonts.ready re-lock regrew them; hidden-view re-measure regrew them. ROOT TRUTH: a 1.3MB page paints progressively, so end-of-body JS ALWAYS runs after the user sees the hero. FINAL FIX (structural): grid-stack all views per slot (`grid-area:1/1`, hidden views `display:block; visibility:hidden; pointer-events:none`) — heights intrinsic from first layout, zero JS. LESSON: layout-critical sizing must be CSS-intrinsic on big pages.
4. **The embedded preview pane lies about motion.** Frozen CSS animations/transitions, latched rAF/IO, lazy-load stalls, black screenshots after scroll. FIX: verify PAINTED GEOMETRY and computed styles (offsetHeight, rects, forced classes), never attributes (the hidden-attr bug hid behind an attribute check); judge feel only in Alex's real browser.
5. **Speculative fixes for unreproduced symptoms.** BREAK: scrollbar-gutter "fix" for the breadcrumb added a resting-layout regression (JoJo's photo moved); the REAL cause was trap #1, already documented in git history. FIX: reproduce or trace before shipping; search the repo's own history for prior fixes FIRST (a commit fixing the same symptom existed).
6. **Stale data columns.** BREAK: analyzed shelf fossils from the CSV SLP snapshot → claimed Watchtower "in rotation" when its computed effectiveSlp=241 (on the Shelf). FIX: analyze from dist/data/site-data.json computed values, never source snapshots.
7. **Brittle QA guards.** BREAK: hardcoded window dates broke the first real post-show sync; "at least one multi-strike cluster" broke on a legitimately clean 4-show window. FIX: guards assert relationships to CURRENT data, never literals; tolerate legitimate-zero cases explicitly.
8. **Don't cry fabrication before checking the data.** "Gimme 100 · Blight 87" and the Nick mock songs looked invented — they were REAL computed values/titles. Also inverted: Oakland photos were Tennille, not Timmermans (Alex had them flipped; gallery fact-check settled it). FIX: verify against data/galleries before asserting either way.
9. **Ambiguous surface references.** BREAK: "Jack Straw handwritten on the setlist" got routed to the bento scrawl; Alex meant the song sheet's hand-addon mechanic. FIX: the sheet now has a data-driven debut rule (isTourDebut = playedThisTour && seedTotal 0 → PanicHand add-on, sequential by tourFirstIso). When Alex says "the setlist," ask WHICH surface if any doubt.
10. **Workflows only register from the default branch.** BREAK: setlistfm-sync.yml lived on the feature branch; the "daily sync" had never run once. FIX: file now on main; branch runs need manual --ref dispatch.
11. **Animation choreography must track the actor, not the clock.** BREAK: separator pressure-ink flashed ahead of the pen (fixed timers). FIX: sync secondary effects to the primary motion's actual arrival; if it keeps fighting (3 strikes), DELETE the secondary element (we did).
12. **Copy/system rules now standing:** no em-dashes (AI tell — use the site's middot); NEVER eyebrow+headline+subheadline stacks; red/coral is urgency-only (within-10 rule) — never spread the accent everywhere; two-tone sw-lead is THE section headline pattern; one arrow affordance sitewide (bc-open rounded-square quarter-turn).
13. **Shell quirks:** cwd resets between bash calls (always cd), zsh nomatch kills compound globs, ~/Downloads is TCC-blocked (Desktop works), `show <file>` opens things in Alex's Chrome.
14. **Token/context ops that worked:** Opus agents for every sizable build (8 dispatched, ~130-230k each), inline only for surgical diffs + verification; bank queue/decisions into this handoff BEFORE context rolls; the build-sheet feedback loop (autosave boxes + copy-all) is the review cadence Alex likes.
