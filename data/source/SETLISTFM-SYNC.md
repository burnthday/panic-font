# setlist.fm sync

Pulls Widespread Panic's full setlist history from the setlist.fm REST API into
`data/source/setlistfm-cache.json`, which the build joins against per song.

setlist.fm is crowd-sourced but complete. It is an **ingestion layer**, not the
editorial source of truth — the Google Sheet and Everyday Companion still own
song classifications, rarity tiers, and the canonical titles the join keys on.
This cache only supplies raw performance rows: date, venue, ordered songs, cover
attribution, and guests.

## The key is a secret

Read from `SETLISTFM_API_KEY` (env only). It is **never** written to the cache or
committed. Request one at <https://api.setlist.fm/docs/>. If a key is ever pasted
somewhere public, rotate it on setlist.fm.

## Attribution is required

setlist.fm's terms require a visible attribution link on any page that renders
their data. The site footer already carries "Setlist data via setlist.fm". Keep
it whenever this cache feeds a page.

## Rate budget

2 requests/sec, 1440/day. The importer pulls **by artist, paginated** (~20 shows
per page). Widespread Panic's ~3,000+ shows are ~150 pages ≈ 150 calls for a full
backfill — well under the daily cap. After the first backfill, a nightly run is
cheap. The default `--delay 550` keeps it under ~1.8 req/sec.

## Run it

```bash
# full pull (needs a key; won't run in the web sandbox — outbound API is blocked)
SETLISTFM_API_KEY=xxxx npm run import:setlistfm

# offline: exercise the transform against the saved fixture, no network
npm run import:setlistfm -- --fixture data/source/__fixtures__/setlistfm-sample.json --out /tmp/setlistfm-cache.json
```

Flags: `--artist` (default "Widespread Panic"), `--mbid` (MusicBrainz id — use the
artist endpoint; confirm the id before relying on it, otherwise leave it off and
the safe artist-name search runs with an exact-name filter), `--out`,
`--max-pages`, `--delay`, `--fixture`.

## Nightly GitHub Action (sketch)

```yaml
# .github/workflows/setlistfm-sync.yml
name: setlist.fm sync
on:
  schedule: [{ cron: "0 9 * * *" }]   # 09:00 UTC daily
  workflow_dispatch:
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run import:setlistfm
        env:
          SETLISTFM_API_KEY: ${{ secrets.SETLISTFM_API_KEY }}
      - run: npm run qa
      - name: Commit refreshed cache
        run: |
          git config user.name  "burnthday-bot"
          git config user.email "bot@burnthday.com"
          git add data/source/setlistfm-cache.json
          git commit -m "Refresh setlist.fm cache" || echo "no changes"
          git push
```

Add the key once under **Repo → Settings → Secrets and variables → Actions →
`SETLISTFM_API_KEY`**.

## Cache shape

```jsonc
{
  "source": "setlist.fm",
  "artist": "Widespread Panic",
  "artistMbid": "…",
  "fetchedAt": "<iso>",
  "showCount": 0,
  "songPerformances": 0,
  "shows": [
    {
      "id": "…", "date": "YYYY-MM-DD",
      "venue": "…", "city": "…", "state": "…", "country": "US",
      "tour": "…", "url": "https://www.setlist.fm/…",
      "songs": [
        { "name": "…", "set": "", "encore": false, "cover": "", "guest": "", "tape": false }
      ]
    }
  ]
}
```

The build groups `shows[].songs[]` by `normalizeTitle(name)` to attach an "Every
performance" log to each `/song/` page — that join is the payoff and lands once a
real cache exists. Segue markers (`>` / `->`) are intentionally absent: the
setlist.fm API does not expose them as data, so we don't fabricate them.
