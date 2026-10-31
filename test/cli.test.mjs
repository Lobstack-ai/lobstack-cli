/**
 * The CLI, run as a subprocess against a real HTTP server.
 *
 *   node --test cli/test/
 *
 * Not unit tests around the functions. What can actually break here is at the
 * seams — a frame split by the network, a receipt read off the wrong field, a
 * redirect quietly eating the key — and none of those show up when you call
 * your own parser with a string you wrote.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { startFakeGateway } from './fake-gateway.mjs';
import { spendReport } from '../src/render.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
const KEY = 'lsk_live_' + 'a'.repeat(56);

/** Runs with a home directory of its own, so no test can read or write a real key. */
function invoke(args, env = {}) {
  return run('node', [CLI, ...args], {
    env: {
      ...process.env,
      HOME: '/tmp/lobstack-cli-test-home',
      USERPROFILE: '/tmp/lobstack-cli-test-home',
      LOBSTACK_API_KEY: KEY,
      NO_COLOR: '1',
      ...env,
    },
  });
}

test('streams the answer and prints the receipt the gateway sent', async () => {
  const gw = await startFakeGateway();
  try {
    const { stdout, stderr } = await invoke(['chat', 'hi', '--base', gw.url]);
    // The fixture cuts a frame in half mid-stream. Both halves have to arrive.
    assert.match(stdout, /Hello there/);
    assert.match(stderr, /claude-haiku-4-5/);
    assert.match(stderr, /\$0\.001100/);
    // Savings only when the router served something other than what was asked.
    assert.match(stderr, /saved/);
    assert.match(stderr, /\$0\.004400/);
    // The model asked for is named, because that is the baseline the saving
    // is measured against.
    assert.match(stderr, /claude-opus-5/);
  } finally {
    gw.close();
  }
});

test('will not call a plan-ceiling comparison a saving', async () => {
  // `auto` has no model the caller named, so the gateway measures against the
  // most expensive model the plan allows. That is a real comparison and it is
  // not the same claim, so the CLI must not print it as "saved" -- which is
  // exactly what it did before `baseline_reason` existed.
  const gw = await startFakeGateway({ ceilingBaseline: true });
  try {
    const { stderr } = await invoke(['chat', 'hi', '--base', gw.url]);
    assert.match(stderr, /vs ceiling/);
    assert.doesNotMatch(stderr, /saved/);
    // And it names the model it measured against, plus why.
    assert.match(stderr, /claude-fable-5-1/);
    assert.match(stderr, /you sent auto/);
  } finally {
    gw.close();
  }
});

test('the answer goes to stdout and the receipt to stderr', async () => {
  const gw = await startFakeGateway();
  try {
    const { stdout } = await invoke(['chat', 'hi', '--base', gw.url]);
    // `lobstack chat "..." > out.txt` must give the answer and nothing else.
    assert.equal(stdout.trim(), 'Hello there');
  } finally {
    gw.close();
  }
});

test('prints "unpriced" rather than $0.00 when the gateway could not price it', async () => {
  const gw = await startFakeGateway({ unpriced: true });
  try {
    const { stderr } = await invoke(['chat', 'hi', '--base', gw.url]);
    // Rendering a null cost as $0.00 writes off a real charge. That exact bug
    // ran for three months in the desktop client.
    assert.match(stderr, /unpriced/);
    assert.doesNotMatch(stderr, /\$0\.000000/);
    assert.match(stderr, /the Lobstack API could not price/);
  } finally {
    gw.close();
  }
});

test('--json emits the receipt verbatim', async () => {
  const gw = await startFakeGateway();
  try {
    const { stdout } = await invoke(['chat', 'hi', '--base', gw.url, '--json']);
    const parsed = JSON.parse(stdout.slice(stdout.indexOf('{')));
    assert.equal(parsed.x_lobstack.cost_usd, 0.0011);
    assert.equal(parsed.usage.prompt_tokens, 400);
  } finally {
    gw.close();
  }
});

