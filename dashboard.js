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

// ─── CATEGORY → SHORT INSIGHT (used in topic resonance table) ─────────────────
const CATEGORY_INTEL = {
  social_motivators:   'They\'re here for belonging. The community itself is their product — recognition and inclusion drive loyalty.',
  communication_needs: 'How you say it matters as much as what you say. Tone, voice, and format are deciding factors for this group.',
  pain_points:         'They\'re working through something. Content that says "I get it" builds deeper loyalty than anything polished.',
  emotional_triggers:  'They act on feeling. Logic doesn\'t close them — emotion does. Create the feeling first.',
  aspirations:         'They\'re chasing a version of their life. Sell the destination, not the product.',
  core_values:         'They need to agree with you before they trust you. Integrity and consistency are non-negotiable.',
  self_image:          'Identity is the product for these users. They buy things that say something about who they are.',
};

// ─── COMMUNITY INTEL (per-category full personality + sales profile) ───────────
const COMMUNITY_INTEL = {
  social_motivators: {
    emoji: '🤝',
    color: '#3498db',
    label: 'The Belongers',
    who: 'These people joined for the feeling of being part of something. The content matters, but the community is what keeps them. They need to feel included, seen, and like there\'s a place for them here specifically.',
    stays: 'Recognition. Shout them out. Give them roles, status, and reasons to feel like insiders. When the community goes through something, they stay loyal because they\'re loyal to the people, not just the creator.',
    sells: 'Membership, exclusivity, and anything that deepens their sense of belonging. "Join the club" framing converts them. FOMO is a real driver — they don\'t want to miss what the group is part of.',
    avoid: 'Making them feel like just a number. Ignoring the community to chase new followers will bleed this segment out fast.',
  },
  communication_needs: {
    emoji: '🗣️',
    color: '#9b59b6',
    label: 'The Listeners',
    who: 'These users are highly attuned to how you communicate. They\'re evaluating your tone, your word choice, and whether what you say feels real. They engage with people who talk to them, not at them.',
    stays: 'Consistency in how you show up. They notice when the energy shifts, when something feels forced, or when you\'re clearly reading a script. Be the same person across every post.',
    sells: 'Conversation-style content converts them. Direct, personal messaging. The less it feels like a pitch and the more it feels like a conversation, the better.',
    avoid: 'Corporate tone, copy-paste captions, or anything that feels like it was written for a brand deck. They can tell.',
  },
  pain_points: {
    emoji: '🩹',
    color: '#e74c3c',
    label: 'The Processors',
    who: 'These users are working through something — a chapter, a loss, a version of themselves they\'re trying to leave behind. They engage most with content that names what they\'re feeling before they\'ve named it themselves.',
    stays: 'They stay when they feel understood. Not fixed, not coached — just understood. If your content or community has been a safe place during a hard time, you own a piece of their trust that\'s almost impossible to lose.',
    sells: 'Transformation-framed products. "This is for the version of you that\'s getting there." Growth, tools, and self-investment. They don\'t buy luxury — they buy progress.',
    avoid: 'Toxic positivity. "Just be grateful" energy will lose them immediately. Acknowledge the hard part before you offer the solution.',
  },
  emotional_triggers: {
    emoji: '⚡',
    color: '#f39c12',
    label: 'The Feelers',
    who: 'These users run entirely on feeling. What makes them stop scrolling, what makes them share something, what makes them buy — it\'s never logical. It\'s always emotional first. They\'re your most reactive segment — in both directions.',
    stays: 'Content that consistently makes them feel something keeps them coming back. Doesn\'t have to be deep — can be funny, exciting, nostalgic, warm. As long as it hits.',
    sells: 'Urgency and feeling. A limited drop with an emotional hook will convert faster than any rational offer. Create the feeling of "I need to be part of this right now."',
    avoid: 'Dry, informational content. If it doesn\'t evoke a reaction within seconds, this segment is already gone.',
  },
  aspirations: {
    emoji: '🚀',
    color: '#2ecc71',
    label: 'The Builders',
    who: 'These users have somewhere they\'re trying to get to. They see their life as a project and they\'re actively building toward a version of themselves or their circumstances. They follow people who seem further down the road.',
    stays: 'Progress content. Show the journey, not just the destination. Let them see you moving, evolving, building — because it mirrors what they\'re doing and makes them feel less alone in it.',
    sells: 'Aspirational positioning. "This is for people who are serious about where they\'re going." Early access, exclusive tiers, and anything that feels like an investment in their future hits. Price is less of a barrier for this group — they frame it as an investment.',
    avoid: 'Stagnation. If you stop evolving visibly, they move on to someone who appears to be winning.',
  },
  core_values: {
    emoji: '🏛️',
    color: '#c9a84c',
    label: 'The Principled',
    who: 'These users have a clear sense of what they stand for and they\'re watching to see if you do too. They\'re not easily impressed and they\'re not easily converted — but once they\'re in, they\'re in for real. They defend people they respect.',
    stays: 'Integrity. Say what you mean. Do what you say. Take stands even when it costs you something. This segment watches how you handle controversy more than how you handle success.',
    sells: 'Alignment over persuasion. They won\'t buy from someone whose values they don\'t respect regardless of the deal. But if they respect you? They buy without needing to be sold to. Limited drops framed around a belief or a statement convert them.',
    avoid: 'Flip-flopping, over-apologizing, or changing your position based on public pressure. It signals weakness to this group and you lose them permanently.',
  },
  self_image: {
    emoji: '🪞',
    color: '#8e44ad',
    label: 'The Identity-Driven',
    who: 'These users see what they consume and who they follow as extensions of who they are. Being part of your community says something about them in their own mind. They\'re invested in the image — both yours and theirs.',
    stays: 'Content that makes them feel like being a fan of you is something to be proud of. Elevate the community\'s identity. Make it mean something to be here.',
    sells: 'Identity products. Anything they can wear, display, or signal publicly. They\'re not buying a hoodie — they\'re buying a statement. Premium pricing often works in your favor here because it adds perceived identity value.',
    avoid: 'Cheapening the brand. Mass-market moves, low-effort content, or anything that makes being a fan feel like something anyone can stumble into. Exclusivity is what keeps this segment engaged.',
  },
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
  philosophical:           'Your audience thinks deeply. Content that asks real questions will earn more trust than content that just entertains.',
};

