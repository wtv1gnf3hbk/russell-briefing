#!/usr/bin/env node
/**
 * Two-step briefing pipeline:
 *   1. Writer (Sonnet) — generates all-bullets briefing from briefing.json
 *   2. Editor (Haiku) — copy-edits for grammar/style bugs the Writer misses
 *
 * The Editor pass is non-critical: if it fails or returns garbage,
 * the Writer's draft is used as-is. Catches: missing articles ("a", "the"),
 * 's contractions, "amid", tacked-on analysis, em-dash run-ons.
 *
 * Outputs briefing.md (markdown) and index.html (styled page)
 *
 * Forked from japan-briefing. Key differences:
 *   - All-bullets format (no prose sections)
 *   - International focus (not Japan)
 *   - No screenshot display in HTML (screenshots are input-only for priority)
 *   - Timezone: America/New_York
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
// CLAUDE API CALL
// ============================================

function callClaude(prompt, systemPrompt = '', model = 'claude-sonnet-4-20250514') {
  return new Promise((resolve, reject) => {
    const messages = [{ role: 'user', content: prompt }];

    const body = JSON.stringify({
      model: model,
      max_tokens: 2500,
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
    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error('API timeout'));
    });

    req.write(body);
    req.end();
  });
}

// ============================================
// TIMEZONE UTILITIES
// ============================================

function formatTimestamp(timezone = 'America/New_York') {
  const now = new Date();

  // Format date
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: timezone
  });

  // Format time
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone
  });

  // Get timezone abbreviation
  const tzAbbr = now.toLocaleTimeString('en-US', {
    timeZone: timezone,
    timeZoneName: 'short'
  }).split(' ').pop();

  // ISO date for machine-readable contexts (feedback, etc.)
  const isoDate = now.toLocaleDateString('en-CA', { timeZone: timezone }); // YYYY-MM-DD

  return { dateStr, timeStr, tzAbbr, isoDate, full: `${dateStr} at ${timeStr} ${tzAbbr}` };
}

// ============================================
// HTML GENERATION
// No screenshots in output — just clean bullets
// ============================================

// Convert Claude's markdown output to HTML
function markdownToHTML(md) {
  let html = md
    // Strip markdown heading markers (## **Title** -> **Title**)
    // Claude sometimes uses ## before section headers
    .replace(/^#{1,3}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    // Handle both "- " and "• " bullet formats (Claude sometimes uses either)
    .replace(/^[-•] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  html = html.split('\n').map(function(line) {
    if (line.startsWith('<ul>') || line.startsWith('<li>') || line.startsWith('</ul>')) return line;
    if (line.startsWith('<strong>')) return '<p class="section-header">' + line + '</p>';
    if (line.trim() && !line.startsWith('<')) return '<p>' + line + '</p>';
    return line;
  }).join('\n');

  return html;
}

function generateHTML(briefingText, config) {
  const timezone = config.metadata?.timezone || 'America/New_York';
  const timestamp = formatTimestamp(timezone);
  const title = config.metadata?.name || "Russell's World Briefing";
  const contentHTML = markdownToHTML(briefingText);

  // The <script> block is a raw string (not a template literal)
  // to avoid escaping issues with backticks in the JS code inside it
  var scriptBlock = [
    '  <script>',
    "    const WORKER_URL = 'https://russell-briefing-refresh.adampasick.workers.dev';",
    '',
    '    async function refreshBriefing() {',
    '      const link = event.target;',
    '      const originalText = link.textContent;',
    '',
    '      try {',
    "        link.textContent = 'Triggering...';",
    '        const triggerRes = await fetch(WORKER_URL + "/trigger", { method: "POST" });',
    "        if (!triggerRes.ok) throw new Error('Failed to trigger');",
    '',
    "        link.textContent = 'Starting...';",
    '        await new Promise(r => setTimeout(r, 3000));',
    '',
    "        link.textContent = 'Finding run...';",
    '        const runsRes = await fetch(WORKER_URL + "/runs");',
    '        const runsData = await runsRes.json();',
    "        if (!runsData.workflow_runs || !runsData.workflow_runs.length) throw new Error('No runs found');",
    '',
    '        const runId = runsData.workflow_runs[0].id;',
    '        const runUrl = runsData.workflow_runs[0].html_url;',
    '',
    '        let attempts = 0;',
    '        while (attempts < 60) {',
    '          const statusRes = await fetch(WORKER_URL + "/status/" + runId);',
    '          const statusData = await statusRes.json();',
    '',
    "          if (statusData.status === 'completed') {",
    "            if (statusData.conclusion === 'success') {",
    "              link.textContent = 'Done! Reloading...';",
    '              await new Promise(r => setTimeout(r, 5000));',
    '              location.reload(true);',
    '              return;',
    '            } else {',
    '              link.innerHTML = \'Failed (<a href="\' + runUrl + \'" target="_blank">logs</a>)\';',
    '              return;',
    '            }',
    '          }',
    '',
    "          link.textContent = 'Running... ' + (attempts * 5) + 's';",
    '          await new Promise(r => setTimeout(r, 5000));',
    '          attempts++;',
    '        }',
    '',
    '        link.innerHTML = \'Timeout (<a href="\' + runUrl + \'" target="_blank">check</a>)\';',
    '      } catch (error) {',
    "        console.error('Refresh error:', error);",
    "        link.textContent = 'Error';",
    '        setTimeout(function() { link.textContent = originalText; }, 3000);',
    '      }',
    '    }',
    '  </script>'
  ].join('\n');

  // Feedback section — returns HTML + JS for the feedback widget
  function feedbackBlock(isoDate) {
    return [
      '',
      '  <div class="feedback-section" id="feedback-section" data-date="' + isoDate + '">',
      '    <div class="feedback-prompt">How was today\'s briefing?</div>',
      '    <div class="feedback-buttons" id="feedback-buttons">',
      '      <button class="feedback-btn" data-reaction="thumbsup" onclick="selectReaction(this)">&#x1F44D;</button>',
      '      <button class="feedback-btn" data-reaction="thumbsdown" onclick="selectReaction(this)">&#x1F44E;</button>',
      '    </div>',
      '    <textarea class="feedback-textarea" id="feedback-comment" placeholder="Optional: tell us more..." rows="3"></textarea>',
      '    <button class="feedback-submit" id="feedback-submit" onclick="submitFeedback()">Send</button>',
      '    <div class="feedback-thanks" id="feedback-thanks">Thanks for the feedback!</div>',
      '  </div>',
      '',
      '  <script>',
      '    var FEEDBACK_URL = "https://russell-briefing-refresh.adampasick.workers.dev/feedback";',
      '    var selectedReaction = null;',
      '',
      '    (function() {',
      '      var dateKey = document.getElementById("feedback-section").dataset.date;',
      '      if (localStorage.getItem("feedback-sent-" + dateKey)) {',
      '        document.getElementById("feedback-buttons").style.display = "none";',
      '        document.querySelector(".feedback-prompt").style.display = "none";',
      '        document.getElementById("feedback-thanks").style.display = "block";',
      '        document.getElementById("feedback-thanks").textContent = "Feedback sent \\u2014 thank you!";',
      '      }',
      '    })();',
      '',
      '    function selectReaction(btn) {',
      '      document.querySelectorAll(".feedback-btn").forEach(function(b) { b.classList.remove("selected"); });',
      '      btn.classList.add("selected");',
      '      selectedReaction = btn.dataset.reaction;',
      '      document.getElementById("feedback-comment").style.display = "block";',
      '      document.getElementById("feedback-submit").style.display = "block";',
      '    }',
      '',
      '    async function submitFeedback() {',
      '      if (!selectedReaction) return;',
      '      var comment = document.getElementById("feedback-comment").value.trim();',
      '      var dateKey = document.getElementById("feedback-section").dataset.date;',
      '      var submitBtn = document.getElementById("feedback-submit");',
      '      submitBtn.textContent = "Sending...";',
      '      submitBtn.disabled = true;',
      '      try {',
      '        var res = await fetch(FEEDBACK_URL, {',
      '          method: "POST",',
      '          headers: { "Content-Type": "application/json" },',
      '          body: JSON.stringify({ reaction: selectedReaction, comment: comment || "", briefingDate: dateKey })',
      '        });',
      '        if (!res.ok) throw new Error("Server error");',
      '        document.getElementById("feedback-buttons").style.display = "none";',
      '        document.getElementById("feedback-comment").style.display = "none";',
      '        document.getElementById("feedback-submit").style.display = "none";',
      '        document.querySelector(".feedback-prompt").style.display = "none";',
      '        document.getElementById("feedback-thanks").style.display = "block";',
      '        localStorage.setItem("feedback-sent-" + dateKey, "1");',
      '      } catch (e) {',
      '        submitBtn.textContent = "Error \\u2014 try again";',
      '        submitBtn.disabled = false;',
      '      }',
      '    }',
      '  </script>'
    ].join('\n');
  }

  return '<!DOCTYPE html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '  <meta charset="UTF-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '  <title>' + title + '</title>\n' +
    '  <style>\n' +
    '    * { box-sizing: border-box; margin: 0; padding: 0; }\n' +
    '    body {\n' +
    "      font-family: Georgia, 'Times New Roman', serif;\n" +
    '      line-height: 1.7;\n' +
    '      max-width: 680px;\n' +
    '      margin: 0 auto;\n' +
    '      padding: 32px 16px;\n' +
    '      background: #fafafa;\n' +
    '      color: #1a1a1a;\n' +
    '    }\n' +
    '    .header {\n' +
    '      margin-bottom: 24px;\n' +
    '      padding-bottom: 16px;\n' +
    '      border-bottom: 1px solid #e0e0e0;\n' +
    '    }\n' +
    '    .title {\n' +
    "      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;\n" +
    '      font-size: 1.5rem;\n' +
    '      font-weight: 700;\n' +
    '      margin-bottom: 8px;\n' +
    '    }\n' +
    '    .timestamp {\n' +
    '      font-size: 0.85rem;\n' +
    '      color: #666;\n' +
    '    }\n' +
    '    .refresh-link {\n' +
    '      color: #666;\n' +
    '      text-decoration: underline;\n' +
    '      cursor: pointer;\n' +
    '    }\n' +
    '    h1, h2, strong {\n' +
    "      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;\n" +
    '    }\n' +
    '    p { margin-bottom: 16px; }\n' +
    '    ul { margin: 12px 0 20px 0; padding-left: 0; list-style: none; }\n' +
    '    li { margin-bottom: 10px; padding-left: 16px; position: relative; }\n' +
    '    li::before { content: "\\2022"; position: absolute; left: 0; color: #999; }\n' +
    '    a {\n' +
    '      color: #1a1a1a;\n' +
    '      text-decoration: underline;\n' +
    '      text-decoration-color: #999;\n' +
    '      text-underline-offset: 2px;\n' +
    '    }\n' +
    '    a:hover { text-decoration-color: #333; }\n' +
    '    strong { font-weight: 600; }\n' +
    '    .section-header { margin-top: 24px; margin-bottom: 12px; }\n' +
    '    /* Feedback section */\n' +
    '    .feedback-section { margin-top: 40px; padding-top: 24px; border-top: 1px solid #e0e0e0; text-align: center; }\n' +
    '    .feedback-prompt { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 0.85rem; color: #666; margin-bottom: 12px; }\n' +
    '    .feedback-buttons { display: flex; justify-content: center; gap: 12px; margin-bottom: 12px; }\n' +
    '    .feedback-btn { font-size: 1.4rem; padding: 8px 16px; border: 1px solid #ddd; border-radius: 8px; background: transparent; cursor: pointer; transition: background 0.15s; }\n' +
    '    .feedback-btn:hover { background: #f0f0f0; }\n' +
    '    .feedback-btn.selected { background: #e8e8e8; border-color: #999; }\n' +
    '    .feedback-textarea { display: none; width: 100%; max-width: 480px; margin: 12px auto; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 0.9rem; resize: vertical; }\n' +
    '    .feedback-submit { display: none; margin: 8px auto; padding: 6px 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 0.85rem; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer; }\n' +
    '    .feedback-submit:hover { background: #e8e8e8; }\n' +
    '    .feedback-thanks { display: none; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 0.85rem; color: #666; margin-top: 8px; }\n' +
    '  </style>\n' +
    '</head>\n' +
    '<body>\n' +
    '  <div class="header">\n' +
    '    <div class="title">' + title + '</div>\n' +
    '    <div class="timestamp">\n' +
    '      Generated ' + timestamp.full + '\n' +
    '      &middot; <a class="refresh-link" onclick="refreshBriefing()">Refresh</a>\n' +
    '    </div>\n' +
    '  </div>\n\n' +
    scriptBlock + '\n\n' +
    '  <div id="content">\n' +
    contentHTML + '\n' +
    '  </div>\n' +
    feedbackBlock(timestamp.isoDate) + '\n' +
    '</body>\n' +
    '</html>';
}

