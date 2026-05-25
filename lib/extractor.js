'use strict';

const axios = require('axios');

async function extract(text, channel, userId) {
  if (!text || text.trim().length < 4) return [];

  const prompt = `You are an extraction engine for a team communication tool.

Analyze this Slack message and extract actionable content.

Message: "${text.replace(/"/g, "'")}"

Reply with a JSON object only — no markdown, no explanation:
{
  "type": "decision" | "task" | "blocker" | "approval" | "decision_change" | null,
  "title": "specific one-line summary naming the actual subject — include the color, tool, person, date, etc. (e.g. 'Red chosen as color' not 'Color choice', 'Stripe chosen for payments' not 'Payment tool decision')",
  "owner": "first name of person who made the decision or is assigned the task (or null)",
  "reason": "one-line reason WHY this was decided or is blocked, if mentioned (or null)",
  "due_date": "YYYY-MM-DD if a deadline is mentioned (or null)",
  "priority": "high" | "medium" | "low"
}

Rules:
- "decision": something was agreed, settled, or chosen — even implicitly ("yeah red is good" = decision, title = "Red chosen")
- "task": someone needs to do something
- "blocker": something is blocked, waiting, or stuck
- "approval": something needs sign-off or was approved
- "decision_change": a previous decision is being reversed or contradicted
- null: casual chat, greetings, or no actionable content
- Always name the specific thing in the title. Never be vague.
- Extract the reason only if explicitly stated — don't infer or guess`;

  try {
    const response = await axios.post(
      'https://integrate.api.nvidia.com/v1/chat/completions',
      {
        model: 'mistralai/mistral-small-4-119b-2603',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 180,
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

    const clean  = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    if (!parsed.type) return [];

    return [{
      type:            parsed.type,
      title:           parsed.title ?? text.slice(0, 200),
      owner:           parsed.owner ?? null,
      reason:          parsed.reason ?? null,
      due_date:        parsed.due_date ?? null,
      priority:        parsed.priority ?? 'low',
      confidence:      0.85,
      source_text:     text,
      source_location: channel,
      extracted_by:    userId,
    }];

  } catch (err) {
    if (err.response?.status === 429) console.warn('[extractor] Rate limit — skipping');
    else console.error('[extractor]', err.message);
    return [];
  }
}

module.exports = { extract };
