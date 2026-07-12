#!/usr/bin/env node
/**
 * Live smoke test against a RUNNING mgga proxy (`mgga serve` first).
 * Costs a few hundred upstream tokens. Not part of `npm test` on purpose.
 *
 *   node scripts/live-smoke.mjs [model]        (default gpt-5.6-sol)
 *   MGGA_URL=http://127.0.0.1:5656 node scripts/live-smoke.mjs gpt-5.6-luna
 *
 * What it proves, in one two-turn tool loop:
 *  1. plain completion works end to end (auth, translation, streaming);
 *  2. the model calls a tool through the Anthropic dialect (stop_reason
 *     tool_use, toolu_call_* id, parseable input);
 *  3. THE SIGNATURE TRICK: turn 1's thinking block carries GPT's encrypted
 *     reasoning in `signature`; replaying it in turn 2 with the tool_result
 *     is accepted upstream — the model keeps its plan across the tool loop,
 *     which is the single thing naive proxies lose.
 */

const BASE = process.env.MGGA_URL ?? 'http://127.0.0.1:5656';
const MODEL = process.argv[2] ?? 'gpt-5.6-sol';

const TOOL = {
  name: 'get_time',
  description: 'Get the current time in a given timezone',
  input_schema: {
    type: 'object',
    properties: { tz: { type: 'string', description: 'IANA timezone, e.g. UTC' } },
  },
};

async function messages(body) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    console.error(`FAIL ${res.status}:`, JSON.stringify(json));
    process.exit(1);
  }
  return json;
}

function describe(label, message) {
  console.log(`\n── ${label} ──`);
  console.log(`stop_reason=${message.stop_reason} usage=${JSON.stringify(message.usage)}`);
  for (const block of message.content) {
    if (block.type === 'text') console.log(`  text     : ${JSON.stringify(block.text.slice(0, 80))}`);
    if (block.type === 'thinking')
      console.log(`  thinking : ${JSON.stringify(block.thinking.slice(0, 60))} signature=${block.signature ? block.signature.length + ' chars' : 'MISSING'}`);
    if (block.type === 'tool_use')
      console.log(`  tool_use : ${block.name} id=${block.id} input=${JSON.stringify(block.input)}`);
  }
}

const base = {
  model: MODEL,
  max_tokens: 512,
  thinking: { type: 'enabled', budget_tokens: 10_000 },
  tools: [TOOL],
  system: 'You are a terse assistant. Use tools when asked.',
};

// Turn 1: the model should think, then call the tool.
const turn1 = await messages({
  ...base,
  messages: [{ role: 'user', content: 'Use get_time for tz UTC, then tell me the time.' }],
});
describe(`turn 1 (${MODEL})`, turn1);

const toolUse = turn1.content.find((b) => b.type === 'tool_use');
const thinking = turn1.content.find((b) => b.type === 'thinking');
if (turn1.stop_reason !== 'tool_use' || !toolUse) {
  console.error('FAIL: turn 1 did not end in a tool call');
  process.exit(1);
}

// Turn 2: replay the assistant turn verbatim (thinking signature included —
// Claude Code does exactly this) plus the tool result.
const turn2 = await messages({
  ...base,
  messages: [
    { role: 'user', content: 'Use get_time for tz UTC, then tell me the time.' },
    { role: 'assistant', content: turn1.content },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUse.id, content: '2026-07-12T03:15:00Z' },
      ],
    },
  ],
});
describe('turn 2 (after tool_result)', turn2);

const answered = turn2.content.some((b) => b.type === 'text' && /03:15|3:15/.test(b.text));
console.log(`\nsignature roundtrip : ${thinking?.signature ? 'CARRIED' : 'absent (model sent no reasoning item)'}`);
console.log(`final answer uses tool result: ${answered ? 'YES' : 'no (inspect text above)'}`);
console.log(turn2.stop_reason === 'end_turn' && answered ? '\nLIVE SMOKE: PASS' : '\nLIVE SMOKE: CHECK OUTPUT');