// ============================================
// PROMPT BUILDING
// ============================================

function buildPrompt(briefing) {
  const config = briefing.metadata || {};
  const ownerName = config.owner || 'Russell';

  // Organize stories — use priority buckets, not category buckets
  // (categories here are general/wire/business, not region-specific like japan-briefing)
  const stories = briefing.stories || {};
  const byPriority = stories.byPriority || {};

  // ---- Recency filter ----
  // Two-tier system:
  //   - Hard cutoff: drop anything > 18h (not 24h — for a 5:30am run,
  //     18h-old stories are genuinely "yesterday" and were likely in the
  //     previous day's briefing already).
  //   - Aging cap: stories 12-18h old are limited to MAX_AGING_PER_BUCKET
  //     so the prompt is dominated by fresh content. This is the code gate
  //     for Rule 10 ("prefer stories from the last 12 hours") — prose-only
  //     rules don't work on LLMs.
  //   - Null dates: limited to MAX_NULL_DATE so undated stories can't flood
  //     the prompt and bypass age checks.
  const HARD_CUTOFF_HOURS = 18;
  const AGING_THRESHOLD_HOURS = 12;
  const MAX_AGING_PER_BUCKET = 3;
  const MAX_NULL_DATE = 2;
  const now = new Date();

  function tagRecency(storyList) {
    return (storyList || []).map(s => {
      if (s.date) {
        const pubDate = new Date(s.date);
        const hoursAgo = isNaN(pubDate.getTime()) ? null : (now - pubDate) / (1000 * 60 * 60);
        return { ...s, hoursAgo: hoursAgo !== null ? Math.round(hoursAgo * 10) / 10 : null };
      }
      return { ...s, hoursAgo: null };
    });
  }

  function filterRecent(storyList, label) {
    const tagged = tagRecency(storyList);

    // Hard cutoff: drop anything older than HARD_CUTOFF_HOURS
    const underCutoff = tagged.filter(s => s.hoursAgo === null || s.hoursAgo <= HARD_CUTOFF_HOURS);
    const hardDropped = tagged.length - underCutoff.length;

    // Sort newest first (null ages to end)
    underCutoff.sort((a, b) => {
      if (a.hoursAgo === null) return 1;
      if (b.hoursAgo === null) return -1;
      return a.hoursAgo - b.hoursAgo;
    });

    // Aging cap: limit stories between 12-18h to MAX_AGING_PER_BUCKET
    let agingCount = 0;
    let agingCapped = 0;
    let nullCount = 0;
    let nullCapped = 0;
    const result = underCutoff.filter(s => {
      // Cap null-date stories
      if (s.hoursAgo === null) {
        nullCount++;
        if (nullCount > MAX_NULL_DATE) { nullCapped++; return false; }
        return true;
      }
      // Cap aging stories (12-18h)
      if (s.hoursAgo > AGING_THRESHOLD_HOURS) {
        agingCount++;
        if (agingCount > MAX_AGING_PER_BUCKET) { agingCapped++; return false; }
      }
      return true;
    });

    // Log what happened
    const parts = [];
    if (hardDropped > 0) parts.push(`${hardDropped} dropped (>${HARD_CUTOFF_HOURS}h)`);
    if (agingCapped > 0) parts.push(`${agingCapped} aging capped (12-${HARD_CUTOFF_HOURS}h, max ${MAX_AGING_PER_BUCKET})`);
    if (nullCapped > 0) parts.push(`${nullCapped} null-date capped`);
    if (parts.length > 0) {
      console.log(`  ${label}: ${parts.join(', ')}`);
    } else {
      console.log(`  ${label}: all ${result.length} stories are fresh (<${AGING_THRESHOLD_HOURS}h)`);
    }

    return result;
  }

  console.log(`Applying recency filter (${HARD_CUTOFF_HOURS}h cutoff, ${AGING_THRESHOLD_HOURS}h aging cap)...`);
  const primaryStories = filterRecent(byPriority.primary || [], 'primary').slice(0, 15);
  const secondaryStories = filterRecent(byPriority.secondary || [], 'secondary').slice(0, 15);

  // Daybook stories: forward-looking event data from dedicated Google News
  // RSS queries. Passed separately so Claude uses them for "What to Watch".
  const daybookStories = (briefing.daybook || []).slice(0, 15);

  // Watch candidates: stories from primary/secondary feeds auto-tagged
  // with forward-looking signals (escalation, deadlines, consequences).
  // Supplements daybook with developing situations that have momentum.
  const watchCandidates = (briefing.watchCandidates || []).slice(0, 10);

  // Get screenshot headline data for editorial priority detection
  const screenshots = briefing.screenshots || [];

  // Build the editorial priority section from extracted headlines
  let headlineSignals = '';
  for (const s of screenshots) {
    if (s.topHeadlines && s.topHeadlines.length > 0) {
      headlineSignals += `\n${s.name} (${s.url}):\n`;
      for (const h of s.topHeadlines) {
        headlineSignals += `  - ${h}\n`;
      }
    }
  }

  // Load shared style rules from file (synced from nyt-concierge/style-rules-prompt.txt).
  // These are the universal rules enforced by validate-draft.js and fix-draft.js.
  const styleRulesPath = require('path').join(__dirname, 'style-rules-prompt.txt');
  const styleRules = fs.readFileSync(styleRulesPath, 'utf8').trim();

  const systemPrompt = `You are writing a morning news briefing for ${ownerName}, a journalist who covers international news.

Your job is to synthesize scraped headlines from major outlets into a concise, all-bullets briefing of the day's top international stories. Prioritize global (non-U.S.) coverage from AP, Reuters, BBC, WSJ, FT, and the Guardian.

${styleRules}

BRIEFING-SPECIFIC RULES:
1. EVERY bullet must be a complete sentence with at least one link.
2. NO prose or flowing paragraphs. Everything is bulleted.
3. International stories lead. US domestic politics is secondary unless it has global implications.
4. Vary attribution phrasing (use each pattern at most twice).
5. Keep it tight — Russell reads this on his phone at 6am.
6. Use standard markdown: "- " for bullets (not "•"), "**text**" for bold, "[text](url)" for links.
7. The briefing MUST begin with the line: "Good morning, Russell! Here's what happened while you were sleeping." (on its own line, before the first section header). This is NOT a bullet point — just a plain text greeting.
8. ACTIVELY SCAN for forward-looking language in stories: "scheduled for", "set to", "expected to", "will meet", "vote on", "summit begins", "deadline", "hearing", "ruling expected". Pull these into the What to Watch section.
9. LINK DIVERSITY: Spread links across at least 4 different source domains. No single domain should account for more than 30% of all links.
10. RECENCY: Each story has an "hoursAgo" field. Stories are pre-filtered to 18h max, with aging stories (12-18h) capped at 3 per source tier. Strongly prefer stories under 12 hours old for Top Stories. If a story's hoursAgo is >12, only include it if it is genuinely major breaking news with no fresher alternative.
11. ATTRIBUTION-URL BINDING: When you attribute a story to a source, the source name MUST match the domain of the URL you link. If you link to apnews.com, write "AP" not "Reuters". If you link to reuters.com, write "Reuters" not "Bloomberg". Each story in the data below has a "source" field — use it. Before finalizing each bullet, double-check: does my attribution match the link's domain?
12. ONE LINK PER BULLET: Each bullet should link to ONE primary source. Do not combine multiple non-NYT links in a single bullet — it creates attribution confusion and makes errors hard to catch.`;

  // Check if sleep filter data exists (from --cutoff run)
  const sleepFilter = briefing.sleepFilter || null;
  let sleepInstructions = '';
  if (sleepFilter) {
    sleepInstructions = `\n\nSLEEP FILTER ACTIVE (cutoff: ${sleepFilter.cutoffLocal}):
Stories have a "sleepStatus" field:
- "new" = published after Russell went to sleep, genuinely new (PRIORITIZE these)
- "flagged" = published after sleep but may rehash earlier coverage (use editorial judgment)
- "pre-sleep" = published before sleep (context only, lower priority)
Focus on "new" stories. Include "flagged" stories only if they represent genuine developments.`;
  }

  const userPrompt = `Good morning. Here are the scraped headlines and homepage data for today's briefing.${sleepInstructions}

Write an ALL-BULLETS briefing using ONLY these sections:

1. **Top Stories** (5-7 bullets): The biggest international stories. Use the homepage headlines below to determine editorial consensus — if multiple outlets lead with the same story, it goes first.

2. **Conflicts & Diplomacy** (3-5 bullets): Wars, peace talks, sanctions, diplomatic moves. Skip this section entirely if nothing notable.

3. **Business & Markets** (3-4 bullets): Global economic news, market moves, trade, corporate stories with international significance. Skip if nothing notable.

4. **Also Notable** (2-3 bullets): Important stories that do not fit above — climate, health, elections, cultural events with global significance. Skip if nothing notable.

5. **What to Watch** (2-4 bullets): Scheduled events AND developing situations with forward momentum expected to unfold in the coming days. Use BOTH the UPCOMING EVENTS (daybook) AND the WATCH CANDIDATES (auto-tagged developing stories) sections below. Prioritize stories with specific deadlines, escalation potential, or pending decisions. Skip entirely if neither data source has anything compelling.

Every bullet must have at least one link. Do NOT include a Sources section — the links within bullets are sufficient.

Do NOT write any prose paragraphs. Only section headers and bullet points.

HOMEPAGE HEADLINES (editorial priority signals — use these to judge what outlets are leading with):
${headlineSignals || '(No homepage headlines extracted this run)'}

PRIMARY STORIES (from Russell's priority sources: AP, Reuters, BBC, WSJ, FT, Guardian):
${JSON.stringify(primaryStories, null, 2)}

SECONDARY STORIES (wider net: NYT, Al Jazeera, France24, WSJ Markets):
${JSON.stringify(secondaryStories, null, 2)}

WATCH CANDIDATES (auto-tagged developing stories from main feeds — use alongside daybook for "What to Watch"):
${JSON.stringify(watchCandidates, null, 2)}

UPCOMING EVENTS (daybook — scheduled events for "What to Watch"):
${JSON.stringify(daybookStories, null, 2)}

Write the briefing now.`;

  return { systemPrompt, userPrompt };
}

