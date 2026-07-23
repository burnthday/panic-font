# Handoff — burnthday QA ownership after the 7/23 publish

## Open loops — swept from the FULL session, not just the end

**(a) Threads opened and never closed**
- **Alex's build-sheet review, rounds 9 through 12.** `~/Desktop/qa-pass-checklist.html` has four unreviewed rounds stacked on it (autosaving notes + a copy-all button). He has not been through any of them. This is the main feedback channel and it is cold.
- **Alex's phone pass.** A 375px technical sweep was done (everything fits, no sideways scroll, pager arrows given 44px targets) but Alex never looked at the site on his actual phone. It was a stated ship gate; the site shipped anyway on his "just publish it". Now a live-site risk, not a pre-ship one.
- **Hero "doesn't fit on the fullscreen of my desktop"** — UNRESOLVED and unreproduced. The hero measures a fixed 902px at every width tested (1440→2560); nothing in the 7/23 commits changes its height, and restoring the old stacking rule produced byte-identical geometry. Needs Alex's actual browser window height, or "it's cut off by about this much", to fix precisely. Do not guess at it.
- **Frozen poster session's WIP is sitting uncommitted on the branch.** Poster-header knockout/mask changes in `renderPosterFigure` + `.ph-poster` CSS (swaps `-knockout` art for plain art, radial mask instead of linear, drops `phFloat`). It was stashed to allow the merge, then restored intact. Someone must finish it or discard it deliberately — read it before doing either.
- **Scheduled deploy has failed at "Run production QA" since 7/21** (7/21, 7/22, 7/23 16:03 all red; the 7/23 17:03 push deploy is green). Most likely cause: those runs were building the stale pre-merge `main`. Probably self-resolves at the next scheduled run — CONFIRM, don't assume.

**(b) Questions asked of Alex, never answered**
- Whether to restore the "loaded with Tone Tubby ceramics" clause on the Sound City caption. Premier Guitar ties Tone Tubby 40/40s to *Herring's* dry cab; the band video calls this cabinet *Mikey's*. They may be one and the same cab — Alex would know — but the join was an inference so it was cut. One word from him restores it.
- Whether to move to separate git checkouts to stop the two-session collisions. Overtaken by events: the other session froze.

**(c) Said I'd do, didn't**
- Nothing outstanding. The rig-caption blocker was cleared and shipped; the LA post-show routine is not "owed" yet (see below).

**(d) How the goal evolved**
Opened as "run the post-show routine for LA 7/23, then stand by for Round-9 feedback". Became, in order: a QA/bug sweep → a hero transition performance investigation → the Nick section rebuild → the Athens/footer motion rework → and finally the rig-caption sourcing pass and a full production publish. Alex drove every pivot. The session ended somewhere very different from where it started, and that was correct.

## Why this exists

Alex wants ONE session owning QA from here. The previous session was out of context ("Fable is pretty much cooked"). The site is now LIVE, so the job changes shape: this is no longer "get it ready to ship", it is "watch what shipped, close the feedback loop, and run the daily content ops".

## The goal

Own QA and daily content operations for burnthday.com now that it is live. Done = Alex's outstanding build-sheet rounds are worked through, the live site is verified on his real phone and desktop, and each show night's setlist lands on the site without him having to ask.

## Confirmed facts (do NOT re-derive)

- **The site is LIVE.** `claude/project-status-4jp3e7` (288 commits) merged to `main` as `a30e9f3`; deploy run 30027816046 green; `burnthday.com/` and `/shelf/updates/` both 200. Gate at merge: **677/677 site + 50/50 production**.
- Repo `/Users/alex/claude/panic-font`. Work continues on `claude/project-status-4jp3e7`; it auto-deploys the PREVIEW (`stagelight-preview.burnthday-d3j.pages.dev`). **Pushing `main` is now a live deploy** and needs Alex's word in his current message, every time.
- Build `node scripts/build.mjs` → `dist/`. Gate `npm run qa`. Changed guarded markup ⇒ update `scripts/qa-site.mjs` at EQUAL strength, never weaken.
- Nearly everything is in `scripts/build.mjs` (~15k lines: render fns + CSS template strings + inline scripts). Guards in `scripts/qa-site.mjs`. Ledger in `CHANGELOG.md` (append-only). Open items in `OPEN-LOOPS.md`.
- **LA Orpheum run is 7/23 (that night) and 7/25**, per widespreadpanic.com. setlist.fm's empty LA stubs are misdated 7/24 and 7/25 — trust the band's own tour dates and match by venue + nearest date.
- **Daily content op after each show:** `npm run postshow`, then (only if still working on the feature branch) `gh workflow run setlistfm-sync.yml --ref claude/project-status-4jp3e7`; then build, qa, push. The sync workflow is registered on `main` now, so the scheduled daily run finally works there. NEVER invent a setlist.
- The rig popup is live with 13 hotspots. Four (Crown XLS, Orange 4x12, Ernie Ball volume, Boss tuner) carry the dashed "From Jimmy's rig" tag because Premier Guitar's Rig Rundown documents them as **Jimmy Herring's**, not as gear confirmed on Nick's stage. Alex's framing: Nick playing Jimmy's and Mikey's gear *is* the story — the modal header already says HALF-JIMMY · HALF-MIKEY.

