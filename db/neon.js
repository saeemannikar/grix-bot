'use strict';

const { neon } = require('@neondatabase/serverless');

function getDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  return neon(process.env.DATABASE_URL);
}

// ─── Store extractions ────────────────────────────────────────────────────────

async function storeExtractions(workspaceId, extractions, rawMessage, messageTs) {
  if (!extractions.length) return;
  const sql = getDb();

  const values = extractions.map(e => ({
    workspace_id: workspaceId,
    type: e.type,
    title: e.title ?? null,
    owner: e.owner ?? null,
    due_date: e.due_date ?? null,
    priority: e.priority ?? 'low',
    confidence: e.confidence ?? null,
    source_text: e.source_text ?? null,
    source_location: e.source_location ?? null,
    extracted_by: e.extracted_by ?? null,
    raw_message: rawMessage ?? null,
    message_ts: messageTs ?? null,
  }));

  for (const v of values) {
    await sql`
      INSERT INTO extractions
        (workspace_id, type, title, owner, due_date, priority, confidence,
         source_text, source_location, extracted_by, raw_message, message_ts)
      VALUES
        (${v.workspace_id}, ${v.type}, ${v.title}, ${v.owner}, ${v.due_date},
         ${v.priority}, ${v.confidence}, ${v.source_text}, ${v.source_location},
         ${v.extracted_by}, ${v.raw_message}, ${v.message_ts})
    `;
  }
}

// ─── Fetch extractions ────────────────────────────────────────────────────────

async function fetchExtractions(workspaceId, { type, limit = 100, days = 30, since } = {}) {
  const sql = getDb();

  const sinceDate = since
    ? new Date(since)
    : new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  if (type && type !== 'all') {
    return await sql`
      SELECT * FROM extractions
      WHERE workspace_id = ${workspaceId}
        AND type = ${type}
        AND created_at >= ${sinceDate.toISOString()}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  }

  return await sql`
    SELECT * FROM extractions
    WHERE workspace_id = ${workspaceId}
      AND created_at >= ${sinceDate.toISOString()}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

// ─── Fetch extractions since a user was last seen ─────────────────────────────

async function fetchSinceLastSeen(workspaceId, userId) {
  const sql = getDb();

  // Get last seen time for this user
  const rows = await sql`
    SELECT last_seen_at FROM user_sessions
    WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
  `;

  const lastSeen = rows[0]?.last_seen_at ?? null;

  // Update last seen to now
  await sql`
    INSERT INTO user_sessions (workspace_id, user_id, last_seen_at)
    VALUES (${workspaceId}, ${userId}, NOW())
    ON CONFLICT (workspace_id, user_id)
    DO UPDATE SET last_seen_at = NOW()
  `;

  if (!lastSeen) {
    // First visit — show last 24h
    return await fetchExtractions(workspaceId, { days: 1, limit: 50 });
  }

  return await fetchExtractions(workspaceId, { since: lastSeen, limit: 50 });
}

// ─── Stats ────────────────────────────────────────────────────────────────────

async function fetchStats(workspaceId, days = 30) {
  const sql = getDb();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const rows = await sql`
    SELECT type, COUNT(*) as count
    FROM extractions
    WHERE workspace_id = ${workspaceId}
      AND created_at >= ${since}
    GROUP BY type
  `;

  const stats = { decisions: 0, tasks: 0, blockers: 0, approvals: 0, decision_changes: 0 };
  for (const r of rows) {
    if (r.type === 'decision') stats.decisions = Number(r.count);
    if (r.type === 'task') stats.tasks = Number(r.count);
    if (r.type === 'blocker') stats.blockers = Number(r.count);
    if (r.type === 'approval') stats.approvals = Number(r.count);
    if (r.type === 'decision_change') stats.decision_changes = Number(r.count);
  }
  return stats;
}

// ─── Format for LLM context ──────────────────────────────────────────────────

function formatForLLM(rows) {
  if (!rows.length) return '(no data)';

  return rows.map(r => {
    const parts = [`[${r.type.toUpperCase()}]`, r.title ?? r.source_text ?? '(no text)'];
    if (r.owner) parts.push(`owner:${r.owner}`);
    if (r.due_date) parts.push(`due:${r.due_date}`);
    if (r.created_at) parts.push(`on:${new Date(r.created_at).toISOString().slice(0, 10)}`);
    return parts.join(' | ');
  }).join('\n');
}

module.exports = {
  storeExtractions,
  fetchExtractions,
  fetchSinceLastSeen,
  fetchStats,
  formatForLLM,
};
