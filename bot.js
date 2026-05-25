require('dotenv').config();
const { App } = require('@slack/bolt');
const axios = require('axios');
const http  = require('http');
const { extract } = require('./lib/extraction');
const { neon } = require('@neondatabase/serverless');

console.log('NVIDIA API Key:', process.env.NVIDIA_API_KEY ? 'OK' : 'MISSING');
console.log('Database URL:', process.env.DATABASE_URL ? 'OK' : 'MISSING');

// ─── DB ───────────────────────────────────────────────────────────────────────

function getDb() { return neon(process.env.DATABASE_URL); }

// In-memory name cache: workspaceId:userId -> displayName
const nameCache = new Map();

async function resolveName(client, workspaceId, userId) {
  const key = `${workspaceId}:${userId}`;
  if (nameCache.has(key)) return nameCache.get(key);
  try {
    const info = await client.users.info({ user: userId });
    const u    = info.user;
    const name = u.profile?.display_name || u.profile?.real_name || u.real_name || userId;
    nameCache.set(key, name);
    // Persist to DB
    const sql = getDb();
    await sql`
      INSERT INTO workspace_members
        (workspace_id, user_id, display_name, real_name, email, title, avatar, is_bot)
      VALUES (
        ${workspaceId}, ${userId},
        ${u.profile?.display_name ?? null},
        ${u.profile?.real_name ?? u.real_name ?? null},
        ${u.profile?.email ?? null},
        ${u.profile?.title ?? null},
        ${u.profile?.image_48 ?? null},
        ${u.is_bot ?? false}
      )
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        real_name    = EXCLUDED.real_name,
        email        = EXCLUDED.email,
        title        = EXCLUDED.title,
        avatar       = EXCLUDED.avatar,
        updated_at   = NOW()
    `;
    return name;
  } catch (_) {
    return userId;
  }
}

async function syncChannelMembers(client, workspaceId, channelId) {
  try {
    const result = await client.conversations.members({ channel: channelId });
    const userIds = (result.members ?? []).filter(id => id !== 'USLACKBOT');
    console.log(`[members] Syncing ${userIds.length} members from #${channelId}`);
    for (const uid of userIds) {
      await resolveName(client, workspaceId, uid);
    }
  } catch (err) {
    console.error('[members] sync failed:', err.message);
  }
}

async function storeExtractions(workspaceId, extractions, rawMessage, messageTs) {
  if (!extractions.length) return;
  const sql = getDb();
  for (const e of extractions) {
    await sql`
      INSERT INTO extractions
        (workspace_id, type, title, owner, reason, due_date, priority, confidence,
         source_text, source_location, extracted_by, raw_message, message_ts)
      VALUES
        (${workspaceId}, ${e.type}, ${e.title ?? null}, ${e.owner ?? null},
         ${e.reason ?? null}, ${e.due_date ?? null}, ${e.priority ?? 'low'},
         ${e.confidence ?? null}, ${e.source_text ?? null}, ${e.source_location ?? null},
         ${e.extracted_by ?? null}, ${rawMessage ?? null}, ${messageTs ?? null})
    `;
  }
}

