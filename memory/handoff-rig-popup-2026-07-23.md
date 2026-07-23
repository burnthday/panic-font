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
