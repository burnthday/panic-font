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

### Burnthday indexes (v1)

Tour Stats adds two deterministic, sortable signals while retaining the underlying counts in the interface.

- **Rarity** is era-aware scarcity, not simply a low lifetime total. The score is `100 × (90% recent scarcity + 10% lifetime scarcity)`, where recent scarcity is derived from plays in the last 100 shows and lifetime scarcity uses a logarithmic lifetime-play scale. A song with no pre-tour history is labeled `New` instead of rare. This lets an older song that was common decades ago but is scarce now read correctly in the current era.
- **Rotation Heat** compares shows since last played with an expected gap. Expected cadence blends this-tour rate at 60% and last-100 rate at 40%; new songs use this-tour cadence until history develops. The score is capped at 100. `Fresh`, `Building`, and `Hot` describe rotation pressure only. They are not probabilities or setlist predictions.

The last-100 input naturally crosses tour boundaries, so the prior tour contributes without creating a hand-maintained special case. Both indexes can be recalculated from the ledger and the verified Everyday Companion baseline.

## 2025 Setlists

The imported 2025 tour setlists live in `data/source/setlists-2025.json`.

Refresh them from the current Blogger feed with:

```bash
npm run import:blogger
```

The deployed build tries this import first, then falls back to the checked-in JSON if Blogger is unavailable.

## Current Tour Setlists

The active year's official Widespread Panic setlists live in `data/source/setlists-YYYY.json`. The refresh scripts default to the current calendar year, while the build selects the newest checked-in setlist snapshot unless `TOUR_YEAR` is explicitly set. Refresh the current tour from the official WSP show pages, then enrich the display text with segue markers from same-date Internet Archive recordings:

```bash
npm run refresh:setlists
```

The checked-in setlist JSON keeps two versions of each set: `songTitles` are canonical official titles used for counting, and `songs` is the display string with `>` transitions. This keeps sandwich songs visible in the setlist while counting each song only once per show.

For the daily, CI-safe refresh used by GitHub Actions:

```bash
npm run refresh:automatic
```

That imports official Widespread Panic setlists into a temporary file, defers same-day shows, requires Internet Archive transition metadata for every eligible show, and only then replaces the local tour ledger. If a setlist or its `>` transitions are not ready, the automation holds the last complete build. It never guesses transitions and it does not require Everyday Companion to be reachable.

Everyday Companion remains the reconciliation source for lifetime totals and prior-play data. When EC is reachable and you intentionally want to refresh those committed baseline snapshots, run:

```bash
npm run refresh:strict
```

That manual strict path imports EC playstats and prior-song stats, refreshes official setlists and transitions, then rebuilds and validates the result. EC is deliberately not a blocking dependency of the scheduled deployment because EC can lag after shows and currently blocks GitHub-hosted runners.

For the morning after a show, use the fast local path:

```bash
npm run postshow
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

The active tour's Shelf/Purgatory return logic uses generated rows in `data/source/everyday-companion-prior-song-stats.json`. Regenerate them with the applicable year:

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

The unattended workflow refreshes complete official setlists and transition markers before building. It deliberately does not require Everyday Companion because EC may lag after a show and may block GitHub-hosted runners. EC lifetime and prior-song snapshots are reconciled through the manual strict command. If the automatic refresh is incomplete, the workflow reports that publishing was held and leaves the current live site untouched.

After each successful deploy, `scripts/check-live-site.mjs` verifies the production title, canonical URL, freshness timestamp, sitemap, robots file, and social card. Run the same check manually with:

```bash
npm run validate:live
```

GitHub sends workflow failure notifications according to the repository owner's notification settings. Held refreshes also appear as an explicit warning and job summary instead of silently skipping deployment.

## Tour Rollover

At the start of a new calendar year:

1. Add `data/source/setlists-YYYY.json` and, when needed, `data/source/setlist-overrides-YYYY.json`.
2. Refresh the EC playstats and prior-song baseline with `TOUR_YEAR=YYYY npm run refresh:strict`.
3. Confirm the Shelf/Purgatory reset and Woodshed personnel rule for that tour.
4. Run `npm run qa`; the build and validation scripts infer the active year from the newest setlist snapshot.
5. Update any year-specific editorial copy, including the Privacy page's displayed revision date when its substance changes.

Routine daily and post-show commands do not need a hard-coded year.

## Search And Sharing

The build produces canonical metadata, Open Graph and X metadata, a 1200x630 social card, `robots.txt`, and `sitemap.xml`. Google Analytics uses measurement ID `G-R74CMVLLK1`.

For Google Search Console:

1. Verify the `burnthday.com` Domain property using the DNS TXT record Google provides.
2. Submit `https://burnthday.com/sitemap.xml`.
3. Inspect the homepage, the current Tour In Review URL, and the preserved 2025 Blogger URL after major releases.
4. Keep `burnthday.com` as the canonical hostname. The Pages Function in `functions/[[path]].js` permanently redirects `www.burnthday.com` to the apex domain while preserving the path and query string.

Facebook and other social networks may cache old Blogger metadata. Use their sharing debugger to request a fresh scrape after changing the social card or homepage metadata.

Review branches run `.github/workflows/ci.yml`, which executes `npm run qa` without deploying. The deploy workflow only publishes after a complete automatic refresh and full QA pass.

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