test('refuses to follow a redirect instead of losing the key to it', async () => {
  // A redirect that changes host makes every HTTP client drop Authorization,
  // and the gateway then answers a perfectly good key with "missing
  // credentials". Failing loudly beats reporting an auth error for a
  // credential that was never sent.
  const redirector = createServer((_req, res) => {
    res.writeHead(307, { location: 'https://www.example.com/somewhere' });
    res.end();
  });
  await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${redirector.address().port}`;
  try {
    await assert.rejects(
      () => invoke(['models', '--base', url]),
      (err) => {
        assert.match(err.stderr, /the Lobstack API redirected/);
        assert.match(err.stderr, /strips your key/);
        return true;
      },
    );
  } finally {
    redirector.close();
  }
});

test('rewrites the bare apex to the host that answers', async () => {
  // A pure-function test on purpose. The first version of this ran the CLI
  // against `--base https://lobstack.ai` and asserted it failed — but the
  // rewrite works, so it reached the real gateway and succeeded, and the test
  // was asserting the bug rather than the fix. It was also quietly making a
  // network call to production on every run.
  const { resolveBase } = await import('../src/config.mjs');

  const apex = resolveBase('https://lobstack.ai');
  assert.equal(apex.base, 'https://www.lobstack.ai');
  assert.equal(apex.corrected, true, 'the correction must be announced, not silent');

  const already = resolveBase('https://www.lobstack.ai');
  assert.equal(already.base, 'https://www.lobstack.ai');
  assert.equal(already.corrected, false, 'nothing to announce when it is already right');

  // Someone else's host is left exactly as given — this rewrite is about one
  // known redirect, not a policy about other people's domains.
  const other = resolveBase('http://127.0.0.1:9999');
  assert.equal(other.base, 'http://127.0.0.1:9999');
  assert.equal(other.corrected, false);
});

test('lists models with their prices', async () => {
  const gw = await startFakeGateway();
  try {
    const { stdout } = await invoke(['models', '--base', gw.url]);
    assert.match(stdout, /claude-opus-5/);
    assert.match(stdout, /flagship/);
    assert.match(stdout, /\$5/);
  } finally {
    gw.close();
  }
});

test('reports the ledger figure the Console shows, and the two savings apart', async () => {
  const gw = await startFakeGateway();
  try {
    const { stdout } = await invoke(['spend', '--base', gw.url]);
    assert.match(stdout, /^Last 7 days: 3 requests, \$0\.004100$/m, 'spend.cost_usd, the Console figure');
    assert.doesNotMatch(stdout, /\$0\.003300/, 'summary.cost_usd is the legacy copy');
    assert.match(stdout, /saved \$0\.0132 on models you named, on 2 requests/);
    assert.match(stdout, /vs ceiling \$0\.5000 on 1 auto request - .*not a saving/);
    assert.doesNotMatch(stdout, /\$0\.5132/, 'the two savings are never added together');
    assert.doesNotMatch(stdout, /legacy/);
  } finally {
    gw.close();
  }
});

test('falls back to the legacy figure only when the ledger could not be read, and says so', async () => {
  const gw = await startFakeGateway({ ledgerUnreadable: true });
  try {
    const { stdout } = await invoke(['spend', '--base', gw.url]);
    assert.match(stdout, /\$0\.003300/);
    assert.match(stdout, /billing ledger could not be read/);
    assert.match(stdout, /legacy summary\.cost_usd/);
    assert.doesNotMatch(stdout, /saved|vs ceiling/);
  } finally {
    gw.close();
  }
});

test('spendReport: an older deployment with no ledger block falls back, and says so', () => {
  const r = spendReport({ summary: { requests: 2, cost_usd: 0.02, unpriced_requests: 1 }, groups: [] }, 7);
  assert.match(r.head, /\$0\.0200/);
  assert.match(r.notes.join('\n'), /does not report the billing ledger/);
  assert.match(r.notes.join('\n'), /1 request could not be priced/);
});

test('spendReport: the floor is counted on the ledger\'s own rows, and all-unpriced is not $0', () => {
  const r = spendReport(
    { summary: { requests: 4, cost_usd: 0, unpriced_requests: 0 }, spend: { cost_usd: 0, rows: 2, unpriced_rows: 2 }, groups: [] },
    30,
  );
  assert.match(r.head, /last 30 days: 4 requests, unpriced$/);
  assert.match(r.notes.join('\n'), /2 rows could not be priced/);
});

test('help names the Lobstack API, not the gateway', async () => {
  const { stdout } = await invoke(['--help']);
  assert.match(stdout, /what the Lobstack API will serve/);
  assert.match(stdout, /override the Lobstack API host/);
  assert.doesNotMatch(stdout, /the gateway/i);
});

test('says what to do when there is no key at all', async () => {
  await assert.rejects(
    () => invoke(['chat', 'hi'], { LOBSTACK_API_KEY: '' }),
    (err) => {
      assert.match(err.stderr, /no API key/);
      assert.match(err.stderr, /lobstack init/);
      return true;
    },
  );
});

test('rejects a malformed key at init rather than saving it', async () => {
  await assert.rejects(
    () => invoke(['init', '--key', 'not-a-key']),
    (err) => {
      // Writing an unusable key to disk moves the failure to the next command,
      // where it is much harder to explain.
      assert.match(err.stderr, /does not look like a Lobstack key/);
      return true;
    },
  );
});

