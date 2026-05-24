require('dotenv').config();
const { App } = require('@slack/bolt');
const axios = require('axios');
const { extract } = require('./lib/extractor');
const { storeExtractions, fetchExtractions, fetchSinceLastSeen, formatForLLM } = require('./db/neon');

console.log('NVIDIA API Key:', process.env.NVIDIA_API_KEY ? 'OK' : 'MISSING');
console.log('Database URL:', process.env.DATABASE_URL ? 'OK' : 'MISSING');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function greetingByHour() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function buildHomeBlocks(userName, rows) {
  const changes   = rows.filter(r => r.type === 'decision_change');
  const decisions = rows.filter(r => r.type === 'decision');
  const tasks     = rows.filter(r => r.type === 'task');
  const blockers  = rows.filter(r => r.type === 'blocker');
  const approvals = rows.filter(r => r.type === 'approval');

  const blocks = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `${greetingByHour()}, ${userName}. Here's what happened.`, emoji: true },
  });
  blocks.push({ type: 'divider' });

  if (!rows.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '✅ *All caught up* — nothing new since you were last here.' },
    });
  }

  if (changes.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `⚠️ *Changed Decisions* (${changes.length})` } });
    changes.slice(0, 8).forEach(r => {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `• ${r.title ?? r.source_text}${r.owner ? `\n  _→ ${r.owner}_` : ''} _${timeAgo(r.created_at)}_` },
      });
    });
    blocks.push({ type: 'divider' });
  }

  if (decisions.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `🟣 *Decisions* (${decisions.length})` } });
    decisions.slice(0, 8).forEach(r => {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `• ${r.title ?? r.source_text}${r.owner ? `\n  _by ${r.owner}_` : ''}` },
      });
    });
    blocks.push({ type: 'divider' });
  }

  if (tasks.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `🔵 *Tasks* (${tasks.length})` } });
    tasks.slice(0, 8).forEach(r => {
      const due = r.due_date ? ` · due ${fmtDate(r.due_date)}` : '';
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `• ${r.title ?? r.source_text}${r.owner ? ` — ${r.owner}` : ''}${due}\n  _${timeAgo(r.created_at)}_` },
      });
    });
    blocks.push({ type: 'divider' });
  }

  if (blockers.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `🔴 *Blockers* (${blockers.length})` } });
    blockers.slice(0, 6).forEach(r => {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `• ${r.title ?? r.source_text}${r.owner ? `\n  _flagged by ${r.owner}_` : ''}` },
      });
    });
    blocks.push({ type: 'divider' });
  }

  if (approvals.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `🟢 *Approvals* (${approvals.length})` } });
    approvals.slice(0, 6).forEach(r => {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `• ${r.title ?? r.source_text}` },
      });
    });
    blocks.push({ type: 'divider' });
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '💡 `/grix ask <question>` · `/grix tasks` · `/grix decisions` · `/grix changes`' }],
  });

  return blocks;
}

// ─── app_home_opened ──────────────────────────────────────────────────────────

app.event('app_home_opened', async ({ event, client, context }) => {
  if (event.tab !== 'home') return;

  const userId      = event.user;
  const workspaceId = context.teamId ?? 'unknown';

  try {
    let userName = 'there';
    try {
      const info = await client.users.info({ user: userId });
      userName = info.user?.profile?.first_name || info.user?.real_name || 'there';
    } catch (_) {}

    const rows   = await fetchSinceLastSeen(workspaceId, userId);
    const blocks = buildHomeBlocks(userName, rows);

    await client.views.publish({
      user_id: userId,
      view: { type: 'home', blocks },
    });

    console.log(`[home] Digest published for ${userName}`);
  } catch (err) {
    console.error('[home]', err.message);
    await client.views.publish({
      user_id: userId,
      view: {
        type: 'home',
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '⚠️ Something went wrong loading your digest. Try again in a moment.' } }],
      },
    }).catch(() => {});
  }
});

// ─── Message listener ─────────────────────────────────────────────────────────

app.message(async ({ message, context }) => {
  console.log('[message] received:', message.text);
  if (message.subtype) return;
  if (!message.text?.trim()) return;

  const workspaceId = context.teamId ?? 'unknown';

  try {
    const extractions = await extract(message.text, message.channel, message.user);
    console.log('[extract result]', JSON.stringify(extractions));

    if (extractions.length) {
      console.log(`[extract] ${extractions.length} item(s) — types: ${extractions.map(e => e.type).join(', ')}`);
      await storeExtractions(workspaceId, extractions, message.text, message.ts);
    }
  } catch (err) {
    console.error('[message handler]', err.message);
  }
});

