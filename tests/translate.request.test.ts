import { describe, expect, it } from 'vitest';
import { translateRequest } from '../src/translate/request.js';
import type { RequestContext } from '../src/pipeline/fixer.js';
import type { ResponsesFunctionCallItem, ResponsesInputMessage, ResponsesReasoningItem } from '../src/types/openai.js';
import { baseRequest, makeCtx } from './helpers.js';

/**
 * Request translation: Anthropic Messages → OpenAI Responses. The input here
 * is post-fixer (normalised), so these tests hand-set the ctx knobs the
 * fixers would have written. What they pin down is the SHAPE GPT sees —
 * especially history replay order, which is what keeps a multi-turn agent
 * coherent.
 */
function ctxWithKnobs(): RequestContext {
  const ctx = makeCtx('claude-opus-4-7');
  ctx.reasoningEffort = 'high';
  ctx.maxOutputTokens = 40_192;
  return ctx;
}

describe('translateRequest', () => {
  it('translates the minimal request with mgga invariants (stream/store/include/truncation)', () => {
    const out = translateRequest(baseRequest({ system: 'You are Claude Code.' }), ctxWithKnobs());

    expect(out.model).toBe('gpt-5.6-sol'); // routed target, not the client id
    expect(out.instructions).toBe('You are Claude Code.');
    expect(out.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
    expect(out).toMatchObject({
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'high', summary: 'auto' },
      max_output_tokens: 40_192,
    });
    // NOT sent, on purpose: the ChatGPT codex endpoint 400s on `truncation`
    // ("Unsupported parameter", verified live 2026-07-12) — and for an agent,
    // silent middle-of-context truncation is worse than a clean overflow.
    expect(out.truncation).toBeUndefined();
  });

  it('flattens block-array system prompts with blank-line joins', () => {
    const out = translateRequest(
      baseRequest({
        system: [
          { type: 'text', text: 'Part one.' },
          { type: 'text', text: 'Part two.' },
        ],
      }),
      ctxWithKnobs(),
    );
    expect(out.instructions).toBe('Part one.\n\nPart two.');
  });

  it('replays a full tool loop in order: reasoning → function_call → function_call_output', () => {
    const out = translateRequest(
      baseRequest({
        messages: [
          { role: 'user', content: 'list the repo' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'I should run ls', signature: 'ENCRYPTED_BLOB' },
              { type: 'tool_use', id: 'call_9f3a', name: 'Bash', input: { command: 'ls' } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_9f3a', content: 'src\ntests\n' }],
          },
        ],
      }),
      ctxWithKnobs(),
    );

    const kinds = out.input.map((item) => item.type);
    expect(kinds).toEqual(['message', 'reasoning', 'function_call', 'function_call_output']);

    const reasoning = out.input[1] as ResponsesReasoningItem;
    // The replay half of the signature trick: signature travels back as encrypted_content.
    expect(reasoning.encrypted_content).toBe('ENCRYPTED_BLOB');

    const call = out.input[2] as ResponsesFunctionCallItem;
    expect(call).toMatchObject({ call_id: 'call_9f3a', name: 'Bash' });
    expect(JSON.parse(call.arguments)).toEqual({ command: 'ls' });

    expect(out.input[3]).toMatchObject({ type: 'function_call_output', call_id: 'call_9f3a', output: 'src\ntests\n' });
  });

  it('prefixes failed tool results so the model sees the failure', () => {
    const out = translateRequest(
      baseRequest({
        messages: [
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ENOENT', is_error: true }] },
        ],
      }),
      ctxWithKnobs(),
    );
    expect(out.input[0]).toMatchObject({ type: 'function_call_output', output: 'ERROR: ENOENT' });
  });

  it('converts base64 images to data-URL input_image parts', () => {
    const out = translateRequest(
      baseRequest({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
            ],
          },
        ],
      }),
      ctxWithKnobs(),
    );
    const msg = out.input[0] as ResponsesInputMessage;
    expect(msg.content[1]).toEqual({
      type: 'input_image',
      image_url: 'data:image/png;base64,iVBORw0KGgo=',
    });
  });

  it('maps tools and tool_choice onto the OpenAI dialect', () => {
    const out = translateRequest(
      baseRequest({
        tools: [
          { name: 'Bash', description: 'Run shell', input_schema: { type: 'object', properties: { command: { type: 'string' } } } },
        ],
        tool_choice: { type: 'any', disable_parallel_tool_use: true },
      }),
      ctxWithKnobs(),
    );
    expect(out.tools).toEqual([
      {
        type: 'function',
        name: 'Bash',
        description: 'Run shell',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ]);
    expect(out.tool_choice).toBe('required'); // anthropic 'any' === openai 'required'
    expect(out.parallel_tool_calls).toBe(false);
  });

  it('pins a specific tool when tool_choice names one', () => {
    const out = translateRequest(
      baseRequest({
        tools: [{ name: 'Read', input_schema: { type: 'object' } }],
        tool_choice: { type: 'tool', name: 'Read' },
      }),
      ctxWithKnobs(),
    );
    expect(out.tool_choice).toEqual({ type: 'function', name: 'Read' });
  });

  it('drops sampling params reasoning models reject, with warnings — never a silent 400', () => {
    const ctx = ctxWithKnobs();
    const out = translateRequest(
      baseRequest({ temperature: 0.7, top_p: 0.9, top_k: 40, stop_sequences: ['\n\nHuman:'] }),
      ctx,
    );
    expect(out.temperature).toBeUndefined();
    expect(out.top_p).toBeUndefined();
    expect(ctx.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it('threads the prompt cache key through', () => {
    const ctx = ctxWithKnobs();
    ctx.promptCacheKey = 'user_5b1f';
    const out = translateRequest(baseRequest(), ctx);
    expect(out.prompt_cache_key).toBe('user_5b1f');
  });
});
