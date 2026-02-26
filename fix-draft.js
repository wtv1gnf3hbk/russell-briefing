#!/usr/bin/env node
// SYNC NOTE: This is the master copy. After editing, sync to all briefing repos:
//   cp ~/Downloads/nyt-concierge/fix-draft.js ~/Downloads/russell-briefing/
//   cp ~/Downloads/nyt-concierge/fix-draft.js ~/Downloads/japan-briefing/
//   cp ~/Downloads/nyt-concierge/fix-draft.js ~/news-briefing/
/**
 * fix-draft.js
 *
 * Auto-fixer for The World newsletter briefings. Companion to validate-draft.js.
 * Applies deterministic, regex-based fixes for the 3 most common repeat offenders
 * that the Editor LLM keeps fixing manually every session:
 *
 *   1. 's contractions  — "Netflix's merging" → "Netflix is merging"
 *   2. "amid"           — "amid tensions" → "during tensions"
 *   3. Tacked-on analysis — ", showing how X..." → deleted
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
// COMBINED FIXER
//
// Runs all 3 fixers in sequence. Order matters:
//   1. Contractions first (may change words that tacked-on patterns match)
//   2. Amid second (simple swap, no side effects)
//   3. Tacked-on analysis last (deletes clauses — do this after other edits)
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

  return { text: r3.text, fixes: allFixes };
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
    fixAll,
    // Expose helpers for testing
    getLineNumber,
    parseArgs,
  };
}