// ============================================
// EDITOR PASS
// Lightweight second API call that catches grammar and style bugs
// the Writer misses: missing articles, 's contractions, "amid",
// awkward phrasing, tacked-on analysis clauses.
// Uses Haiku — cheap and fast, grammar doesn't need Sonnet.
// ============================================

// Editor system prompt — focused copy-edit, not a full rewrite
const EDITOR_SYSTEM_PROMPT = `You are a copy editor. Your ONLY job is to fix grammar and style errors in the news briefing below. You must return the COMPLETE corrected briefing — every bullet, every link, every section header.

FIX these issues:
1. Missing articles ("a", "an", "the") — e.g. "creating murky outlook" → "creating a murky outlook"
2. 's used as contraction for "is" or "has" — expand them. "China's planning" → "China is planning". Keep possessives: "China's economy" is fine.
3. The word "amid" — replace with "as", "during", "while", or "following"
4. Em-dash run-on sentences joining two independent clauses — split into separate sentences
5. Subject-verb agreement errors
6. Tacked-on analysis clauses: ", highlighting...", ", showing how...", ", underscoring...", ", suggesting that..." — delete the clause, end with the fact
7. Editorializing language: "saber-rattling", "reaching a crescendo", "makes diplomats nervous" — rewrite with facts

DO NOT:
- Change story selection or order
- Add or remove bullets
- Change link URLs or link text
- Rewrite sentences that are already correct
- Add commentary or notes — return ONLY the corrected briefing markdown`;

