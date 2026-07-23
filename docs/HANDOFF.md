# Burnthday — Session Handoff (2026-07-22, ~1:30am ET)

State: redesign complete, QA 428/428 site + 50/50 production, all green.
Branch `claude/project-status-4jp3e7` = the shippable site. `main` = old site,
clean fast-forward away. Launch runbook: docs/CUTOVER.md. Target: July 27
(site's 19th anniversary).

## Open loops — Alex's moves
1. RUMORS ART (#20): approved treatment built & waiting. Preview viewer HTML
   delivered (rumors-hero-preview.html — pair with mother-rumors.png locally).
   To go live: upload PNG as design/art/mother-rumors.png (GitHub web upload
   or local session), then any session wires the hero per the locked spec
   (Marquee pattern, feathered-edge mask, Rumor-Red stage).
2. TOUR NOTES: 5 drafts in data/source/tour-notes/*.md await Alex's read/edit.
   His verdict calibrates the voice before scaling past 5.
3. CUTOVER: follow docs/CUTOVER.md. Only Alex says go.

## Small pending decisions
- Cross-promo band (Song Origins + Lyrics & Chords cards): homepage-only
  today; extend sitewide? (one-word decision)
- Lyrics filter label shipped as "On Burnthday" — rename if preferred.
- Watch the first 4am ET setlist.fm sync run end-to-end (cron + deploy
  dispatch shipped tonight, not yet observed live).

## Post-launch backlog (documented, deliberately deferred)
- Scale Tour Notes 5 → 148 tours (after voice verdict)
- newsletters.json + import-newsletters.mjs sit UNMERGED on branch
  claude/affectionate-blackwell-b25e75 — Alex's call
- Cluster index pages (origin chips are labels, not links yet)
- /faq/ page from data/source/band-faq.json (merged, unrendered)
- Abi art slate (Shelf/Origins/Lyrics/Tour/404) — paused by Alex
- Relisten per-track links for Burnthday's Picks — cancelled unless revived
- Archive "Entry 28"-style untitled posts cleanup
- Tour photos via Alex's Bright Data/Facebook pull
- Motion/sparkline extras from the Stripe plan

## For any future session
- ONE agent at a time in scripts/build.mjs (serialize; it's the whole site)
- QA is the wall: npm run qa must stay green; never weaken checks
- Voice rule: Alex's words verbatim only; neutral chrome elsewhere
- renderStagelightCss wraps legacy CSS in .laminate{} — live styles must be
  body.stagelight-prefixed; beware pseudo-element collisions (see laminate
  rim/glow incident)
- Relisten slug is /wsp/; panicstream is banned in output (QA-enforced)
