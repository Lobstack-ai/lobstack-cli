/**
 * A stand-in Gateway, so the CLI can be tested against real bytes.
 *
 * It speaks the shapes that matter and nothing else: an SSE completion whose
 * final frame carries `x_lobstack`, a `/models` listing with prices, and a
 * usage summary. The stream is written in awkwardly-sized pieces on purpose —
 * a frame is split across two writes — because that is the failure the CLI's
 * buffer exists to survive, and a fixture that always sends whole frames tests
 * nothing.
 */
import { createServer } from 'node:http';

const FRAMES = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
  { choices: [{ index: 0, delta: { content: 'Hello' } }] },
  { choices: [{ index: 0, delta: { content: ' there' } }] },
  { choices: [{ index: 0, delta: {} , finish_reason: 'stop' }] },
  {
    choices: [],
    model: 'claude-haiku-4-5',
    usage: { prompt_tokens: 400, completion_tokens: 140, total_tokens: 540 },
    x_lobstack: {
      request_id: 'req_test',
      served_model: 'claude-haiku-4-5',
      requested_model: 'claude-opus-5',
      routed: true,
      cost_usd: 0.0011,
      savings_usd: 0.0044,
      priced: true,
      // A named baseline: the caller asked for opus-5 and the router served
      // haiku. That is the like-for-like case, and it is the only one the CLI
      // is allowed to print the word "saved" next to.
      baseline_reason: 'named',
      baseline_model: 'claude-opus-5',
      baseline_cost_usd: 0.0055,
    },
  },
];

export function startFakeGateway({ unpriced = false, ceilingBaseline = false } = {}) {
  const server = createServer(async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer lsk_')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'missing credentials' } }));
      return;
    }

    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'claude-haiku-4-5', tier: 'small', price_per_mtok: { input: 1, output: 5 } },
            { id: 'claude-opus-5', tier: 'flagship', price_per_mtok: { input: 5, output: 25 } },
          ],
        }),
      );
      return;
    }

    if (req.url?.includes('/api/v1/usage')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          summary: { requests: 3, cost_usd: 0.0033, savings_usd: 0.0132 },
          groups: [{ key: 'claude-haiku-4-5', requests: 3, cost_usd: 0.0033 }],
        }),
      );
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frames = FRAMES.map((f) => {
      if (!f.x_lobstack) return f;
      if (unpriced) {
        return { ...f, x_lobstack: { ...f.x_lobstack, cost_usd: null, savings_usd: null, priced: false } };
      }
      if (ceilingBaseline) {
        // Nobody asked for the baseline model here. The receipt has to say so.
        return {
          ...f,
          x_lobstack: {
            ...f.x_lobstack,
            requested_model: 'auto',
            baseline_reason: 'plan_ceiling',
            baseline_model: 'claude-fable-5-1',
          },
        };
      }
      return f;
    });
    const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';

    // Cut mid-frame. Whole-frame writes would never exercise the buffer.
    const cut = Math.floor(text.length * 0.37);
    res.write(text.slice(0, cut));
    await new Promise((r) => setTimeout(r, 10));
    res.write(text.slice(cut));
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}