// ============================================
// LINK DIVERSITY ENFORCEMENT
// Code gate for Rule 16. Counts link domains in the Writer output.
// If any single domain exceeds 30% of all links, does ONE retry
// with explicit feedback telling the Writer which domains to diversify.
// ============================================

function analyzeLinkDiversity(markdown) {
  // Extract all markdown links: [text](url)
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  const domains = {};
  let total = 0;
  let match;

  while ((match = linkRegex.exec(markdown)) !== null) {
    try {
      const hostname = new URL(match[2]).hostname.replace(/^www\./, '');
      domains[hostname] = (domains[hostname] || 0) + 1;
      total++;
    } catch (e) { /* skip malformed URLs */ }
  }

  return { domains, total };
}

async function enforceLinkDiversity(draft, systemPrompt, userPrompt) {
  const { domains, total } = analyzeLinkDiversity(draft);
  const MAX_SHARE = 0.30;

  if (total === 0) return draft; // no links to check

  // Find domains that exceed 30%
  const violations = [];
  for (const [domain, count] of Object.entries(domains)) {
    const share = count / total;
    if (share > MAX_SHARE) {
      violations.push({ domain, count, share: (share * 100).toFixed(0) });
    }
  }

  // Log the distribution either way
  console.log(`\nLink diversity check (${total} links):`);
  const sorted = Object.entries(domains).sort((a, b) => b[1] - a[1]);
  for (const [domain, count] of sorted) {
    const pct = ((count / total) * 100).toFixed(0);
    const flag = (count / total) > MAX_SHARE ? ' ⚠ OVER 30%' : '';
    console.log(`  ${domain}: ${count}/${total} (${pct}%)${flag}`);
  }

  if (violations.length === 0) {
    console.log('  ✓ Diversity check passed');
    return draft;
  }

  // Build targeted retry prompt
  const violationDesc = violations
    .map(v => `${v.domain} has ${v.count}/${total} links (${v.share}%)`)
    .join(', ');
  const otherSources = ['theguardian.com', 'wsj.com', 'ft.com', 'aljazeera.com', 'france24.com', 'reuters.com']
    .filter(d => !violations.some(v => v.domain.includes(d.replace('.com', ''))))
    .join(', ');

  console.log(`\n  ⚠ Diversity violation: ${violationDesc}`);
  console.log('  Retrying with diversity feedback...');

  const diversityFeedback = `\n\nIMPORTANT CORRECTION: Your previous draft violated Rule 16 (link diversity). ${violationDesc}. No single domain should exceed 30% of links. Actively replace some of those links with coverage from ${otherSources}. The story data includes URLs from ALL of these sources — use them.`;

  try {
    const retryDraft = await callClaude(userPrompt + diversityFeedback, systemPrompt);

    // Check if retry actually improved things
    const retry = analyzeLinkDiversity(retryDraft);
    const stillBad = Object.entries(retry.domains).some(([_, c]) => c / retry.total > MAX_SHARE);

    if (stillBad) {
      console.log('  ⚠ Retry still has diversity issues — using retry anyway (closer to target)');
    } else {
      console.log('  ✓ Retry passed diversity check');
    }

    // Log retry distribution
    for (const [domain, count] of Object.entries(retry.domains).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${domain}: ${count}/${retry.total} (${((count / retry.total) * 100).toFixed(0)}%)`);
    }

    return retryDraft;
  } catch (e) {
    console.warn('  Diversity retry failed — using original draft:', e.message);
    return draft;
  }
}

function callClaudeEditor(draft) {
  const userPrompt = `Copy-edit this briefing. Return the full corrected markdown — nothing else.\n\n${draft}`;
  // Reuses the same callClaude function and model (Sonnet).
  // Tried Haiku but the model ID isn't available on this API key.
  // Cost delta for one short edit pass per day is negligible.
  return callClaude(userPrompt, EDITOR_SYSTEM_PROMPT);
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('Reading briefing.json...');

  if (!fs.existsSync('briefing.json')) {
    console.error('briefing.json not found. Run generate-briefing.js first.');
    process.exit(1);
  }

  const briefing = JSON.parse(fs.readFileSync('briefing.json', 'utf8'));

  console.log(`Found ${briefing.stats?.totalStories || 0} stories`);
  console.log('');

  // Build prompt
  const { systemPrompt, userPrompt } = buildPrompt(briefing);

  // ---- Step 1: Writer (Sonnet) ----
  console.log('Calling Claude API (Writer)...');
  const writerStart = Date.now();

  let briefingText;
  try {
    briefingText = await callClaude(userPrompt, systemPrompt);
    const elapsed = ((Date.now() - writerStart) / 1000).toFixed(1);
    console.log(`Writer responded in ${elapsed}s`);
  } catch (e) {
    console.error('Writer failed:', e.message);
    process.exit(1);
  }

  // ---- Step 1b: Link diversity check ----
  // Code gate for Rule 16. If any single domain > 30% of links,
  // retry once with explicit feedback. Prose rules alone don't work.
  briefingText = await enforceLinkDiversity(briefingText, systemPrompt, userPrompt);

  // ---- Step 2: Editor pass (Haiku) ----
  // Catches grammar bugs the Writer misses: missing articles,
  // 's contractions, "amid", tacked-on analysis, etc.
  console.log('Running editor pass...');
  const editorStart = Date.now();

  let editedText;
  try {
    editedText = await callClaudeEditor(briefingText);
    const elapsed = ((Date.now() - editorStart) / 1000).toFixed(1);
    console.log(`Editor responded in ${elapsed}s`);

    // Sanity check: editor should return something roughly the same length.
    // If it's wildly different (< 50% or > 200% of original), something went
    // wrong — fall back to the Writer's draft.
    const ratio = editedText.length / briefingText.length;
    if (ratio < 0.5 || ratio > 2.0) {
      console.warn(`Editor output length ratio ${ratio.toFixed(2)} is suspicious — using Writer draft`);
      editedText = briefingText;
    }
  } catch (e) {
    // Editor is non-critical — if it fails, use the Writer's draft as-is
    console.warn('Editor pass failed (using Writer draft):', e.message);
    editedText = briefingText;
  }

  // Save markdown
  fs.writeFileSync('briefing.md', editedText);
  console.log('Saved briefing.md');

  // Save HTML
  const htmlContent = generateHTML(editedText, briefing);
  fs.writeFileSync('index.html', htmlContent);
  console.log('Saved index.html');

  console.log('');
  console.log('Done');
}

main();
