# Burnthday

Static Cloudflare Pages build for Burnthday's Widespread Panic Spread Sheet.

## Local Build

```bash
npm run build
```

The site is written to `dist/`. If Google credentials are not present, the build uses the CSV snapshots in `data/source/`.

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
