'use strict';
// ─── BULLYLAND ANALYTICS DASHBOARD ───────────────────────────────────────────
// Lightweight Express server that serves a psychology/audience analytics page.
// Reads directly from the SQLite DB — always current, no extra service needed.
//
// Setup:
//   1. npm install express
//   2. Set DASHBOARD_PASSWORD in your .env / Railway variables
//   3. The dashboard is available at:  https://your-railway-url.up.railway.app/
//
// Railway automatically exposes the PORT env var — no extra config needed.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');

// ─── ARCHETYPE → AUDIENCE INTELLIGENCE ───────────────────────────────────────
// Each archetype maps to plain-English audience insights and content strategy tips.
const ARCHETYPE_INTEL = {
  'Comfort Seeker': {
    emoji: '🫂',
    color: '#6c8ebf',
    headline: 'They come here to feel something.',
    audience: 'These are your most emotionally invested fans. They follow you because your content makes them feel seen, safe, or understood. They\'re not just watching — they\'re connecting.',
    buys: 'They buy from people they feel emotionally attached to. A personal story, a moment of vulnerability, or a "this made me think of you" post will convert them far faster than any sale.',
    content: [
      'Behind-the-scenes moments — the real, unfiltered ones',
      'Personal stories that show vulnerability or growth',
      'Community moments where they feel included',
      'Content that says "I see you" directly to them',
    ],
    avoid: 'Hard sells, purely hype-based content, or anything that feels transactional.',
  },
  'Social Magnet': {
    emoji: '⚡',
    color: '#f0a500',
    headline: 'They want to be where the energy is.',
    audience: 'High-energy, socially driven audience members. They thrive on hype, trends, and being part of something that feels exclusive or popular. They\'re your amplifiers — when they\'re excited, they share.',
    buys: 'They buy when something feels like a cultural moment. Limited drops, exclusive items, and anything with social proof ("everyone wants this") triggers them.',
    content: [
      'Hype posts — new drops, announcements, countdowns',
      'Exclusive or limited access content',
      'Anything trending or culturally relevant',
      'Call-outs, challenges, or anything they can participate in publicly',
    ],
    avoid: 'Slow, reflective content. They tune out when the energy drops.',
  },
  'Chaotic Spirit': {
    emoji: '🌀',
    color: '#e74c3c',
    headline: 'They\'re here for the chaos and the comedy.',
    audience: 'These are your most unpredictable fans — they show up for the entertainment, the laughs, and the unexpected. They hate routine and love when you do something surprising.',
    buys: 'Impulse buyers. A funny post, a random drop, or a "why not" moment gets them. They don\'t need to be convinced — they need to be entertained.',
    content: [
      'Unplanned, raw, chaotic content — the less polished the better',
      'Humor, roasts, and self-aware posts',
      'Random drops or surprise reveals',
      'Content that breaks the fourth wall',
    ],
    avoid: 'Overly serious or structured content. They lose interest fast when things get too corporate.',
  },
  'Loyal at Heart': {
    emoji: '🤝',
    color: '#2ecc71',
    headline: 'They\'re not going anywhere.',
    audience: 'Your most dependable audience segment. These are the people who\'ve been here from near the start, who defend you in comments, and who show up consistently regardless of algorithm or trends.',
    buys: 'They buy because they believe in you personally, not just the product. Loyalty programs, early access, and anything that rewards their dedication will convert extremely well.',
    content: [
      'Acknowledgment — shout them out, notice their loyalty',
      'Exclusive content for "OG" or long-time fans',
      'Transparency about your journey and process',
      'Content that makes them feel like insiders',
    ],
    avoid: 'Anything that feels like you\'re chasing a new audience at the expense of them.',
  },
  'Bold & Direct': {
    emoji: '🔥',
    color: '#e67e22',
    headline: 'They respect confidence and cut the noise.',
    audience: 'No-nonsense audience members who respond to directness, confidence, and clarity. They don\'t want to be coddled — they want straight talk and real opinions.',
    buys: 'They buy when the pitch is direct and the value is obvious. Clear calls to action, no fluff.',
    content: [
      'Strong opinions, hot takes, or "unpopular truth" content',
      'Direct, no-nonsense product posts — what it is, why it\'s worth it',
      'Confidence-forward content — you being unfiltered',
      'Debates or "I said what I said" moments',
    ],
    avoid: 'Wishy-washy language, over-apologizing, or content that feels uncertain.',
  },
  'Deeply Sentimental': {
    emoji: '💙',
    color: '#3498db',
    headline: 'Memory and nostalgia move them.',
    audience: 'Emotionally deep audience members who respond to authenticity, memory, and meaning. They think about the past, care about legacy, and want content that matters.',
    buys: 'They buy things that feel meaningful or that represent something — not just objects, but symbols. Storytelling in your product descriptions will carry enormous weight with this group.',
    content: [
      '"Where it all started" type content — origin stories',
      'Throwbacks, milestones, and reflection posts',
      'Content about your values, what you\'re building, and why',
      'Heartfelt acknowledgments of the journey',
    ],
    avoid: 'Content that feels hollow or purely commercial without emotional grounding.',
  },
  'Social Observer': {
    emoji: '👁️',
    color: '#9b59b6',
    headline: 'They\'re watching everything and saying nothing.',
    audience: 'Your silent majority. They consume far more than they comment, but they\'re paying attention to everything. Don\'t mistake their silence for disengagement — they\'re fully in.',
    buys: 'They need to feel like buying is their own decision, not that they were sold to. Social proof (seeing others buy) and subtle "this is for you" content converts them.',
    content: [
      'Observations about culture, trends, or social dynamics',
      'Content that feels like an inside joke or shared understanding',
      '"Did you notice…" or commentary-style posts',
      'Anything that makes them feel smart for following you',
    ],
    avoid: 'High-pressure sales or anything that feels pushy. They\'ll back away.',
  },
  'Emotionally Aware': {
    emoji: '💜',
    color: '#8e44ad',
    headline: 'They\'re tuned in to the energy behind everything.',
    audience: 'Highly perceptive, introspective audience members who can read between the lines. They appreciate depth, nuance, and content that respects their intelligence.',
    buys: 'They research before buying and respond to authenticity above everything. Fake energy, forced enthusiasm, or overly polished content reads as dishonest to them.',
    content: [
      'Depth over surface-level content — go beyond the obvious take',
      'Honest reflections on growth, mistakes, and change',
      'Content that acknowledges complexity rather than simplifying everything',
      'Real conversations, not performances',
    ],
    avoid: 'Anything that feels performative or manufactured.',
  },
  'Spontaneous Spirit': {
    emoji: '🎲',
    color: '#1abc9c',
    headline: 'They live for the unexpected.',
    audience: 'Excitement-seeking, variety-loving fans who engage most when they don\'t know what\'s coming. Routine kills their interest. Surprise keeps them coming back.',
    buys: 'Flash sales, mystery items, and limited-time anything. The less predictable the offer, the more attracted they are to it.',
    content: [
      'Spontaneous posts — no pattern, no schedule, just energy',
      'Mystery drops and surprise reveals',
      'Collaborations with unexpected people',
      'Breaking your own format — do the opposite of what you always do',
    ],
    avoid: 'A predictable content calendar. They crave variety.',
  },
  'Self-Aware Reflector': {
    emoji: '🪞',
    color: '#7f8c8d',
    headline: 'They\'re on a personal growth journey.',
    audience: 'Thoughtful, introspective audience members who engage most with content that mirrors their inner life. They\'re drawn to people who are honest about their own growth.',
    buys: 'They invest in things that align with who they\'re becoming. Position your brand around identity and growth — "this is for the version of you that has it together."',
    content: [
      'Honest posts about personal development and self-improvement',
      'Content that validates the journey, not just the destination',
      '"I used to…" or growth arc content',
      'Questions that make them think about themselves',
    ],
    avoid: 'Content that glorifies perfection or makes success look effortless.',
  },
  'Open Book': {
    emoji: '📖',
    color: '#95a5a6',
    headline: 'Still forming — watch how they grow.',
    audience: 'Newer community members whose patterns haven\'t fully emerged yet. They\'re absorbing the community culture and haven\'t landed on a dominant engagement style.',
    buys: 'Give them time. Their buying triggers will become clear as they interact more.',
    content: [
      'Broad, welcoming content that doesn\'t assume too much',
      'Onboarding-style posts that show them what\'s possible',
    ],
    avoid: 'Nothing specific yet — keep the range wide.',
  },
};

