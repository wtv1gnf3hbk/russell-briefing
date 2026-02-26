#!/usr/bin/env node
// SYNC NOTE: This is the master copy. After editing, sync to all briefing repos:
//   cp ~/Downloads/nyt-concierge/validate-draft.js ~/Downloads/russell-briefing/
//   cp ~/Downloads/nyt-concierge/validate-draft.js ~/Downloads/japan-briefing/
//   cp ~/Downloads/nyt-concierge/validate-draft.js ~/news-briefing/
/**
 * validate-draft.js
 *
 * Post-draft quality gate for The World newsletter briefings.
 * Runs 13 automated checks against the briefing markdown before publication.
 *
 * Usage:
 *   node validate-draft.js < draft.md           # Read from stdin
 *   node validate-draft.js draft.md             # Read from file
 *   node validate-draft.js --json < draft.md    # JSON output
 *
 * Exit codes:
 *   0 = pass (no errors or warnings)
 *   1 = fail (has blocking errors — must fix before publishing)
 *   2 = warn (non-blocking warnings — review and fix if appropriate)
 *
 * Checks run (in order):
 *   ERRORS (blocking):
 *     1. Link diversity   — min 5 total links, min 2 non-NYT in Around the World
 *     2. Google News URLs — reject news.google.com/rss/articles/ redirect links
 *     3. Attribution-domain mismatch — "Bloomberg" text + reuters.com link = error
 *
 *   WARNINGS (non-blocking):
 *     4. Attribution presence — non-NYT links need "reports"/"per"/"according to"
 *     5. Banned phrases — ~30 phrases from writing-rules.md
 *     6. 's contraction + verb — "Netflix's merging" should be "Netflix is merging"
 *     7. US-domestic lead — flag if lead paragraph looks US-only
 *     8. Tacked-on analysis — ", showing how..." / ", highlighting..." at end of bullets
 *     9. Link text quality — bare country/person names, vague fragments, form CTAs
 *    10. "While" overuse — ", while" clause joiners; warns if > 2 occurrences
 *    11. Multi-paragraph lead — lead should be ONE narrative paragraph
 *    12. Link text length — max 3 words per writing-rules.md Rule 7
 *    13. Stale stories — cross-refs draft against briefing.json pubDates >36h old
 *
 * No external dependencies — pure Node.js.
 */

const fs = require('fs');

// ---------------------------------------------------------------------------
// CONSTANTS — edit these when writing-rules.md changes
// ---------------------------------------------------------------------------

// Minimum total links in the entire briefing
const MIN_TOTAL_LINKS = 5;

// Minimum non-NYT links in the "Around the World" section
const MIN_NON_NYT_AROUND_WORLD = 2;

// Banned editorial phrases from shared/writing-rules.md
// These are matched case-insensitively against the draft text.
// Keep in sync with writing-rules.md — if you add one there, add it here.
const BANNED_PHRASES = [
  "It's a reminder",
  "It's another reminder",
  "a testament to",
  "This signals",
  "This underscores",
  "The move highlights",
  "it suggests",
  "It's exactly the kind of",
  "this could signal",
  "observers say",
  "it remains to be seen",
  "showing just how volatile",
  "showing just how",
  "showing how",
  "in a move that",
  "amid growing concerns",
  "This isn't just about",
  "makes diplomats nervous",
  "reaching a crescendo",
  "saber-rattling",
  "belt-tightening continues",
  "political headaches",
  "brutal blow",
  "remains volatile",
  // These shorter phrases are checked AFTER the longer ones above
  // to avoid double-flagging. The validator deduplicates by line.
  "highlighting how",
  "highlighting",
  "underscoring",
  "demonstrating",
  "revealing",
  "suggesting that",
  "which could",
];

// Verbs that indicate an 's = "is/has" contraction bug.
// If we see "word's <verb>", it's a violation.
// Keep in sync with writing-rules.md contraction section.
const CONTRACTION_VERBS = [
  'named', 'announced', 'said', 'reported', 'confirmed', 'denied',
  'merging', 'acquiring', 'raising', 'heading', 'planning', 'considering',
  'expanding', 'stumbling', 'falling', 'rising', 'dropping', 'surging',
  'sliding', 'detaining', 'arresting', 'releasing', 'targeting',
  'reportedly', 'expected', 'set', 'cutting', 'seeking', 'facing',
  'launching', 'preparing', 'pushing', 'pulling', 'moving', 'looking',
];

