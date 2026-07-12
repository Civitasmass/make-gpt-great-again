import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createMggaServer } from '../src/server.js';
import { MockBackend, scriptTextResponse, scriptToolCall } from '../src/backends/mock.js';
import type { Backend } from '../src/backends/backend.js';
import type { ResponsesRequest } from '../src/types/openai.js';
import { testConfig } from './helpers.js';

/**
 * Full wire-path test: a real HTTP server, a scripted backend, real SSE over
 * the socket. This is the test that proves "Claude Code can point at mgga" —
 * everything between the socket and the backend (routing, fixers, both
 * translators, serialisation) has to hold hands correctly.
 */
let server: Server;
let base: string;

beforeAll(async () => {
  const cfg = testConfig({ backend: 'mock' });
  server = createMggaServer(cfg, MockBackend.fromEvents(scriptToolCall('Bash', '{"command":"ls"}')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('plumbing that works before the translator lands', () => {
  it('GET /healthz reports the backend', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, backend: 'mock' });
  });

  it('GET /v1/models lists the routing registry', async () => {
    const res = await fetch(`${base}/v1/models`);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toEqual(
      expect.arrayContaining(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']),
    );
  });

  it('POST /v1/messages/count_tokens answers the context meter', async () => {
    const res = await fetch(`${base}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'hello '.repeat(100) }],
      }),
    });
    expect(res.status).toBe(200);
    const { input_tokens } = (await res.json()) as { input_tokens: number };
    expect(input_tokens).toBeGreaterThan(50);
  });

  it('rejects invalid JSON bodies with an Anthropic-dialect 400', async () => {
    const res = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{nope' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
  });

  it('404s unknown routes in the Anthropic error dialect', async () => {
    const res = await fetch(`${base}/v1/complete`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'not_found_error' } });
  });
});

describe('the full round-trip (red until translate/* and fixers land)', () => {
  const request = {
    model: 'claude-opus-4-7',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'list files' }],
    tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
  };

  it('streams a complete Anthropic SSE session for a tool call', async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    const eventNames = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(eventNames[0]).toBe('message_start');
    expect(eventNames).toContain('content_block_start');
    expect(eventNames.at(-1)).toBe('message_stop');
    // The tool call surfaces with a bridged id and parseable args.
    expect(text).toContain('toolu_call_mock_1');
  });

  it('collects the same session into a non-streaming message', async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(res.status).toBe(200);
    const message = (await res.json()) as {
      content: Array<{ type: string; name?: string; input?: unknown }>;
      stop_reason: string;
    };
    expect(message.stop_reason).toBe('tool_use');
    expect(message.content[0]).toMatchObject({ type: 'tool_use', name: 'Bash', input: { command: 'ls' } });
  });
});

describe('auth gate', () => {
  it('enforces MGGA_API_KEY when configured', async () => {
    const cfg = testConfig({ backend: 'mock', apiKey: 'secret' });
    const gated = createMggaServer(cfg, MockBackend.hello());
    await new Promise<void>((resolve) => gated.listen(0, '127.0.0.1', resolve));
    const gatedBase = `http://127.0.0.1:${(gated.address() as AddressInfo).port}`;

    try {
      const denied = await fetch(`${gatedBase}/v1/messages`, { method: 'POST', body: '{}' });
      expect(denied.status).toBe(401);

      const counted = await fetch(`${gatedBase}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'x-api-key': 'secret', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(counted.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => gated.close(() => resolve()));
    }
  });
});

describe('GET /quota', () => {
  it('hints when no quota has been observed yet (mock backend has none)', async () => {
    const res = await fetch(`${base}/quota`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { note: string }).note).toContain('no quota data');
  });

  it('serves the backend snapshot once one exists', async () => {
    const withQuota: Backend = {
      name: 'mock',
      quota: () => ({
        capturedAt: '2026-07-12T04:00:00.000Z',
        planType: 'pro',
        primary: { usedPercent: 1, windowMinutes: 300, resetsAt: '2026-07-12T07:10:43.000Z' },
      }),
      stream: (req, opts) => MockBackend.hello().stream(req, opts),
    };
    const server = createMggaServer(testConfig({ backend: 'mock' }), withQuota);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const body = (await (await fetch(`http://127.0.0.1:${port}/quota`)).json()) as {
        planType: string;
        primary: { usedPercent: number };
      };
      expect(body.planType).toBe('pro');
      expect(body.primary.usedPercent).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('mixed mode: anthropic passthrough', () => {
  /**
   * With anthropic.passthrough on, claude-* requests must reach Anthropic
   * BYTE-FOR-BYTE — same body (prompt-cache prefixes key on exact bytes),
   * same client credentials (mgga holds none) — while gpt-* requests on the
   * SAME server still run the translation pipeline. This is what lets a real
   * Claude session spawn GPT subagents natively.
   */
  it('forwards claude-* verbatim with client auth; gpt-* still runs the pipeline', async () => {
    let seen: { path?: string; auth?: string; body?: string } = {};
    const fakeAnthropic = createHttpServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c));
      req.on('end', () => {
        seen = { path: req.url ?? '', auth: req.headers.authorization as string, body };
        res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_fake_1' });
        res.end('event: message_start\ndata: {"type":"message_start"}\n\n');
      });
    });
    await new Promise<void>((resolve) => fakeAnthropic.listen(0, '127.0.0.1', resolve));

    const cfg = testConfig({ backend: 'mock' });
    cfg.anthropic = {
      baseUrl: `http://127.0.0.1:${(fakeAnthropic.address() as AddressInfo).port}`,
      passthrough: true,
    };
    const mixed = createMggaServer(cfg, MockBackend.hello());
    await new Promise<void>((resolve) => mixed.listen(0, '127.0.0.1', resolve));
    const mixedBase = `http://127.0.0.1:${(mixed.address() as AddressInfo).port}`;

    try {
      const raw = JSON.stringify({
        model: 'claude-opus-4-7',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const res = await fetch(`${mixedBase}/v1/messages?beta=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer client-owned-token' },
        body: raw,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('request-id')).toBe('req_fake_1'); // upstream headers surface
      expect(await res.text()).toContain('message_start');
      expect(seen.body).toBe(raw); // byte-for-byte — caching prefixes survive
      expect(seen.auth).toBe('Bearer client-owned-token'); // the CLIENT's credentials, not ours
      expect(seen.path).toBe('/v1/messages?beta=true'); // query string intact

      // Same server, gpt-* request → the normal pipeline (mock backend answers).
      const gpt = await fetch(`${mixedBase}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.6-sol', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(gpt.status).toBe(200);
      expect(((await gpt.json()) as { content: Array<{ text: string }> }).content[0]!.text).toContain(
        'Hello from mgga',
      );
    } finally {
      await new Promise<void>((resolve) => mixed.close(() => resolve()));
      await new Promise<void>((resolve) => fakeAnthropic.close(() => resolve()));
    }
  });
});

describe('backend dialect: unsupportedParams', () => {
  /**
   * Discovered live 2026-07-12: the ChatGPT codex endpoint 400s
   * "Unsupported parameter" on fields api.openai.com accepts
   * (max_output_tokens, truncation). Backends declare their dialect;
   * the SERVER strips those params after translation — backends still
   * never edit requests themselves.
   */
  it('strips params the backend declares unsupported, before the backend sees them', async () => {
    let seen: ResponsesRequest | undefined;
    const dialectBackend: Backend = {
      name: 'mock',
      unsupportedParams: ['max_output_tokens'],
      stream(req, opts) {
        seen = req;
        return MockBackend.fromEvents(scriptTextResponse('ok')).stream(req, opts);
      },
    };

    const server = createMggaServer(testConfig({ backend: 'mock' }), dialectBackend);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          max_tokens: 1024,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);
      expect(seen).toBeDefined();
      expect(seen!.max_output_tokens).toBeUndefined(); // stripped for this dialect
      expect(seen!.store).toBe(false); // everything else intact
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