// ─── CATEGORY → CONTENT INSIGHT ───────────────────────────────────────────────
const CATEGORY_INTEL = {
  emotional_comfort:        'They want to feel safe and understood. Warmth and reassurance in your content will land.',
  emotional_safety:         'Trust is everything to these users. Consistency and authenticity build your hold on them.',
  loneliness:               'Your community is filling a real void for these users. Community-first content has outsized impact.',
  attention_triggers:       'This segment wants to be seen. Shout-outs, mentions, and audience-focused content drives their loyalty.',
  attraction:               'Aesthetic and image-conscious content performs well. Visual quality and style matter to this group.',
  social_energy:            'Hype-driven content and community energy keep this group engaged.',
  boredom:                  'Entertainment is the hook. If it\'s not engaging in 3 seconds, you\'ve lost them.',
  chaos_vs_stability:       'These users are thinking about structure vs. freedom. Authentic and unfiltered content resonates.',
  humor:                    'Comedy is a direct path to their loyalty. Don\'t be afraid to be funny and self-aware.',
  trust:                    'They need to believe in you before they\'ll buy from you. Consistency over time is your biggest asset.',
  interpersonal_values:     'Relationships and character matter to them. Show who you are as a person.',
  conflict:                 'Bold opinions and directness earn their respect. Don\'t soften everything.',
  confidence:               'They\'re drawn to people who own their identity without apology.',
  validation:               'Acknowledging your audience\'s experience and perspective builds deep connection.',
  memory_nostalgia:         'Throwbacks, origin stories, and milestone content hits hard with this group.',
  social_dynamics:          'Content about culture, trends, and group behavior gets engagement.',
  communication_style:      'How you say things matters as much as what you say. Voice and tone are crucial.',
  emotional_intelligence:   'Depth and nuance in your content earns outsized respect from this segment.',
  insecurity:               'Vulnerability and honesty about your own struggles builds exceptional loyalty.',
  personality_preference:   'Authenticity and individuality are their filters. Be yourself — loudly.',
  lifestyle_preferences:    'Aspirational content showing your actual lifestyle converts well.',
  routine:                  'Consistency and ritual-building keeps this group coming back.',
};