// Source name → expected link domains.
// Used to catch mismatches like "Bloomberg reports" + reuters.com link.
const SOURCE_DOMAINS = {
  'bloomberg':   ['bloomberg.com'],
  'reuters':     ['reuters.com'],
  'bbc':         ['bbc.com', 'bbc.co.uk'],
  'guardian':    ['theguardian.com'],
  'al jazeera':  ['aljazeera.com'],
  'france24':    ['france24.com'],
  'financial times': ['ft.com'],
  'ft':          ['ft.com'],
  'wsj':         ['wsj.com'],
  'wall street journal': ['wsj.com'],
  'scmp':        ['scmp.com'],
  'south china morning post': ['scmp.com'],
  'japan times':  ['japantimes.co.jp'],
  'haaretz':     ['haaretz.com'],
  'economist':   ['economist.com'],
  'cnn':         ['cnn.com'],
  'npr':         ['npr.org'],
  'ap':          ['apnews.com'],
  'afp':         ['france24.com', 'afp.com'],
};

// Keywords suggesting a US-domestic story (used for lead region check)
const US_DOMESTIC_KEYWORDS = [
  'Trump', 'Biden', 'White House', 'Congress', 'Senate',
  'House of Representatives', 'Supreme Court', 'Democrats', 'Republicans',
  'GOP', 'Capitol Hill', 'MAGA', 'Epstein', 'FBI', 'DOJ',
  'Department of Justice', 'impeach', 'indictment', 'grand jury',
];

// Keywords suggesting an international angle (even in a US-originated story)
const INTERNATIONAL_KEYWORDS = [
  'sanctions', 'tariff', 'trade war', 'NATO', 'United Nations', 'U.N.',
  'EU', 'European Union', 'China', 'Russia', 'Ukraine', 'Iran', 'Israel',
  'Gaza', 'Middle East', 'Asia', 'Africa', 'Latin America', 'Europe',
  'embassy', 'diplomat', 'foreign policy', 'treaty', 'alliance',
  'international', 'global',
];

// Tacked-on analysis patterns — secondary clauses that interpret the news.
// These typically appear as ", <phrase>" at the end of a bullet.
const TACKED_ON_PATTERNS = [
  // Explicit patterns (original)
  /, showing how\b/i,
  /, showing just how\b/i,
  /, highlighting how\b/i,
  /, highlighting\b/i,
  /, underscoring\b/i,
  /, demonstrating\b/i,
  /, a sign that\b/i,
  /, suggesting\b/i,
  /, revealing\b/i,
  /, indicating\b/i,
  /, signaling\b/i,
  /, reflecting\b/i,
  // Soft variants — backtesting found these in ~60% of drafts where
  // the explicit patterns above missed them. Added Feb 2026.
  /the latest .{5,40} to\b/i,
  /adding another\b/i,
  /adding to\b/i,
  /continuing a pattern/i,
  /marking the latest/i,
  /in what (many|some|officials|analysts) (see|call|describe|are calling)/i,
];


// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Parse command-line args.
 * Returns { json: boolean, filePath: string|null }
 */
function parseArgs(argv) {
  const result = { json: false, filePath: null };
  for (const arg of argv) {
    if (arg === '--json') {
      result.json = true;
    } else if (!arg.startsWith('--')) {
      result.filePath = arg;
    }
  }
  return result;
}

/**
 * Read draft text from file path or stdin.
 * Stdin read is synchronous (fd 0).
 */
function readDraft(args) {
  if (args.filePath) {
    if (!fs.existsSync(args.filePath)) {
      console.error(`Error: File not found: ${args.filePath}`);
      process.exit(1);
    }
    return fs.readFileSync(args.filePath, 'utf8');
  }
  // Read from stdin
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    console.error('Error: No input. Pipe a draft via stdin or pass a file path.');
    console.error('Usage: node validate-draft.js < draft.md');
    console.error('       node validate-draft.js draft.md');
    process.exit(1);
  }
}

/**
 * Get 1-indexed line number for a character position in text.
 */
function getLineNumber(text, position) {
  return text.substring(0, position).split('\n').length;
}

/**
 * Extract all markdown links from text.
 * Returns array of { text, url, line, fullMatch, index }
 */
function extractLinks(text) {
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  const links = [];
  let match;
  while ((match = linkRegex.exec(text)) !== null) {
    links.push({
      text: match[1],
      url: match[2],
      line: getLineNumber(text, match.index),
      fullMatch: match[0],
      index: match.index,
    });
  }
  return links;
}

/**
 * Extract a section's content by its bold header (e.g. "Around the World").
 * Returns the text between that header and the next top-level bold header
 * (or end of text). Top-level headers start at the beginning of a line,
 * unlike inline bold text like "**Latin America:**" inside bullets.
 */
function extractSection(text, headerName) {
  // Find the header line — it's a standalone **Header** on its own line (or start of one)
  const escapedHeader = headerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerRegex = new RegExp(
    `^\\s*\\*\\*${escapedHeader}[:\\s]*\\*\\*`,
    'im'
  );
  const headerMatch = headerRegex.exec(text);
  if (!headerMatch) return null;

  // Content starts after the header line
  const contentStart = headerMatch.index + headerMatch[0].length;

  // Find next top-level section header: a line starting with **SomeHeader**
  // (not a bullet's inline bold like "• **Latin America:**")
  const nextHeaderRegex = /^\s*\*\*[A-Z][^*]*\*\*\s*$/m;
  const remaining = text.substring(contentStart);
  const nextMatch = nextHeaderRegex.exec(remaining);

  if (nextMatch) {
    return remaining.substring(0, nextMatch.index);
  }
  return remaining;
}

