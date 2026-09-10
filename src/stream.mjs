/**
 * Read an OpenAI-compatible SSE stream, and keep the receipt.
 *
 * Two things here are load-bearing.
 *
 * The splitter buffers across chunk boundaries. A JSON frame can be cut in the
 * middle by the network, and parsing per chunk instead of per frame drops
 * tokens — which surfaces as answers that end mid-sentence and that nobody can
 * reproduce.
 *
 * The last frame carries `x_lobstack`. That is where the Gateway puts the price
 * on a streamed response, because headers are written before the provider has
 * counted a token. Pricing the token counts against a local rate card instead
 * is exactly what our own desktop client did, and it printed $0.00 for three
 * months next to a correct invoice. This reads the number the seller sent.
 */

export async function* sseFrames(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload) yield payload;
      }
    }
  }
}

/**
 * Consume a completion stream. Calls `onText` per delta; returns the receipt.
 */
export async function consume(body, onText) {
  let text = '';
  let usage = null;
  let receipt = null;
  let model = null;

  for await (const payload of sseFrames(body)) {
    if (payload === '[DONE]') break;
    let frame;
    try {
      frame = JSON.parse(payload);
    } catch {
      continue; // a half-frame is not worth ending a turn over
    }
    if (frame.error) {
      throw new Error(frame.error.message || 'the gateway reported an error mid-stream');
    }
    if (frame.model) model = frame.model;
    if (frame.usage) usage = frame.usage;
    if (frame.x_lobstack) receipt = frame.x_lobstack;

    const delta = frame.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length) {
      text += delta;
      onText?.(delta);
    }
  }
  return { text, usage, receipt, model };
}
