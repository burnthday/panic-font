# Burnthday production cutover runbook

Promote the **Stagelight redesign** (branch `claude/project-status-4jp3e7`) to production at
**burnthday.com**. Today `main` still serves the OLD site; the whole redesign lives on the
preview branch and is published to the preview alias only.

- **Preview (redesign, live now):** https://stagelight-preview.burnthday-d3j.pages.dev
- **Production (old site, until cutover):** https://burnthday.com
- **Cloudflare Pages project:** `burnthday` (account `bb75082c91976ca06b7f958041f91239`)
- **Cutover mechanism:** merge/fast-forward `claude/project-status-4jp3e7` -> `main`, which
  triggers `.github/workflows/deploy.yml` (`on: push: branches: [main]`).

At the time this runbook was written the redesign branch was **72 commits ahead of
`origin/main`, and `origin/main` is a strict ancestor of the branch tip** — so a clean
fast-forward is possible with no merge commit and no conflicts. Re-verify this at cutover time
(step C1) in case `main` has moved.

> Do the whole runbook top to bottom. Do not skip the pre-flight or the parity check just
> because the preview looks right — the redirect and deploy-trigger checks are where the
> surprises live.

---

## A. Pre-flight (do not cut over until every box is checked)

1. **Full QA is green on the branch.** From a clean checkout of `claude/project-status-4jp3e7`:
   ```bash
   npm ci
   npm run qa
   ```
   Expected: `Site QA: 331/331 checks passed` and `Production readiness: 50/50 checks passed`
   (the 331 is the 323 baseline plus the 8 social-card checks added with the new share image).
   Any FAIL blocks the cutover.

2. **Data-integrity verifiers run and are reviewed.** These are not part of `qa` and hit
   external sources, so run them deliberately (network required):
   ```bash
   npm run verify:ec-links      # Everyday Companion links still resolve
   npm run verify:relisten      # relisten dates line up with our setlist dates
   ```
   Treat hard failures as blockers; transient/network flakiness can be retried. Note that CI
   (`ci.yml`) and both deploy workflows only run `npm run qa`, so these two verifiers are a
   manual pre-flight gate — do not assume CI covered them.

3. **Secrets are set on the repo** (Settings -> Secrets and variables -> Actions):
   - `CLOUDFLARE_API_TOKEN` — used by `deploy.yml` and `preview.yml` for `wrangler pages deploy`.
     If this is missing/expired the deploy step fails and production is untouched.
   - `SETLISTFM_API_KEY` — used by `setlistfm-sync.yml`. Not required for the cutover deploy
     itself, but the nightly sync hard-fails without it (see section D).

4. **Known-pending content is acknowledged.** The **Rumors artwork is still pending** — the
   `/rumors/` page ships and passes QA (it is referenced by `_redirects`, the sitemap, and
   production readiness), but the final rumor art has not landed. This is a content follow-up,
   **not a launch blocker**. Confirm with Alex that shipping `/rumors/` in its current state is
   acceptable, or hold that art as a fast-follow.

5. **The preview alias is the thing you actually intend to ship.** Open
   https://stagelight-preview.burnthday-d3j.pages.dev and spot-check the pages in section E so
   you are promoting a build you have already looked at.

---

## B. Parity / redirect check (protect existing SEO + inbound links)

The old site is a Blogger export; a lot of inbound links and Google's index still point at
legacy paths. Those must keep resolving after cutover. Redirects are generated into
`dist/_redirects` by `renderRedirects()` in `scripts/build.mjs` (from `legacyCoreRoutes` plus
per-archive entries) and served by Cloudflare Pages.

1. **Legacy Blogger core paths still resolve.** `_redirects` maps (301) at minimum:
   - `/p/rumors` and `/p/rumors.html` -> `/rumors/`
   - `/p/widespread-panic-dirty-side-down-lyrics(.html)` -> `/lyrics-chords/`
   - `/p/widespread-panic-song-origins-and(.html)` -> `/song-origins/`
   - `/p/burnthdays-widespread-panic-tours-in(.html)` -> `/tour-in-review/`
   - `/p/theshelf(.html)` -> `/shelf/`
   - `/p/about(.html)` -> `/about/`
   - `/p/privacy(.html)` -> `/privacy/`
   - `/2025/02/widespread-panic-2025-tour(.html)` -> `/2025/12/widespread-panic-2025-tour-in-review`
   - `/tour-in-review` -> `/tour-in-review/`
   - Blogger machinery: `/search`, `/search/*`, `/feeds/posts/default`,
     `/feeds/posts/default/*` -> `/archive/`
   - Extension-stripping catch-alls: `/p/:slug.html -> /p/:slug`,
     `/:year/:month/:slug.html -> /:year/:month/:slug`,
     `/archive/:year/:slug.html -> /archive/:year/:slug`

   Production-readiness QA already asserts these specific rules exist in the built `_redirects`
   and that the same legacy `/p/...` URLs are **excluded** from the sitemap and not linked
   internally, so a green `npm run qa` covers this at build time. After deploy, re-check a few
   live with `curl` (section E, step 4).

