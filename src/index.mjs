#!/usr/bin/env node
/**
 * lobstack — the Gateway from a terminal.
 *
 *   npx lobstack init
 *   npx lobstack chat "say hello"
 *   npx lobstack models
 *   npx lobstack spend
 *   npx lobstack proxy
 *
 * Zero dependencies, on purpose. `fetch`, `node:http` and `node:readline` are
 * all in the runtime, so `npx lobstack` starts immediately instead of resolving
 * a tree first — and there is no supply chain between a user's key and us.
 */

import { readConfig, writeConfig, resolveKey, resolveBase, gatewayUrl, CONFIG_PATH } from './config.mjs';
import { consume } from './stream.mjs';
import { printReceipt, dim, bold, green, money, fail } from './render.mjs';
import { startProxy } from './proxy.mjs';
import { createInterface } from 'node:readline/promises';

const HELP = `${bold('lobstack')} - one key, every model, and what each call cost.

  ${bold('lobstack init')}                 save an API key to ${CONFIG_PATH}
  ${bold('lobstack chat')} "<prompt>"      one call, streamed, with the receipt
  ${bold('lobstack models')}               what the gateway will serve, and at what price
  ${bold('lobstack spend')} [--days 7]     what you have spent, from the usage API
  ${bold('lobstack proxy')} [--port 8787]  a local OpenAI-compatible endpoint

${dim('Options')}
  --model <key>     default: auto (let the router choose)
  --key <lsk_...>   override the saved key for one command
  --base <url>      override the gateway host
  --json            machine-readable output where it makes sense

${dim('Environment')}
  LOBSTACK_API_KEY, LOBSTACK_BASE_URL - both win over the saved config.
`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.flags.json = true;
    else if (a.startsWith('--')) out.flags[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

function requireKey(flags) {
  const key = flags.key || resolveKey();
  if (!key) {
    fail(
      'no API key.',
      'Run `lobstack init`, or set LOBSTACK_API_KEY. Get a key at https://www.lobstack.ai/start',
    );
  }
  return key;
}

function base(flags) {
  const { base: b, corrected } = resolveBase(flags.base);
  if (corrected) {
    // Not a silent fix. The apex redirects to www, and every HTTP client drops
    // Authorization when a redirect changes host, so honouring what was typed
    // would answer a valid key with "missing credentials" - which is precisely
    // the bug that made this gateway look broken for three months.
    process.stderr.write(
      dim(`- using ${b} - the bare domain redirects, and a redirect drops your Authorization header\n`),
    );
  }
  return b;
}

async function gwFetch(url, key, init = {}) {
  const res = await fetch(url, {
    ...init,
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'x-lobstack-client': 'lobstack-cli',
      ...(init.headers || {}),
    },
  });
  if (res.status >= 300 && res.status < 400) {
    fail(
      `the gateway redirected to ${res.headers.get('location') || 'somewhere else'}.`,
      'A redirect strips your key. Point --base at the host that answers directly.',
    );
  }
  return res;
}

async function errorText(res) {
  const id = res.headers.get('x-lobstack-request-id');
  let msg = `${res.status}`;
  try {
    const body = await res.json();
    msg = body?.error?.message || body?.error || msg;
  } catch {
    /* not JSON */
  }
  return id ? `${msg} (request ${id})` : msg;
}

/* ── init ──────────────────────────────────────────────────────────────── */

async function cmdInit(flags) {
  let key = flags.key;
  if (!key) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(
      `Get a key at ${bold('https://www.lobstack.ai/start')} - it is free and takes a minute.\n\n`,
    );
    key = (await rl.question('Paste your key (lsk_live_...): ')).trim();
    rl.close();
  }
  if (!/^lsk_(live|test)_[0-9a-f]{56}$/.test(key)) {
    fail(
      'that does not look like a Lobstack key.',
      'A key is lsk_live_ or lsk_test_ followed by 56 hex characters.',
    );
  }

  // Verified before saving. Writing an unusable key to disk just moves the
  // failure to the next command, where it is harder to explain.
  const b = base(flags);
  process.stdout.write(dim('checking the key...\n'));
  const res = await gwFetch(gatewayUrl(b, '/models'), key);
  if (!res.ok) fail(`the gateway rejected that key: ${await errorText(res)}`);

  writeConfig({ ...readConfig(), key, baseUrl: b });
  process.stdout.write(
    `\n${green('Saved')} to ${CONFIG_PATH} ${dim('(0600)')}\n\n` +
      `Try it:  ${bold('lobstack chat "say hello"')}\n`,
  );
}

