#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type ResolvedConfig } from './config.js';
import { createBackend } from './backends/backend.js';
import { createMggaServer } from './server.js';
import { ALL_FIXERS } from './pipeline/index.js';
import { askOnce } from './ask.js';
import { runMcpServer } from './mcp.js';

export const VERSION = '0.1.0';

/**
 * mgga — make gpt great again.
 *
 *   mgga serve  [--port N] [--config FILE] [--backend openai|chatgpt|mock]
 *   mgga ask    [-m model[:effort]] [-s system] "question"   (stdin pipes in)
 *   mgga mcp    [--config FILE]                stdio MCP server (tool: ask_gpt)
 *   mgga doctor [--config FILE]
 */
async function main(argv: string[]): Promise<number> {
  const [command = 'help'] = argv;
  const flags = parseFlags(argv.slice(1));
  switch (command) {
    case 'serve':
      return serve(flags);
    case 'ask':
      return ask(argv.slice(1));
    case 'mcp': {
      const cfg = applyFlagOverrides(loadConfig(flags['config']), flags);
      const backend = await createBackend(cfg);
      await runMcpServer({ cfg, backend, version: VERSION });
      return 0;
    }
    case 'doctor': {
      const cfg = applyFlagOverrides(loadConfig(flags['config']), flags);
      process.stdout.write(buildDoctorReport(cfg));
      return 0;
    }
    default:
      process.stdout.write(
        `mgga v${VERSION} — run GPT-5.6 inside Claude Code\n\n` +
          `  mgga serve  [--port N] [--config FILE] [--backend openai|chatgpt|mock]\n` +
          `  mgga ask    [-m model[:effort]] [-s system] "question"   (or pipe stdin)\n` +
          `  mgga mcp    [--config FILE]     stdio MCP server exposing ask_gpt\n` +
          `  mgga doctor [--config FILE]\n`,
      );
      return command === 'help' ? 0 : 1;
  }
}

/** `mgga ask` — one question in, one answer out; the whole pipeline, no server. */
async function ask(args: string[]): Promise<number> {
  let model: string | undefined;
  let system: string | undefined;
  let configPath: string | undefined;
  let backendName: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-m' || arg === '--model') model = args[++i];
    else if (arg === '-s' || arg === '--system') system = args[++i];
    else if (arg === '--config') configPath = args[++i];
    else if (arg === '--backend') backendName = args[++i];
    else positional.push(arg);
  }

  const stdinText = process.stdin.isTTY ? '' : (await readAll(process.stdin)).trim();
  const prompt = [positional.join(' ').trim(), stdinText].filter(Boolean).join('\n\n');
  if (!prompt) {
    process.stderr.write('usage: mgga ask [-m model[:effort]] [-s system] "question"   (or pipe stdin)\n');
    return 1;
  }

  const cfg = loadConfig(configPath);
  if (backendName) cfg.backend = backendName as ResolvedConfig['backend'];
  const backend = await createBackend(cfg);

  const answer = await askOnce(cfg, backend, {
    prompt,
    ...(model !== undefined ? { model } : {}),
    ...(system !== undefined ? { system } : {}),
  });
  process.stderr.write(`[mgga] ${answer.model}${answer.effort ? ` @ ${answer.effort}` : ''}\n`);
  process.stdout.write(`${answer.text}\n`);
  return 0;
}

function readAll(stream: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => (data += chunk));
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

async function serve(flags: Record<string, string>): Promise<number> {
  const cfg = applyFlagOverrides(loadConfig(flags['config']), flags);
  const backend = await createBackend(cfg);
  const server = createMggaServer(cfg, backend);

  await new Promise<void>((resolve) => server.listen(cfg.port, resolve));
  process.stdout.write(
    `mgga v${VERSION} listening on http://localhost:${cfg.port} (backend: ${backend.name})\n\n` +
      `Point Claude Code at it:\n` +
      `  export ANTHROPIC_BASE_URL=http://localhost:${cfg.port}\n` +
      `  export ANTHROPIC_AUTH_TOKEN=mgga   # any value unless MGGA_API_KEY is set\n` +
      `  claude --model gpt-5.6-sol\n`,
  );
  // Runs until killed; the promise below never resolves on purpose.
  await new Promise<never>(() => {});
  return 0;
}

/** Everything `mgga doctor` prints. Pure function of config — tested in tests/doctor.test.ts. */
export function buildDoctorReport(cfg: ResolvedConfig): string {
  const lines: string[] = [];
  lines.push(`mgga v${VERSION} doctor`);
  lines.push('');
  lines.push(`config   : ${cfg.source}`);
  lines.push(`port     : ${cfg.port}`);
  lines.push(`backend  : ${cfg.backend}${describeCredentials(cfg)}`);
  lines.push(`default  : ${cfg.defaultModel}`);
  lines.push('');

  lines.push('models:');
  for (const [slug, profile] of Object.entries(cfg.models)) {
    lines.push(`  ${slug.padEnd(16)} efforts=${profile.efforts.join('/')} shim=${profile.shim !== false}`);
  }
  lines.push('');

  lines.push('aliases (pattern → model):');
  for (const [pattern, target] of Object.entries(cfg.aliases)) {
    lines.push(`  ${pattern.padEnd(20)} → ${target}`);
  }
  lines.push('');

  lines.push('fixer pipeline:');
  for (const fixer of ALL_FIXERS) {
    const badge = fixer.status === 'ready' ? '[ready]' : '[stub] ';
    lines.push(`  ${badge} ${fixer.name.padEnd(20)} ${fixer.why}`);
  }
  lines.push('');

  const stubs = ALL_FIXERS.filter((f) => f.status === 'stub').length;
  lines.push(
    stubs === 0
      ? 'all fixers ready.'
      : `${stubs} fixer(s) are architecture stubs — \`npm test\` names the missing pieces.`,
  );
  lines.push('');
  return lines.join('\n');
}

function describeCredentials(cfg: ResolvedConfig): string {
  switch (cfg.backend) {
    case 'openai': {
      const envVar = cfg.openai.apiKeyEnv ?? 'OPENAI_API_KEY';
      return process.env[envVar] ? ` (${envVar}: set)` : ` (${envVar}: MISSING)`;
    }
    case 'chatgpt': {
      const home = process.env['CODEX_HOME'] ?? cfg.chatgpt.codexHome ?? join(homedir(), '.codex');
      const authPath = join(home, 'auth.json');
      return existsSync(authPath) ? ` (auth: ${authPath})` : ` (auth: ${authPath} MISSING — run \`codex login\`)`;
    }
    case 'mock':
      return ' (no credentials needed)';
  }
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) continue;
    flags[arg.slice(2)] = args[i + 1] && !args[i + 1]!.startsWith('--') ? args[++i]! : 'true';
  }
  return flags;
}

function applyFlagOverrides(cfg: ResolvedConfig, flags: Record<string, string>): ResolvedConfig {
  const out = { ...cfg };
  if (flags['port']) out.port = Number(flags['port']);
  if (flags['backend']) out.backend = flags['backend'] as ResolvedConfig['backend'];
  return out;
}

// Only run the CLI when executed directly (`mgga …`), not when imported by tests.
const invokedDirectly = process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('mgga');
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exitCode = code,
    (err) => {
      console.error(`[mgga] fatal: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