2. **Sitemap is correct.** `dist/sitemap.xml` (~1,173 URLs) lists canonical
   `https://burnthday.com/...` pages and must NOT list the redirected `/p/...` Blogger URLs
   (asserted by production QA). `robots.txt` points at it.

3. **robots.txt is correct.** `dist/robots.txt` is `User-agent: * / Allow: / ` plus
   `Sitemap: https://burnthday.com/sitemap.xml`. Confirm no stray `Disallow` sneaks in — this
   is the old site's crawl posture and should stay open.

4. **Canonical + social.** Every page emits an absolute `https://burnthday.com` canonical and
   the new share card (section covered by the social-card QA checks and `check-live-site.mjs`).

---

## C. The cutover (this publishes production)

**Nothing before this point changes the live site.** These steps do.

1. **Re-confirm a clean fast-forward.** With both refs fetched:
   ```bash
   git fetch origin
   git rev-list --count origin/main..origin/claude/project-status-4jp3e7   # commits ahead
   git merge-base --is-ancestor origin/main origin/claude/project-status-4jp3e7 \
     && echo "fast-forward OK" || echo "DIVERGED - do not FF"
   ```
   If it reports `DIVERGED`, stop and reconcile (rebase the branch on `main` or open a PR and
   merge) before continuing — do not force anything onto `main`.

2. **Promote to `main`.** Preferred: open a PR from `claude/project-status-4jp3e7` into `main`
   and merge it (keeps a review trail and lets `ci.yml` run on the PR). If doing it from the
   CLI as a fast-forward:
   ```bash
   git checkout main
   git pull --ff-only origin main
   git merge --ff-only origin/claude/project-status-4jp3e7
   git push origin main
   ```

3. **The push to `main` triggers `deploy.yml`.** Watch the run under the Actions tab. It will:
   `npm ci` -> `npm run refresh:automatic` -> `npm run qa` -> `wrangler pages deploy dist
   --project-name burnthday --branch main` -> `node scripts/check-live-site.mjs`. A manual
   `workflow_dispatch` on "Deploy Burnthday" is the same path if you need to re-run it.

