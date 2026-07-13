# Burnthday

Static Cloudflare Pages build for Burnthday's Widespread Panic Spread Sheet.

## Local Build

```bash
npm run build
```

The site is written to `dist/`. If Google credentials are not present, the build uses the CSV snapshots in `data/source/`.

## 2025 Setlists

The imported 2025 tour setlists live in `data/source/setlists-2025.json`.

Refresh them from the current Blogger feed with:

```bash
npm run import:blogger
```

The deployed build tries this import first, then falls back to the checked-in JSON if Blogger is unavailable.

## Current Tour Setlists

The 2026 official Widespread Panic setlists live in `data/source/setlists-2026.json`. Refresh the current tour from the official WSP show pages, then enrich the display text with segue markers from same-date Internet Archive recordings:

```bash
TOUR_YEAR=2026 npm run refresh:setlists
```

The checked-in setlist JSON keeps two versions of each set: `songTitles` are canonical official titles used for counting, and `songs` is the display string with `>` transitions. This keeps sandwich songs visible in the setlist while counting each song only once per show.

## Lifetime Play Stats

Shelf, Purgatory, and The Woodshed use lifetime count and last-played metadata from `data/source/everyday-companion-playstats.json`. Refresh that snapshot with:

```bash
npm run import:playstats
```

The build keeps Burnthday's original/cover classifications from `catalog.csv`, but overlays Everyday Companion's public `First`, `Last`, `Total`, `L100`, and `SLP` values for matched song titles.

## Blogger Archive

The full Blogger Takeout feed is checked in at `data/source/blogger-feed.atom`. The build turns those entries into static pages at their original Blogger paths, plus archive indexes at `/archive/` and `/tour-in-review/`. Media files recovered from Takeout live in `assets/archive-media/` and are linked locally when the old Blogger image filename can be matched safely.

## Live Google Sheets Automation

For automatic rebuilds from Google Sheets, add a Google service account that has viewer access to this spreadsheet:

`1EAJINzjyHFauVqHYLSYpmoJpNARg61ghCGDfOlb-D9s`

Set this secret in Cloudflare Pages or GitHub Actions:

```bash
GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
```

Raw JSON or base64-encoded JSON both work. The build will use the live Sheet when this secret exists, and fall back to `data/source/*.csv` otherwise.

## GitHub Actions Automation

This repo includes `.github/workflows/deploy.yml`, which deploys on:

- every push to `main`
- manual `workflow_dispatch`
- a daily scheduled rebuild

Add these GitHub repository settings:

```text
Variables:
GOOGLE_SHEET_ID = 1EAJINzjyHFauVqHYLSYpmoJpNARg61ghCGDfOlb-D9s

Secrets:
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
GOOGLE_SERVICE_ACCOUNT_JSON
```

The Cloudflare API token needs Pages edit access for the account that owns the `burnthday` Pages project.

## Cloudflare Pages

Recommended settings:

```text
Framework preset: None
Build command: npm run build
Build output directory: dist
Root directory: /
```

After the Pages project is connected to GitHub, point DNS to Cloudflare Pages and remove the old Blogger DNS records:

```text
burnthday.com      CNAME  <project>.pages.dev
www.burnthday.com  CNAME  <project>.pages.dev
```

Cloudflare may show a slightly different target for the apex custom domain; use the value it gives in Pages > Custom domains.