test('the proxy forwards a stream and reports what it cost', async () => {
  const gw = await startFakeGateway();
  const port = 8791;
  const proxy = execFile('node', [CLI, 'proxy', '--base', gw.url, '--port', String(port)], {
    env: { ...process.env, LOBSTACK_API_KEY: KEY, NO_COLOR: '1' },
  });
  try {
    await new Promise((r) => setTimeout(r, 700));
    // The caller sends no Lobstack key: that is the point. The proxy holds it.
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer anything' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /Hello/);
    assert.match(text, /x_lobstack/);
    assert.match(text, /\[DONE\]/);
  } finally {
    proxy.kill();
    gw.close();
  }
});

/* ── 0.2.0: embeddings, search, spend windows, error classes ───────────── */

test('embed sends the model and dimensions, and prints the size and the header cost', async () => {
  const gw = await startFakeGateway();
  try {
    const { stdout, stderr } = await invoke([
      'embed', 'why did the deploy roll back', '--model', 'text-embedding-3-large', '--dimensions', '256', '--tag', 'acme', '--base', gw.url,
    ]);
    const req = gw.seen.find((r) => r.url.endsWith('/embeddings'));
    assert.equal(req.method, 'POST');
    assert.equal(req.body.input, 'why did the deploy roll back');
    assert.equal(req.body.model, 'text-embedding-3-large');
    assert.equal(req.body.dimensions, 256);
    assert.equal(req.headers['x-lobstack-client-tag'], 'acme');
    assert.match(stdout, /^256 dimensions/);
    // Eight decimal places on the wire; a tiny cost must not print as zero.
    assert.match(stderr, /\$0\.000000/);
    assert.doesNotMatch(stderr, /unpriced/);
    assert.match(stderr, /tokens 6/);
  } finally {
    gw.close();
  }
});

test('embed --json carries the full vector and the receipt', async () => {
  const gw = await startFakeGateway();
  try {
    const { stdout } = await invoke(['embed', 'hello', '--json', '--base', gw.url]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.data[0].embedding.length, 1536);
    assert.equal(parsed.x_lobstack.cost_usd, 1.2e-7);
    assert.equal(parsed.x_lobstack.priced, true);
  } finally {
    gw.close();
  }
});

test('search prints results with escapes stripped, and the per-search cost', async () => {
  const gw = await startFakeGateway();
  try {
    const { stdout, stderr } = await invoke(['search', 'deploy rollback', '--count', '2', '--base', gw.url]);
    const req = gw.seen.find((r) => r.url.endsWith('/search'));
    assert.deepEqual(req.body, { query: 'deploy rollback', count: 2 });
    assert.match(stdout, /1\. Rollbacks/);
    assert.match(stdout, /https:\/\/example\.com\/rollbacks/);
    assert.equal(stdout.includes('\u001b'), false, 'a title must not carry an escape to the terminal');
    assert.match(stderr, /web-search/);
    assert.match(stderr, /\$0\.005000/);
    assert.match(stderr, /cache miss/);
  } finally {
    gw.close();
  }
});

test('a cached search says so and costs nothing', async () => {
  const gw = await startFakeGateway({ searchCached: true });
  try {
    const { stderr } = await invoke(['search', 'deploy rollback', '--base', gw.url]);
    assert.match(stderr, /cache hit/);
    assert.match(stderr, /cost \$0\.000000/);
  } finally {
    gw.close();
  }
});

test('search refuses a count the API would refuse', async () => {
  await assert.rejects(
    () => invoke(['search', 'x', '--count', '11', '--base', 'http://127.0.0.1:9']),
    (err) => {
      assert.match(err.stderr, /--count must be an integer from 1 to 10/);
      return true;
    },
  );
});

test('spend passes --range and --group-by through, and labels the grouping', async () => {
  const gw = await startFakeGateway();
  try {
    const { stdout } = await invoke(['spend', '--range', 'month', '--group-by', 'agent', '--client', 'acme', '--base', gw.url]);
    const req = gw.seen.find((r) => r.url.includes('/api/v1/usage'));
    const q = new URL(req.url, 'http://x').searchParams;
    assert.equal(q.get('range'), 'month');
    assert.equal(q.get('group_by'), 'agent');
    assert.equal(q.get('client'), 'acme');
    assert.match(stdout, /^This month: 3 requests, \$0\.004100$/m);
    assert.match(stdout, /AGENT/);
  } finally {
    gw.close();
  }
});

test('spend refuses a window the usage API would silently answer as 7d', async () => {
  await assert.rejects(
    () => invoke(['spend', '--days', '5', '--base', 'http://127.0.0.1:9']),
    (err) => {
      assert.match(err.stderr, /"5d" is not a window/);
      assert.match(err.stderr, /month \| 1d \| 7d/);
      return true;
    },
  );
  await assert.rejects(
    () => invoke(['spend', '--group-by', 'colour', '--base', 'http://127.0.0.1:9']),
    (err) => {
      assert.match(err.stderr, /"colour" is not a grouping/);
      return true;
    },
  );
});

