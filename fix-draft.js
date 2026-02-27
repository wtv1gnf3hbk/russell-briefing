#!/usr/bin/env node
// SYNC NOTE: This is the master copy. After editing, sync to all briefing repos:
//   cp ~/Downloads/nyt-concierge/fix-draft.js ~/Downloads/russell-briefing/
//   cp ~/Downloads/nyt-concierge/fix-draft.js ~/Downloads/japan-briefing/
//   cp ~/Downloads/nyt-concierge/fix-draft.js ~/news-briefing/
/**
 * fix-draft.js
 *
 * Auto-fixer for The World newsletter briefings. Companion to validate-draft.js.
 * Applies deterministic, regex-based fixes for the 4 most common repeat offenders
 * that the Editor LLM keeps fixing manually every session:
 *
 *   1. 's contractions       — "Netflix's merging" → "Netflix is merging"
 *   2. "amid"                — "amid tensions" → "during tensions"
 *   3. Tacked-on analysis    — ", showing how X..." → deleted
 *   4. Attribution mismatch  — "per Reuters" + apnews.com link → "per AP"
 *
 * Designed to run BETWEEN the Writer and Editor passes, so the Editor LLM
 * can focus on things that actually require judgment (grammar, tone, missing
 * articles) instead of wasting an API call on mechanical regex fixes.
 *
 * Usage:
 *   node fix-draft.js < draft.md           # Read from stdin, fixed text to stdout
 *   node fix-draft.js draft.md             # Read from file, fixed text to stdout
 *   node fix-draft.js --json < draft.md    # JSON report of fixes (no text output)
 *   node fix-draft.js --dry-run < draft.md # Show what would change, don't output fixed text
 *
 * Exit codes:
 *   0 = fixes applied (or --dry-run found fixes)
 *   1 = no changes needed (draft was clean)
 *
 * No external dependencies — pure Node.js.
 * Imports shared constants from validate-draft.js to avoid duplication.
 */

const fs = require('fs');

// Import shared constants from validate-draft.js so we don't maintain two copies.
// These are the canonical lists — if a verb or pattern is added to the validator,
// the fixer picks it up automatically.
const {
  CONTRACTION_VERBS,
  TACKED_ON_PATTERNS,
  SOURCE_DOMAINS,
  extractLinks,
  extractDomain,
} = require('./validate-draft.js');


// ---------------------------------------------------------------------------
// HELPERS (shared with validate-draft.js patterns)
// ---------------------------------------------------------------------------

/**
 * Parse command-line args.
 * Returns { json: boolean, dryRun: boolean, filePath: string|null }
 */
function parseArgs(argv) {
  const result = { json: false, dryRun: false, filePath: null };
  for (const arg of argv) {
    if (arg === '--json') result.json = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (!arg.startsWith('--')) result.filePath = arg;
  }
  return result;
}

/**
 * Read draft text from file path or stdin.
 */
function readDraft(args) {
  if (args.filePath) {
    if (!fs.existsSync(args.filePath)) {
      console.error(`Error: File not found: ${args.filePath}`);
      process.exit(1);
    }
    return fs.readFileSync(args.filePath, 'utf8');
  }
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    console.error('Error: No input. Pipe a draft via stdin or pass a file path.');
    console.error('Usage: node fix-draft.js < draft.md');
    process.exit(1);
  }
}

/**
 * Get 1-indexed line number for a character position in text.
 */
function getLineNumber(text, position) {
  return text.substring(0, position).split('\n').length;
}


// ---------------------------------------------------------------------------
// FIXER 1: 's Contractions
//
// Detects "word's <verb>" where 's means "is" or "has" (not possessive).
// Uses the same CONTRACTION_VERBS list as validate-draft.js.
//
// Fix rules:
//   - -ing verbs, "reportedly", "expected" → expand to "word is verb"
//   - Past tense (named, said, etc.) → drop the 's: "word verb"
// ---------------------------------------------------------------------------