## Decisions on record this session (with WHY — don't reopen unless the WHY changes)

- **Hero slots keep only the longest few views in layout** (`hv-hold`), everything else `display:none`. WHY: grid-stacking all ~29 views held 87 subtrees / 6,591 elements in the hero and made a forced layout pass cost 11.4ms median (28ms worst) against a 16.7ms frame budget — that was the transition stutter Alex reported. After: 15 views, 796 elements, 5.0ms. Verified no load-shift regression by revealing every view in all three slots; none exceeds its reserved height. A guard locks the bounded holder count. **Never re-stack all views.**
- **The blanket `main > *:not(...)` stacking rule stays.** It was dismantled and then RESTORED. WHY: the dismantle was verified for layout only (ten pages, byte-identical) and never for motion, and it landed in the window Alex reported the stutter. It is a known bug factory (five documented strikes) and dismantling it is still the right long-term move — but only with a real frame-rate measurement in a real browser first.
- **Athens/footer reveal is scroll-driven CSS with no JavaScript.** WHY: a JS reveal must hide the footer and trust a later event to restore it; if that event never fires the footer is invisible on every page. The embedded preview pane throttles timers, observers and rAF, so that event could not be verified there — neither the observer nor a 6s failsafe fired. Scroll-driven animation degrades to the finished state instead.
- **The living-poster canvas loop pauses off-screen and when the tab is hidden.** WHY: it was redrawing ~1.5M canvas pixels every frame from load onward with no stop condition.
- **No "half-way" links anywhere.** Songsterr *search* URLs were replaced sitewide with direct Everyday Companion song pages. A guard fails the build if one returns. Alex: links that land half-way are worse than nothing.

## What's NOT done

1. Alex's build-sheet rounds 9–12 (the whole feedback backlog).
2. Alex's real-phone pass, and his look at the live rig popup.
3. The hero fullscreen-fit question (needs his window height).
4. Confirm the next scheduled deploy goes green now that `main` is current.
5. The frozen poster-header WIP on the branch: finish or discard.
6. Parked by Alex, do not reopen unprompted: shelf taxonomy rethink (hybrid 200-shows-OR-3-years cutoff, analysis on file), the Garrie separator, the poster 2.5D pass (needs layered re-exports first).
7. Optional: restore the Tone Tubby clause if Alex confirms it's the same cab.

## Tools available

Bash, build + qa scripts, `gh` (authed), WebSearch/WebFetch for sourcing claims, the `show <url>` script (copies to Desktop / opens in Alex's real Chrome). The embedded preview pane is for YOUR verification only and **lies about motion** — it freezes rAF, timers, IntersectionObservers and CSS animations, and returns black screenshots after scrolling. Verify painted geometry and computed styles, never motion, in that pane.

## Constraints

Alex is not a coder: show rendered results, never file paths or code talk. Deploying to `main` needs his explicit word in his current message. Never fabricate band facts or setlists — sourcing beats plausibility, and unverifiable claims get cut, never guessed. No em-dashes in site copy (use the middot ·). Never an eyebrow+headline+subheadline stack. Red/coral is urgency-only. One arrow affordance sitewide.

## Failure modes from this session (do not repeat)

- **Reasoning instead of measuring.** The transition stutter was chased through two wrong theories (my own CSS change, then another session's canvases) before anyone opened the transition itself. Alex's "have you analyzed the actual transition?" found it in ten minutes. Measure the thing that is broken, first.
- **Blaming an adjacent change.** I pointed at another session's commit while my own untested change sat in the same window. Rule: rule yourself out with evidence before naming anyone else.
- **Two sessions in one working copy is destructive.** Builds raced and wiped `dist` mid-verification, a `git checkout` destroyed ~170k tokens of in-flight agent work, and a blanket `git add` swept one session's feature into another's unrelated commit. If parallel sessions are ever running again: separate checkouts, or strictly one at a time.
- **A guard that asserts the old shape will fail the moment you improve the thing.** Expect it, and rewrite the guard at equal strength rather than weakening it.
- Shell: cwd resets between bash calls (always `cd` first), foreground `sleep` is blocked, `~/Downloads` is TCC-blocked (Desktop works).

## Session-start reading order

1. `OPEN-LOOPS.md` 2. This file 3. `CHANGELOG.md` (top entries) 4. `git log --oneline -20` 5. On demand in `scripts/build.mjs`: `NICK_RIG` (rig popup), `renderNickJohnsonFeature`, hero code around `renderHomeHero` / `renderHeroView` / `renderHeroModalScript`.

## Suggested order of work

1. Ask Alex for the build sheet — work rounds 9–12 in order, fixing flagged items first. That is the backlog.
2. Run the post-show routine after each LA show (7/23 night, then 7/25) and verify the show promotes to the hero end to end.
3. Confirm the next scheduled deploy is green.
4. Get his window height and close the hero fullscreen-fit question.
5. Resolve the frozen poster WIP.

## Session close ritual

Append a `CHANGELOG.md` entry for anything shipped, reconcile `OPEN-LOOPS.md` checkboxes, and add a dated line here if ownership moves again.