/**
 * Extract the lead paragraph — everything before the first **bold header** section.
 * Strips the greeting line to focus on the actual lead content.
 */
function extractLead(text) {
  // Find first occurrence of a bold section header like **Business/Technology**
  const headerMatch = text.match(/\n\s*\*\*[A-Z]/);
  if (!headerMatch) return text.trim();
  const leadText = text.substring(0, headerMatch.index).trim();
  // Remove the greeting line ("Good morning. Here's the state of play...")
  const lines = leadText.split('\n');
  const contentLines = lines.filter(l => {
    const trimmed = l.trim();
    // Skip greeting lines and empty lines
    if (!trimmed) return false;
    if (/^(good (morning|afternoon|evening)|here's the state)/i.test(trimmed)) return false;
    if (/^generated /i.test(trimmed)) return false;
    return true;
  });
  return contentLines.join('\n').trim();
}

/**
 * Get ~80 chars of context around a position in text, for error messages.
 */
function getContext(text, position, radius = 40) {
  const start = Math.max(0, position - radius);
  const end = Math.min(text.length, position + radius);
  let ctx = text.substring(start, end).replace(/\n/g, ' ').trim();
  if (start > 0) ctx = '...' + ctx;
  if (end < text.length) ctx = ctx + '...';
  return ctx;
}

/**
 * Check if a URL is an NYT link.
 */
function isNYTLink(url) {
  return url.includes('nytimes.com');
}

/**
 * Extract domain from a URL string. Returns lowercase domain or null.
 */
function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    // Not a valid URL — might be a relative path or malformed
    return null;
  }
}


// ---------------------------------------------------------------------------
// VALIDATORS
// Each returns an array of { type: 'error'|'warning', message, line, context }
// ---------------------------------------------------------------------------

/**
 * CHECK 1: Link diversity
 *
 * Ensures the briefing has enough total links AND enough non-NYT links
 * in the Around the World section. A briefing with all NYT links means
 * the Writer didn't pull from the 40+ RSS feeds available.
 *
 * ERRORS if:
 *   - Total links < 5
 *   - Non-NYT links in Around the World < 2
 */
function validateLinkDiversity(text) {
  const issues = [];
  const allLinks = extractLinks(text);

  // Total link count
  if (allLinks.length < MIN_TOTAL_LINKS) {
    issues.push({
      type: 'error',
      message: `Link count: Only ${allLinks.length} links found (minimum ${MIN_TOTAL_LINKS})`,
      line: null,
      context: null,
    });
  }

  // Non-NYT links in Around the World
  const atwSection = extractSection(text, 'Around the World');
  if (atwSection) {
    const atwLinks = extractLinks(atwSection);
    const nonNytCount = atwLinks.filter(l => !isNYTLink(l.url)).length;
    const nytCount = atwLinks.filter(l => isNYTLink(l.url)).length;

    if (nonNytCount < MIN_NON_NYT_AROUND_WORLD) {
      issues.push({
        type: 'error',
        message: `Link diversity: ${nytCount} NYT links, ${nonNytCount} non-NYT links in Around the World (minimum ${MIN_NON_NYT_AROUND_WORLD} non-NYT required)`,
        line: null,
        context: null,
      });
    }
  } else {
    // No "Around the World" section — fall back to checking non-NYT diversity
    // across the full briefing. This handles Russell-style formats (Top Stories,
    // Conflicts & Diplomacy, etc.) and any future briefing formats.
    // Backtest finding: this check was structurally broken for Russell (100% false
    // positive rate) because it errored on the missing section instead of adapting.
    const nonNytCount = allLinks.filter(l => !isNYTLink(l.url)).length;
    const nytCount = allLinks.filter(l => isNYTLink(l.url)).length;

    if (nonNytCount < MIN_NON_NYT_AROUND_WORLD) {
      issues.push({
        type: 'error',
        message: `Link diversity (full briefing fallback): ${nytCount} NYT links, ${nonNytCount} non-NYT links (minimum ${MIN_NON_NYT_AROUND_WORLD} non-NYT required)`,
        line: null,
        context: null,
      });
    }
  }

  return issues;
}

/**
 * CHECK 2: Google News redirect URLs
 *
 * Google News RSS feeds return redirect URLs like:
 *   https://news.google.com/rss/articles/CBMi...
 * These don't resolve for readers and are useless as links.
 * The rss-scraper.js strips them, but they can leak through
 * businessTechHighlights or other paths.
 *
 * ERRORS if any link contains news.google.com/rss/articles/
 */
