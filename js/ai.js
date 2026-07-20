// ============================================================================
// ai.js — optional AI assistants (Gemini = raw-stats researcher,
//         Claude = pick reviewer). The Poisson/Dixon-Coles engine remains
//         the ONLY source of probabilities; the AIs never output a BTTS %.
//
// API keys live in their own localStorage key, separate from the app state,
// so they are NEVER included in backup exports. Keys stay in this browser.
// ============================================================================

const AI_KEYS_STORAGE = 'pools_ai_keys_v1';

function loadAiKeys() {
  try {
    return JSON.parse(localStorage.getItem(AI_KEYS_STORAGE)) || { gemini: '', claude: '' };
  } catch { return { gemini: '', claude: '' }; }
}

function saveAiKeys(keys) {
  localStorage.setItem(AI_KEYS_STORAGE, JSON.stringify({
    gemini: keys.gemini || '', claude: keys.claude || '',
  }));
}

/** Strip markdown code fences and find the outermost JSON object. */
function extractJSON(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

// ----------------------------------------------------------------------
// GEMINI — raw venue-split stats researcher (with Google Search grounding)
// ----------------------------------------------------------------------
const GEMINI_MODEL = 'gemini-3-flash-preview';

const GEMINI_SYSTEM = `You are a football statistics research assistant. For each fixture listed, use web search to find CURRENT-season venue-split stats. Return ONLY raw numbers — NEVER a BTTS percentage, probability, prediction or verdict of any kind.

For each fixture return an object with:
- "match_no": the number given
- "fixture": "Home Team v Away Team"
- "league": full league name (e.g. "Allsvenskan", "Norwegian Eliteserien")
- "n": matches played (home team at home; if home/away counts differ, use the smaller)
- "hgf": home team AVERAGE goals scored PER HOME GAME this season
- "hga": home team average goals conceded per home game
- "agf": away team average goals scored PER AWAY GAME this season
- "aga": away team average goals conceded per away game
- "runaway": 1 if either side is a runaway leader or mathematically settled with nothing to play for, else 0
- "source": short note of where the numbers came from (e.g. "SoccerStats", "FBref")

Preferred sources: SoccerStats venue tables, FBref, FotMob, WinDrawWin. If totals are given instead of per-game averages, divide by matches played. If you cannot find reliable venue-split data for a fixture, set its four stat fields to null and add a "note" explaining why.

Respond with ONLY valid JSON, no prose: {"matches":[ ... ]}`;

async function geminiFetchStats(fixtureLines, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    system_instruction: { parts: [{ text: GEMINI_SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: `Fixtures to research (today is ${new Date().toDateString()}):\n${fixtureLines}` }] }],
    tools: [{ google_search: {} }],
    // Gemini 3: keep temperature at default 1.0; use thinkingLevel for depth
    generationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Gemini API ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p.text || '').join('');
  if (!text) throw new Error('Gemini returned an empty response.');
  const parsed = extractJSON(text);
  if (!Array.isArray(parsed.matches) || parsed.matches.length === 0) {
    throw new Error('Gemini response had no "matches" array.');
  }
  return parsed;
}

// ----------------------------------------------------------------------
// GEMINI — coupon screenshot reader (vision). Turns a Lottotech coupon PNG
// into "| no | home | away |" lines for the auto-match box. No stats, no
// verdicts — pure transcription.
// ----------------------------------------------------------------------
const GEMINI_OCR_SYSTEM = `You transcribe football pool coupon screenshots (e.g. Lottotech Goal Rush / Classic Pools fixture lists). Extract EVERY fixture row visible: match number, home team, away team.

Respond with ONLY lines in exactly this format, one per fixture, nothing else — no headers, no code fences, no commentary:
| 01 | Home Team | Away Team |

Rules: keep team names exactly as printed (including abbreviations); preserve the printed match numbers; if a number is missing, count sequentially; if a row is genuinely unreadable, skip it. Do NOT add stats, odds, dates or predictions.`;

async function geminiReadCoupon(base64Data, mimeType, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    system_instruction: { parts: [{ text: GEMINI_OCR_SYSTEM }] },
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: mimeType, data: base64Data } },
        { text: 'Transcribe all fixtures from this coupon image.' },
      ],
    }],
    // pure transcription — no deep reasoning needed, keep it fast/cheap
    generationConfig: { thinkingConfig: { thinkingLevel: 'minimal' } },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Gemini API ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini returned an empty response.');
  // keep only lines that look like fixture rows
  const rows = text.split('\n').map(l => l.trim()).filter(l => /^\|.+\|.+\|/.test(l));
  if (rows.length === 0) throw new Error('Gemini could not find any fixture rows in the image.');
  return rows.join('\n');
}

// ----------------------------------------------------------------------
// CLAUDE — qualitative reviewer of the engine's picks (never re-computes P)
// ----------------------------------------------------------------------
const CLAUDE_MODEL = 'claude-sonnet-5';

const CLAUDE_SYSTEM = `You review football pool picks produced by a deterministic Poisson/Dixon-Coles engine. The engine's probabilities are the source of truth — do NOT produce your own probabilities or percentages, and do not second-guess the maths.

Your job is purely qualitative risk review. Use web search to check, for each picked fixture:
- key injuries or suspensions (especially attackers/keepers)
- cup or continental rotation risk, fixture congestion
- managerial change, dressing-room turmoil, motivation (dead rubber, must-win, derby)
- postponement/venue/weather concerns
- data concerns the engine can't see (promoted team, tiny sample, recent form collapse)

For each pick output one line: verdict KEEP / CAUTION / RECONSIDER — followed by a 1–2 sentence reason with the concrete fact found (or "no red flags found"). Finish with a short overall comment on the slip. Plain text, no markdown tables, no probabilities.`;

async function claudeReviewPicks(reviewText, apiKey) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system: CLAUDE_SYSTEM,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
      messages: [{ role: 'user', content: `Today is ${new Date().toDateString()}.\n${reviewText}` }],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Claude API ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!text) throw new Error('Claude returned an empty response.');
  return text;
}

export { loadAiKeys, saveAiKeys, geminiFetchStats, geminiReadCoupon, claudeReviewPicks, GEMINI_MODEL, CLAUDE_MODEL };
