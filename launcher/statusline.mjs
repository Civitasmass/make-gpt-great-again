#!/usr/bin/env node
/**
 * Claude Code statusline for claudex: current model + live Codex subscription
 * quota (5-hour and weekly windows), read from the mgga proxy's GET /quota.
 *
 * Wire it up in ~/.claude-gpt/settings.json:
 *   "statusLine": {
 *     "type": "command",
 *     "command": "node \"<repo>/launcher/statusline.mjs\""
 *   }
 *
 * Claude Code pipes session JSON on stdin; whatever this prints is the bar.
 * Degrades gracefully: proxy down / no data yet → model name only.
 */

const port = process.env.CLAUDEX_PORT ?? process.env.MGGA_PORT ?? '5656';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 300).unref();
  });
}

function untilReset(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!iso || Number.isNaN(ms) || ms <= 0) return '';
  if (ms < 90 * 60_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 36 * 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

function windowPart(label, w) {
  if (!w) return '';
  const reset = untilReset(w.resetsAt);
  return ` | ${label} ${w.usedPercent}%${reset ? ` (resets ${reset})` : ''}`;
}

let input = {};
try {
  input = JSON.parse((await readStdin()) || '{}');
} catch {
  /* bar still renders */
}
const model = input?.model?.display_name ?? input?.model?.id ?? 'claudex';

let quota = '';
try {
  const res = await fetch(`http://127.0.0.1:${port}/quota`, { signal: AbortSignal.timeout(400) });
  const q = await res.json();
  quota =
    windowPart('5h', q.primary) +
    windowPart('wk', q.secondary) +
    (q.planType ? ` | ${q.planType}` : '');
} catch {
  /* proxy down or cold — show model only */
}

process.stdout.write(`${model}${quota}`);
