/**
 * Entity extraction and overlap scoring for headline dedup.
 *
 * Shared module used by:
 *   - sleeping-filter.js (standalone overnight filter)
 *   - generate-briefing.js (--cutoff pipeline integration)
 *
 * Extracts people, places, and orgs from headlines, then scores
 * how much two headlines overlap. High overlap = likely rehash.
 *
 * Ported from ~/.claude/skills/sleeping-filter/sleeping-filter.js
 */

// Minimum entity overlap score to flag a pair for LLM review.
// Lower = more sensitive (flags more). Higher = fewer false positives.
const FLAG_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// KNOWN ENTITY LISTS
// These get higher confidence scores than unknown capitalized phrases.
// ---------------------------------------------------------------------------

const KNOWN_PEOPLE = [
  // World leaders
  "Trump", "Biden", "Xi Jinping", "Putin", "Zelensky", "Macron", "Scholz",
  "Starmer", "Sunak", "Modi", "Kishida", "Ishiba", "Lula", "Milei",
  "Netanyahu", "Erdogan", "Marcos", "Yoon", "Kim Jong Un",
  "Sheinbaum", "Carney", "Albanese", "Meloni",
  // Tech/business
  "Musk", "Bezos", "Zuckerberg", "Altman", "Nadella", "Cook", "Pichai",
  "Dimon", "Buffett", "Gates",
  // International figures
  "Guterres", "Lavrov", "Blinken", "Sullivan", "Austin", "Rubio",
];

const KNOWN_ORGS = [
  // International orgs
  "UN", "NATO", "EU", "WHO", "IMF", "OPEC", "BRICS", "ASEAN", "G7", "G20",
  "ICC", "ICJ", "WTO", "IAEA", "IOC",
  // Companies (high-value for business dedup)
  "Apple", "Google", "Microsoft", "Amazon", "Meta", "Tesla", "SpaceX",
  "OpenAI", "Nvidia", "xAI", "Samsung", "TSMC", "ByteDance", "TikTok",
  "Netflix", "Disney", "Boeing", "Airbus", "DeepSeek",
  // Government agencies
  "FBI", "CIA", "NSA", "Pentagon", "State Department", "Treasury",
  "Fed", "Federal Reserve", "ECB", "Bank of Japan",
  // Militant/political groups
  "Hamas", "Hezbollah", "Taliban", "Houthis",
];

const KNOWN_PLACES = [
  // Countries (only ones specific enough to matter)
  "Ukraine", "Russia", "China", "Taiwan", "Israel", "Gaza", "Palestine",
  "Iran", "North Korea", "Syria", "Lebanon", "Yemen", "Sudan", "Myanmar",
  "Afghanistan", "Libya", "Venezuela", "Haiti", "Congo", "Cuba",
  // Cities that signal specific stories
  "Kyiv", "Moscow", "Beijing", "Taipei", "Jerusalem", "Tel Aviv",
  "Pyongyang", "Tehran", "Kabul", "Damascus",
];

// ---------------------------------------------------------------------------
// ENTITY EXTRACTION
// ---------------------------------------------------------------------------

// Words to skip when looking for unknown capitalized phrases
const SKIP_WORDS = new Set([
  "The", "In", "On", "At", "To", "For", "Of", "And", "But", "Or",
  "Is", "Are", "Was", "Were", "Has", "Have", "Had", "Will", "Would",
  "Could", "Should", "May", "Can", "Not", "No", "New", "Old", "Top",
  "How", "Why", "What", "When", "Where", "Who", "Says", "Said",
  "After", "Before", "Over", "Under", "With", "From", "Into",
  "First", "Last", "More", "Most", "Some", "All", "Big", "Major",
  "Report", "Reports", "Breaking", "Update", "Live", "Latest",
]);

/**
 * Extracts entities from a headline string.
 * Returns: { people: [], places: [], orgs: [], raw: [] }
 *
 * Uses a combination of:
 *   - Known entity lists (high confidence)
 *   - Capitalized multi-word phrases (medium confidence)
 */
function extractEntities(headline) {
  const entities = { people: [], places: [], orgs: [], raw: [] };
  if (!headline) return entities;

  // Normalize: strip HTML tags, decode common entities
  const clean = headline
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

  // Check known people
  for (const person of KNOWN_PEOPLE) {
    if (clean.includes(person)) {
      entities.people.push(person);
      entities.raw.push(person);
    }
  }

  // Check known orgs
  for (const org of KNOWN_ORGS) {
    // Use word boundary check for short acronyms to avoid false matches
    const regex = org.length <= 3
      ? new RegExp(`\\b${org}\\b`)
      : new RegExp(org.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (regex.test(clean)) {
      entities.orgs.push(org);
      entities.raw.push(org);
    }
  }

  // Check known places
  for (const place of KNOWN_PLACES) {
    if (clean.includes(place)) {
      entities.places.push(place);
      entities.raw.push(place);
    }
  }

  // Extract unknown capitalized phrases (2+ words) — likely names or places
  const capPhraseRegex = /(?:^|[.!?]\s+|[,;:\u2013\u2014]\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/g;
  let match;
  while ((match = capPhraseRegex.exec(clean)) !== null) {
    const phrase = match[1];
    const words = phrase.split(/\s+/);
    if (words.every((w) => SKIP_WORDS.has(w))) continue;
    if (!entities.raw.includes(phrase)) {
      entities.raw.push(phrase);
    }
  }

  return entities;
}

// ---------------------------------------------------------------------------
// OVERLAP SCORING
// ---------------------------------------------------------------------------

/**
 * Scores the entity overlap between two sets of entities.
 *
 * Scoring weights:
 *   - Full person name match: 5 (instant flag by itself)
 *   - Org match: 3
 *   - Place match: 1 (lone country is not enough)
 *   - Unknown capitalized phrase match: 2
 *
 * Returns { score, matchDetails }. Scores >= FLAG_THRESHOLD get flagged.
 */
function scoreOverlap(entitiesA, entitiesB) {
  let score = 0;
  const matchDetails = [];

  // People matches (highest weight)
  for (const person of entitiesA.people) {
    if (entitiesB.people.includes(person)) {
      score += 5;
      matchDetails.push(`person:${person}`);
    }
  }

  // Org matches
  for (const org of entitiesA.orgs) {
    if (entitiesB.orgs.includes(org)) {
      score += 3;
      matchDetails.push(`org:${org}`);
    }
  }

  // Place matches (low weight)
  for (const place of entitiesA.places) {
    if (entitiesB.places.includes(place)) {
      score += 1;
      matchDetails.push(`place:${place}`);
    }
  }

  // Unknown entity phrase matches
  const unknownA = entitiesA.raw.filter(
    (e) =>
      !entitiesA.people.includes(e) &&
      !entitiesA.orgs.includes(e) &&
      !entitiesA.places.includes(e)
  );
  const unknownB = new Set(
    entitiesB.raw.filter(
      (e) =>
        !entitiesB.people.includes(e) &&
        !entitiesB.orgs.includes(e) &&
        !entitiesB.places.includes(e)
    )
  );
  for (const phrase of unknownA) {
    if (unknownB.has(phrase)) {
      score += 2;
      matchDetails.push(`phrase:${phrase}`);
    }
  }

  return { score, matchDetails };
}

module.exports = {
  FLAG_THRESHOLD,
  KNOWN_PEOPLE,
  KNOWN_ORGS,
  KNOWN_PLACES,
  extractEntities,
  scoreOverlap,
};
