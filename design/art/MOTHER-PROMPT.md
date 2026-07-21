# Burnthday Totems — Mother Image Prompt Package

The mother image locks the illustration language. Generate it in Gemini with the
prompts below, iterate until it's right, and every future piece reuses the
STYLE LOCK clause verbatim so the set stays one hand.

Direction (locked with Alex, 07/21/26):
- NO container shapes (the pick is dead). One free-standing hand-drawn figure.
- The background IS part of the art: a roughly circular hand-stippled dot field
  on black, organic edge dissolving to pure black (vignette look), so it
  composites straight onto the site's dark stage.
- Poster lineage: classic screen-print gig posters (Forbes/JT energy) — inspired
  by, never copied. Original characters only.
- No text in the art, ever. Type lives in HTML below the image.
- Output: square, largest available (2048+), PNG.

---

## STYLE LOCK — paste this into EVERY generation, unchanged

Vintage psychedelic rock-poster screen print on a pure black background.
Heavy uniform black ink outlines with flat inks only: bone off-white #F2F2F0,
marker red #D4514F, warm gold #D4A017, deep green #2D7C52, plus pale mint
stipple dots. Shading is stipple and halftone only — no gradients, no
airbrushing. Slight screen-print misregistration where one color slips off the
linework. Subtle paper grain. Hand-drawn, playful-sinister character design.
The scene sits inside a large roughly-circular field of densely hand-stippled
pale mint dots on black whose organic edge dissolves into generous pure-black
margins on all sides. Absolutely no text, lettering, numbers, or logos.
Avoid: gradients, glossy 3D, photorealism, digital-painting softness,
generic fantasy art, guitar picks, cropped figures, watermarks.

---

## MOTHER IMAGE — Rumors: "The Crystal Ball" (generate this first)

[STYLE LOCK] + :

A wild-bearded old wizard with a crooked mischievous grin and one raised
eyebrow cradles a glowing crystal ball in both hands at the center of the
field; inside the glass, a tiny handwritten song list dissolves into curling
smoke. Gold radiance rendered as dots surrounds the ball and underlights his
face. His robe is marker red. Two spotted amanita mushrooms with sly character
sprout at the bottom corners of the field, leaning inward.

Iteration knobs (change ONE per pass):
- Grin wider / more deadpan
- Ball larger (dominant) vs. intimate
- Mushrooms: bigger with eyes / smaller no faces
- Stipple density of the field: sparser cosmic vs. dense swarm

## VARIANT — Field-only atmosphere plate (generate second)

[STYLE LOCK] + :

No figure. Only the large roughly-circular hand-stippled pale mint dot field
on pure black, denser toward center, its organic edge scattering and
dissolving into the black margins, with two small spotted amanita mushrooms
sprouting at the bottom edge of the field. Quiet, cosmic, hand-inked.

(Used for: section dividers, empty states, and pages whose figure isn't drawn
yet — the field alone already carries the style.)

---

## Acceptance checklist (before we call it the mother)

- [ ] Reads as screen print (flat inks, visible stipple) at 200px AND full-bleed
- [ ] Edge dissolves fully to #000-ish black — no visible rectangle edge
- [ ] Palette holds to the five inks (bone/red/gold/green/mint) + black
- [ ] Character is ours: playful-sinister, not generic wizard, not a Forbes copy
- [ ] Zero text/lettering artifacts anywhere (check the smoke and the ball)
- [ ] Nothing important within the outer 12% (safe margin for vignetting)

## After approval

1. Alex: drop the approved PNG at design/art/mother-rumors.png (git or GitHub upload).
2. Claude: builds the Marquee hero component around it (vignette, glow,
   entrance motion, type zone), Abi vectorizes for the crisp final, and the
   STYLE LOCK becomes the standing clause for the remaining slate
   (Jar Shelf, Rooted Phonograph, Porch Guitar, Long Highway, Woodshed, Burst).
