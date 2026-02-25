#!/usr/bin/env node
/**
 * Config-driven news briefing scraper for Russell's World Briefing
 *
 * Forked from japan-briefing. Key differences:
 *   - No Twitter scraping or Japanese translation
 *   - Headline extraction from screenshot pages (for editorial priority detection)
 *   - 15 items per RSS feed (wider international net)
 *
 * Reads sources from sources.json and scrapes them in parallel.
 * Supports source types: rss, screenshot
 *
 * Run: node generate-briefing.js
 * Output: briefing.json + screenshots/ folder
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { extractEntities, scoreOverlap, FLAG_THRESHOLD } = require('./entity-matcher');

// ============================================
// CONFIGURATION
// ============================================

const CONFIG_PATH = './sources.json';
const SCREENSHOTS_DIR = './screenshots';

// How many items to grab per RSS feed
// Higher than japan-briefing's 10 because we're casting a wider net
const RSS_ITEMS_PER_FEED = 15;

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Config file not found: ${CONFIG_PATH}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// ============================================
// FETCH UTILITIES
// ============================================

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html, application/rss+xml, application/xml, text/xml',
        ...options.headers
      }
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetch(res.headers.location, options).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(options.timeout || 15000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

// ============================================
// HEADLINE CLEANING
// ============================================

function cleanHeadline(text) {
  if (!text) return null;
  let h = text.trim().replace(/\s+/g, ' ');
  // Strip "X min read" markers that some feeds append
  h = h.replace(/^\d+\s*min\s*(read|listen)/i, '').trim();
  h = h.replace(/\d+\s*min\s*(read|listen)$/i, '').trim();
  // Only keep headlines between 10-300 chars
  return (h.length >= 10 && h.length <= 300) ? h : null;
}

// ============================================
// RSS PARSER
// ============================================

function parseRSS(xml, source) {
  const items = [];

  // Try RSS format first (<item> tags)
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null && items.length < RSS_ITEMS_PER_FEED) {
    const itemXml = match[1];

    // Extract title — handles both CDATA and plain text
    const title = (itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                   itemXml.match(/<title>(.*?)<\/title>/))?.[1]?.trim();

    // Extract link — handles CDATA, plain text, and href attribute
    const link = (itemXml.match(/<link><!\[CDATA\[(.*?)\]\]><\/link>/) ||
                  itemXml.match(/<link>(.*?)<\/link>/) ||
                  itemXml.match(/<link[^>]*href="([^"]+)"/))?.[1]?.trim();

    // Extract description for additional context
    const description = (itemXml.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) ||
                        itemXml.match(/<description>(.*?)<\/description>/))?.[1]?.trim();

    const pubDate = (itemXml.match(/<pubDate>(.*?)<\/pubDate>/))?.[1]?.trim();

    const headline = cleanHeadline(title?.replace(/<[^>]*>/g, ''));
    if (headline && link) {
      items.push({
        headline,
        url: link,
        source: source.name,
        sourceId: source.id,
        category: source.category || 'general',
        priority: source.priority || 'secondary',
        date: pubDate || null,
        description: description ? description.replace(/<[^>]*>/g, '').trim().slice(0, 200) : ''
      });
    }
  }

  // Fallback: try Atom format (<entry> tags) if RSS found nothing
  if (items.length === 0) {
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    while ((match = entryRegex.exec(xml)) !== null && items.length < RSS_ITEMS_PER_FEED) {
      const entryXml = match[1];
      const title = (entryXml.match(/<title[^>]*>(.*?)<\/title>/))?.[1]?.trim();
      const link = (entryXml.match(/<link[^>]*href="([^"]+)"/))?.[1]?.trim();
      const updated = (entryXml.match(/<updated>(.*?)<\/updated>/))?.[1]?.trim();

      const headline = cleanHeadline(title?.replace(/<[^>]*>/g, ''));
      if (headline && link) {
        items.push({
          headline,
          url: link,
          source: source.name,
          sourceId: source.id,
          category: source.category || 'general',
          priority: source.priority || 'secondary',
          date: updated || null,
          description: ''
        });
      }
    }
  }

  return items;
}

// ============================================
// GOOGLE NEWS URL RESOLVER
// Google News RSS returns opaque redirect URLs like:
//   news.google.com/rss/articles/<encrypted-base64>
// These don't work as direct links — they use JS-based redirection.
// We resolve them to real article URLs using Playwright.
// ============================================

function isGoogleNewsUrl(url) {
  return url && url.includes('news.google.com/rss/articles/');
}

/**
 * Resolves a batch of Google News redirect URLs to their real destinations.
 * Uses Playwright to follow the JS redirect chain.
 * Returns a Map of googleNewsUrl -> resolvedUrl.
 *
 * Opens up to BATCH_SIZE tabs in parallel for speed.
 */
