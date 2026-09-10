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
    assert.match(stderr, /could not price/);
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
        assert.match(err.stderr, /redirected/);
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

test('reports spend, and names the saving', async () => {
  const gw = await startFakeGateway();
  try {
    const { stdout } = await invoke(['spend', '--base', gw.url]);
    assert.match(stdout, /3 requests/);
    assert.match(stdout, /saved/);
  } finally {
    gw.close();
  }
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