// ─── TONE → CONTENT INSIGHT ───────────────────────────────────────────────────
const TONE_INTEL = {
  funny:                   'Comedy works. Lean into humor without overthinking it.',
  reflective:              'Your audience rewards depth. Give them something real to think about.',
  chaotic:                 'Unpredictability is your asset. Don\'t over-plan — let some content breathe.',
  playful:                 'Lighthearted content keeps the community energy high.',
  observational:           'Your audience appreciates sharp takes on everyday things.',
  comforting:              'Warmth and reassurance create genuine emotional bonds.',
  dramatic:                'Your audience loves a story arc. Build tension, deliver the payoff.',
  socially_analytical:     'Thoughtful commentary on culture and trends establishes authority.',
  hypothetical:            'Thought experiment content drives engagement and shares.',
  personality_based:       'Personality-forward content is your brand. Show more of yourself.',
  relationship_oriented:   'Relationship dynamics are catnip for your audience. Mine that.',
  emotionally_intelligent: 'Nuanced, emotionally aware content earns disproportionate respect.',
  gossip_style:            'Entertaining, informal storytelling keeps your audience hooked.',
  girl_group_chat:         'Relatable, community-driven content builds belonging and loyalty.',
  toxic:                   'Provocative content drives engagement — use intentionally.',
};