async function resolveGoogleNewsUrls(urls) {
  const BATCH_SIZE = 5;
  // Hard cap: don't spend more than 3 minutes total on URL resolution.
  // If we hit it, return what we have — some resolved is better than none.
  const TOTAL_TIMEOUT_MS = 180000;
  const resolved = new Map();

  if (urls.length === 0) return resolved;

  const b = await initBrowser();
  if (!b) {
    console.log('  ⚠ Browser not available — Google News URLs will remain unresolved');
    return resolved;
  }

  console.log(`\nResolving ${urls.length} Google News URLs...`);
  const startTime = Date.now();

  // Process in batches to avoid overwhelming the browser
  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    // Bail if we've exceeded the total timeout
    if (Date.now() - startTime > TOTAL_TIMEOUT_MS) {
      console.log(`  ⚠ Hit ${TOTAL_TIMEOUT_MS / 1000}s timeout — stopping with ${resolved.size} resolved`);
      break;
    }

    const batch = urls.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async (gnUrl) => {
      let page;
      try {
        page = await b.newPage();
        await page.goto(gnUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        // Wait for JS redirect — 2s is enough for most redirects
        await page.waitForTimeout(2000);
        const finalUrl = page.url();
        // Only count as resolved if we actually left Google News
        if (!finalUrl.includes('news.google.com')) {
          return { gnUrl, finalUrl };
        }
        return { gnUrl, finalUrl: null };
      } catch (e) {
        return { gnUrl, finalUrl: null };
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }));

    for (const { gnUrl, finalUrl } of results) {
      if (finalUrl) {
        resolved.set(gnUrl, finalUrl);
      }
    }
  }

  const successCount = resolved.size;
  const failCount = urls.length - successCount;
  console.log(`  ✓ Resolved ${successCount}/${urls.length} URLs${failCount > 0 ? ` (${failCount} failed — kept as Google News links)` : ''}`);

  return resolved;
}

// ============================================
// SCREENSHOT HANDLER (Playwright)
// With headline extraction for editorial priority detection
// ============================================

let browser = null;

async function initBrowser() {
  if (browser) return browser;

  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    return browser;
  } catch (e) {
    console.error('Failed to launch browser:', e.message);
    return null;
  }
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

/**
 * Takes a screenshot of a homepage AND extracts top headlines via DOM scraping.
 *
 * The headlines are used as editorial priority signals — Claude reads them
 * to determine what each outlet is leading with. The screenshots themselves
 * are saved but NOT displayed in the final briefing output.
 */
