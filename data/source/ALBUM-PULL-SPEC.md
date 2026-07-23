# Album Pull Spec — Burnthday

Fill `data/source/albums.json`. One object per album. **Only the fields below.**
The build computes all live-play stats itself — do **not** add stats.

## Golden rules (make it ours, not a copy)
- **Rewrite everything in plain English.** Never paste label boilerplate
  ("BrownCat is…"), special thanks, dedications, fan-club plugs, or the
  copyright/©️ line. Those don't go in the file at all.
- **`blurb` is 1–2 original sentences** in a neutral, informative voice — what
  the record is, when/where it was made, one thing that makes it notable. No
  marketing hype, no first person.
- **Facts only** for the pulled fields, from official/reputable sources
  (band site, liner notes, Wikipedia, AllMusic, Discogs).
- Leave a field **empty** if you can't verify it. Empty fields simply don't render.

## Fields to pull, per album

| Field | Type | What to put |
|---|---|---|
| `slug` | string | keep as-is (already set) |
| `title` | string | keep as-is |
| `releaseDate` | `"YYYY-MM-DD"` | keep/confirm |
| `cover` | string path | `/assets/albums/<slug>.jpg` — see cover note below |
| `blurb` | string | 1–2 original sentences (see rules) |
| `label` | string | release label, e.g. `"ATO Records"` |
| `recordedAt` | string[] | studio names + cities, e.g. `["Echo Mountain, Asheville NC"]` |
| `producedBy` | string[] | producer name(s) |
| `engineeredBy` | string[] | lead engineer(s) — skip assistant-of-assistant credits |
| `mixedBy` | string[] | mixer(s) |
| `personnel` | `{name, role}[]` | the band lineup **on this record**, e.g. `{"name":"John Bell","role":"vocals, guitar"}` |
| `tracks` | `{title, writtenBy?}[]` | full tracklist **in album order**; `writtenBy` only when it's a cover or co-write |
| `links` | object | official URLs: `spotify`, `appleMusic`, `bandcamp`, `amazon`, `purchase` (leave any unknown empty) |

## Track titles matter
Use the **exact song title** as it appears in setlists (the build matches
tracks to live-play data by title). "St. Louis", "Shut Up And Drive", etc.
If a title differs from the common live name, use the live name.

## Cover images
Drop cover files at `assets/albums/<slug>.jpg` (square, ≥1000×1000 ideal) and
set `cover` to `/assets/albums/<slug>.jpg`. Three already exist under
`/assets/archive-media/` and are pre-wired (dirty-side-down, free-somehow,
earth-to-america). The four newer records need art:
hailbound-queen, snake-oil-king, miss-kittys-lounge, street-dogs.

## Example (shape only)
```json
{
  "slug": "dirty-side-down",
  "title": "Dirty Side Down",
  "releaseDate": "2010-05-25",
  "cover": "/assets/archive-media/dirty-side-down-cover.jpg",
  "blurb": "Widespread Panic's tenth studio album, cut with producer John Keane and the first to feature Jimmy Herring across a full record.",
  "label": "Rounder Records",
  "recordedAt": ["Echo Mountain, Asheville NC"],
  "producedBy": ["John Keane", "Widespread Panic"],
  "engineeredBy": ["John Keane"],
  "mixedBy": ["John Keane"],
  "personnel": [
    {"name": "John Bell", "role": "vocals, guitar"},
    {"name": "Jimmy Herring", "role": "guitar"}
  ],
  "tracks": [
    {"title": "Saint Ex"},
    {"title": "North", "writtenBy": "Jerry Joseph"}
  ],
  "links": {"spotify": "", "appleMusic": "", "bandcamp": "", "amazon": "", "purchase": ""}
}
```
(The blurb/label/credits above are illustration — verify before using.)
