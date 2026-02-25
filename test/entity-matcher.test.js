/**
 * Tests for entity-matcher.js — entity extraction and overlap scoring
 * used by the sleeping filter and briefing dedup pipeline.
 *
 * Uses Node's built-in test runner (node:test + node:assert).
 * No external dependencies.
 *
 * Run: node --test test/entity-matcher.test.js
 *   or: npm test (from russell-briefing root)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractEntities,
  scoreOverlap,
  FLAG_THRESHOLD,
  KNOWN_PEOPLE,
  KNOWN_ORGS,
  KNOWN_PLACES,
} = require('../entity-matcher.js');


// ---------------------------------------------------------------------------
// extractEntities
// ---------------------------------------------------------------------------

describe('extractEntities — known people', () => {
  it('finds Putin and Lavrov in a headline', () => {
    const e = extractEntities('Putin fires Lavrov in surprise move');
    assert.ok(e.people.includes('Putin'));
    assert.ok(e.people.includes('Lavrov'));
  });

  it('finds multi-word names like "Xi Jinping"', () => {
    const e = extractEntities('Xi Jinping meets world leaders at G20');
    assert.ok(e.people.includes('Xi Jinping'));
  });

  it('finds "Kim Jong Un" with spaces', () => {
    const e = extractEntities('Kim Jong Un orders new missile test');
    assert.ok(e.people.includes('Kim Jong Un'));
  });
});


describe('extractEntities — known orgs', () => {
  it('finds NATO as a word-boundary match', () => {
    const e = extractEntities('NATO summit begins in Brussels');
    assert.ok(e.orgs.includes('NATO'));
  });

  it('word boundary only applies to 3-char-or-less acronyms (EU, UN, G7)', () => {
    // Word boundary check is for orgs <= 3 chars. NATO (4 chars) uses
    // plain substring match — so "DONATO" WILL match NATO. This is a
    // known trade-off: word-boundary on all acronyms would miss cases
    // like "NATOs" (possessive). Short acronyms like EU/UN need it
    // to avoid false positives in common words.
    const e = extractEntities('EU summit in Brussels');
    assert.ok(e.orgs.includes('EU'), 'EU should match with word boundary');
    // "REUNITED" contains "EU" but should NOT match (word boundary)
    const e2 = extractEntities('The family reunited after years apart');
    assert.ok(!e2.orgs.includes('EU'), 'EU should not match inside "reunited"');
  });

  it('finds longer org names without word boundary', () => {
    const e = extractEntities('OpenAI releases new model');
    assert.ok(e.orgs.includes('OpenAI'));
  });
});


describe('extractEntities — known places', () => {
  it('finds Ukraine and Russia', () => {
    const e = extractEntities('Russia launches new offensive in Ukraine');
    assert.ok(e.places.includes('Russia'));
    assert.ok(e.places.includes('Ukraine'));
  });

  it('finds city names like Kyiv', () => {
    const e = extractEntities('Explosions heard across Kyiv overnight');
    assert.ok(e.places.includes('Kyiv'));
  });
});


describe('extractEntities — HTML handling', () => {
  it('strips HTML tags before extraction', () => {
    const e = extractEntities('<b>Putin</b> meets <i>Macron</i>');
    assert.ok(e.people.includes('Putin'));
    assert.ok(e.people.includes('Macron'));
  });

  it('decodes &amp; entities', () => {
    const e = extractEntities('EU &amp; NATO hold joint summit');
    assert.ok(e.orgs.includes('EU'));
    assert.ok(e.orgs.includes('NATO'));
  });

  it('decodes &quot; entities', () => {
    const e = extractEntities('Putin says &quot;no negotiations&quot;');
    assert.ok(e.people.includes('Putin'));
  });
});


describe('extractEntities — empty/null input', () => {
  it('returns empty arrays for empty string', () => {
    const e = extractEntities('');
    assert.deepEqual(e.people, []);
    assert.deepEqual(e.places, []);
    assert.deepEqual(e.orgs, []);
    assert.deepEqual(e.raw, []);
  });

  it('returns empty arrays for null', () => {
    const e = extractEntities(null);
    assert.deepEqual(e.people, []);
  });

  it('returns empty arrays for undefined', () => {
    const e = extractEntities(undefined);
    assert.deepEqual(e.people, []);
  });
});


describe('extractEntities — unknown capitalized phrases', () => {
  it('picks up multi-word caps phrases at sentence boundaries', () => {
    // The unknown phrase regex requires caps phrases to follow sentence-ending
    // punctuation (. ! ?) or certain delimiters (, ; : — –). It won't catch
    // mid-sentence names like "visited Mark Rutte" — only "... Mark Rutte said".
    const e = extractEntities('Tensions are rising. Mark Rutte called for calm.');
    assert.ok(e.raw.includes('Mark Rutte'), 'should find "Mark Rutte" after sentence boundary');
  });

  it('does not pick up caps phrases mid-sentence without punctuation', () => {
    // "Mark Rutte" after "PM " has no preceding punctuation — should miss it
    const e = extractEntities('Dutch PM Mark Rutte visits Berlin');
    // "Mark Rutte" won't be in raw from the unknown caps regex,
    // but if any known entity matches, raw will have those
    const hasMarkRutte = e.raw.includes('Mark Rutte');
    assert.ok(!hasMarkRutte, 'should not detect mid-sentence caps phrase without punctuation');
  });
});


// ---------------------------------------------------------------------------
// scoreOverlap
// ---------------------------------------------------------------------------

describe('scoreOverlap — person matches', () => {
  it('scores 5+ for matching person (Putin)', () => {
    const a = extractEntities('Putin orders military drills');
    const b = extractEntities('Putin meets Xi in Beijing');
    const { score, matchDetails } = scoreOverlap(a, b);
    assert.ok(score >= 5, `Expected score >= 5, got ${score}`);
    assert.ok(matchDetails.some(d => d.includes('person:Putin')));
  });

  it('scores 10+ for two matching people', () => {
    const a = extractEntities('Putin and Zelensky trade accusations');
    const b = extractEntities('Zelensky rejects Putin peace offer');
    const { score } = scoreOverlap(a, b);
    assert.ok(score >= 10, `Expected score >= 10, got ${score}`);
  });
});


describe('scoreOverlap — org matches', () => {
  it('scores 3 for matching org (NATO)', () => {
    const a = extractEntities('NATO holds emergency meeting');
    const b = extractEntities('NATO deploys more troops');
    const { score, matchDetails } = scoreOverlap(a, b);
    assert.ok(score >= 3, `Expected score >= 3, got ${score}`);
    assert.ok(matchDetails.some(d => d.includes('org:NATO')));
  });
});


describe('scoreOverlap — place matches', () => {
  it('scores only 1 for matching place alone', () => {
    const a = extractEntities('Heavy rains in Ukraine');
    const b = extractEntities('Wheat harvest falls in Ukraine');
    const { score } = scoreOverlap(a, b);
    // Place alone = 1, which is below FLAG_THRESHOLD (3)
    // This is by design — lone country match is not enough for dedup
    assert.equal(score, 1);
    assert.ok(score < FLAG_THRESHOLD, 'Lone place should be below flag threshold');
  });
});


describe('scoreOverlap — unrelated headlines', () => {
  it('scores 0 for completely unrelated headlines', () => {
    const a = extractEntities('Apple launches new iPhone');
    const b = extractEntities('Heavy rains flood Bangladesh');
    const { score } = scoreOverlap(a, b);
    // Apple is an org, Bangladesh is not in known places — should be 0
    assert.equal(score, 0);
  });
});


describe('scoreOverlap — FLAG_THRESHOLD', () => {
  it('threshold is 3', () => {
    assert.equal(FLAG_THRESHOLD, 3);
  });
});
