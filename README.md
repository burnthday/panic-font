# Burnthday

Static Cloudflare Pages build for Burnthday's Widespread Panic Spread Sheet.

The visual roles, typography scale, responsive rules, and non-negotiable spreadsheet behavior are documented in [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md).

## Local Build

```bash
npm run build
```

The site is written to `dist/`. If Google credentials are not present, the build uses the CSV snapshots in `data/source/`.

Run the full local verification before publishing or committing data changes:

```bash
npm run qa
```

That builds the site, checks generated lifetime playstats against Everyday Companion, checks current-tour counts against the raw setlists, checks Burnthday-specific page rules, and runs production readiness checks. Sandwiches count once per show for the tour-count math.

The generated build also writes a machine-readable freshness report:

```text
dist/data/freshness.json
```

That report records the build time, active sheet title, latest posted setlist, marker legend, source URLs, totals, and whether prior-song stats came directly from EC or include a verified local bridge over newer official shows.

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

For the daily, CI-safe refresh used by GitHub Actions:

```bash
TOUR_YEAR=2026 npm run refresh:automatic
```

That imports official Widespread Panic setlists into a temporary file, defers same-day shows, requires Internet Archive transition metadata for every eligible show, and only then replaces the local tour ledger. If a setlist or its `>` transitions are not ready, the automation holds the last complete build. It never guesses transitions and it does not require Everyday Companion to be reachable.

Everyday Companion remains the reconciliation source for lifetime totals and prior-play data. When EC is reachable and you intentionally want to refresh those committed baseline snapshots, run:

```bash
TOUR_YEAR=2026 npm run refresh:strict
```

That manual strict path imports EC playstats and prior-song stats, refreshes official setlists and transitions, then rebuilds and validates the result. EC is deliberately not a blocking dependency of the scheduled deployment because EC can lag after shows and currently blocks GitHub-hosted runners.

For the morning after a show, use the fast local path:

```bash
TOUR_YEAR=2026 npm run postshow
```

That updates official WSP setlists, enriches `>` markers when Archive data exists, rebuilds, and validates current-tour counts. It also allows a temporary EC-lag baseline for new bustouts: if EC has not posted the latest current-year play yet, the importer can still use EC's existing played-page/playstats row plus the local official setlist to keep lifetime count and last-played date visible locally. Use `refresh:automatic` for unattended publishing and `refresh:strict` only when reconciling the EC baseline.

## Lifetime Play Stats

Shelf, Purgatory, and The Woodshed use lifetime count and last-played metadata from `data/source/everyday-companion-playstats.json`. Refresh that snapshot with:

```bash
npm run import:playstats
```

The build keeps Burnthday's original/cover classifications from `catalog.csv`, but overlays Everyday Companion's public `First`, `Last`, `Total`, `L100`, and `SLP` values for matched song titles. Public Everyday Companion titles that are missing from the seed CSV are added to the generated catalog so the lifetime layer stays complete. Generic `Jam`, unknown `???`, and separate `reprise` rows are intentionally excluded from the public sheet.

After a build, verify that generated lifetime stats still match Everyday Companion:

```bash
npm run validate:playstats
```

Verify the current-tour board counts and generated prior-song coverage with:

```bash
npm run validate:tour-data
```

The deployment workflow runs both validations before publishing, so mismatched lifetime totals, bad tour counts, or missing prior-song stats stop the deploy instead of leaking to the live boards.

The production gate is:

```bash
npm run validate:production
```

It verifies the generated freshness report, important Blogger redirects, core legacy routes, sitemap coverage, security/cache headers, strict prior-song data, Cloudflare workflow shape, and absence of root-level secret files.

## Prior Tour Song Stats

The 2026 Shelf/Purgatory return logic uses generated rows in `data/source/everyday-companion-prior-song-stats.json`. Regenerate them with:

```bash
npm run import:ec-prior-stats -- --year 2026 --require-all
```

For each song played in the current tour, the importer reads that song's Everyday Companion played-history page and captures the first play in the tour year. The EC row's SLP value becomes the pre-tour shows-since-last-played number, the previous history row supplies the last-played date, and the row position supplies the lifetime total before the tour. The build uses official WSP setlists for current-tour counts, so songs repeated inside one show still count once.

When `--require-all` is used, a missing EC played-history row stops the import. That keeps automated deploys from publishing guessed bustout math when EC has not caught up yet.

For a local post-show build only, `npm run postshow` passes `--allow-ec-lag`. When EC has not posted the current-year played-history row, the importer finds EC's newest posted show and adds only the official local shows between that date and the song's first local tour play to EC's SLP baseline. Those auditable rows use `sourceStatus: "ec-lag-verified-local-bridge"`; missing or unverified rows still stop production validation.

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

The workflow refreshes official setlists, EC lifetime playstats, EC prior song stats, and transition markers before building. If required EC prior stats are missing, the workflow fails before deploy so the current live site stays untouched.

Review branches run `.github/workflows/ci.yml`, which executes `npm run qa` without deploying. The deploy workflow only publishes after strict refresh and full QA pass.

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