async function takeScreenshot(source) {
  const b = await initBrowser();
  if (!b) {
    return { ...source, screenshot: null, topHeadlines: [], error: 'Browser not available' };
  }

  try {
    const page = await b.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.goto(source.url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    // Wait for images and content to render
    await page.waitForTimeout(4000);

    // ---- HEADLINE EXTRACTION ----
    // Grab top h1/h2/h3 text from the page. This gives Claude actual
    // headline text for each outlet's homepage, which is much more useful
    // than just knowing a screenshot exists.
    let topHeadlines = [];
    try {
      topHeadlines = await page.evaluate(() => {
        const headlines = [];
        const seen = new Set();

        function addHeadline(text) {
          if (!text) return;
          text = text.trim().replace(/\s+/g, ' ');
          if (text.length > 15 && text.length < 200 && !seen.has(text)) {
            seen.add(text);
            headlines.push(text);
          }
        }

        // Standard heading elements (works for BBC, Guardian, FT)
        document.querySelectorAll('h1, h2, h3').forEach(el => {
          if (headlines.length < 10) addHeadline(el.innerText);
        });

        // NYT uses p.indicate-hover for story headlines
        document.querySelectorAll('p.indicate-hover').forEach(el => {
          if (headlines.length < 10) addHeadline(el.innerText);
        });

        // Fallback: look for common headline-like attributes
        document.querySelectorAll('[data-testid*="headline"], [class*="headline"]').forEach(el => {
          if (headlines.length < 10) addHeadline(el.innerText);
        });

        return headlines;
      });
    } catch (e) {
      // DOM scraping failed — continue with screenshot only
      console.log(`  ⚠ Headline extraction failed for ${source.name}: ${e.message}`);
    }

    // ---- SCREENSHOT ----
    if (!fs.existsSync(SCREENSHOTS_DIR)) {
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    }

    const filename = `${source.id}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);

    // Use Chrome DevTools Protocol directly to take screenshot
    // This bypasses Playwright's font waiting which can hang on some sites
    const client = await page.context().newCDPSession(page);
    const result = await client.send('Page.captureScreenshot', {
      format: 'png',
      clip: {
        x: 0,
        y: 0,
        width: 1280,
        height: 900,
        scale: 1
      }
    });

    fs.writeFileSync(filepath, Buffer.from(result.data, 'base64'));

    await page.close();

    return { ...source, screenshot: filename, topHeadlines, error: null };
  } catch (e) {
    return { ...source, screenshot: null, topHeadlines: [], error: e.message };
  }
}

// ============================================
// SOURCE SCRAPING
// ============================================

async function scrapeRSSSource(source) {
  try {
    const content = await fetch(source.url);
    const stories = parseRSS(content, source);
    return { ...source, stories, storyCount: stories.length, error: null };
  } catch (e) {
    return { ...source, stories: [], error: e.message };
  }
}

async function scrapeSource(source) {
  // Skip comment entries in sources.json
  if (source._comment) return null;

  switch (source.type) {
    case 'rss':
      return scrapeRSSSource(source);
    case 'screenshot':
      return takeScreenshot(source);
    default:
      return { ...source, stories: [], error: `Unknown type: ${source.type}` };
  }
}

// ============================================
// WATCH CANDIDATE TAGGER
// Scans primary/secondary stories for forward-looking signals
// that indicate developing situations worth watching.
// These get passed to Claude alongside daybook data to improve
// the "What to Watch" section with stories that have momentum,
// not just scheduled events.
// ============================================

const WATCH_PATTERNS = {
  // Stories mentioning upcoming timeframes
  temporal: /\b(this week|next week|coming days|expected to|set to begin|set to start|will meet|due to|ahead of|days to|in the coming)\b/i,
  // Explicitly scheduled events, decisions, votes
  scheduled: /\b(ruling expected|vote on|vote scheduled|summit begins?|deadline|hearing|data release|talks resume|election|opens today|begins today|scheduled for|rate decision)\b/i,
  // Situations that could escalate or have forward momentum
  escalation: /\b(threatens? to|brink of|could lead to|raises? prospect|warns? of|ultimatum|countdown|preparing for war|military option|considering strikes?|pressure to)\b/i,
  // Aftermath/fallout stories that signal ongoing consequences
  consequence: /\b(fallout from|implications of|markets? brace|uncertainty|what comes next|aftermath|murky waters|uncharted|faces pressure|could test)\b/i
};

/**
 * Scans all non-daybook stories for forward-looking language patterns.
 * Tags matching stories with watchCandidate:true and watchSignals array.
 * Returns the array of candidates (stories are also mutated in place).
 */
function tagWatchCandidates(stories) {
  const candidates = [];
  for (const story of stories) {
    // Skip daybook stories — they already have their own pipeline
    if (story.category === 'daybook') continue;

    const text = (story.headline || '') + ' ' + (story.description || '');
    const signals = [];

    for (const [category, pattern] of Object.entries(WATCH_PATTERNS)) {
      const match = text.match(pattern);
      if (match) signals.push({ category, matched: match[0] });
    }

    if (signals.length > 0) {
      story.watchCandidate = true;
      story.watchSignals = signals;
      candidates.push(story);
    }
  }
  return candidates;
}

// ============================================
// MAIN SCRAPING LOGIC
// ============================================

async function scrapeAll(config) {
  const sources = config.sources.filter(s => !s._comment);

  const rssSources = sources.filter(s => s.type === 'rss');
  const screenshotSources = sources.filter(s => s.type === 'screenshot');

  console.log(`Fetching ${rssSources.length} RSS feeds...`);

  // RSS feeds in parallel (fast, no browser needed)
  const rssResults = await Promise.all(rssSources.map(s => scrapeSource(s)));

  // Log RSS results
  for (const r of rssResults) {
    if (r.error) {
      console.log(`  ✗ ${r.name}: ${r.error}`);
    } else {
      console.log(`  ✓ ${r.name} (${r.storyCount} stories)`);
    }
  }

  // Screenshots sequentially (prevents browser resource exhaustion)
  console.log(`\nTaking ${screenshotSources.length} screenshots + extracting headlines...`);
  const screenshotResults = [];
  for (const source of screenshotSources) {
    const result = await scrapeSource(source);
    screenshotResults.push(result);
    if (result.error) {
      console.log(`  ✗ ${source.name}: ${result.error}`);
    } else {
      const headlineCount = result.topHeadlines?.length || 0;
      console.log(`  ✓ ${source.name} (${headlineCount} headlines extracted)`);
    }
  }

  await closeBrowser();

  // ---- PROCESS RESULTS ----
  const allResults = [...rssResults, ...screenshotResults].filter(Boolean);
  const allStories = [];
  const byCategory = {};
  const byPriority = { primary: [], secondary: [], tertiary: [], reference: [] };
  const screenshots = [];
  const failed = [];

  for (const result of allResults) {
    if (result.error) {
      failed.push({ name: result.name, error: result.error });
      continue;
    }

    // RSS stories
    if (result.stories && result.stories.length > 0) {
      for (const story of result.stories) {
        allStories.push(story);
        const cat = story.category || 'general';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(story);
        const pri = story.priority || 'secondary';
        if (byPriority[pri]) byPriority[pri].push(story);
      }
    }

    // Screenshots (with extracted headlines)
    if (result.screenshot) {
      screenshots.push({
        id: result.id,
        name: result.name,
        url: result.url,
        filename: result.screenshot,
        category: result.category,
        priority: result.priority,
        topHeadlines: result.topHeadlines || []
      });
    }
  }

  // Deduplicate stories by URL
  const seen = new Set();
  const deduped = allStories.filter(story => {
    if (seen.has(story.url)) return false;
    seen.add(story.url);
    return true;
  });

  // ---- RESOLVE GOOGLE NEWS URLS ----
  // Google News RSS feeds (AP, Reuters, daybook) return opaque redirect
  // URLs that don't work as direct links. Resolve them to real article
  // URLs using Playwright before passing to the writer.
  const googleNewsUrls = [...new Set(
    deduped.filter(s => isGoogleNewsUrl(s.url)).map(s => s.url)
  )];
  const resolvedUrls = await resolveGoogleNewsUrls(googleNewsUrls);

  // Apply resolved URLs back to stories
  for (const story of deduped) {
    if (resolvedUrls.has(story.url)) {
      story.url = resolvedUrls.get(story.url);
    }
  }

  // Re-deduplicate after URL resolution — two Google News URLs
  // might resolve to the same real article
  const seenResolved = new Set();
  const dedupedFinal = deduped.filter(story => {
    if (seenResolved.has(story.url)) return false;
    seenResolved.add(story.url);
    return true;
  });

  // Extract daybook stories separately for What to Watch section.
  // These are tagged category:"daybook" in sources.json and come from
  // Google News RSS queries targeting forward-looking event language.
  const daybook = dedupedFinal.filter(s => s.category === 'daybook');

  // Tag stories from primary/secondary feeds that have forward-looking
  // signals (escalation, deadlines, consequences). These supplement
  // the daybook data and give Claude better input for "What to Watch".
  const watchCandidates = tagWatchCandidates(dedupedFinal);

  return {
    allStories: dedupedFinal,
    byCategory,
    byPriority,
    daybook,
    watchCandidates,
    screenshots,
    failed,
    sourceCount: sources.length,
    successCount: sources.length - failed.length
  };
}

// ============================================
// SLEEPING FILTER (--cutoff integration)
// ============================================

/**
 * Parses --cutoff argument from command line.
 * Returns null if not provided, or a Date object if valid.
 */
function parseCutoffArg() {
  const idx = process.argv.indexOf('--cutoff');
  if (idx === -1 || !process.argv[idx + 1]) return null;

  const cutoffStr = process.argv[idx + 1];

  // Try ISO datetime first
  if (cutoffStr.includes('T') || cutoffStr.includes('-')) {
    const d = new Date(cutoffStr);
    if (!isNaN(d.getTime())) return d;
  }

  // Parse "10 PM", "10:30 PM", "22:00" etc.
  let hours, minutes;

  const ampmMatch = cutoffStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (ampmMatch) {
    hours = parseInt(ampmMatch[1], 10);
    minutes = parseInt(ampmMatch[2] || '0', 10);
    const isPM = ampmMatch[3].toUpperCase() === 'PM';
    if (isPM && hours !== 12) hours += 12;
    if (!isPM && hours === 12) hours = 0;
  } else {
    const militaryMatch = cutoffStr.match(/^(\d{1,2}):(\d{2})$/);
    if (militaryMatch) {
      hours = parseInt(militaryMatch[1], 10);
      minutes = parseInt(militaryMatch[2], 10);
    } else {
      console.error(`Cannot parse cutoff time: "${cutoffStr}". Use "22:00" or "10 PM".`);
      return null;
    }
  }

  const now = new Date();
  const cutoffDate = new Date(
    now.getFullYear(), now.getMonth(), now.getDate(),
    hours, minutes, 0
  );

  // If the cutoff is in the future, user means yesterday evening
  if (cutoffDate > now) {
    cutoffDate.setDate(cutoffDate.getDate() - 1);
  }

  return cutoffDate;
}

/**
 * Runs the sleeping filter on already-scraped stories.
 * Tags each story with sleepStatus and returns summary stats.
 *
 * Uses the same entity-matching logic as sleeping-filter.js
 * but operates on the generate-briefing.js story format
 * (headline/date string fields instead of title/pubDate Date objects).
 */
function applySleepFilter(allStories, cutoff) {
  const beforeSleep = [];
  const afterSleep = [];

  for (const story of allStories) {
    const storyDate = story.date ? new Date(story.date) : null;
    if (!storyDate || isNaN(storyDate.getTime())) {
      // No valid date — treat as after-sleep (include it)
      story.sleepStatus = 'new';
      afterSleep.push(story);
      continue;
    }

    if (storyDate <= cutoff) {
      story.sleepStatus = 'pre-sleep';
      beforeSleep.push(story);
    } else {
      afterSleep.push(story);
    }
  }

  // Extract entities for all stories
  for (const story of [...beforeSleep, ...afterSleep]) {
    story._entities = extractEntities(story.headline);
  }

  // Compare each after-sleep story against before-sleep stories
  const flaggedPairs = [];

  for (const afterStory of afterSleep) {
    let bestMatch = null;
    let bestScore = 0;
    let bestDetails = [];

    for (const beforeStory of beforeSleep) {
      const { score, matchDetails } = scoreOverlap(
        afterStory._entities,
        beforeStory._entities
      );
      if (score > bestScore) {
        bestScore = score;
        bestMatch = beforeStory;
        bestDetails = matchDetails;
      }
    }

    if (bestScore >= FLAG_THRESHOLD && bestMatch) {
      afterStory.sleepStatus = 'flagged';
      afterStory.sleepOverlap = {
        score: bestScore,
        matchDetails: bestDetails,
        matchedHeadline: bestMatch.headline,
        matchedSource: bestMatch.source
      };
      flaggedPairs.push(afterStory);
    } else {
      afterStory.sleepStatus = 'new';
    }
  }

  // Clean up temp entities
  for (const story of allStories) {
    delete story._entities;
  }

  return {
    cutoff: cutoff.toISOString(),
    cutoffLocal: cutoff.toLocaleString(),
    beforeSleepCount: beforeSleep.length,
    afterSleepCount: afterSleep.length,
    flaggedCount: flaggedPairs.length,
    newCount: afterSleep.length - flaggedPairs.length
  };
}

// ============================================
// MAIN
// ============================================

async function main() {
  const config = loadConfig();
  const cutoff = parseCutoffArg();

  console.log('='.repeat(50));
  console.log(`${config.metadata?.name || 'News Briefing'}`);
  console.log(`Owner: ${config.metadata?.owner || 'Unknown'}`);
  console.log(new Date().toISOString());
  console.log('='.repeat(50));
  console.log('');

  const startTime = Date.now();
  const results = await scrapeAll(config);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Run sleeping filter if --cutoff was provided
  let sleepFilter = null;
  if (cutoff) {
    console.log(`\nApplying sleep filter (cutoff: ${cutoff.toLocaleString()})...`);
    sleepFilter = applySleepFilter(results.allStories, cutoff);
    console.log(`  Before sleep: ${sleepFilter.beforeSleepCount}`);
    console.log(`  After sleep (new): ${sleepFilter.newCount}`);
    console.log(`  After sleep (flagged): ${sleepFilter.flaggedCount}`);
  }

  // Build output JSON
  const briefing = {
    metadata: {
      ...config.metadata,
      generated: new Date().toISOString(),
      generatedTimestamp: Date.now()
    },
    stats: {
      sourceCount: results.sourceCount,
      successCount: results.successCount,
      totalStories: results.allStories.length,
      totalScreenshots: results.screenshots.length,
      daybookStories: results.daybook.length,
      watchCandidateCount: results.watchCandidates.length,
      elapsed: `${elapsed}s`
    },
    stories: {
      all: results.allStories,
      byCategory: results.byCategory,
      byPriority: results.byPriority
    },
    // Daybook: forward-looking event stories for What to Watch section.
    // Separated from main stories so Claude gets them as dedicated input.
    daybook: results.daybook,
    // Watch candidates: stories from primary/secondary feeds auto-tagged
    // with forward-looking signals (escalation, deadlines, consequences).
    watchCandidates: results.watchCandidates,
    screenshots: results.screenshots,
    sleepFilter: sleepFilter,
    feedHealth: { failed: results.failed }
  };

  fs.writeFileSync('briefing.json', JSON.stringify(briefing, null, 2));

  console.log('');
  console.log('='.repeat(50));
  console.log('RESULTS');
  console.log('='.repeat(50));
  console.log(`Sources: ${results.successCount}/${results.sourceCount}`);
  console.log(`Stories: ${results.allStories.length}`);
  console.log(`Daybook: ${results.daybook.length}`);
  console.log(`Watch candidates: ${results.watchCandidates.length}`);
  console.log(`Screenshots: ${results.screenshots.length}`);

  if (results.failed.length > 0) {
    console.log(`\n⚠️  ${results.failed.length} failed`);
  }

  console.log(`\nTime: ${elapsed}s`);

  if (results.allStories.length === 0 && results.screenshots.length === 0) {
    console.error('❌ FAILED: No content');
    process.exit(1);
  }

  console.log('✅ SUCCESS');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