async function fetchExtractions(workspaceId, { type, limit = 100, days = 30, since } = {}) {
  const sql = getDb();
  const sinceDate = since
    ? new Date(since)
    : new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  if (type && type !== 'all') {
    return await sql`
      SELECT * FROM extractions
      WHERE workspace_id = ${workspaceId} AND type = ${type}
        AND created_at >= ${sinceDate.toISOString()}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  }
  return await sql`
    SELECT * FROM extractions
    WHERE workspace_id = ${workspaceId}
      AND created_at >= ${sinceDate.toISOString()}
    ORDER BY created_at DESC LIMIT ${limit}
  `;
}

async function fetchSinceLastSeen(workspaceId, userId) {
  const sql = getDb();
  const rows = await sql`
    SELECT last_seen_at FROM user_sessions
    WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
  `;
  const lastSeen = rows[0]?.last_seen_at ?? null;
  await sql`
    INSERT INTO user_sessions (workspace_id, user_id, last_seen_at)
    VALUES (${workspaceId}, ${userId}, NOW())
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET last_seen_at = NOW()
  `;
  return await fetchExtractions(workspaceId, {
    since: lastSeen ?? undefined,
    days:  lastSeen ? undefined : 1,
    limit: 50,
  });
}

function formatForLLM(rows) {
  if (!rows.length) return '(no data)';
  return rows.map(r => {
    const parts = [`[${r.type.toUpperCase()}]`, r.title ?? r.source_text ?? '(no text)'];
    if (r.owner)    parts.push(`owner:${r.owner}`);
    if (r.reason)   parts.push(`reason:${r.reason}`);
    if (r.due_date) parts.push(`due:${r.due_date}`);
    if (r.created_at) parts.push(`on:${new Date(r.created_at).toISOString().slice(0, 10)}`);
    return parts.join(' | ');
  }).join('\n');
}

// ─── Active workspace instances ───────────────────────────────────────────────
const activeWorkspaces = new Map();

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
  blocks.push({ type: 'header', text: { type: 'plain_text', text: `${greetingByHour()}, ${userName}. Here's what happened.`, emoji: true } });
  blocks.push({ type: 'divider' });

  if (!rows.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '✅ *All caught up* — nothing new since you were last here.' } });
  }

  const sections = [
    { items: changes,   emoji: '⚠️', label: 'Changed Decisions' },
    { items: decisions, emoji: '🟣', label: 'Decisions' },
    { items: tasks,     emoji: '🔵', label: 'Tasks' },
    { items: blockers,  emoji: '🔴', label: 'Blockers' },
    { items: approvals, emoji: '🟢', label: 'Approvals' },
  ];

  for (const { items, emoji, label } of sections) {
    if (!items.length) continue;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${emoji} *${label}* (${items.length})` } });
    items.slice(0, 8).forEach(r => {
      const due    = r.due_date ? ` · due ${fmtDate(r.due_date)}` : '';
      const owner  = r.owner  ? `\n  _by ${r.owner}_` : '';
      const reason = r.reason ? `\n  _↳ ${r.reason}_` : '';
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `• ${r.title ?? r.source_text}${due}${owner}${reason} _${timeAgo(r.created_at)}_` },
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

// ─── Start a bot instance per workspace ──────────────────────────────────────

async function startWorkspaceBot(workspaceId, botToken) {
  if (activeWorkspaces.has(workspaceId)) {
    console.log(`[init] Workspace ${workspaceId} already active`);
    return;
  }

  const app = new App({
    token: botToken,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
  });

  // ── Sync members when Grix joins a channel ──
  app.event('member_joined_channel', async ({ event, client, context }) => {
    const wsId = context.teamId ?? workspaceId;
    // Only act when Grix itself joins
    if (event.user !== event.inviter && event.user) {
      await syncChannelMembers(client, wsId, event.channel);
    }
  });

  // ── Home tab ──
  app.event('app_home_opened', async ({ event, client, context }) => {
    if (event.tab !== 'home') return;
    const userId = event.user;
    const wsId   = context.teamId ?? workspaceId;
    try {
      const name = await resolveName(client, wsId, userId);
      const firstName = name.split(' ')[0];
      const rows   = await fetchSinceLastSeen(wsId, userId);
      const blocks = buildHomeBlocks(firstName, rows);
      await client.views.publish({ user_id: userId, view: { type: 'home', blocks } });
      console.log(`[home] Digest for ${firstName} in ${wsId}`);
    } catch (err) {
      console.error('[home]', err.message);
    }
  });

  // ── Message listener ──
  app.message(async ({ message, client, context }) => {
    console.log('[message] received:', message.text);
    if (message.subtype) return;
    if (!message.text?.trim()) return;
    const wsId = context.teamId ?? workspaceId;

    // Resolve sender name and cache it
    if (message.user) {
      resolveName(client, wsId, message.user).catch(() => {});
    }

    try {
      const extractions = await extract(message.text, message.channel, message.user);
      console.log('[extract result]', JSON.stringify(extractions));
      if (extractions.length) {
        // Replace user ID owner with real name if we have it
        for (const e of extractions) {
          if (e.owner && e.owner.startsWith('U')) {
            const key = `${wsId}:${e.owner}`;
            if (nameCache.has(key)) e.owner = nameCache.get(key);
          }
        }
        console.log(`[extract] ${extractions.length} item(s) — types: ${extractions.map(e => e.type).join(', ')}`);
        await storeExtractions(wsId, extractions, message.text, message.ts);
      }
    } catch (err) {
      console.error('[message handler]', err.message);
    }
  });

  // ── /grix command ──
  app.command('/grix', async ({ command, ack, respond, client, context }) => {
    await ack();
    const input = command.text.trim();
    const wsId  = context.teamId ?? workspaceId;

    if (!input) {
      await respond('Usage:\n• `/grix ask <question>`\n• `/grix tasks`\n• `/grix blockers`\n• `/grix decisions`\n• `/grix changes`\n• `/grix summary`');
      return;
    }

    const listCommands = { tasks: 'task', blockers: 'blocker', decisions: 'decision', approvals: 'approval', changes: 'decision_change' };

    if (listCommands[input.toLowerCase()]) {
      const type  = listCommands[input.toLowerCase()];
      const rows  = await fetchExtractions(wsId, { type, limit: 20 });
      if (!rows.length) { await respond(`No ${type.replace('_', ' ')}s found in the last 30 days.`); return; }
      const label = type === 'decision_change' ? 'Changed Decisions' : `${type.charAt(0).toUpperCase() + type.slice(1)}s`;
      const lines = rows.map(r => {
        const due    = r.due_date ? ` [due ${fmtDate(r.due_date)}]` : '';
        const owner  = r.owner  ? ` — ${r.owner}` : '';
        const reason = r.reason ? `\n  _↳ ${r.reason}_` : '';
        const when   = r.created_at ? ` _(${timeAgo(r.created_at)})_` : '';
        return `• ${r.title ?? r.source_text ?? '(no text)'}${due}${owner}${when}${reason}`;
      });
      await respond({ response_type: 'ephemeral', text: `*${label} (last 30 days):*\n${lines.join('\n')}`, mrkdwn: true });
      return;
    }

    if (input.toLowerCase() === 'summary') {
      const all = await fetchExtractions(wsId, { limit: 200, days: 7 });
      if (!all.length) { await respond('Nothing captured this week.'); return; }
      await respond({ response_type: 'ephemeral', text: `*Grix Weekly Summary:*\n${formatForLLM(all)}`, mrkdwn: true });
      return;
    }

    const query = input.replace(/^ask\s+/i, '').trim();
    if (!query) { await respond('Try: `/grix ask did we decide on the vendor?`'); return; }

    await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, text: '🔍 Searching workspace memory...' });

    try {
      const stored = await fetchExtractions(wsId, { limit: 150, days: 30 });
      if (!stored.length) { await respond('No stored data yet.'); return; }

      const response = await axios.post(
        'https://integrate.api.nvidia.com/v1/chat/completions',
        {
          model: 'mistralai/mistral-small-4-119b-2603',
          messages: [
            { role: 'system', content: `You are Grix, an AI operational memory for a business team. Answer using ONLY the provided extractions. Never make up information. Be concise. Use bullet points. Attribute to people by name when mentioned. Include reasons when available. If you see decision_change entries that contradict decisions, flag them clearly.` },
            { role: 'user', content: `Workspace memory (last 30 days):\n${formatForLLM(stored)}\n\nQuestion: ${query}` },
          ],
          temperature: 0.1,
          max_tokens: 400,
        },
        { headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY.trim()}`, 'Content-Type': 'application/json' } }
      );

      const result = response.data.choices[0]?.message?.content;
      if (!result) { await respond('Got an empty response.'); return; }
      await respond({ response_type: 'ephemeral', text: `*Grix:* ${result}`, mrkdwn: true });
    } catch (err) {
      console.error('[grix ask]', err.response?.data || err.message);
      await respond('Something went wrong. Please try again.');
    }
  });

  await app.start();
  activeWorkspaces.set(workspaceId, app);
  console.log(`✅ Grix running for workspace: ${workspaceId}`);
}