function validateGoogleNewsUrls(text) {
  const issues = [];
  const allLinks = extractLinks(text);

  for (const link of allLinks) {
    if (link.url.includes('news.google.com/rss/articles/')) {
      issues.push({
        type: 'error',
        message: `Google News redirect URL — readers can't open this link`,
        line: link.line,
        context: `[${link.text}](${link.url.substring(0, 60)}...)`,
      });
    }
  }

  return issues;
}

/**
 * CHECK 3: Attribution-domain mismatch
 *
 * Catches cases like "according to Bloomberg News" where the actual link
 * goes to reuters.com. Scans text near each link for source name mentions
 * and compares against the link's domain.
 *
 * ERRORS if attributed source doesn't match link domain.
 */
function validateAttributionDomainMatch(text) {
  const issues = [];
  const allLinks = extractLinks(text);

  for (const link of allLinks) {
    const domain = extractDomain(link.url);
    if (!domain) continue;

    // Skip NYT links — they don't need attribution
    if (isNYTLink(link.url)) continue;
    // Skip Google News redirects — handled by check 2
    if (link.url.includes('news.google.com')) continue;

    // Get surrounding context (100 chars each side of the link)
    const ctxStart = Math.max(0, link.index - 100);
    const ctxEnd = Math.min(text.length, link.index + link.fullMatch.length + 100);
    const context = text.substring(ctxStart, ctxEnd).toLowerCase();

    // Check each known source name against the context
    for (const [sourceName, expectedDomains] of Object.entries(SOURCE_DOMAINS)) {
      // Does the nearby text mention this source?
      if (context.includes(sourceName.toLowerCase())) {
        // Does the link domain match any of the expected domains?
        const domainMatches = expectedDomains.some(d => domain.includes(d));
        if (!domainMatches) {
          issues.push({
            type: 'error',
            message: `Attribution says "${sourceName}" but links to ${domain}`,
            line: link.line,
            context: getContext(text, link.index),
          });
        }
        break; // Only check the first matching source name
      }
    }
  }

  return issues;
}

/**
 * CHECK 4: Attribution presence
 *
 * Every non-NYT link needs attribution nearby: "Reuters reports",
 * "per the BBC", "according to Bloomberg", etc. NYT links don't
 * need attribution since it's Adam's own outlet.
 *
 * WARNS if a non-NYT link has no attribution phrase nearby.
 */
function validateAttributionPresence(text) {
  const issues = [];
  const allLinks = extractLinks(text);

  // Attribution indicator patterns — things that signal a source is credited.
  // "per" can appear as "per the BBC" or "per Al Jazeera" (no "the").
  const attributionRegex = /\b(reports?|reported|per\b|according to|says?|said)\b/i;

  for (const link of allLinks) {
    // Skip NYT links
    if (isNYTLink(link.url)) continue;
    // Skip Google News redirects
    if (link.url.includes('news.google.com')) continue;

    // Get surrounding context (150 chars each side)
    const ctxStart = Math.max(0, link.index - 150);
    const ctxEnd = Math.min(text.length, link.index + link.fullMatch.length + 150);
    const context = text.substring(ctxStart, ctxEnd);

    // Check if any attribution phrase exists in the context
    if (!attributionRegex.test(context)) {
      const domain = extractDomain(link.url);
      issues.push({
        type: 'warning',
        message: `Missing attribution for non-NYT link to ${domain || link.url.substring(0, 40)}`,
        line: link.line,
        context: getContext(text, link.index),
      });
    }
  }

  return issues;
}

/**
 * CHECK 5: Banned phrases
 *
 * Scans for exact phrase matches from the banned list in writing-rules.md.
 * These are editorial crutches and analysis-tacking that should be cut.
 *
 * WARNS for each occurrence. Lists are sorted longest-first so we don't
 * double-flag "showing just how" and "showing how" on the same match.
 */
function validateBannedPhrases(text) {
  const issues = [];

  // Track which lines have already been flagged (avoid duplicates from
  // overlapping phrases like "showing just how" and "showing how")
  const flaggedPositions = new Set();

  // Sort longest first so "showing just how" matches before "showing how"
  const sorted = [...BANNED_PHRASES].sort((a, b) => b.length - a.length);

  for (const phrase of sorted) {
    // Build case-insensitive regex for the phrase
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    let match;

    while ((match = regex.exec(text)) !== null) {
      // Skip if this position was already flagged by a longer phrase
      const posKey = `${getLineNumber(text, match.index)}`;
      if (flaggedPositions.has(posKey)) continue;
      flaggedPositions.add(posKey);

      issues.push({
        type: 'warning',
        message: `Banned phrase: "${phrase}"`,
        line: getLineNumber(text, match.index),
        context: getContext(text, match.index),
      });
    }
  }

  return issues;
}