// ─── HTML TEMPLATE ─────────────────────────────────────────────────────────────
function buildHTML(data) {
  const {
    totalUsers, totalResponses, archetypes, topCategories, topTones,
    dominantArchetype, dominantCategory, dominantTone, contentStrategy, communityProfile,
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

  // Community profile cards
  const profileCards = communityProfile.map((p, i) => {
    const intel = COMMUNITY_INTEL[p.category];
    if (!intel) return '';
    const barWidth = communityProfile[0].pct > 0 ? Math.round((p.pct / communityProfile[0].pct) * 100) : 0;
    const rank = i === 0 ? '👑 #1 Dominant Type' : i === 1 ? '#2 Second Largest' : `#${i + 1}`;
    return `
      <div class="profile-card" style="border-left: 4px solid ${intel.color}">
        <div class="profile-header">
          <span class="profile-emoji">${intel.emoji}</span>
          <div class="profile-title-block">
            <div class="profile-rank">${rank}</div>
            <div class="profile-name">${intel.label}</div>
            <div class="profile-bar-wrap">
              <div class="profile-bar" style="width:${barWidth}%;background:${intel.color}"></div>
            </div>
          </div>
          <div class="profile-pct" style="color:${intel.color}">${p.pct}%</div>
        </div>
        <div class="profile-grid">
          <div class="profile-block">
            <div class="profile-label">👤 Who they are</div>
            <p>${intel.who}</p>
          </div>
          <div class="profile-block">
            <div class="profile-label">📌 What keeps them here</div>
            <p>${intel.stays}</p>
          </div>
          <div class="profile-block">
            <div class="profile-label">💰 What sells to them</div>
            <p>${intel.sells}</p>
          </div>
          <div class="profile-block warn-block">
            <div class="profile-label">⚠️ What loses them</div>
            <p>${intel.avoid}</p>
          </div>
        </div>
      </div>`;
  }).join('');

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

  .profile-card { background: var(--surface2); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 20px; }
  .profile-header { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
  .profile-emoji { font-size: 32px; line-height: 1; flex-shrink: 0; }
  .profile-title-block { flex: 1; }
  .profile-rank { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin-bottom: 4px; }
  .profile-name { font-size: 20px; font-weight: 700; color: var(--text); margin-bottom: 10px; }
  .profile-bar-wrap { height: 6px; background: #1e1e1e; border-radius: 3px; width: 100%; max-width: 300px; }
  .profile-bar { height: 6px; border-radius: 3px; }
  .profile-pct { font-size: 36px; font-weight: 800; flex-shrink: 0; line-height: 1; }
  .profile-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 700px) { .profile-grid { grid-template-columns: 1fr; } }
  .profile-block { background: var(--bg); border-radius: 8px; padding: 14px 16px; }
  .profile-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin-bottom: 8px; }
  .profile-block p { color: #ccc; font-size: 13px; line-height: 1.6; }
  .warn-block { background: #1a0f0f; border: 1px solid #2e1212; }
  .warn-block .profile-label { color: #c0392b; }
  .warn-block p { color: #e88; }

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

  <div class="section">
    <div class="section-title">🧠 Community Profile — Who Your People Actually Are</div>
    ${communityProfile.length ? profileCards : `<div class="empty"><strong>No profile data yet.</strong><p>Data builds as members answer daily questions. Each answer moves them closer to a type.</p></div>`}
  </div>

  ${contentStrategy.length ? `
  <div class="strategy-box">
    <h2>🧭 What Your Data Is Telling You Right Now</h2>
    <p class="sub">Derived directly from how your community engages. These are not guesses.</p>
    <ul>${strategyItems}</ul>
  </div>` : ''}

  <div class="section">
    <div class="section-title">📊 Archetype Breakdown — Personality Mix</div>
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

  // ── Community profile: each user's dominant category = their "type" ──────────
  const allPsychRows = db.prepare('SELECT cat_counts FROM dq_psychology WHERE cat_counts IS NOT NULL').all();
  const dominantCounts = {};
  for (const row of allPsychRows) {
    try {
      const counts = JSON.parse(row.cat_counts || '{}');
      const entries = Object.entries(counts).filter(([, n]) => n > 0);
      if (!entries.length) continue;
      const dominant = entries.sort((a, b) => b[1] - a[1])[0][0];
      dominantCounts[dominant] = (dominantCounts[dominant] || 0) + 1;
    } catch (_) {}
  }
  const communityProfile = Object.entries(dominantCounts)
    .map(([category, count]) => ({
      category,
      count,
      pct: totalUsers > 0 ? Math.round((count / totalUsers) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  // ── Cross-segment insights: what combinations reveal ─────────────────────────
  const crossInsights = [];
  const profileMap = Object.fromEntries(communityProfile.map(p => [p.category, p.pct]));
  if ((profileMap.social_motivators || 0) >= 30) {
    crossInsights.push('Over a third of your community is here primarily for belonging. The community itself is your best product — when people feel included and recognized, they stay and they spend.');
  }
  if ((profileMap.pain_points || 0) >= 20) {
    crossInsights.push('A significant portion of your audience is working through something. They need to feel understood, not just entertained. "I\'ve been there" content builds loyalty that\'s almost impossible to lose.');
  }
  if ((profileMap.emotional_triggers || 0) >= 25) {
    crossInsights.push('Your community runs on feeling. Logic and information won\'t move them — emotion and urgency will. If content doesn\'t make them feel something within seconds, it doesn\'t exist to them.');
  }
  if ((profileMap.aspirations || 0) >= 20) {
    crossInsights.push('A solid portion of your audience is building toward something. They see you as part of the life they\'re working toward. Position yourself as the person who\'s already where they\'re trying to go.');
  }
  if ((profileMap.core_values || 0) >= 15) {
    crossInsights.push('You have a principled audience that watches what you do more than what you say. Integrity and consistency are what keep this group — and they\'re the most valuable advocates you can have.');
  }
  if ((profileMap.self_image || 0) >= 15) {
    crossInsights.push('A meaningful segment ties their identity to what they follow. Being associated with your brand means something to them. Premium, exclusive, and signature products convert this group at high rates.');
  }
  if ((profileMap.pain_points || 0) >= 15 && (profileMap.aspirations || 0) >= 15) {
    crossInsights.push('You have users who know what\'s wrong AND know what they want. They just need someone to bridge the gap. Position yourself as that bridge — not a motivator, but a practical path forward.');
  }
  if ((profileMap.social_motivators || 0) >= 20 && (profileMap.pain_points || 0) >= 15) {
    crossInsights.push('A portion of your community came seeking belonging during a hard time. These are your most emotionally loyal members — they\'re not just fans, you\'re part of how they got through something.');
  }

  // ── Content strategy bullets ─────────────────────────────────────────────────
  const contentStrategy = [];
  if (communityProfile.length > 0) {
    const top = COMMUNITY_INTEL[communityProfile[0].category];
    if (top) {
      contentStrategy.push(`Your #1 audience type is **${top.label}** (${communityProfile[0].pct}% of community) — ${top.sells}`);
    }
  }
  if (communityProfile.length > 1) {
    const second = COMMUNITY_INTEL[communityProfile[1].category];
    if (second) contentStrategy.push(`Second largest segment: **${second.label}** (${communityProfile[1].pct}%) — ${second.sells}`);
  }
  if (dominantTone && TONE_INTEL[dominantTone]) {
    contentStrategy.push(`Most engaged tone: **${dominantTone}** — ${TONE_INTEL[dominantTone]}`);
  }
  crossInsights.forEach(i => contentStrategy.push(i));

  return { totalUsers, totalResponses, archetypes, topCategories, topTones, dominantArchetype, dominantCategory, dominantTone, contentStrategy, communityProfile };
}

// ─── EXPRESS SERVER ────────────────────────────────────────────────────────────
// Stripe payment callback — set by bot.js after boot so the webhook can trigger it
let _stripePaymentCallback = null;
function setStripePaymentCallback(fn) { _stripePaymentCallback = fn; }

function startDashboard(db) {
  console.log('[Dashboard] Initializing...');
  let express;
  try { express = require('express'); } catch (_) {
    console.error('[Dashboard] Express not installed — run: npm install express');
    return;
  }

  const app      = express();
  const PORT     = process.env.PORT || 3000;
  const PASSWORD = process.env.DASHBOARD_PASSWORD || null;
  console.log(`[Dashboard] Starting on port ${PORT} (PASSWORD=${PASSWORD ? 'set' : 'NOT SET'})`);

  // ── Stripe webhook — MUST be before any body parsers and the password gate ──
  // Stripe requires the raw request body to verify the signature.
  app.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
    const sig           = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error('[Stripe Webhook] STRIPE_WEBHOOK_SECRET not set in Railway variables');
      return res.status(500).send('Webhook secret not configured');
    }

    let event;
    try {
      const Stripe = require('stripe');
      const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error('[Stripe Webhook] Signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`[Stripe Webhook] Event received: ${event.type}`);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log(`[Stripe Webhook] Payment confirmed — session ${session.id}, metadata:`, session.metadata);
      if (_stripePaymentCallback) {
        _stripePaymentCallback(session).catch(err =>
          console.error('[Stripe Webhook] Callback error:', err.message)
        );
      } else {
        console.warn('[Stripe Webhook] No payment callback registered yet');
      }
    }

    res.json({ received: true });
  });

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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Dashboard] Running on port ${PORT}${PASSWORD ? ' (password protected)' : ' (no password — set DASHBOARD_PASSWORD)'}`);
  });
}

module.exports = { startDashboard, setStripePaymentCallback };