// ─── HTML TEMPLATE ─────────────────────────────────────────────────────────────
function buildHTML(data) {
  const {
    totalUsers, totalResponses, archetypes, topCategories, topTones,
    dominantArchetype, dominantCategory, dominantTone, contentStrategy,
  } = data;

  const archetypeCards = archetypes.map(a => {
    const intel = ARCHETYPE_INTEL[a.archetype] || ARCHETYPE_INTEL['Open Book'];
    const pct = totalUsers > 0 ? Math.round((a.count / totalUsers) * 100) : 0;
    return `
      <div class="card archetype-card" style="border-left: 4px solid ${intel.color}">
        <div class="card-header">
          <span class="emoji">${intel.emoji}</span>
          <div>
            <h3>${a.archetype}</h3>
            <span class="badge" style="background:${intel.color}20;color:${intel.color}">${a.count} user${a.count!==1?'s':''} · ${pct}%</span>
          </div>
        </div>
        <p class="headline">"${intel.headline}"</p>
        <div class="intel-grid">
          <div class="intel-block">
            <div class="intel-label">👥 Who they are</div>
            <p>${intel.audience}</p>
          </div>
          <div class="intel-block">
            <div class="intel-label">💳 How they buy</div>
            <p>${intel.buys}</p>
          </div>
        </div>
        <div class="intel-block">
          <div class="intel-label">🎯 Content that converts them</div>
          <ul>${intel.content.map(c => `<li>${c}</li>`).join('')}</ul>
        </div>
        <div class="intel-block warn">
          <div class="intel-label">⚠️ What to avoid</div>
          <p>${intel.avoid}</p>
        </div>
      </div>`;
  }).join('');

  const catRows = topCategories.slice(0, 12).map(c => {
    const intel = CATEGORY_INTEL[c.category] || 'High engagement topic.';
    const cleanName = c.category.replace(/_/g, ' ');
    return `
      <tr>
        <td class="cat-name">${cleanName}</td>
        <td><div class="bar-wrap"><div class="bar" style="width:${Math.round(c.total/topCategories[0].total*100)}%;background:#c9a84c"></div></div></td>
        <td class="count">${c.total}</td>
        <td class="insight">${intel}</td>
      </tr>`;
  }).join('');

  const toneRows = topTones.slice(0, 10).map(t => {
    const intel = TONE_INTEL[t.tone] || 'Resonant tone with your audience.';
    return `
      <tr>
        <td class="cat-name">${t.tone}</td>
        <td><div class="bar-wrap"><div class="bar" style="width:${Math.round(t.total/topTones[0].total*100)}%;background:#9b59b6"></div></div></td>
        <td class="count">${t.total}</td>
        <td class="insight">${intel}</td>
      </tr>`;
  }).join('');

  const strategyItems = contentStrategy.map(s => `<li>✦ ${s}</li>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BULLYLAND — Audience Intelligence</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0e0e0e; --surface: #161616; --surface2: #1e1e1e; --border: #2a2a2a;
    --gold: #c9a84c; --text: #e8e8e8; --muted: #888; --accent: #c9a84c;
  }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.6; padding: 0 0 60px; }
  a { color: var(--gold); }

  .topbar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 18px 32px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 10; }
  .topbar h1 { font-size: 18px; font-weight: 700; letter-spacing: 0.05em; color: var(--gold); }
  .topbar .meta { color: var(--muted); font-size: 12px; }
  .refresh-note { font-size: 11px; color: var(--muted); }

  .container { max-width: 1200px; margin: 0 auto; padding: 32px 24px; }

  .stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 40px; }
  .stat-box { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; text-align: center; }
  .stat-box .val { font-size: 32px; font-weight: 700; color: var(--gold); }
  .stat-box .lbl { color: var(--muted); font-size: 12px; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.08em; }

  .section { margin-bottom: 48px; }
  .section-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted); margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 10px; }

  .strategy-box { background: linear-gradient(135deg, #1a1206, #161616); border: 1px solid #3a2e10; border-radius: 12px; padding: 28px 32px; margin-bottom: 40px; }
  .strategy-box h2 { color: var(--gold); font-size: 16px; margin-bottom: 6px; }
  .strategy-box .sub { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
  .strategy-box ul { list-style: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 10px; }
  .strategy-box li { color: var(--text); padding: 10px 14px; background: #1e1a0e; border-radius: 8px; border: 1px solid #2e2508; font-size: 13px; }

  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 20px; }
  .archetype-card { background: var(--surface2); }
  .card-header { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 14px; }
  .card-header .emoji { font-size: 28px; line-height: 1; }
  .card-header h3 { font-size: 17px; font-weight: 700; color: var(--text); }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; margin-top: 4px; }
  .headline { color: var(--muted); font-style: italic; font-size: 13px; margin-bottom: 18px; padding: 10px 14px; background: var(--bg); border-radius: 8px; border-left: 3px solid var(--border); }
  .intel-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  @media (max-width: 680px) { .intel-grid { grid-template-columns: 1fr; } }
  .intel-block { background: var(--bg); border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
  .intel-block:last-child { margin-bottom: 0; }
  .intel-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin-bottom: 8px; }
  .intel-block p { color: #ccc; font-size: 13px; }
  .intel-block ul { list-style: none; }
  .intel-block li { color: #ccc; font-size: 13px; padding: 3px 0; padding-left: 14px; position: relative; }
  .intel-block li::before { content: '→'; position: absolute; left: 0; color: var(--gold); font-size: 11px; top: 5px; }
  .intel-block.warn { background: #1a0f0f; border: 1px solid #2e1212; }
  .intel-block.warn .intel-label { color: #c0392b; }
  .intel-block.warn p { color: #c0392b; font-size: 12px; }

  .table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 12px 16px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); border-bottom: 1px solid var(--border); }
  td { padding: 10px 16px; border-bottom: 1px solid #1e1e1e; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #1a1a1a; }
  .cat-name { font-weight: 600; font-size: 13px; white-space: nowrap; text-transform: capitalize; min-width: 160px; }
  .bar-wrap { width: 160px; background: #1e1e1e; border-radius: 4px; height: 8px; }
  .bar { height: 8px; border-radius: 4px; transition: width 0.3s; }
  .count { color: var(--muted); font-size: 12px; white-space: nowrap; text-align: right; padding-right: 20px; }
  .insight { color: #aaa; font-size: 12px; max-width: 400px; }

  .empty { text-align: center; padding: 60px 24px; color: var(--muted); }
  .empty p { margin-top: 8px; font-size: 13px; }

  footer { text-align: center; color: var(--muted); font-size: 11px; padding: 32px; }
</style>
</head>
<body>
<div class="topbar">
  <h1>🎨 BULLYLAND — Audience Intelligence</h1>
  <div>
    <div class="meta">${totalUsers} profiled users · ${totalResponses} total responses</div>
    <div class="refresh-note">Auto-refreshes every 5 minutes</div>
  </div>
</div>
<div class="container">

  <div class="stat-row">
    <div class="stat-box"><div class="val">${totalUsers}</div><div class="lbl">Profiled Users</div></div>
    <div class="stat-box"><div class="val">${totalResponses}</div><div class="lbl">Total Responses</div></div>
    <div class="stat-box"><div class="val">${archetypes.length}</div><div class="lbl">Distinct Archetypes</div></div>
    <div class="stat-box"><div class="val">${dominantArchetype || '—'}</div><div class="lbl">Dominant Archetype</div></div>
  </div>

  ${contentStrategy.length ? `
  <div class="strategy-box">
    <h2>🧭 Content Strategy — What Your Data Is Telling You</h2>
    <p class="sub">Derived from your audience's response patterns. These are not guesses.</p>
    <ul>${strategyItems}</ul>
  </div>` : ''}

  <div class="section">
    <div class="section-title">🧠 Audience Archetypes — Who Your Community Actually Is</div>
    ${archetypes.length ? archetypeCards : `<div class="empty"><strong>No psychology data yet.</strong><p>Data builds as users respond to daily questions. Come back after a few days of posts.</p></div>`}
  </div>

  <div class="section">
    <div class="section-title">📌 Topic Resonance — What Gets Them Talking</div>
    ${topCategories.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Topic</th><th>Engagement</th><th>#</th><th>What it means</th></tr></thead>
      <tbody>${catRows}</tbody>
    </table></div>` : `<div class="empty"><strong>No topic data yet.</strong></div>`}
  </div>

  <div class="section">
    <div class="section-title">🎭 Tone Resonance — What Energy Lands Best</div>
    ${topTones.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Tone</th><th>Engagement</th><th>#</th><th>What it means</th></tr></thead>
      <tbody>${toneRows}</tbody>
    </table></div>` : `<div class="empty"><strong>No tone data yet.</strong></div>`}
  </div>

</div>
<footer>BULLYLAND Analytics · Private · Data from live database · Refreshes automatically</footer>
<script>setTimeout(() => location.reload(), 5 * 60 * 1000);</script>
</body>
</html>`;
}

// ─── DATA BUILDER ─────────────────────────────────────────────────────────────
function buildAnalyticsData(db) {
  // Archetype distribution
  const archetypes = db.prepare(`
    SELECT archetype, COUNT(*) as count
    FROM dq_psychology
    WHERE archetype IS NOT NULL
    GROUP BY archetype
    ORDER BY count DESC
  `).all();

  const totalUsers     = db.prepare('SELECT COUNT(*) as c FROM dq_psychology').get()?.c ?? 0;
  const totalResponses = db.prepare('SELECT COUNT(*) as c FROM dq_responses').get()?.c ?? 0;

  // Aggregate category counts across all users
  const psychRows    = db.prepare('SELECT cat_counts FROM dq_psychology').all();
  const catTotals    = {};
  for (const row of psychRows) {
    try {
      const counts = JSON.parse(row.cat_counts || '{}');
      for (const [cat, n] of Object.entries(counts)) {
        catTotals[cat] = (catTotals[cat] || 0) + n;
      }
    } catch (_) {}
  }
  const topCategories = Object.entries(catTotals)
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total);

  // Aggregate tone counts across all users
  const toneTotals = {};
  for (const row of psychRows) {
    try {
      const counts = JSON.parse(row.tone_counts || '{}');
      for (const [tone, n] of Object.entries(counts)) {
        toneTotals[tone] = (toneTotals[tone] || 0) + n;
      }
    } catch (_) {}
  }
  const topTones = Object.entries(toneTotals)
    .map(([tone, total]) => ({ tone, total }))
    .sort((a, b) => b.total - a.total);

  const dominantArchetype = archetypes[0]?.archetype || null;
  const dominantCategory  = topCategories[0]?.category?.replace(/_/g, ' ') || null;
  const dominantTone      = topTones[0]?.tone || null;

  // Generate plain-English content strategy from top signals
  const contentStrategy = [];
  const da  = ARCHETYPE_INTEL[dominantArchetype];
  if (da && da.content.length) {
    contentStrategy.push(`Your dominant archetype is **${dominantArchetype}** (${archetypes[0]?.count} users). ${da.headline} ${da.buys}`);
    da.content.slice(0, 2).forEach(c => contentStrategy.push(c));
  }
  if (dominantCategory && CATEGORY_INTEL[dominantCategory.replace(/ /g,'_')]) {
    contentStrategy.push(`Top topic engagement: **${dominantCategory}** — ${CATEGORY_INTEL[dominantCategory.replace(/ /g,'_')]}`);
  }
  if (dominantTone && TONE_INTEL[dominantTone]) {
    contentStrategy.push(`Top tone: **${dominantTone}** — ${TONE_INTEL[dominantTone]}`);
  }
  if (archetypes.length >= 2) {
    const second = ARCHETYPE_INTEL[archetypes[1]?.archetype];
    if (second) contentStrategy.push(`Secondary segment: **${archetypes[1].archetype}** (${archetypes[1].count} users) — ${second.buys}`);
  }

  return { totalUsers, totalResponses, archetypes, topCategories, topTones, dominantArchetype, dominantCategory, dominantTone, contentStrategy };
}