/**
 * CHECK 6: 's contraction violations
 *
 * Finds "word's <verb>" patterns where 's means "is" or "has" instead
 * of a possessive. The most common style bug in generated briefings.
 *
 * Examples:
 *   "Netflix's merging" → should be "Netflix is merging"
 *   "Tesla's reportedly" → should be "Tesla is reportedly"
 *   "Disney's named" → should be "Disney named"
 *
 * WARNS with suggested fix.
 */
function validateContractions(text) {
  const issues = [];

  // Match: word's followed by a word
  const regex = /\b(\w+)'s\s+(\w+)/gi;
  let match;

  // Build a set of verbs for fast lookup (lowercase)
  const verbSet = new Set(CONTRACTION_VERBS.map(v => v.toLowerCase()));

  while ((match = regex.exec(text)) !== null) {
    const subject = match[1];
    const nextWord = match[2].toLowerCase();

    if (verbSet.has(nextWord)) {
      // Determine the fix: -ing verbs → "is <verb>", past tense → drop 's
      let fix;
      if (nextWord.endsWith('ing') || nextWord === 'reportedly' || nextWord === 'expected') {
        fix = `"${subject} is ${match[2]}"`;
      } else {
        // Past tense (named, said, announced, etc.) — just drop the 's
        fix = `"${subject} ${match[2]}"`;
      }

      issues.push({
        type: 'warning',
        message: `'s contraction: "${match[0]}" → ${fix}`,
        line: getLineNumber(text, match.index),
        context: getContext(text, match.index),
      });
    }
  }

  return issues;
}

/**
 * CHECK 7: US-domestic lead
 *
 * The World is an international newsletter. US-domestic stories should
 * not lead unless they have direct international consequences or
 * non-US outlets are also leading with the story.
 *
 * This check is a heuristic: it counts US-domestic vs international
 * keywords in the lead paragraph. If the lead looks US-focused with
 * no international angle, it warns.
 *
 * WARNS if lead paragraph has 2+ US keywords and <2 international keywords.
 */
function validateLeadRegion(text) {
  const issues = [];
  const lead = extractLead(text);
  if (!lead) return issues;

  const leadLower = lead.toLowerCase();

  // Count keyword hits (case-insensitive)
  const usHits = US_DOMESTIC_KEYWORDS.filter(kw =>
    leadLower.includes(kw.toLowerCase())
  );
  const intlHits = INTERNATIONAL_KEYWORDS.filter(kw =>
    leadLower.includes(kw.toLowerCase())
  );

  if (usHits.length >= 2 && intlHits.length < 2) {
    issues.push({
      type: 'warning',
      message: `US-domestic lead: Found ${usHits.length} US keywords (${usHits.slice(0, 3).join(', ')}), only ${intlHits.length} international keywords. The World should lead with international news unless this story has global significance.`,
      line: 1,
      context: lead.substring(0, 100) + (lead.length > 100 ? '...' : ''),
    });
  }

  return issues;
}

/**
 * CHECK 8: Tacked-on analysis
 *
 * Catches secondary clauses that interpret the news instead of reporting it.
 * These typically appear as ", showing how...", ", highlighting...", etc.
 * at the end of bullet points.
 *
 * WARNS for each occurrence.
 */
function validateTackedOnAnalysis(text) {
  const issues = [];

  for (const pattern of TACKED_ON_PATTERNS) {
    // Reset regex lastIndex for global-like behavior
    const regex = new RegExp(pattern.source, 'gi');
    let match;

    while ((match = regex.exec(text)) !== null) {
      issues.push({
        type: 'warning',
        message: `Tacked-on analysis: "${match[0].trim()}"`,
        line: getLineNumber(text, match.index),
        context: getContext(text, match.index, 60),
      });
    }
  }

  return issues;
}


/**
 * CHECK 9: Link text quality
 *
 * Flags link text patterns that backtesting shows kill clicks:
 *   - Bare country/person names (1-2 words, just a place or leader name)
 *   - Lowercase fragments under 3 words (vague, context-dependent)
 *   - Form CTAs ("fill out", "submit", "sign up")
 *
 * Based on Feb 2026 backtest of 1,162 editorial links.
 * See shared/scoring-models.md for full evidence.
 *
 * WARNS for each occurrence.
 */
// Country and leader names for bare-name detection.
// Keep concise — only names that have actually appeared as bare link text.
const BARE_GEO_NAMES = [
  'china', 'russia', 'ukraine', 'israel', 'iran', 'gaza', 'india', 'japan',
  'korea', 'brazil', 'mexico', 'france', 'germany', 'turkey', 'syria',
  'colombia', 'venezuela', 'pakistan', 'afghanistan', 'iraq', 'egypt',
  'nepal', 'indonesia', 'georgia', 'taiwan', 'kenya', 'nigeria', 'myanmar',
  'south africa', 'south korea', 'north korea', 'saudi arabia',
];

