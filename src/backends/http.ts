import type { ResponsesRequest, ResponsesStreamEvent } from '../types/openai.js';
import { translateHttpError } from '../translate/errors.js';
import { parseSseStream } from '../util/sse.js';

/**
 * The one HTTP/SSE transport both real backends share. POST a Responses
 * request, stream back parsed events; non-2xx becomes an UpstreamError in the
 * Anthropic dialect (translate/errors.ts); an abort ends the stream quietly.
 */
export async function* streamResponses(
  url: string,
  headers: Record<string, string>,
  req: ResponsesRequest,
  signal: AbortSignal,
  /** Called once with the 2xx response before streaming — for header capture (quota etc.). */
  onResponse?: (res: Response) => void,
): AsyncGenerator<ResponsesStreamEvent> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...headers,
      },
      body: JSON.stringify(req),
      signal,
    });
  } catch (err) {
    if (isAbort(err, signal)) return;
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw translateHttpError(res.status, body, res.headers.get('retry-after') ?? undefined);
  }
  if (!res.body) {
    throw translateHttpError(502, 'upstream returned an empty response body');
  }
  onResponse?.(res);

  try {
    for await (const sse of parseSseStream(res.body)) {
      const data = sse.data.trim();
      if (data === '' || data === '[DONE]') continue;
      let parsed: ResponsesStreamEvent;
      try {
        parsed = JSON.parse(data) as ResponsesStreamEvent;
      } catch {
        continue; // malformed keep-alive noise — never kill a live stream over it
      }
      yield parsed;
    }
  } catch (err) {
    if (isAbort(err, signal)) return;
    throw err;
  }
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof Error && err.name === 'AbortError');
}
