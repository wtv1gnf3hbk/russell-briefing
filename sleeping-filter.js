#!/usr/bin/env node

/**
 * sleeping-filter.js
 *
 * "What happened while Russell was sleeping?" filter.
 *
 * HOW IT WORKS:
 *   1. Fetches RSS feeds from sources.json (flat-array format)
 *   2. Splits stories into BEFORE and AFTER a user-provided cutoff time
 *   3. Runs entity-matching dedup: extracts people, places, orgs from headlines
 *      and flags post-sleep stories that overlap with pre-sleep stories
 *   4. Outputs JSON for Claude to do LLM review on flagged pairs
 *
 * USAGE:
 *   node sleeping-filter.js --cutoff "22:00"
 *   node sleeping-filter.js --cutoff "10 PM"
 *   node sleeping-filter.js --cutoff "22:00" --sources "ap_world,reuters_world,bbc_world"
 *
 * OUTPUT:
 *   JSON to stdout with three sections:
 *     - beforeSleep: stories published before cutoff (context)
 *     - afterSleep: stories published after cutoff, NOT flagged (genuinely new)
 *     - flaggedPairs: post-sleep stories that overlap with pre-sleep stories
 *       (need LLM review to classify as new/incremental/rehash)
 *
 * Ported from ~/.claude/skills/sleeping-filter/sleeping-filter.js
 * Adapted for russell-briefing's flat-array sources.json format.
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { parseString } = require("xml2js");
const { extractEntities, scoreOverlap, FLAG_THRESHOLD } = require("./entity-matcher");

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const SOURCES_PATH = path.join(__dirname, "sources.json");

// ---------------------------------------------------------------------------
// ARGUMENT PARSING
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    cutoff: null,     // required: time string like "22:00" or ISO datetime
    sources: null,    // optional: comma-separated source IDs from sources.json
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--cutoff":
        parsed.cutoff = args[++i];
        break;
      case "--sources":
        parsed.sources = args[++i]?.split(",").map((s) => s.trim());
        break;
      case "--verbose":
        parsed.verbose = true;
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!parsed.cutoff) {
    console.error("Error: --cutoff is required. Example: --cutoff '22:00'");
    process.exit(1);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// CUTOFF TIME RESOLUTION
// ---------------------------------------------------------------------------

/**
 * Resolves a cutoff string into a Date object.
 *
 * Accepts:
 *   "22:00"                  -> today (or yesterday) at 22:00 local time
 *   "2026-02-10T22:00"       -> explicit ISO datetime
 *   "10 PM"                  -> parsed as HH:MM
 *   "10:30 PM"               -> parsed as HH:MM
 *
 * For bare HH:MM times: if that time is in the future, we assume the user
 * means YESTERDAY at that time (they slept last night, not tonight).
 */