// ─── /grix command ───────────────────────────────────────────────────────────

app.command('/grix', async ({ command, ack, respond, client, context }) => {
  await ack();

  const input       = command.text.trim();
  const workspaceId = context.teamId ?? 'unknown';

  if (!input) {
    await respond(
      'Usage:\n' +
      '• `/grix ask <question>` — query workspace memory\n' +
      '• `/grix tasks` — open tasks\n' +
      '• `/grix blockers` — current blockers\n' +
      '• `/grix decisions` — recent decisions\n' +
      '• `/grix changes` — changed decisions\n' +
      '• `/grix summary` — full weekly summary'
    );
    return;
  }

  const listCommands = {
    tasks:     'task',
    blockers:  'blocker',
    decisions: 'decision',
    approvals: 'approval',
    changes:   'decision_change',
  };

  if (listCommands[input.toLowerCase()]) {
    const type = listCommands[input.toLowerCase()];
    const rows = await fetchExtractions(workspaceId, { type, limit: 20 });

    if (!rows.length) {
      await respond(`No ${type.replace('_', ' ')}s found in the last 30 days.`);
      return;
    }

    const label = type === 'decision_change' ? 'Changed Decisions'
      : `${type.charAt(0).toUpperCase() + type.slice(1)}s`;

    const lines = rows.map(r => {
      const due   = r.due_date ? ` [due ${fmtDate(r.due_date)}]` : '';
      const owner = r.owner ? ` — ${r.owner}` : '';
      const when  = r.created_at ? ` _(${timeAgo(r.created_at)})_` : '';
      return `• ${r.title ?? r.source_text ?? '(no text)'}${due}${owner}${when}`;
    });

    await respond({
      response_type: 'ephemeral',
      text: `*${label} (last 30 days):*\n${lines.join('\n')}`,
      mrkdwn: true,
    });
    return;
  }

  if (input.toLowerCase() === 'summary') {
    const all = await fetchExtractions(workspaceId, { limit: 200, days: 7 });
    if (!all.length) {
      await respond('Nothing captured this week. Invite Grix to your active channels.');
      return;
    }
    await respond({
      response_type: 'ephemeral',
      text: `*Grix Weekly Summary:*\n${formatForLLM(all)}`,
      mrkdwn: true,
    });
    return;
  }

  const query = input.replace(/^ask\s+/i, '').trim();
  if (!query) {
    await respond('What do you want to ask? Try: `/grix ask did we decide on the vendor?`');
    return;
  }

  await client.chat.postEphemeral({
    channel: command.channel_id,
    user:    command.user_id,
    text:    '🔍 Searching workspace memory...',
  });

  try {
    const stored        = await fetchExtractions(workspaceId, { limit: 150, days: 30 });
    const context_block = formatForLLM(stored);

    if (!stored.length) {
      await respond('No stored data yet. Invite Grix to your channels and give it a day.');
      return;
    }

    const response = await axios.post(
      'https://integrate.api.nvidia.com/v1/chat/completions',
      {
        model: 'mistralai/mistral-small-4-119b-2603',
        messages: [
          {
            role: 'system',
            content: `You are Grix, an AI operational memory for a business team.
Answer using ONLY the provided extractions. Never make up information.
Be concise. Use bullet points. Attribute to people when mentioned.
If you see decision_change entries that contradict decisions, flag them clearly.`,
          },
          {
            role: 'user',
            content: `Workspace memory (last 30 days):\n${context_block}\n\nQuestion: ${query}`,
          },
        ],
        temperature: 0.1,
        max_tokens: 400,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.NVIDIA_API_KEY.trim()}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const result = response.data.choices[0]?.message?.content;
    if (!result) {
      await respond('Got an empty response. Please try again.');
      return;
    }

    await respond({
      response_type: 'ephemeral',
      text: `*Grix:* ${result}`,
      mrkdwn: true,
    });

  } catch (err) {
    console.error('[grix ask]', err.response?.data || err.message);
    await respond('Something went wrong. Please try again.');
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

(async () => {
  await app.start();
  console.log('✅ Grix is running — digest on Home tab open');
})();