const BARE_PERSON_NAMES = [
  'trump', 'biden', 'putin', 'xi', 'zelensky', 'netanyahu', 'modi',
  'macron', 'scholz', 'erdogan', 'milei', 'lula', 'starmer', 'meloni',
];

const FORM_CTA_PATTERNS = [
  /^fill(ing)? out/i,
  /^submit/i,
  /^sign up/i,
  /^filling out/i,
];

function validateLinkTextQuality(text) {
  const issues = [];
  const allLinks = extractLinks(text);

  for (const link of allLinks) {
    const linkText = link.text.trim();
    const words = linkText.split(/\s+/);
    const lower = linkText.toLowerCase();

    // --- Bare country/region name (1-2 words) ---
    if (words.length <= 2) {
      const isBareGeo = BARE_GEO_NAMES.some(name => lower === name);
      if (isBareGeo) {
        issues.push({
          type: 'warning',
          message: `Weak link text: bare country name "${linkText}" (-76% CTR vs median). Add context or use a CTA.`,
          line: link.line,
          context: getContext(text, link.index),
        });
        continue; // Don't double-flag
      }
    }

    // --- Bare person name (1-2 words) ---
    if (words.length <= 2) {
      const isBarePerson = BARE_PERSON_NAMES.some(name => lower === name);
      if (isBarePerson) {
        issues.push({
          type: 'warning',
          message: `Weak link text: bare person name "${linkText}" (-29% CTR vs median). Add context or use a CTA.`,
          line: link.line,
          context: getContext(text, link.index),
        });
        continue;
      }
    }

    // --- Single-word lowercase fragment ---
    // One-word links like "norms" or "blockade" are vague and context-dependent.
    // Two-word lowercase fragments are often fine ("strong earnings", "shut down").
    if (words.length === 1 && linkText[0] && /^[a-z]/.test(linkText)) {
      // Exclude common short CTAs and good patterns
      const goodShortPatterns = /^(read|see|take|watch|here|listen|more|video)/i;
      if (!goodShortPatterns.test(linkText)) {
        issues.push({
          type: 'warning',
          message: `Weak link text: single-word fragment "${linkText}". Fails standalone test — readers won't know what this links to.`,
          line: link.line,
          context: getContext(text, link.index),
        });
        continue;
      }
    }

    // --- Form CTAs ---
    for (const pattern of FORM_CTA_PATTERNS) {
      if (pattern.test(linkText)) {
        issues.push({
          type: 'warning',
          message: `Weak link text: form CTA "${linkText}" (-70% CTR). Use "Read more" or "Take a look" instead.`,
          line: link.line,
          context: getContext(text, link.index),
        });
        break;
      }
    }
  }

  return issues;
}


/**
 * CHECK 10: "While" overuse
 *
 * The word "while" used as a conjunction to glue two loosely related clauses
 * is the single most overused crutch in AI-generated briefings. Typical
 * pattern: "Country did X, while Country did Y" — should be two sentences.
 *
 * Legitimate uses:
 *   - "Meanwhile" as a paragraph/sentence opener (transitional)
 *   - "while" meaning "during" (e.g. "arrested while reporting")
 *
 * The lazy conjunction pattern almost always appears as ", while " or
 * "; while " — a comma or semicolon followed by "while" joining an
 * independent clause. We count those and warn if > 2.
 *
 * WARNS if the ", while" clause-joining pattern appears more than twice.
 */
const MAX_WHILE_JOINS = 2;

function validateWhileOveruse(text) {
  const issues = [];

  // Match ", while " or "; while " — the clause-joining pattern.
  // This excludes "Meanwhile" (no preceding comma) and temporal "while"
  // that typically follows a verb directly ("arrested while", "said while").
  const joinRegex = /[,;]\s+while\s/gi;
  const matches = [];
  let match;

  while ((match = joinRegex.exec(text)) !== null) {
    matches.push({
      index: match.index,
      line: getLineNumber(text, match.index),
      context: getContext(text, match.index, 60),
    });
  }

  if (matches.length > MAX_WHILE_JOINS) {
    // Report each occurrence so the writer knows which to fix
    for (const m of matches) {
      issues.push({
        type: 'warning',
        message: `"While" clause joiner (${matches.length} total, max ${MAX_WHILE_JOINS}). Split into separate sentences.`,
        line: m.line,
        context: m.context,
      });
    }
  }

  return issues;
}


/**
 * CHECK 11: Multi-paragraph lead
 *
 * The Writer ROLE.md says the lead should be ONE narrative paragraph.
 * Backtesting found 51.3% of drafts had multi-paragraph leads — the Writer
 * kept splitting the lead across 2-3 paragraphs instead of one punchy block.
 *
 * "Lead" = everything before the first bold section header (**Business/...**),
 * minus the greeting line. Multiple non-empty paragraphs = violation.
 *
 * WARNS if lead contains more than one paragraph.
 */
