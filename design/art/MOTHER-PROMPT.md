# Burnthday Totems — Abi Workflow

All artwork is generated in Abi. Claude does not generate or draw art;
Claude writes short briefs and integrates approved output into the site.

## The method (per Alex)
1. **Always feed a reference image.** The style comes from the reference,
   not from prompt adjectives. Master reference: the approved wizard frame
   (drop at `design/art/reference/`). Supporting refs: the JT crystal-ball
   poster and Sleepy Sun stipple-field poster.
2. **Short prompts.** One or two lines: subject + composition. The reference
   carries the style. Do not stack style words.
3. Palette stays: bone / marker red / gold / deep green / mint stipple on black.
   No text in the art.

## Style anchors
The REFERENCE POSTERS are the anchor — the JT crystal-ball poster and the
Sleepy Sun stipple-field poster (drop scans at `design/art/reference/`).
No generated frame is an anchor until Alex approves one.

The 07/21 wizard test frame is the REJECTED example: what you get from
overprompting with no reference. Reject any output showing its tells:
- soft airbrushed shading anywhere (faces, robes, glows) — inks must be flat
- auto-halftone gradient fades instead of deliberate stipple
- generic stock faces with no character design
- muddy washed color instead of the marker palette
- subjects cropped by the frame edge

## Short prompts for the remaining slate (reference image attached each time)
- **Shelf:** "Same style: a dusty shelf of mason jars on the stippled halo, one jar glowing and rattling."
- **Origins:** "Same style: an old phonograph horn with tree roots gripping a stack of stories."
- **Lyrics:** "Same style: a resonator guitar leaning on a porch rocking chair, moths around the porch light."
- **Tour in Review:** "Same style: a two-lane highway rolling to the horizon, mile markers, a little van."
- **404 / Woodshed:** "Same style: a small woodshed at night in tall grass, one warm window lit."

## Handoff
Approved exports (cleanest Abi gives, largest size) go to `design/art/`:
`mother-rumors.(png|svg)`, then one file per piece. Claude wires each into its
page hero (vignette, glow, type zone, entrance motion) on arrival.
