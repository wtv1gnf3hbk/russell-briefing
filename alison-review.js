#!/usr/bin/env node
/**
 * Alison Review — automated fact-check pass for Russell's briefing.
 *
 * Named after the senior editor agent. Runs after write-briefing.js,
 * before fix-draft.js. Fetches the actual articles linked in the draft,
 * then asks Claude Haiku to compare each bullet's claims against the
 * article text. If discrepancies are found (wrong numbers, names, outcomes),
 * calls Sonnet to rewrite the affected bullets with corrected facts.
 *
 * Only checks public sources — skips paywalled domains (FT, WSJ).
 *
 * Pipeline position:
 *   generate-briefing.js → write-briefing.js → [alison-review.js] → fix-draft.js → validate-draft.js
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 */

const https = require('https');
const fs = require('fs');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY environment variable');
  process.exit(1);
}

// ============================================
// CONFIG
// ============================================

// Domains we can fetch (public or soft paywall).
// Everything else gets skipped.
const FETCHABLE_DOMAINS = [
  'bbc.com',
  'apnews.com',
  'reuters.com',
  'theguardian.com',
  'aljazeera.com',
  'nytimes.com',
  'france24.com',
];

// Max concurrent article fetches
const CONCURRENCY = 5;

// Timeout per fetch (ms)
const FETCH_TIMEOUT = 10000;

// Max chars of article text to send to Haiku for fact-checking.
// ~3000 chars is enough for the key facts without burning tokens.
const MAX_ARTICLE_CHARS = 3000;

// ============================================
// CLAUDE API CALL
// Reuses the same pattern as write-briefing.js
// ============================================

function callClaude(prompt, systemPrompt = '', model = 'claude-haiku-4-5-20251001') {
  return new Promise((resolve, reject) => {
    const messages = [{ role: 'user', content: prompt }];

    const body = JSON.stringify({
      model: model,
      max_tokens: 1000,
      system: systemPrompt,
      messages
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(json.error.message));
          } else {
            resolve(json.content[0].text);
          }
        } catch (e) {
          reject(new Error('Failed to parse API response: ' + data.slice(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('API timeout'));
    });

    req.write(body);
    req.end();
  });
}

// ============================================
// ARTICLE FETCHING
// ============================================

/**
 * Check if a URL's domain is in our fetchable list.
 */
function isFetchable(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return FETCHABLE_DOMAINS.some(d => hostname.endsWith(d));
  } catch {
    return false;
  }
}

/**
 * Fetch a URL and extract article body text from the HTML.
 * Simple regex-based HTML stripping — good enough for fact-checking.
 * Returns empty string on failure (non-blocking).
 */