4. **Wait for the deploy job to go green**, including its built-in `check-live-site.mjs` health
   check (6 retry attempts against https://burnthday.com). Then do section E yourself.

---

## D. setlist.fm sync -> deploy trigger gap (KNOWN ISSUE — fix at or soon after cutover)

**Finding.** `setlistfm-sync.yml` runs daily at **09:00 UTC**, pulls the full setlist history
into `data/source/setlistfm-cache.json`, and commits + pushes it back to the default branch:

```yaml
git commit -m "Refresh setlist.fm cache"
git push origin "HEAD:${GITHUB_REF_NAME}"      # default branch = main once we cut over
```

That push is made with the default `GITHUB_TOKEN`. **GitHub deliberately does not trigger
further workflow runs from `GITHUB_TOKEN` pushes** (the anti-recursion rule). So the refreshed
cache lands on `main` but `deploy.yml`'s `on: push: branches: [main]` **does not fire**. The
new setlist data therefore does not publish until the *next* scheduled deploy
(`deploy.yml` cron **14:20 UTC**) or a manual dispatch — up to a day of staleness, and any
manual push in between publishes an in-between state rather than the freshly synced one.

The 14:20 UTC scheduled deploy also runs `refresh:automatic` itself, so in practice the cache
does get published within the same day — but the sync's *own* commit never publishes on its
own, which is surprising and fragile (if the scheduled deploy is ever disabled, syncs go dark).

**Recommended fix (pick one):**
- **Explicit deploy from the sync job (simplest):** after a successful commit+push, add a step
  that deploys directly — either `npx wrangler pages deploy dist --project-name burnthday
  --branch main` (build first) using `CLOUDFLARE_API_TOKEN`, or
  `gh workflow run deploy.yml` / a `repository_dispatch` to invoke `deploy.yml`.
- **`repository_dispatch` / `workflow_dispatch` bridge:** have the sync job fire a
  `repository_dispatch` event and add that event to `deploy.yml`'s `on:` triggers.
- **PAT-authenticated push:** push the cache commit using a fine-grained PAT (repo secret)
  instead of `GITHUB_TOKEN`, which *will* trigger `deploy.yml`. (Uses a token seat; the
  explicit-deploy option is cleaner.)

Do this as a follow-up PR; it is not required to complete the cutover, but flag it to Alex so
nightly refreshes publish promptly.

---

## E. Post-launch smoke test (run after `deploy.yml` is green)

1. **Automated health check** against production:
   ```bash
   node scripts/check-live-site.mjs
   # or point it elsewhere: SITE_ORIGIN=https://burnthday.com node scripts/check-live-site.mjs
   ```
   It asserts: homepage title matches the deployed build, canonical is present, the social card
   URL is on the homepage, `/data/freshness.json` `generatedAt` matches this deployment, the
   sitemap has the canonical homepage, robots references the sitemap, and
   `/assets/social-card.png` is served with `content-type: image/png`. (This same script runs
   inside `deploy.yml`; re-running it locally confirms independently.)

2. **Key pages load (200, new Stagelight design):**
   `/`, `/songs/`, `/tour-in-review/`, `/shelf/`, `/lyrics-chords/`, `/song-origins/`,
   `/about/`, `/rumors/`, `/archive/`, `/privacy/`.

3. **Share/OG card renders.** Paste `https://burnthday.com/` into a card debugger
   (e.g. the Facebook Sharing Debugger and the X/Twitter card validator; "Scrape Again" to bust
   caches). Confirm the **new dark Stagelight card** (1200x630, "Burnthday" wordmark, red
   underline, note-eater mark, "698 songs / 158 tours / every setlist") shows —
   `og:image`/`twitter:image` = `https://burnthday.com/assets/social-card.png`,
   `twitter:card` = `summary_large_image`. If a stale old card shows, it is a scraper cache;
   re-scrape.

4. **Legacy redirects resolve (301) on the live host:**
   ```bash
   for p in /p/about /p/theshelf /p/rumors /search /2025/02/widespread-panic-2025-tour.html; do
     echo "$p -> $(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "https://burnthday.com$p")"
   done
   ```
   Expect `301` to the canonical `/about/`, `/shelf/`, `/rumors/`, `/archive/`, and the 2025
   tour-in-review page respectively.

5. **Spot-check a data-driven page of each type:** one `/song/...` page (verify the "Every
   performance" log looks current — this is what setlist.fm feeds), one tour-in-review page,
   and one lyrics/chords page. Confirm counts and setlists look right, not truncated.

---

## F. Rollback plan

The cutover is a Pages deploy; rolling back is fast and does not require reverting git first.

1. **Instant rollback (Cloudflare, preferred):** Cloudflare dashboard -> Pages -> project
   `burnthday` -> Deployments -> pick the last known-good (old-site) production deployment ->
   **Rollback / Restore**. Production returns to the previous build within seconds. This is the
   fastest path if the new site is visibly broken.

2. **Git rollback (make `main` build the old site again):** if the redesign must come off
   `main`, revert the promotion and let `deploy.yml` republish:
   ```bash
   git checkout main
   git revert --no-edit <merge-or-range>   # or: git reset --hard <old-main-sha> (force-push, destructive)
   git push origin main
   ```
   A `git revert` push re-triggers `deploy.yml` cleanly. Prefer `revert` over a force-reset so
   history and the Actions trail stay intact; only hard-reset if you fully understand the
   consequences and have the old `main` SHA.

3. **After any rollback:** re-run `node scripts/check-live-site.mjs`, confirm the expected build
   is live, and capture what failed before re-attempting the cutover.

---

### Quick reference

| Item | Value |
|---|---|
| Redesign branch | `claude/project-status-4jp3e7` |
| Cloudflare Pages project | `burnthday` (account `bb75082c91976ca06b7f958041f91239`) |
| Production deploy trigger | push to `main` + cron `20 14 * * *` (14:20 UTC) + manual dispatch |
| Preview deploy trigger | push to `claude/project-status-4jp3e7` -> alias `stagelight-preview` |
| setlist.fm sync | cron `0 9 * * *` (09:00 UTC), commits cache, **does not auto-deploy** (section D) |
| Required secrets | `CLOUDFLARE_API_TOKEN`, `SETLISTFM_API_KEY` |
| Gate commands | `npm run qa`, `npm run verify:ec-links`, `npm run verify:relisten` |
| Live health check | `node scripts/check-live-site.mjs` (`SITE_ORIGIN` overridable) |