function validateLeadParagraphCount(text) {
  const issues = [];

  // Get the raw text before the first bold section header — we need to count
  // paragraphs BEFORE extractLead strips blank lines (which would collapse
  // multi-paragraph leads into one block).
  const headerMatch = text.match(/\n\s*\*\*[A-Z]/);
  if (!headerMatch) return issues;
  const rawLead = text.substring(0, headerMatch.index).trim();
  if (!rawLead) return issues;

  // Split into paragraphs (separated by blank lines), then filter out
  // greeting lines, "generated" timestamps, and empty blocks.
  const paragraphs = rawLead.split(/\n\s*\n/).filter(p => {
    const trimmed = p.trim();
    if (!trimmed) return false;
    if (/^(good (morning|afternoon|evening)|here's the state)/i.test(trimmed)) return false;
    if (/^generated /i.test(trimmed)) return false;
    return true;
  });

  if (paragraphs.length > 1) {
    issues.push({
      type: 'warning',
      message: `Multi-paragraph lead: Found ${paragraphs.length} paragraphs before first section header. The lead should be ONE narrative paragraph.`,
      line: 1,
      context: paragraphs[0].substring(0, 80) + (paragraphs[0].length > 80 ? '...' : ''),
    });
  }

  return issues;
}


/**
 * CHECK 12: Link text length
 *
 * Writing-rules.md Rule 7: link text max 3 words. Backtesting found 38.5%
 * of drafts violate this with zero enforcement.
 *
 * Exceptions:
 *   - CTAs like "Read more here" (4 words but high-performing)
 *   - Headlines used as link text (full sentence style, >5 words)
 *     are technically a violation but handled differently by the Editor.
 *
 * WARNS for link text > 3 words that isn't a known CTA pattern.
 */
const LINK_TEXT_CTA_EXCEPTIONS = [
  /^read more here$/i,
  /^take a look$/i,
  /^see how/i,
  /^see the/i,
  /^see what/i,
  /^here'?s what/i,
  /^here are/i,
  /^watch .* here$/i,
  /^listen to/i,
];

function validateLinkTextLength(text) {
  const issues = [];
  const allLinks = extractLinks(text);

  for (const link of allLinks) {
    const linkText = link.text.trim();
    const words = linkText.split(/\s+/);

    if (words.length > 3) {
      // Skip if it matches a known high-performing CTA pattern
      const isCTA = LINK_TEXT_CTA_EXCEPTIONS.some(p => p.test(linkText));
      if (isCTA) continue;

      issues.push({
        type: 'warning',
        message: `Link text too long: "${linkText}" (${words.length} words, max 3). Shorten or use a CTA pattern.`,
        line: link.line,
        context: getContext(text, link.index),
      });
    }
  }

  return issues;
}


/**
 * CHECK 13: Stale stories
 *
 * Cross-references the draft text against briefing.json to detect stories
 * whose pubDate is older than 36 hours. This catches the case where an RSS
 * feed returns an old story, the recency filter in write-briefing.js misses it
 * (or doesn't exist), and Claude includes it in the briefing anyway.
 *
 * How it works:
 *   1. Reads briefing.json from CWD (same directory where validation runs)
 *   2. Collects all RSS stories with a parseable pubDate
 *   3. Flags any story > 36h old whose headline appears in the draft text
 *      (fuzzy match: first 5 significant words of the headline)
 *
 * Returns empty array if briefing.json doesn't exist (graceful fallback
 * for stdin-only validation or when run outside the briefing directory).
 *
 * WARNS (non-blocking) so editors can review whether the story is genuinely stale.
 */
const STALE_HOURS_THRESHOLD = 36;

function validateStaleStories(text) {
  const issues = [];

  // Try to load briefing.json from CWD
  let briefing;
  try {
    const raw = fs.readFileSync('briefing.json', 'utf8');
    briefing = JSON.parse(raw);
  } catch {
    // No briefing.json available — skip this check silently
    return issues;
  }

  const now = new Date();

  // Collect all RSS-sourced stories with pubDate from the secondary sources
  // (wire services like reuters, ap, bbc, bloomberg, etc.)
  const allRssStories = [];
  if (briefing.secondary && typeof briefing.secondary === 'object') {
    for (const [source, stories] of Object.entries(briefing.secondary)) {
      if (!Array.isArray(stories)) continue;
      for (const story of stories) {
        const dateStr = story.pubDate || story.date;
        if (!dateStr) continue;
        const pubDate = new Date(dateStr);
        if (isNaN(pubDate.getTime())) continue;
        const hoursAgo = (now - pubDate) / (1000 * 60 * 60);
        if (hoursAgo > STALE_HOURS_THRESHOLD) {
          allRssStories.push({ source, title: story.title, hoursAgo: Math.round(hoursAgo) });
        }
      }
    }
  }

  if (allRssStories.length === 0) return issues;

  // For each stale story, check if its headline appears in the draft.
  // Use first 5 significant words of the headline for fuzzy matching.
  const draftLower = text.toLowerCase();
  for (const story of allRssStories) {
    if (!story.title) continue;
    // Extract significant words (skip short words like "a", "the", "in")
    const words = story.title
      .replace(/[^\w\s]/g, '')
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 2);
    const searchPhrase = words.slice(0, 5).join(' ');
    if (searchPhrase.length < 10) continue; // Too short to match reliably

    // Check if enough of the headline words appear near each other in the draft
    const matchCount = words.slice(0, 5).filter(w => draftLower.includes(w)).length;
    if (matchCount >= 4) {
      issues.push({
        type: 'warning',
        message: `Possibly stale story (~${story.hoursAgo}h old) from ${story.source}: "${story.title.slice(0, 60)}..."`,
      });
    }
  }

  return issues;
}


// ---------------------------------------------------------------------------
// OUTPUT
// ---------------------------------------------------------------------------

/**
 * Print human-readable validation report to stdout.
 */
function printHumanReadable(results) {
  const { errors, warnings } = results;

  console.log('\n📝 DRAFT VALIDATION REPORT\n');
  console.log('='.repeat(50));

  if (errors.length > 0) {
    console.log('\nERRORS (must fix before publishing):');
    for (const err of errors) {
      const lineInfo = err.line ? ` (line ${err.line})` : '';
      console.log(`   ❌ ${err.message}${lineInfo}`);
      if (err.context) {
        console.log(`      ${err.context}`);
      }
    }
  }

  if (warnings.length > 0) {
    console.log('\nWARNINGS (review and fix if appropriate):');
    for (const warn of warnings) {
      const lineInfo = warn.line ? ` (line ${warn.line})` : '';
      console.log(`   ⚠️  ${warn.message}${lineInfo}`);
      if (warn.context) {
        console.log(`      ${warn.context}`);
      }
    }
  }

  if (errors.length === 0 && warnings.length === 0) {
    console.log('\n✅ All checks passed!');
  }

  console.log('\n' + '='.repeat(50));

  // Summary line
  const total = errors.length + warnings.length;
  if (total === 0) {
    console.log('Result: PASS\n');
  } else {
    console.log(`Result: ${errors.length} error(s), ${warnings.length} warning(s)\n`);
  }
}


// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const draftText = readDraft(args);

  // Bail on empty input
  if (!draftText.trim()) {
    if (args.json) {
      console.log(JSON.stringify({ errors: [], warnings: [], note: 'Empty input' }));
    } else {
      console.log('No draft content to validate.');
    }
    process.exit(0);
  }

  // Run all 13 validators
  const errors = [
    ...validateLinkDiversity(draftText),       // Check 1
    ...validateGoogleNewsUrls(draftText),      // Check 2
    ...validateAttributionDomainMatch(draftText), // Check 3
  ];

  const warnings = [
    ...validateAttributionPresence(draftText), // Check 4
    ...validateBannedPhrases(draftText),        // Check 5
    ...validateContractions(draftText),         // Check 6
    ...validateLeadRegion(draftText),           // Check 7
    ...validateTackedOnAnalysis(draftText),     // Check 8
    ...validateLinkTextQuality(draftText),      // Check 9
    ...validateWhileOveruse(draftText),          // Check 10
    ...validateLeadParagraphCount(draftText),   // Check 11
    ...validateLinkTextLength(draftText),        // Check 12
    ...validateStaleStories(draftText),          // Check 13
  ];

  const results = { errors, warnings };

  // Output
  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printHumanReadable(results);
  }

  // Exit code
  if (errors.length > 0) {
    process.exit(1);
  } else if (warnings.length > 0) {
    process.exit(2);
  } else {
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// EXPORTS (for testing) vs CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  // Called directly from command line: node validate-draft.js < draft.md
  main();
} else {
  // Required as a module (e.g. from test suite)
  module.exports = {
    // Helpers
    extractLinks,
    extractSection,
    extractLead,
    getLineNumber,
    getContext,
    isNYTLink,
    extractDomain,
    // Validators (each returns array of { type, message, line, context })
    validateLinkDiversity,
    validateGoogleNewsUrls,
    validateAttributionDomainMatch,
    validateAttributionPresence,
    validateBannedPhrases,
    validateContractions,
    validateLeadRegion,
    validateTackedOnAnalysis,
    validateLinkTextQuality,
    validateWhileOveruse,
    validateLeadParagraphCount,
    validateLinkTextLength,
    validateStaleStories,
    // Constants (useful for test assertions and fix-draft.js)
    BANNED_PHRASES,
    CONTRACTION_VERBS,
    TACKED_ON_PATTERNS,
    SOURCE_DOMAINS,
    US_DOMESTIC_KEYWORDS,
    INTERNATIONAL_KEYWORDS,
    MIN_TOTAL_LINKS,
    MIN_NON_NYT_AROUND_WORLD,
  };
}