// ─── Sync new workspaces every 60s ───────────────────────────────────────────

async function syncNewWorkspaces() {
  try {
    const sql = getDb();
    const workspaces = await sql`SELECT workspace_id, bot_token FROM workspaces`;
    for (const ws of workspaces) {
      if (!activeWorkspaces.has(ws.workspace_id)) {
        console.log(`[sync] New workspace: ${ws.workspace_id}`);
        await startWorkspaceBot(ws.workspace_id, ws.bot_token);
      }
    }
  } catch (err) {
    console.error('[sync]', err.message);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

(async () => {
  if (process.env.PORT || process.env.AWS_EXECUTION_ENV) {
    http.createServer((req, res) => res.end('Grix is running')).listen(8080);
  }

  try {
    const sql = getDb();
    const workspaces = await sql`SELECT workspace_id, bot_token FROM workspaces`;
    console.log(`[init] Loading ${workspaces.length} workspace(s)`);
    for (const ws of workspaces) {
      await startWorkspaceBot(ws.workspace_id, ws.bot_token);
    }
  } catch (err) {
    console.error('[init] DB load failed:', err.message);
  }

  if (activeWorkspaces.size === 0 && process.env.SLACK_BOT_TOKEN) {
    console.log('[init] Falling back to env token');
    await startWorkspaceBot('dev', process.env.SLACK_BOT_TOKEN);
  }

  setInterval(syncNewWorkspaces, 60000);
  console.log('✅ Grix is running');
})();
