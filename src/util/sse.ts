/**
 * Minimal Server-Sent-Events plumbing. Both sides of mgga are SSE: we parse
 * OpenAI's stream and emit Anthropic's. No dependency earns its keep here.
 */

export interface SseEvent {
  /** Value of the `event:` field, or null when the field is absent (OpenAI omits it). */
  event: string | null;
  data: string;
}

/** Serialise one Anthropic-style event (`event:` line + single `data:` line). */
export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Parse an SSE byte/text stream into events. Handles events split across
 * arbitrary chunk boundaries, CRLF, multi-line `data:` fields, and comment
 * lines. `[DONE]` sentinels are yielded like any other event — dropping them
 * is the caller's policy, not the parser's.
 */
export async function* parseSseStream(
  source: AsyncIterable<string | Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | null = null;
  let data: string[] = [];

  function* flush(): Generator<SseEvent> {
    if (data.length > 0) yield { event, data: data.join('\n') };
    event = null;
    data = [];
  }

  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        yield* flush();
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trimStart();
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).trimStart());
      }
      // Comments (`:`) and unknown fields are ignored per the SSE spec.
    }
  }
  yield* flush();
}
