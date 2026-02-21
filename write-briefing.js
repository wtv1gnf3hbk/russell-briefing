#!/usr/bin/env node
/**
 * Calls Claude API to write an all-bullets briefing from briefing.json
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

function callClaude(prompt, systemPrompt = '') {
  return new Promise((resolve, reject) => {
    const messages = [{ role: 'user', content: prompt }];

    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
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

  return { dateStr, timeStr, tzAbbr, full: `${dateStr} at ${timeStr} ${tzAbbr}` };
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

  const primaryStories = (byPriority.primary || []).slice(0, 15);
  const secondaryStories = (byPriority.secondary || []).slice(0, 15);

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

  const systemPrompt = `You are writing a morning news briefing for ${ownerName}, a journalist who covers international news.

Your job is to synthesize scraped headlines from major outlets into a concise, all-bullets briefing of the day's top international stories. Prioritize global (non-U.S.) coverage from AP, Reuters, BBC, WSJ, FT, and the Guardian.

CRITICAL RULES:
1. NEVER use the word "amid" — find a better way to connect ideas.
2. Link text must be MAX 3 WORDS.
   - GOOD: "Ukraine [rejected the](url) ceasefire proposal"
   - BAD: "[Ukraine rejects latest Russian ceasefire proposal](url)"
3. NEVER use 's as a contraction for "is" or "has" — only use 's for possessives.
   - BAD: "China's planning" -> GOOD: "China is planning"
   - OK: "China's economy" (possessive)
4. EVERY bullet must be a complete sentence with at least one link.
5. NEVER use em-dashes to join independent clauses. Write separate sentences instead.
6. NO prose or flowing paragraphs. Everything is bulleted.
7. NO editorializing. No "saber-rattling," "reaching a crescendo," "makes diplomats nervous." Report facts.
8. International stories lead. US domestic politics is secondary unless it has global implications.
9. Vary attribution: "Reuters reports", "according to the BBC", "the Guardian notes", "per the FT" (use each pattern at most twice).
10. Keep it tight — Russell reads this on his phone at 6am.
11. Use standard markdown: "- " for bullets (not "•"), "**text**" for bold, "[text](url)" for links.
12. The briefing MUST begin with the line: "Good morning, Russell! Here's what happened while you were sleeping." (on its own line, before the first section header). This is NOT a bullet point — just a plain text greeting.`;

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

Every bullet must have at least one link. Do NOT include a Sources section — the links within bullets are sufficient.

Do NOT write any prose paragraphs. Only section headers and bullet points.

HOMEPAGE HEADLINES (editorial priority signals — use these to judge what outlets are leading with):
${headlineSignals || '(No homepage headlines extracted this run)'}

PRIMARY STORIES (from Russell's priority sources: AP, Reuters, BBC, WSJ, FT, Guardian):
${JSON.stringify(primaryStories, null, 2)}

SECONDARY STORIES (wider net: NYT, Al Jazeera, France24, WSJ Markets):
${JSON.stringify(secondaryStories, null, 2)}

Write the briefing now.`;

  return { systemPrompt, userPrompt };
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

  console.log('Calling Claude API...');
  const startTime = Date.now();

  try {
    const briefingText = await callClaude(userPrompt, systemPrompt);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Claude responded in ${elapsed}s`);

    // Save markdown
    fs.writeFileSync('briefing.md', briefingText);
    console.log('Saved briefing.md');

    // Save HTML
    const htmlContent = generateHTML(briefingText, briefing);
    fs.writeFileSync('index.html', htmlContent);
    console.log('Saved index.html');

    console.log('');
    console.log('Done');

  } catch (e) {
    console.error('Failed to write briefing:', e.message);
    process.exit(1);
  }
}

main();