function fixContractions(text) {
  const fixes = [];
  const verbSet = new Set(CONTRACTION_VERBS.map(v => v.toLowerCase()));

  // Replace in one pass. The regex matches word's followed by a word.
  // We check if that next word is a known contraction verb.
  const fixed = text.replace(/\b(\w+)'s\s+(\w+)/g, (match, subject, nextWord, offset) => {
    const nextLower = nextWord.toLowerCase();

    if (!verbSet.has(nextLower)) {
      // Not a contraction violation — it's a possessive. Keep as-is.
      return match;
    }

    let replacement;
    if (nextLower.endsWith('ing') || nextLower === 'reportedly' || nextLower === 'expected') {
      // "Netflix's merging" → "Netflix is merging"
      replacement = `${subject} is ${nextWord}`;
    } else {
      // "Disney's named" → "Disney named" (past tense — drop 's entirely)
      replacement = `${subject} ${nextWord}`;
    }

    fixes.push({
      type: 'contraction',
      original: match,
      fixed: replacement,
      line: getLineNumber(text, offset),
    });

    return replacement;
  });

  return { text: fixed, fixes };
}


// ---------------------------------------------------------------------------
// FIXER 2: "amid" → "during"
//
// Simple word swap. "amid" is banned per writing-rules.md Rule 12.
// "during" works in ~90% of cases:
//   "amid growing concerns" → "during growing concerns" ✓
//   "amid tensions" → "during tensions" ✓
//   "amid all this" → "during all this" (slightly awkward but acceptable)
//
// Edge cases that need restructuring (e.g. "amid" at sentence start
// where "as" would be better) are rare enough to leave for the Editor.
// ---------------------------------------------------------------------------

function fixAmid(text) {
  const fixes = [];

  const fixed = text.replace(/\bamid\b/gi, (match, offset) => {
    // Preserve original case: "Amid" → "During", "amid" → "during"
    const replacement = match[0] === match[0].toUpperCase() ? 'During' : 'during';

    fixes.push({
      type: 'amid',
      original: match,
      fixed: replacement,
      line: getLineNumber(text, offset),
    });

    return replacement;
  });

  return { text: fixed, fixes };
}


// ---------------------------------------------------------------------------
// FIXER 3: Tacked-on Analysis Clauses
//
// Deletes secondary clauses that interpret the news instead of reporting it.
// Examples:
//   "got prison time for jokes, showing how Moscow's crackdown extends."
//   → "got prison time for jokes."
//
//   "revenue fell 8%, highlighting the impact of tariffs."
//   → "revenue fell 8%."
//
// Uses TACKED_ON_PATTERNS from validate-draft.js (16 regex patterns).
//
// Strategy: find the match, then delete from the comma/start of the match
// to the end of the sentence (next period, or end of line for bullets).
// Tricky part: the match might be mid-sentence, so we need to find the
// preceding comma or semicolon that starts the tacked-on clause.
// ---------------------------------------------------------------------------