async function fetchArticleText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Pretend to be a browser so sites don't block us
        'User-Agent': 'Mozilla/5.0 (compatible; NewsBriefingBot/1.0)',
        'Accept': 'text/html',
      },
      redirect: 'follow',
    });

    if (!res.ok) {
      console.log(`  ⚠ ${new URL(url).hostname}: HTTP ${res.status}`);
      return '';
    }

    const html = await res.text();
    return extractText(html);
  } catch (e) {
    const domain = new URL(url).hostname;
    console.log(`  ⚠ ${domain}: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Strip HTML tags and extract readable text from article HTML.
 * Focuses on <article>, <main>, or <body> content.
 * Removes scripts, styles, nav, footer, and other non-content elements.
 */
function extractText(html) {
  // Try to find the article body first (most news sites use <article>)
  let content = '';
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);

  if (articleMatch) {
    content = articleMatch[1];
  } else if (mainMatch) {
    content = mainMatch[1];
  } else {
    // Fall back to <body>
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    content = bodyMatch ? bodyMatch[1] : html;
  }

  // Remove non-content elements
  content = content
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/<figure[^>]*>[\s\S]*?<\/figure>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');

  // Strip remaining HTML tags
  content = content.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  content = content
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Collapse whitespace
  content = content.replace(/\s+/g, ' ').trim();

  // Return first N chars — enough for fact-checking key claims
  return content.slice(0, MAX_ARTICLE_CHARS);
}

/**
 * Fetch multiple URLs in parallel with concurrency limit.
 * Returns a Map of url -> articleText.
 */
async function fetchArticles(urls) {
  const results = new Map();
  const queue = [...urls];

  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift();
      const text = await fetchArticleText(url);
      if (text) {
        results.set(url, text);
      }
    }
  }

  // Spawn concurrent workers
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, urls.length) },
    () => worker()
  );
  await Promise.all(workers);

  return results;
}

// ============================================
// BULLET PARSING
// ============================================

/**
 * Parse briefing.md into individual bullets with their URLs and text.
 * Each bullet is a markdown list item: "- text with [link](url)"
 */
function parseBullets(markdown) {
  const bullets = [];
  const lines = markdown.split('\n');

  for (const line of lines) {
    // Match markdown list items
    if (!line.match(/^- /)) continue;

    // Extract all links from this bullet
    const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
    const urls = [];
    let match;
    while ((match = linkRegex.exec(line)) !== null) {
      urls.push(match[2]);
    }

    if (urls.length === 0) continue;

    // Strip markdown formatting for clean text
    const plainText = line
      .replace(/^- /, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

    bullets.push({
      original: line,      // the full markdown line (for replacement later)
      text: plainText,      // plain text version of the bullet
      urls: urls,           // all URLs in this bullet
    });
  }

  return bullets;
}

// ============================================
// FACT-CHECK VIA HAIKU
// ============================================

const FACT_CHECK_SYSTEM = `You are a fact-checker for a news briefing. Compare the briefing bullet against the article text. Focus on:
- Numbers (quantities, percentages, dollar amounts, death tolls, recruitment counts)
- Names (people, organizations, countries)
- Outcomes (what actually happened vs. what the bullet claims)
- Key facts (dates, locations, decisions)

Reply with exactly one line:
PASS — if the bullet accurately represents the article
FAIL: <brief description of the discrepancy> — if there is a factual error

Be strict about numbers. If the bullet says "1,000" but the article says "22", that is a FAIL.
If the article text is too short or unclear to verify, reply PASS (benefit of the doubt).`;

/**
 * Fact-check a single bullet against its article text.
 * Returns { pass: boolean, reason: string } or null if check failed.
 */
async function factCheckBullet(bullet, articleText) {
  const prompt = `BRIEFING BULLET:
${bullet.text}

ARTICLE TEXT:
${articleText}

Does the bullet accurately represent the article?`;

  try {
    const response = await callClaude(prompt, FACT_CHECK_SYSTEM);
    const trimmed = response.trim();

    if (trimmed.startsWith('PASS')) {
      return { pass: true, reason: '' };
    } else if (trimmed.startsWith('FAIL')) {
      const reason = trimmed.replace(/^FAIL:?\s*/, '');
      return { pass: false, reason };
    } else {
      // Unexpected format — treat as pass
      console.log(`  ? Unexpected Haiku response: "${trimmed.slice(0, 80)}"`);
      return { pass: true, reason: '' };
    }
  } catch (e) {
    console.log(`  ⚠ Fact-check API error: ${e.message}`);
    return null; // skip this bullet
  }
}

// ============================================
// CORRECTION VIA SONNET
// ============================================

/**
 * Given bullets that failed fact-checking, ask Sonnet to rewrite them
 * with the correct information from the articles.
 * Returns a Map of original_line -> corrected_line.
 */
async function correctBullets(failures) {
  // Build a prompt with all the failures and their article text
  const items = failures.map((f, i) => {
    return `BULLET ${i + 1}:
${f.bullet.text}

FACT-CHECK RESULT: ${f.reason}

ARTICLE TEXT:
${f.articleText}`;
  }).join('\n\n---\n\n');

  const systemPrompt = `You are rewriting news briefing bullets to fix factual errors.
For each bullet, you will see the original text, the fact-check failure reason, and the actual article text.
Rewrite ONLY the bullets that need correction. Keep the same style (concise, no editorializing).
Preserve the markdown link format: [link text](url)

IMPORTANT: Return ONLY the corrected markdown bullets, one per line, prefixed with "- ".
Return them in order (BULLET 1, BULLET 2, etc). If a bullet only needs a minor number fix,
change just that number — don't rewrite the whole sentence.`;

  const userPrompt = `Fix these ${failures.length} bullet(s) to match the article facts:\n\n${items}

Original markdown lines (preserve link URLs exactly):
${failures.map((f, i) => `BULLET ${i + 1}: ${f.bullet.original}`).join('\n')}

Return the corrected markdown lines:`;

  try {
    const response = await callClaude(userPrompt, systemPrompt, 'claude-sonnet-4-20250514');

    // Parse corrected bullets from response
    const correctedLines = response
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('- '));

    if (correctedLines.length !== failures.length) {
      console.log(`  ⚠ Sonnet returned ${correctedLines.length} bullets, expected ${failures.length}`);
      // Try to use what we got, matching by index
    }

    const corrections = new Map();
    for (let i = 0; i < Math.min(correctedLines.length, failures.length); i++) {
      const original = failures[i].bullet.original;
      const corrected = correctedLines[i];
      if (original !== corrected) {
        corrections.set(original, corrected);
      }
    }

    return corrections;
  } catch (e) {
    console.error(`  ⚠ Correction API error: ${e.message}`);
    return new Map();
  }
}

// ============================================
// HTML REGENERATION
// Simplified version of write-briefing.js's generateHTML.
// Only rewrites the content div — preserves the rest of index.html.
// ============================================

