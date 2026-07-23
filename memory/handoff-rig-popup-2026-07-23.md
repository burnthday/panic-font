# Handoff — Nick's Rig popup: verify captions, then publish

## Why this exists
The rig-popup session (design side) is done and freezing per Alex's 7/23 decision: the publish-run session drives the ship; this session finishes, commits, freezes. Two sessions were colliding in the same working copy — this file is the clean baton pass. Lesson learned: coordinate through OPEN-LOOPS/commits, not parallel edits to the same dist.

## The goal
Clear the OPEN-LOOPS publish blocker on the rig popup's gear claims, then merge `claude/project-status-4jp3e7` to main so it deploys with the rest of the branch. Done = popup live on burnthday.com with every caption sourced or cut.

## Confirmed facts (do NOT re-derive)
- The popup is built, committed, and functionally verified: `661bb90` (feature) + `c91bdd9` (videos + lite-embed handler on homepage). All code lives in `scripts/build.mjs` — search `NICK_RIG` (data), `renderNickRigModal` (markup), `renderNickRigScript` (JS), `NICK'S RIG RUNDOWN` (CSS, in the stagelight overrides near `.nick-bento`).
- [FEATURE] Trigger: "Explore the rig →" pill on the nick-bento art. Modal follows the cmdk glass conventions (backdrop blur, `cmdk-lock` scroll lock, Esc/backdrop close, focus to close button). 13 hotspots → caption cards; legend (solid blue = seen on stage, dashed amber = carried over from Jimmy's rig); two yt-lite video embeds.
- [FEATURE] Videos are wired and verified playing, both from the official Widespread Panic channel:
  - Guitar Review — Zoel on "Amber": `h9Weuskqsvw` ("What's the deal with Nick's guitar?")
  - Rig Rundown — Joel Byron at Red Rocks: `5x4gVol4iIM` ("Nick Johnson's Rig Rundown with Guitar Tech Joel Byron")
- Name fix already applied everywhere: the guitar-review tech is **Zoel** (not Zel). The Red Rocks tech is Joel Byron per the video's official title.
- [HISTORICAL] The mockup prototype (design/prototypes/nick-rig-popup.html) was superseded by the real integration and deleted. Two untracked PNGs in assets/posters/ belong to the poster-2.5D workstream, not this one — leave them.

## The publish blocker — claim-by-claim source map
Verify each caption in `NICK_RIG_SPOTS` (scripts/build.mjs) against its source. Watch both videos once; that covers most of it.

**Sourced directly from the two embedded videos (strong):**
- amber — PRS DGT, Mexico backline rental → Nick bought it, flame maple/amber stain, bent trem arm, swapped volume controls, nickname Amber. Source: Zoel video, verbatim.
- hometeam — friend-built Soldano SLO clone, same amp type Mikey used. Source: Joel video.
- steve — "50W Marshall clone" used before the SLO arrived at Red Rocks. Source: Joel video ("STEVE" nameplate visible on stage art/photos).
- soundcity — "Mikey's main cabinet from back in the day." Source: Joel video. **BUT see flag 1 below.**
- dd3t — Mikey ran the original DD-3, this one adds tap tempo. Source: Joel video.

**Sourced from Premier Guitar's Jimmy Herring rig coverage, applied to Nick because Joel says Nick uses "Jimmy's reverb setup" as the second half (medium — keep, soften, or cut):**
- crown — "one live and one spare" (PG says XLS1500 + spare).
- orange — "runs in stereo for the wet side."
- brownbox — voltage attenuator, Col. Bruce sticker. Already hedged with the dashed "From Jimmy's rig" tag.
- vol — "first thing the guitar hits" (PG describes Jimmy plugging straight into an EB volume pedal — Nick's chain not explicitly documented).
- tuner — "battered chromatic tuner, straight off Jimmy's floor" (PG describes Jimmy's battered TU-2).

**Flags — fix before ship:**
1. **soundcity caption says "loaded with Tone Tubby ceramics."** Tone Tubby comes from PG's description of *Jimmy's* Sound City. Joel's video calls the cab *Mikey's*. Possibly the same physical cab, but unconfirmed → **cut the Tone Tubby clause** unless you can source it. Anti-fabrication rule: unverifiable gets cut, never guessed.
2. green — "SAT BASS scrawled on top" came from stage-photo reads in Alex's research thread, not the videos. If the Joel video shows it, keep; otherwise soften to "overdrive wrapped in green gaffer tape."
3. mesa — caption only says it sits under the hometeam head (visible in stage photos). Low risk, confirm against the Joel video's pan of the backline.

## What's NOT yet done
- The caption verification pass above (the blocker).
- Merge to main → auto-deploy (deploy.yml fires on push to main). Alex's deploy word required in-session per the global gate.
- Alex's real-browser look at the popup on the deployed site.
- Uncheck the OPEN-LOOPS publish-blocker line once cleared.

## Constraints
- Alex is not a coder; show results via `show <url>`, never file paths or code talk.
- Deploy gate: merging/pushing to main is the live deploy — needs Alex's explicit word in the current message.
- R14: caption copy is Alex-approved as shipped; the only edits on the table are the sourcing fixes flagged above. Don't rewrite voice.
- Append-only CHANGELOG; new entries for corrections.

## Failure modes from this session (don't repeat)
- Two sessions editing the same working copy: dist builds raced (ENOTEMPTY), a dev server died mid-verify, and branch tips crossed. You own the repo now; this session is frozen.
- "Zel" shipped in code + changelog from an auto-transcript; Alex had to correct it. Verify names against the official video titles, not transcripts.

## Session-start reading order
1. OPEN-LOOPS.md (rig blocker + publish-run decision lines)
2. This file
3. `scripts/build.mjs` — search `NICK_RIG`

## Suggested order of work
1. Watch both videos, verify the claim map above; apply flag fixes (Tone Tubby clause especially).
2. `npm run build`, spot-check the popup locally, `show` Alex the result.
3. On Alex's deploy word: merge branch → main, push, confirm the Action deploys, verify live, then clear the OPEN-LOOPS line and checkpoint.

## Session close ritual
Dated one-liner in the master/checkpoint surface + CHANGELOG entry for the merge.

## Post-handoff insight (Alex, 7/23) — the retag that takes it to a 10
While verifying captions, also **retag the hotspots by whose gear it is — Mikey's · Jimmy's · Nick's own — instead of confirmed/assumed.** Same dots, same verification work, three colors; legend reads "Mikey's · Jimmy's · Nick's." The rig's real story is that it's mostly two other guys' gear: Mikey's actual Sound City 4x12 still moving air, a Soldano because that's the amp Mikey ran, Jimmy's entire wet rig humming behind Nick while Jimmy's out sick, and one guitar (Amber) that's genuinely Nick's — bought after Mexico because he wouldn't give it back. The whose-gear framing makes the graphic tell that at a glance; the confirmed/assumed label was just fact-checking nobody asked for. Sourcing still governs what each caption *claims* — this is only about what the dots *communicate*. (Rejected en route: deep-linking captions to video timestamps — the tech naming a cab isn't a wow moment, so it's a citation, not a payoff. Skip it.)

---

## RETAG EXECUTION SPEC — added 2026-07-23 (ONE session executes this, alone)

Three sessions were colliding on this working copy (races wiped dist, checkouts clobbered uncommitted work). This spec exists so a SINGLE session can do the whole retag start to finish with the other sessions frozen. Do not run this in parallel with another writer.

### What Alex approved
Retag the rig hotspots by WHOSE GEAR each piece is — Mikey's / Jimmy's / Nick's — replacing the old "confirmed / assumed" scheme. The dots should tell "mostly two other guys' gear" at a glance. Sourcing governs every caption; this is what the dots communicate before you read a word.

### Sourcing audit (why the map is what it is)
Only three hard sources exist, plus Alex's own calls:
- **Zoel video** (h9Weuskqsvw, "guitar review"): the Amber PRS DGT only.
- **Joel Byron video** (5x4gVol4iIM, Red Rocks "rig rundown"): names exactly six things — "Mikey's main cabinet" (UNNAMED in the video), the 50W Marshall clone (STEVE), the Soldano SLO clone (hometeam, "one of Nick's friends made this amp"), "Jimmy's reverb setup," and a "newer DD-3" with tap tempo (Mikey ran the original).
- **Premier Guitar, Widespread Panic Rig Rundown** — this documents JIMMY HERRING's rig: the Sound City 4x12 (Herring's dry cab), Crown XLS1500 + spare, Orange 4x12 in stereo, Brown Box w/ Col. Bruce sticker, Ernie Ball volume + battered Boss TU-2.
- **Alex (superfan authority):** Mikey had the Mesa/Boogie cab; STEVE is Nick's; Mikey did NOT have a Sound City.

The captions had been generated by an AI (Gemini/ChatGPT) that repeatedly conflated Jimmy's published 2024 rig with Nick's 2026 rig and read pedals off blurry photos. Errors caught and to be removed/fixed: "Mikey's Sound City" (conflation — Sound City is Jimmy's), "Tone Tubby" (already cut — that's Jimmy's cab spec), the green "SAT BASS" box (AI photo-read only), the TC PolyTune (AI photo-read only).

### FINAL OWNER MAP (11 hotspots)
- **nick (4):** amber, hometeam, steve, dd3t
- **jimmy (6):** soundcity, crown, orange, brownbox, tuner, vol
- **mikey (1):** mesa

### CUT these two hotspots entirely (unsourced — AI reading photos)
- `green` ("The green box" / SAT BASS overdrive)
- `polytune` ("TC PolyTune") — also redundant with the sourced Boss TU-2

### Caption rewrites (keep voice; only these change)
- `soundcity` owner jimmy, note → "The dry side of Jimmy's rig, an old 4x12 Nick inherited while Jimmy's out." (was wrongly "Mikey's original cabinet")
- `mesa` owner mikey, note → "Mikey's main cabinet from back in the day. Still moving air." (was "Sits under the hometeam head")
- `tuner` name → "Boss TU-2" (Premier Guitar names it precisely); note stays "Battered chromatic tuner, straight off Jimmy's floor."
All other captions already verify verbatim against the sources — leave them.

### Data shape change (scripts/build.mjs, NICK_RIG_SPOTS ~line 9690)
Replace `tag` + `assumed` on each spot with a single `owner: "mikey"|"jimmy"|"nick"`. Add `const RIG_OWNER_LABEL = { mikey: "Mikey's", jimmy: "Jimmy's", nick: "Nick's" };`.

### Render (build.mjs ~9707)
- spot: `class="rig-spot rig-${s.owner}"` (drop is-assumed)
- tip tag: `<span class="rig-tag rig-${s.owner}">${escapeHtml(RIG_OWNER_LABEL[s.owner])}</span>`
- legend (~9727): three entries — Mikey's / Jimmy's / Nick's, each with a color swatch `<i>`.

### CSS (build.mjs ~15807) — ALSO fixes the design-system gripe (colors were hardcoded rgb, not tokens)
Define per-owner color as an `--c: R,G,B` triple on each owner class and drive the spot/tag/legend off `rgba(var(--c), a)`:
- `.rig-mikey { --c: 201,163,95; }`  (heritage gold, ties to the amber guitar + Athens gold)
- `.rig-jimmy { --c: 94,158,210; }`  (cool blue = the wet/reverb side)
- `.rig-nick  { --c: 242,242,240; }` (bright warm white = the living player)
Remove the old `.is-assumed`, `.rl-conf`, `.rl-assumed` rules. Keep the `.is-active` behavior (brighten the active dot).

### QA guard to ADD (scripts/qa-site.mjs) — at equal strength
Assert: legend reads Mikey's/Jimmy's/Nick's (3 owners); no `rig-tag` says "Confirmed"/"assumed"; NO hotspot id `green` or `polytune` in the built HTML; `soundcity` carries the jimmy owner class (guards the conflation from returning). Search qa-site for the existing rig line (~401, "rig runtime animation-safe") to place near.

### OPEN — Alex must still call these (do NOT decide unilaterally)
1. **Top bar:** the `.rig-head` has extra padding + a border-bottom divider the other modals (`.hero-modal-head`, e.g. song-stats) don't — reads heavier. Proposal: match the standard modal header. AWAITING ALEX.
2. **Tagline** FULLY RESOLVED (Alex 7/23, Katherine-gated). Drop "HALF-JIMMY · HALF-MIKEY". The header becomes a bold HEADLINE + a body line:
   - **HEADLINE (bold, the site's headline style):** "An honest tone with a blistering lead."
   - **BODY line under it:** "Nick's playing through Mikey's old cabinet and an SLO clone running through Jimmy's wet rig."
   NOTE for the executing session: the headline deliberately ECHOES a Widespread Panic lyric from "Driving Song" (a Houser co-write, founding era): "an honest tune with a lingering lead has taken me this far." Alex adapted it on purpose to "tone" + "blistering lead" so it is Nick's own line and NOT a lyric reproduction. DO NOT "correct" it back to the lyric or flag it as a typo. No attribution shown. This replaces the <span> micro-label with a headline+body block; do it as part of the top-bar header rework.

### Ship path
All edits on `claude/project-status-4jp3e7` → preview only. Live requires a merge to main with Alex's explicit deploy word. Build `node scripts/build.mjs`, gate `npm run qa` must stay green, then `show` Alex the preview before any deploy talk.
