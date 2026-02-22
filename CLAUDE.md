# Russell's World Briefing

Daily international news briefing for Russell Goldman. All bullets, no prose. Ready by 6am ET.

## How It Works

Two-stage pipeline (same architecture as japan-briefing):

1. **`generate-briefing.js`** — Scrapes 10 RSS feeds + takes 5 homepage screenshots. Extracts top headlines from screenshot pages via DOM scraping for editorial priority detection. Outputs `briefing.json`.

2. **`write-briefing.js`** — Two-step pipeline: Writer (Sonnet) drafts briefing, Editor (Sonnet) copy-edits for grammar/style bugs. Outputs `briefing.md` + `index.html`.

## Running Locally

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm run briefing
# Or step by step:
ANTHROPIC_API_KEY=sk-ant-... npm run generate   # scrape -> briefing.json
ANTHROPIC_API_KEY=sk-ant-... npm run write       # Claude -> index.html
```

## Sources

**Primary RSS (7):** NYT World, AP, Reuters, BBC World, WSJ World, FT, Guardian World
**Secondary RSS (3):** Al Jazeera, WSJ Markets, France24
**Screenshots (5):** NYT, BBC, WSJ, Guardian, FT homepages (priority signals only, not displayed)

Source config: `sources.json`

## Schedule

GitHub Actions cron: `30 10 * * *` (10:30 UTC = 5:30am EST / 6:30am EDT)
Manual trigger: `workflow_dispatch`

## Secrets

- `ANTHROPIC_API_KEY` — Claude API key (GitHub Actions secret)
- `GITHUB_TOKEN` — PAT with repo + actions:write scope (Cloudflare Worker secret)

## Refresh Button

The index.html page has a "Refresh" link that triggers GitHub Actions via a Cloudflare Worker proxy.

Worker URL: `https://russell-briefing-refresh.adampasick.workers.dev`
Worker code: `cloudflare-worker/worker.js`

Deploy: `cd cloudflare-worker && npx wrangler deploy`
Set token: `cd cloudflare-worker && npx wrangler secret put GITHUB_TOKEN`

## Key Design Decisions

- **Screenshots are input-only.** They are taken and committed to git, but the HTML output does NOT display them. They exist so Claude can see homepage headlines and determine editorial priority.
- **All bullets.** No prose sections. Five sections: Top Stories, Conflicts & Diplomacy, Business & Markets, Also Notable, What to Watch.
- **No email.** Russell bookmarks the GitHub Pages URL.
- **15 items per RSS feed** (vs japan-briefing's 10) to cast a wider net for international stories.

## File Structure

```
sources.json              # Source config
generate-briefing.js      # Scraper (RSS + screenshots + headline extraction)
write-briefing.js         # Claude API writer (all-bullets prompt + HTML template)
package.json
.github/workflows/briefing.yml
cloudflare-worker/
  worker.js               # Refresh button proxy
  wrangler.toml
screenshots/              # Committed but not displayed in output
briefing.json             # Generated intermediate data
briefing.md               # Generated markdown
index.html                # Generated HTML (GitHub Pages serves this)
```
