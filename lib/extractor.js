'use strict';

const axios = require('axios');

/**
 * Uses Mistral via NVIDIA API to extract structured info from a Slack message.
 * Falls back to null if the message has no actionable content.
 *
 * @param {string} text        - raw message text
 * @param {string} channel     - Slack channel ID
 * @param {string} userId      - Slack user ID
 * @returns {Promise<Array>}   - array of extraction objects (usually 0 or 1)
 */
async function extract(text, channel, userId) {
  if (!text || text.trim().length < 4) return [];

  const prompt = `You are an extraction engine for a team communication tool.

Analyze this Slack message and extract actionable content.

Message: "${text.replace(/"/g, "'")}"

Reply with a JSON object only — no markdown, no explanation:
{
  "type": "decision" | "task" | "blocker" | "approval" | "decision_change" | null,
  "title": "concise one-line summary of what was decided/assigned/blocked (or null)",
  "owner": "person's first name if someone is assigned or mentioned (or null)",
  "due_date": "YYYY-MM-DD if a deadline is mentioned (or null)",
  "priority": "high" | "medium" | "low"
}

Rules:
- "decision": something was agreed, settled, chosen, or confirmed — even implicitly ("yeah red is good" = decision)
- "task": someone needs to do something, assigned or requested
- "blocker": something is blocked, waiting, stuck, or can't proceed
- "approval": something needs sign-off or was approved
- "decision_change": a previous decision is being reversed, updated, or contradicted
- null: casual chat, greetings, reactions, questions with no actionable content
- If unclear, return null for type`;

  try {
    const response = await axios.post(
      'https://integrate.api.nvidia.com/v1/chat/completions',
      {
        model: 'mistralai/mistral-small-4-119b-2603',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 150,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.NVIDIA_API_KEY.trim()}`,
          'Content-Type': 'application/json',
        },
        timeout: 8000,
      }
    );

    const raw = response.data.choices[0]?.message?.content?.trim();
    if (!raw) return [];

    // Strip markdown fences if model wraps in ```json
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    if (!parsed.type) return [];

    return [{
      type:            parsed.type,
      title:           parsed.title ?? text.slice(0, 200),
      owner:           parsed.owner ?? null,
      due_date:        parsed.due_date ?? null,
      priority:        parsed.priority ?? 'low',
      confidence:      0.85,
      source_text:     text,
      source_location: channel,
      extracted_by:    userId,
    }];

  } catch (err) {
    if (err.response?.status === 429) {
      console.warn('[extractor] Rate limit hit — skipping message');
    } else {
      console.error('[extractor] Error:', err.message);
    }
    return [];
  }
}

module.exports = { extract };