function markdownToHTML(md) {
  let html = md
    .replace(/^#{1,3}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    .replace(/^[-\u2022] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  html = html.split('\n').map(function(line) {
    if (line.startsWith('<ul>') || line.startsWith('<li>') || line.startsWith('</ul>')) return line;
    if (line.startsWith('<strong>')) return '<p class="section-header">' + line + '</p>';
    if (line.trim() && !line.startsWith('<')) return '<p>' + line + '</p>';
    return line;
  }).join('\n');

  return html;
}

/**
 * Update index.html's content div with corrected markdown.
 * Preserves the header, script, and styling — only replaces the
 * innerHTML of <div id="content">.
 */
function updateHTML(correctedMarkdown) {
  if (!fs.existsSync('index.html')) return;

  const html = fs.readFileSync('index.html', 'utf8');
  const contentHTML = markdownToHTML(correctedMarkdown);

  // Replace everything between <div id="content"> and </div>\n</body>
  const updated = html.replace(
    /(<div id="content">)[\s\S]*?(<\/div>\s*<\/body>)/,
    `$1\n${contentHTML}\n  $2`
  );

  fs.writeFileSync('index.html', updated);
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('=== Alison Review (Fact-Check) ===\n');

  // 1. Read the draft
  if (!fs.existsSync('briefing.md')) {
    console.log('No briefing.md found — skipping review');
    process.exit(0);
  }

  const markdown = fs.readFileSync('briefing.md', 'utf8');
  const bullets = parseBullets(markdown);
  console.log(`Found ${bullets.length} bullets in briefing.md`);

  // 2. Collect all unique fetchable URLs
  const allUrls = new Set();
  for (const bullet of bullets) {
    for (const url of bullet.urls) {
      if (isFetchable(url)) {
        allUrls.add(url);
      }
    }
  }

  const skippedCount = bullets.reduce((n, b) => n + b.urls.filter(u => !isFetchable(u)).length, 0);
  console.log(`Fetching ${allUrls.size} articles (${skippedCount} paywalled URLs skipped)\n`);

  if (allUrls.size === 0) {
    console.log('No fetchable URLs — nothing to fact-check');
    process.exit(0);
  }

  // 3. Fetch articles in parallel
  console.log('Fetching articles...');
  const fetchStart = Date.now();
  const articles = await fetchArticles([...allUrls]);
  const fetchElapsed = ((Date.now() - fetchStart) / 1000).toFixed(1);
  console.log(`Fetched ${articles.size}/${allUrls.size} articles in ${fetchElapsed}s\n`);

  // 4. Fact-check each bullet that has a fetched article
  console.log('Fact-checking bullets...');
  const checkStart = Date.now();
  const failures = [];
  let checked = 0;
  let passed = 0;

  for (const bullet of bullets) {
    // Find the first fetchable URL that we actually got article text for
    const fetchedUrl = bullet.urls.find(u => articles.has(u));
    if (!fetchedUrl) continue; // no article text available for this bullet

    const articleText = articles.get(fetchedUrl);
    const result = await factCheckBullet(bullet, articleText);

    checked++;

    if (result === null) continue; // API error, skip

    if (result.pass) {
      passed++;
      console.log(`  ✓ ${bullet.text.slice(0, 60)}...`);
    } else {
      failures.push({
        bullet,
        reason: result.reason,
        articleText,
        url: fetchedUrl,
      });
      console.log(`  ✗ ${bullet.text.slice(0, 60)}...`);
      console.log(`    FAIL: ${result.reason}`);
    }
  }

  const checkElapsed = ((Date.now() - checkStart) / 1000).toFixed(1);
  console.log(`\nChecked ${checked} bullets in ${checkElapsed}s: ${passed} passed, ${failures.length} failed`);

  // 5. If any failures, correct them
  if (failures.length > 0) {
    console.log(`\nCorrecting ${failures.length} bullet(s)...`);

    const corrections = await correctBullets(failures);

    if (corrections.size > 0) {
      // Apply corrections to briefing.md
      let corrected = markdown;
      for (const [original, fixed] of corrections) {
        corrected = corrected.replace(original, fixed);
        console.log(`  Fixed: "${original.slice(2, 62)}..." → "${fixed.slice(2, 62)}..."`);
      }

      fs.writeFileSync('briefing.md', corrected);
      console.log(`\nSaved corrected briefing.md (${corrections.size} fix(es))`);

      // Regenerate index.html with corrected content
      updateHTML(corrected);
      console.log('Updated index.html');
    } else {
      console.log('  No corrections applied (Sonnet returned nothing usable)');
    }
  } else {
    console.log('\nAll bullets passed fact-check — no corrections needed');
  }

  console.log('\n=== Alison Review complete ===');
}

main().catch(e => {
  // Non-blocking — if the review fails entirely, the pipeline continues
  console.error('Alison review error:', e.message);
  process.exit(0); // exit 0 so CI doesn't halt
});