test('a 402 names its class and code and says what to do', async () => {
  const gw = await startFakeGateway({
    fail: {
      status: 402,
      body: { error: { message: 'monthly allowance exhausted', type: 'quota', code: 402, error_code: 'ALLOWANCE_EXHAUSTED', request_id: 'req_err' } },
    },
  });
  try {
    await assert.rejects(
      () => invoke(['chat', 'hi', '--base', gw.url]),
      (err) => {
        assert.match(err.stderr, /monthly allowance exhausted \[402 quota ALLOWANCE_EXHAUSTED\] \(request req_err\)/);
        assert.match(err.stderr, /Top up or upgrade in Console > Billing/);
        return true;
      },
    );
  } finally {
    gw.close();
  }
});

test('a 429 puts the Retry-After in the hint', async () => {
  const gw = await startFakeGateway({
    fail: {
      status: 429,
      headers: { 'retry-after': '23' },
      body: { error: { message: 'rate limit', type: 'quota', code: 429, error_code: 'RATE_LIMITED' } },
    },
  });
  try {
    await assert.rejects(
      () => invoke(['search', 'x', '--base', gw.url]),
      (err) => {
        assert.match(err.stderr, /\[429 quota RATE_LIMITED\]/);
        assert.match(err.stderr, /Wait for 23s, then retry/);
        return true;
      },
    );
  } finally {
    gw.close();
  }
});

test('a 403 on spend names the usage:read scope', async () => {
  const gw = await startFakeGateway({ fail: { status: 403, body: { error: 'this API key lacks the "usage:read" scope' } } });
  try {
    await assert.rejects(
      () => invoke(['spend', '--base', gw.url]),
      (err) => {
        assert.match(err.stderr, /\[403 auth\]/);
        assert.match(err.stderr, /needs the "usage:read" scope/);
        return true;
      },
    );
  } finally {
    gw.close();
  }
});

test('the 503 SEARCH_UNAVAILABLE shape (a plain-string error) still maps to a hint', async () => {
  const gw = await startFakeGateway({
    fail: { status: 503, body: { error: 'search not configured', error_code: 'SEARCH_UNAVAILABLE', request_id: 'req_err' } },
  });
  try {
    await assert.rejects(
      () => invoke(['search', 'x', '--base', gw.url]),
      (err) => {
        assert.match(err.stderr, /search not configured \[503 provider SEARCH_UNAVAILABLE\]/);
        assert.match(err.stderr, /Use another search/);
        return true;
      },
    );
  } finally {
    gw.close();
  }
});

test('--tag sends the client tag on chat', async () => {
  const gw = await startFakeGateway();
  try {
    await invoke(['chat', 'hi', '--tag', 'acme', '--base', gw.url]);
    const req = gw.seen.find((r) => r.url.endsWith('/chat/completions'));
    assert.equal(req.headers['x-lobstack-client-tag'], 'acme');
  } finally {
    gw.close();
  }
});

test('models labels embedding rows and prices the router as -, not $0', async () => {
  const gw = await startFakeGateway();
  try {
    const { stdout } = await invoke(['models', '--base', gw.url]);
    assert.match(stdout, /text-embedding-3-small\s+embedding/);
    // The router has no price of its own: it costs whatever it picks.
    assert.match(stdout, /^auto\s+router\s+-\s+-$/m);
    // An unpriced model is a dash, not a zero.
    assert.match(stdout, /^gpt-6-luna-unpriced\s+nano\s+-\s+-$/m);
  } finally {
    gw.close();
  }
});

test('help lists every command and the spend options the API accepts', async () => {
  const { stdout } = await invoke(['--help']);
  for (const c of ['init', 'chat', 'embed', 'search', 'models', 'spend', 'proxy']) {
    assert.match(stdout, new RegExp(`lobstack ${c}`));
  }
  assert.match(stdout, /month \| 1d \| 7d \| 14d \| 30d \| 90d \| 365d/);
  assert.match(stdout, /day \| model \| key \| agent \| provider \| mode \| client \| app/);
});

test('names only the four US model providers, nowhere DeepSeek', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = ['README.md', 'package.json', ...readdirSync(`${root}/src`).map((f) => `src/${f}`)];
  for (const f of files) {
    const text = readFileSync(`${root}/${f}`, 'utf8');
    assert.doesNotMatch(text, /deepseek|mistral|qwen|five (model )?providers/i, `${f} names a provider Lobstack does not serve`);
  }
  const { stdout } = await invoke(['--help']);
  assert.match(stdout, /Anthropic, OpenAI, Google and xAI/);
});