function resolveCutoff(cutoffStr) {
  // Try ISO datetime first
  if (cutoffStr.includes("T") || cutoffStr.includes("-")) {
    const d = new Date(cutoffStr);
    if (!isNaN(d.getTime())) return d;
  }

  // Parse "10 PM", "10:30 PM", "22:00" etc.
  let hours, minutes;

  const ampmMatch = cutoffStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (ampmMatch) {
    hours = parseInt(ampmMatch[1], 10);
    minutes = parseInt(ampmMatch[2] || "0", 10);
    const isPM = ampmMatch[3].toUpperCase() === "PM";
    if (isPM && hours !== 12) hours += 12;
    if (!isPM && hours === 12) hours = 0;
  } else {
    const militaryMatch = cutoffStr.match(/^(\d{1,2}):(\d{2})$/);
    if (militaryMatch) {
      hours = parseInt(militaryMatch[1], 10);
      minutes = parseInt(militaryMatch[2], 10);
    } else {
      console.error(
        `Cannot parse cutoff time: "${cutoffStr}". Use "22:00" or "10 PM" or ISO datetime.`
      );
      process.exit(1);
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

// ---------------------------------------------------------------------------
// RSS FETCHING
// ---------------------------------------------------------------------------

/**
 * Fetches a URL and returns the response body as a string.
 * Follows up to 5 redirects. Handles both http and https.
 */
function fetchURL(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error(`Too many redirects: ${url}`));

    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html, application/rss+xml, application/xml, text/xml',
      },
      timeout: 15000,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith("/")) {
          const parsed = new URL(url);
          redirectUrl = `${parsed.protocol}//${parsed.host}${redirectUrl}`;
        }
        return resolve(fetchURL(redirectUrl, maxRedirects - 1));
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

/**
 * Parses an RSS/Atom XML string into an array of story objects.
 * Uses xml2js for robust parsing (handles CDATA, namespaces, etc.)
 */
function parseRSS(xml, sourceName) {
  return new Promise((resolve, reject) => {
    parseString(xml, { explicitArray: false, trim: true }, (err, result) => {
      if (err) return reject(err);

      let items = [];

      // RSS 2.0 format
      if (result?.rss?.channel?.item) {
        const rawItems = Array.isArray(result.rss.channel.item)
          ? result.rss.channel.item
          : [result.rss.channel.item];

        items = rawItems.map((item) => ({
          title: item.title || "",
          link: item.link || "",
          pubDate: item.pubDate ? new Date(item.pubDate) : null,
          source: sourceName,
          description: (item.description || "").substring(0, 300),
        }));
      }
      // Atom format
      else if (result?.feed?.entry) {
        const rawEntries = Array.isArray(result.feed.entry)
          ? result.feed.entry
          : [result.feed.entry];

        items = rawEntries.map((entry) => ({
          title: entry.title?._ || entry.title || "",
          link: entry.link?.$?.href || entry.link || "",
          pubDate: entry.published
            ? new Date(entry.published)
            : entry.updated
            ? new Date(entry.updated)
            : null,
          source: sourceName,
          description: (entry.summary?._ || entry.summary || "").substring(0, 300),
        }));
      }

      // Filter out items with no valid date (can't split without timestamps)
      items = items.filter((item) => item.pubDate && !isNaN(item.pubDate.getTime()));

      resolve(items);
    });
  });
}

/**
 * Resolves which feeds to fetch from russell-briefing's flat-array sources.json.
 * Only returns RSS sources (skips screenshot entries).
 *
 * If --sources is provided, filters to those specific source IDs.
 * Otherwise returns all RSS sources.
 */
function resolveFeeds(sourcesConfig, args) {
  // Get all RSS sources from the flat array
  const allRSS = sourcesConfig.sources.filter(
    (s) => s.type === "rss" && !s._comment
  );

  // If --sources flag provided, filter to those IDs
  if (args.sources) {
    const wantedIds = new Set(args.sources);
    const filtered = allRSS.filter((s) => wantedIds.has(s.id));
    if (filtered.length === 0) {
      console.error(
        `No matching sources found. Available IDs: ${allRSS.map((s) => s.id).join(", ")}`
      );
      process.exit(1);
    }
    return filtered.map((s) => ({ name: s.name, url: s.url }));
  }

  // Default: all RSS sources
  return allRSS.map((s) => ({ name: s.name, url: s.url }));
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  const verbose = args.verbose;

  // 1. Resolve cutoff time
  const cutoff = resolveCutoff(args.cutoff);
  if (verbose) console.error(`Cutoff time: ${cutoff.toISOString()}`);

  // 2. Load sources.json
  let sourcesConfig;
  try {
    sourcesConfig = JSON.parse(fs.readFileSync(SOURCES_PATH, "utf8"));
  } catch (e) {
    console.error(`Cannot load sources.json at ${SOURCES_PATH}: ${e.message}`);
    process.exit(1);
  }

  // 3. Resolve which feeds to fetch
  const feeds = resolveFeeds(sourcesConfig, args);
  if (verbose) console.error(`Fetching ${feeds.length} feeds...`);

  // 4. Fetch all feeds concurrently
  const allStories = [];
  const feedResults = await Promise.allSettled(
    feeds.map(async (feed) => {
      try {
        const xml = await fetchURL(feed.url);
        const stories = await parseRSS(xml, feed.name);
        return stories;
      } catch (e) {
        if (verbose) console.error(`Failed: ${feed.name} (${feed.url}): ${e.message}`);
        return [];
      }
    })
  );

  // Collect results and track failures
  const failedFeeds = [];
  feeds.forEach((feed, i) => {
    const result = feedResults[i];
    if (result.status === "fulfilled") {
      allStories.push(...result.value);
    } else {
      failedFeeds.push(feed.name);
    }
  });

  if (verbose) {
    console.error(`Total stories fetched: ${allStories.length}`);
    console.error(`Failed feeds: ${failedFeeds.length}`);
  }

  // 5. Split into before/after cutoff
  const beforeSleep = [];
  const afterSleep = [];

  for (const story of allStories) {
    if (story.pubDate <= cutoff) {
      beforeSleep.push(story);
    } else {
      afterSleep.push(story);
    }
  }

  if (verbose) {
    console.error(`Before sleep: ${beforeSleep.length} stories`);
    console.error(`After sleep: ${afterSleep.length} stories`);
  }

  // 6. Extract entities from all stories
  for (const story of [...beforeSleep, ...afterSleep]) {
    story.entities = extractEntities(story.title);
  }

  // 7. Entity-matching dedup: compare each after-sleep story against all
  //    before-sleep stories. Flag pairs that exceed the overlap threshold.
  const flaggedPairs = [];
  const cleanAfterSleep = [];

  for (const afterStory of afterSleep) {
    let bestMatch = null;
    let bestScore = 0;
    let bestDetails = [];

    for (const beforeStory of beforeSleep) {
      const { score, matchDetails } = scoreOverlap(
        afterStory.entities,
        beforeStory.entities
      );
      if (score > bestScore) {
        bestScore = score;
        bestMatch = beforeStory;
        bestDetails = matchDetails;
      }
    }

    if (bestScore >= FLAG_THRESHOLD && bestMatch) {
      flaggedPairs.push({
        afterStory: {
          title: afterStory.title,
          link: afterStory.link,
          pubDate: afterStory.pubDate.toISOString(),
          source: afterStory.source,
          description: afterStory.description,
        },
        bestPreSleepMatch: {
          title: bestMatch.title,
          link: bestMatch.link,
          pubDate: bestMatch.pubDate.toISOString(),
          source: bestMatch.source,
        },
        overlapScore: bestScore,
        matchDetails: bestDetails,
      });
    } else {
      cleanAfterSleep.push(afterStory);
    }
  }

  // 8. Build output JSON
  const serialize = (story) => ({
    title: story.title,
    link: story.link,
    pubDate: story.pubDate.toISOString(),
    source: story.source,
    description: story.description,
  });

  const output = {
    meta: {
      cutoff: cutoff.toISOString(),
      cutoffLocal: cutoff.toLocaleString(),
      totalStories: allStories.length,
      beforeSleepCount: beforeSleep.length,
      afterSleepCount: afterSleep.length,
      flaggedCount: flaggedPairs.length,
      cleanAfterSleepCount: cleanAfterSleep.length,
      failedFeeds,
      feedsAttempted: feeds.length,
    },

    // Stories published BEFORE sleep (context — cap at 50)
    beforeSleep: beforeSleep
      .sort((a, b) => b.pubDate - a.pubDate)
      .slice(0, 50)
      .map(serialize),

    // Stories published AFTER sleep that are clearly NEW
    afterSleep: cleanAfterSleep
      .sort((a, b) => b.pubDate - a.pubDate)
      .map(serialize),

    // Potential rehashes — need LLM review
    flaggedPairs: flaggedPairs.sort((a, b) => b.overlapScore - a.overlapScore),
  };

  // 9. Output JSON to stdout
  console.log(JSON.stringify(output, null, 2));
}

main().catch((e) => {
  console.error(`Fatal error: ${e.message}`);
  process.exit(1);
});