// ─── EXPRESS SERVER ────────────────────────────────────────────────────────────
function startDashboard(db) {
  let express;
  try { express = require('express'); } catch (_) {
    console.log('[Dashboard] Express not installed — run: npm install express');
    return;
  }

  const app      = express();
  const PORT     = process.env.PORT || 3000;
  const PASSWORD = process.env.DASHBOARD_PASSWORD || null;

  // Simple password gate
  app.use((req, res, next) => {
    if (!PASSWORD) return next(); // no password set = open
    const provided = req.query.key || req.headers['x-dashboard-key'];
    if (provided !== PASSWORD) {
      res.status(401).set('Content-Type', 'text/html').send(`
        <html><body style="background:#0e0e0e;color:#888;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column">
          <h2 style="color:#c9a84c">BULLYLAND Analytics</h2>
          <p style="margin-top:12px">Add <code style="color:#fff">?key=YOUR_PASSWORD</code> to the URL</p>
        </body></html>
      `);
      return;
    }
    next();
  });

  app.get('/', (req, res) => {
    try {
      const data = buildAnalyticsData(db);
      res.set('Content-Type', 'text/html').send(buildHTML(data));
    } catch (e) {
      console.error('[Dashboard] Error building page:', e.message);
      res.status(500).send('Dashboard error — check bot logs.');
    }
  });

  // JSON API endpoint (for future integrations)
  app.get('/api', (req, res) => {
    try { res.json(buildAnalyticsData(db)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.listen(PORT, () => {
    console.log(`[Dashboard] Running on port ${PORT}${PASSWORD ? ' (password protected)' : ' (no password — set DASHBOARD_PASSWORD)'}`);
  });
}

module.exports = { startDashboard };
