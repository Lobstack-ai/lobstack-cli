/**
 * A stand-in Gateway, so the CLI can be tested against real bytes.
 *
 * It speaks the shapes that matter and nothing else: an SSE completion whose
 * final frame carries `x_lobstack`, a `/models` listing with prices, and a
 * usage summary. The stream is written in awkwardly-sized pieces on purpose —
 * a frame is split across two writes — because that is the failure the CLI's
 * buffer exists to survive, and a fixture that always sends whole frames tests
 * nothing.
 *
 * It also runs standalone, so the TUI can be driven against it by hand in a
 * real pty:
 *
 *   node cli/test/fake-gateway.mjs --port 8799
 */
import { createServer } from 'node:http';

const FRAMES = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
  { choices: [{ index: 0, delta: { content: 'Hello' } }] },
  { choices: [{ index: 0, delta: { content: ' there' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
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

/**
 * A longer answer, for exercising wrapping and scrolling in the TUI. Deltas are
 * deliberately mid-word in places: a renderer that assumes a delta is a whole
 * token draws a space that is not there.
 */
const LONG_DELTAS = [
  'A B-tree keeps sorted data in a shallow, ',
  'wide tree, so a looku',
  'p touches very few nodes even when the table is enormous. ',
  'Each node holds many keys and many child pointers, ',
  'which is what keeps the height down to three or four levels ',
  'for tables with billions of rows.\n\n',
  'That shape is chosen for disks, not for memory: ',
  'one node is one page, so one level of descent is one read.',
];

/**
 * @param {object} [o]
 * @param {boolean} [o.unpriced]        cost_usd null, priced false
 * @param {boolean} [o.ceilingBaseline] baseline_reason plan_ceiling
 * @param {boolean} [o.noReceipt]       no x_lobstack at all, like an older gateway
 * @param {boolean} [o.long]            the multi-paragraph answer
 * @param {number}  [o.slow]            ms between the two halves of the stream
 * @param {number}  [o.port]            fixed port; 0 (default) picks one
 */
export function startFakeGateway({
  unpriced = false,
  ceilingBaseline = false,
  noReceipt = false,
  long = false,
  slow = 10,
  port = 0,
} = {}) {
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
            { id: 'claude-fable-5-1', tier: 'frontier', price_per_mtok: { input: 9, output: 45 } },
            // No price at all. The listing has to render this without inventing
            // a zero, and the picker has to survive it.
            { id: 'llama-4-scout-local', tier: 'open', price_per_mtok: {} },
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
    const body = long
      ? [
          FRAMES[0],
          ...LONG_DELTAS.map((content) => ({ choices: [{ index: 0, delta: { content } }] })),
          FRAMES[3],
          FRAMES[4],
        ]
      : FRAMES;
    const frames = body.map((f) => {
      if (!f.x_lobstack) return f;
      if (noReceipt) {
        // An older gateway, or a non-Lobstack base URL: usage but no price.
        const rest = { ...f };
        delete rest.x_lobstack;
        return rest;
      }
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
    await new Promise((r) => setTimeout(r, slow));
    res.write(text.slice(cut));
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ url: `http://127.0.0.1:${addr.port}`, port: addr.port, close: () => server.close() });
    });
  });
}

// Standalone, for driving the TUI by hand in a pty.
if (process.argv[1] && process.argv[1].endsWith('fake-gateway.mjs')) {
  const flag = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i === -1 ? d : process.argv[i + 1];
  };
  const gw = await startFakeGateway({
    port: Number(flag('port', 0)),
    slow: Number(flag('slow', 10)),
    long: process.argv.includes('--long'),
    unpriced: process.argv.includes('--unpriced'),
    ceilingBaseline: process.argv.includes('--ceiling'),
    noReceipt: process.argv.includes('--no-receipt'),
  });
  process.stdout.write(`${gw.url}\n`);
}
