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

  return {
    allStories: deduped,
    byCategory,
    byPriority,
    screenshots,
    failed,
    sourceCount: sources.length,
    successCount: sources.length - failed.length
  };
}

// ============================================
// MAIN
// ============================================

async function main() {
  const config = loadConfig();

  console.log('='.repeat(50));
  console.log(`${config.metadata?.name || 'News Briefing'}`);
  console.log(`Owner: ${config.metadata?.owner || 'Unknown'}`);
  console.log(new Date().toISOString());
  console.log('='.repeat(50));
  console.log('');

  const startTime = Date.now();
  const results = await scrapeAll(config);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

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
      elapsed: `${elapsed}s`
    },
    stories: {
      all: results.allStories,
      byCategory: results.byCategory,
      byPriority: results.byPriority
    },
    screenshots: results.screenshots,
    feedHealth: { failed: results.failed }
  };

  fs.writeFileSync('briefing.json', JSON.stringify(briefing, null, 2));

  console.log('');
  console.log('='.repeat(50));
  console.log('RESULTS');
  console.log('='.repeat(50));
  console.log(`Sources: ${results.successCount}/${results.sourceCount}`);
  console.log(`Stories: ${results.allStories.length}`);
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