/* ── chat ──────────────────────────────────────────────────────────────── */

async function cmdChat(args, flags) {
  const prompt = args.join(' ').trim();
  if (!prompt) fail('nothing to send.', 'lobstack chat "your prompt here"');

  const key = requireKey(flags);
  const b = base(flags);
  const model = flags.model || 'auto';

  const res = await gwFetch(gatewayUrl(b, '/chat/completions'), key, {
    method: 'POST',
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!res.ok || !res.body) fail(await errorText(res));

  const { usage, receipt, model: served } = await consume(res.body, (t) => process.stdout.write(t));
  process.stdout.write('\n');
  if (flags.json) {
    process.stdout.write(JSON.stringify({ usage, x_lobstack: receipt }, null, 2) + '\n');
  } else {
    printReceipt({ receipt, usage, model: served });
  }
}

/* ── models ────────────────────────────────────────────────────────────── */

async function cmdModels(flags) {
  const key = requireKey(flags);
  const res = await gwFetch(gatewayUrl(base(flags), '/models'), key);
  if (!res.ok) fail(await errorText(res));
  const body = await res.json();
  const rows = body.data ?? [];

  if (flags.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }

  const w = Math.max(...rows.map((m) => (m.id || '').length), 5);
  process.stdout.write(
    `${dim('MODEL'.padEnd(w))}  ${dim('TIER'.padEnd(9))}  ${dim('IN/M')}  ${dim('OUT/M')}\n`,
  );
  for (const m of rows) {
    const p = m.price_per_mtok || {};
    const price = (v) => (typeof v === 'number' ? `$${v}` : dim('-'));
    process.stdout.write(
      `${(m.id || '').padEnd(w)}  ${String(m.tier || '').padEnd(9)}  ${price(p.input).padEnd(6)}  ${price(p.output)}\n`,
    );
  }
  process.stdout.write(
    `\n${dim(`${rows.length} models. Send "auto" and the router picks one, then tells you which.`)}\n`,
  );
}

/* ── spend ─────────────────────────────────────────────────────────────── */

async function cmdSpend(flags) {
  const key = requireKey(flags);
  const days = Number(flags.days || 7);
  const range = `${days}d`;
  const res = await gwFetch(`${base(flags)}/api/v1/usage?range=${range}&group_by=model`, key);
  if (!res.ok) {
    const msg = await errorText(res);
    fail(
      msg,
      res.status === 403
        ? 'This key needs the "usage:read" scope. Mint one in Console > API keys.'
        : undefined,
    );
  }
  const body = await res.json();

  if (flags.json) {
    process.stdout.write(JSON.stringify(body, null, 2) + '\n');
    return;
  }
  if (body.enabled === false) {
    fail(body.message || 'usage reporting is not enabled on this deployment.');
  }

  const s = body.summary || {};
  process.stdout.write(
    `${bold(`Last ${days} days`)}  ${dim('-')}  ` +
      `${s.requests ?? 0} requests  ${dim('-')}  ${money(Number(s.cost_usd ?? 0))}` +
      (Number(s.savings_usd ?? 0) > 0 ? `  ${dim('-')}  saved ${green(money(Number(s.savings_usd)))}` : '') +
      '\n\n',
  );
  for (const g of body.groups ?? []) {
    process.stdout.write(
      `  ${String(g.key ?? '').padEnd(24)} ${String(g.requests ?? 0).padStart(6)}  ${money(Number(g.cost_usd ?? 0))}\n`,
    );
  }
}

/* ── main ──────────────────────────────────────────────────────────────── */

const { _: positional, flags } = parseArgs(process.argv.slice(2));
const [command, ...rest] = positional;

try {
  switch (command) {
    case 'init':
      await cmdInit(flags);
      break;
    case 'chat':
      await cmdChat(rest, flags);
      break;
    case 'models':
      await cmdModels(flags);
      break;
    case 'spend':
      await cmdSpend(flags);
      break;
    case 'proxy':
      await startProxy({ key: requireKey(flags), base: base(flags), port: Number(flags.port || 8787) });
      break;
    case 'help':
    case undefined:
      process.stdout.write(HELP);
      break;
    default:
      fail(`unknown command "${command}".`, 'Run `lobstack help`.');
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