function fixTackedOnAnalysis(text) {
  const fixes = [];

  // Work line-by-line so we don't accidentally delete across bullet boundaries.
  // Most tacked-on analysis appears at the end of a bullet point.
  const lines = text.split('\n');
  const fixedLines = lines.map((line, lineIdx) => {
    let fixedLine = line;

    for (const pattern of TACKED_ON_PATTERNS) {
      // Build a global regex from the pattern so we catch all matches on this line
      const regex = new RegExp(pattern.source, 'gi');
      let match;

      while ((match = regex.exec(fixedLine)) !== null) {
        const matchStart = match.index;
        const matchText = match[0];

        // Find where to cut: from the match start to the end of the sentence.
        // A "sentence end" here is the next period followed by whitespace/EOL,
        // or just the end of the line (for bullet points).
        const afterMatch = fixedLine.substring(matchStart);
        // Look for sentence-ending punctuation after the matched phrase
        const sentenceEndMatch = afterMatch.match(/[.!?](?:\s|$|"|\))/);

        let cutEnd;
        if (sentenceEndMatch) {
          // Cut THROUGH the sentence-ending punctuation (include the period)
          cutEnd = matchStart + sentenceEndMatch.index + 1;
        } else {
          // No sentence-ending punctuation found — cut to end of line
          cutEnd = fixedLine.length;
        }

        // The text we're removing (for the fix report)
        const removedText = fixedLine.substring(matchStart, cutEnd).trim();

        // What comes before the tacked-on clause?
        // We need to check if there's a trailing comma/semicolon to clean up.
        let newLine = fixedLine.substring(0, matchStart);

        // Clean up trailing whitespace + comma before the cut point
        newLine = newLine.replace(/[,;]\s*$/, '');

        // Add a period if the line doesn't already end with punctuation
        if (newLine.length > 0 && !/[.!?]$/.test(newLine)) {
          newLine += '.';
        }

        // Append anything remaining after the cut (e.g. text after the sentence)
        const afterCut = fixedLine.substring(cutEnd);
        if (afterCut.length > 0) {
          newLine += afterCut;
        }

        fixes.push({
          type: 'tacked-on',
          original: removedText,
          fixed: '(deleted)',
          line: lineIdx + 1,
        });

        fixedLine = newLine;
        break; // One fix per line to avoid index chaos from the replacement
      }
    }

    return fixedLine;
  });

  return { text: fixedLines.join('\n'), fixes };
}


// ---------------------------------------------------------------------------
// FIXER 4: Attribution-Domain Mismatch
//
// When the Writer says "per Reuters" but links to apnews.com, replace the
// attribution with the correct source name based on the URL domain.
// Mirrors the logic in validate-draft.js's validateAttributionDomainMatch()
// but fixes instead of flagging.
//
// Reverse lookup: URL domain -> how the source should appear in attributions.
// Includes "the" where conventional (the BBC, the Guardian, the Financial Times).
// ---------------------------------------------------------------------------

// Domain -> display name for attribution text.
// Keys match the domains in SOURCE_DOMAINS values.
const DOMAIN_TO_ATTRIBUTION = {
  'apnews.com':       'AP',
  'reuters.com':      'Reuters',
  'bbc.com':          'the BBC',
  'bbc.co.uk':        'the BBC',
  'theguardian.com':  'the Guardian',
  'aljazeera.com':    'Al Jazeera',
  'france24.com':     'France24',
  'ft.com':           'the Financial Times',
  'wsj.com':          'the Wall Street Journal',
  'bloomberg.com':    'Bloomberg',
  'scmp.com':         'the South China Morning Post',
  'japantimes.co.jp': 'the Japan Times',
  'haaretz.com':      'Haaretz',
  'economist.com':    'the Economist',
  'cnn.com':          'CNN',
  'npr.org':          'NPR',
  'afp.com':          'AFP',
};

// SOURCE_DOMAINS keys -> how they appear in text (with optional "the" prefix).
// We need to find these in the text and replace them.
// Map from SOURCE_DOMAINS key -> regex-friendly display forms to search for.
const SOURCE_DISPLAY_FORMS = {
  'bloomberg':              ['Bloomberg'],
  'reuters':                ['Reuters'],
  'bbc':                    ['the BBC', 'BBC'],
  'guardian':               ['the Guardian', 'Guardian'],
  'al jazeera':             ['Al Jazeera'],
  'france24':               ['France24', 'France 24'],
  'financial times':        ['the Financial Times', 'Financial Times'],
  'ft':                     ['the FT', 'FT'],
  'wsj':                    ['the WSJ', 'WSJ'],
  'wall street journal':    ['the Wall Street Journal', 'Wall Street Journal'],
  'scmp':                   ['the SCMP', 'SCMP'],
  'south china morning post': ['the South China Morning Post', 'South China Morning Post'],
  'japan times':            ['the Japan Times', 'Japan Times'],
  'haaretz':                ['Haaretz'],
  'economist':              ['the Economist', 'Economist'],
  'cnn':                    ['CNN'],
  'npr':                    ['NPR'],
  'ap':                     ['AP'],
  'afp':                    ['AFP'],
};

/**
 * Look up the correct attribution display name for a URL domain.
 * Returns null if domain isn't in our map.
 */
function getAttributionForDomain(domain) {
  if (!domain) return null;
  for (const [d, name] of Object.entries(DOMAIN_TO_ATTRIBUTION)) {
    if (domain.endsWith(d)) return name;
  }
  return null;
}

/**
 * Fix attribution-domain mismatches.
 *
 * For each link in the text, checks if nearby attribution text mentions a
 * source that doesn't match the link's domain. If so, replaces the wrong
 * source name with the correct one based on the URL.
 *
 * Example: "per the BBC" + apnews.com link → "per AP"
 */
function fixAttributionDomain(text) {
  const fixes = [];
  const allLinks = extractLinks(text);

  // Process line by line to avoid cross-bullet contamination
  const lines = text.split('\n');

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];

    // Find links on this line
    const lineLinks = allLinks.filter(l => l.line === lineIdx + 1);
    if (lineLinks.length === 0) continue;

    let fixedLine = line;
    let madeChange = false;

    for (const link of lineLinks) {
      const domain = extractDomain(link.url);
      if (!domain) continue;
      // Skip NYT links (no attribution needed)
      if (domain.includes('nytimes.com')) continue;

      const correctAttribution = getAttributionForDomain(domain);
      if (!correctAttribution) continue;

      // Check each known source name against this line
      for (const [sourceName, expectedDomains] of Object.entries(SOURCE_DOMAINS)) {
        // Does the line mention this source?
        const lowerLine = fixedLine.toLowerCase();
        if (!lowerLine.includes(sourceName.toLowerCase())) continue;

        // Does the link domain match the expected domains for this source?
        const domainMatches = expectedDomains.some(d => domain.includes(d));
        if (domainMatches) continue; // No mismatch — skip

        // MISMATCH: line says "sourceName" but URL goes to a different domain.
        // Find the display form in the actual text and replace it.
        const displayForms = SOURCE_DISPLAY_FORMS[sourceName];
        if (!displayForms) continue;

        for (const form of displayForms) {
          // Case-insensitive search for the display form in the line
          const formRegex = new RegExp(escapeRegex(form), 'i');
          const formMatch = formRegex.exec(fixedLine);
          if (!formMatch) continue;

          const originalForm = formMatch[0]; // preserve original casing context
          const replacement = correctAttribution;

          // Handle "the" prefix: if original had "the X" and replacement starts
          // with "the", just swap. If original had "the X" but replacement doesn't
          // start with "the", remove the preceding "the " too.
          let actualOriginal = originalForm;
          let actualReplacement = replacement;

          // Check if there's a "the " before the matched form that's part of
          // the attribution (e.g., "per the BBC" where "the" isn't part of
          // SOURCE_DISPLAY_FORMS but is in the text)
          const beforeIdx = formMatch.index;
          const textBefore = fixedLine.substring(Math.max(0, beforeIdx - 4), beforeIdx);

          if (textBefore.match(/the\s$/i) && !form.toLowerCase().startsWith('the')) {
            // There's a "the " before the source name.
            // If replacement starts with "the ", include the preceding "the " in the original
            if (replacement.toLowerCase().startsWith('the ')) {
              actualOriginal = textBefore.match(/the\s$/i)[0] + originalForm;
              actualReplacement = replacement;
            } else {
              // Replacement doesn't have "the" — remove the preceding "the " too
              actualOriginal = textBefore.match(/the\s$/i)[0] + originalForm;
              actualReplacement = replacement;
            }
          } else if (form.toLowerCase().startsWith('the ') && !replacement.toLowerCase().startsWith('the ')) {
            // Display form includes "the" but replacement doesn't — just replace whole thing
            actualReplacement = replacement;
          }

          fixedLine = fixedLine.replace(actualOriginal, actualReplacement);

          fixes.push({
            type: 'attribution-domain',
            line: lineIdx + 1,
            original: actualOriginal,
            fixed: actualReplacement,
            domain: domain,
          });
          madeChange = true;
          break; // One fix per source per link
        }

        if (madeChange) break; // Move to next link
      }
    }

    if (madeChange) {
      lines[lineIdx] = fixedLine;
    }
  }

  return { text: lines.join('\n'), fixes };
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


// ---------------------------------------------------------------------------
// COMBINED FIXER
//
// Runs all 4 fixers in sequence. Order matters:
//   1. Contractions first (may change words that tacked-on patterns match)
//   2. Amid second (simple swap, no side effects)
//   3. Tacked-on analysis (deletes clauses — do this after other text edits)
//   4. Attribution-domain mismatch last (needs stable link positions)
// ---------------------------------------------------------------------------

function fixAll(text) {
  const allFixes = [];

  // Pass 1: contractions
  const r1 = fixContractions(text);
  allFixes.push(...r1.fixes);

  // Pass 2: amid
  const r2 = fixAmid(r1.text);
  allFixes.push(...r2.fixes);

  // Pass 3: tacked-on analysis
  const r3 = fixTackedOnAnalysis(r2.text);
  allFixes.push(...r3.fixes);

  // Pass 4: attribution-domain mismatch
  // "per Reuters" but link goes to apnews.com → "per AP"
  const r4 = fixAttributionDomain(r3.text);
  allFixes.push(...r4.fixes);

  return { text: r4.text, fixes: allFixes };
}


// ---------------------------------------------------------------------------
// OUTPUT
// ---------------------------------------------------------------------------

/**
 * Print fix summary to stderr (doesn't interfere with stdout text output).
 */
function printSummary(fixes) {
  if (fixes.length === 0) {
    console.error('No fixes needed — draft was clean.');
    return;
  }

  console.error(`\n🔧 FIX-DRAFT: ${fixes.length} fix(es) applied\n`);

  // Group by type
  const grouped = {};
  for (const fix of fixes) {
    if (!grouped[fix.type]) grouped[fix.type] = [];
    grouped[fix.type].push(fix);
  }

  for (const [type, typeFixes] of Object.entries(grouped)) {
    console.error(`  ${type} (${typeFixes.length}):`);
    for (const fix of typeFixes) {
      if (fix.type === 'tacked-on') {
        console.error(`    L${fix.line}: deleted "${fix.original.substring(0, 60)}${fix.original.length > 60 ? '...' : ''}"`);
      } else {
        console.error(`    L${fix.line}: "${fix.original}" → "${fix.fixed}"`);
      }
    }
  }

  console.error('');
}


// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const draftText = readDraft(args);

  if (!draftText.trim()) {
    if (args.json) {
      console.log(JSON.stringify({ text: '', fixes: [] }));
    } else {
      console.error('No draft content to fix.');
    }
    process.exit(1);
  }

  const result = fixAll(draftText);

  if (args.json) {
    // JSON mode: output structured report
    console.log(JSON.stringify({
      fixes: result.fixes,
      fixCount: result.fixes.length,
      text: args.dryRun ? undefined : result.text,
    }, null, 2));
  } else if (args.dryRun) {
    // Dry-run: show what would change, don't output fixed text
    printSummary(result.fixes);
  } else {
    // Normal mode: fixed text to stdout, summary to stderr
    console.log(result.text);
    printSummary(result.fixes);
  }

  // Exit code: 0 = fixes applied, 1 = no changes
  process.exit(result.fixes.length > 0 ? 0 : 1);
}


// ---------------------------------------------------------------------------
// EXPORTS (for testing) vs CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  main();
} else {
  module.exports = {
    fixContractions,
    fixAmid,
    fixTackedOnAnalysis,
    fixAttributionDomain,
    fixAll,
    // Expose helpers for testing
    getLineNumber,
    parseArgs,
    getAttributionForDomain,
    DOMAIN_TO_ATTRIBUTION,
  };
}
