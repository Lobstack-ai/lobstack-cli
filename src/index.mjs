#!/usr/bin/env node
/**
 * lobstack — the Gateway from a terminal.
 *
 *   npx lobstack                    the interactive UI, when there is a
 *                                   terminal on both ends and a key to use
 *   npx lobstack tui                the same thing, asked for by name
 *   npx lobstack init
 *   npx lobstack chat "say hello"
 *   npx lobstack models
 *   npx lobstack spend
 *   npx lobstack proxy
 *
 * Zero dependencies, on purpose. `fetch`, `node:http` and `node:readline` are
 * all in the runtime, so `npx lobstack` starts immediately instead of resolving
 * a tree first — and there is no supply chain between a user's key and us.
 *
 * That still holds with a full-screen UI in the box. `node:readline` already
 * has the escape-sequence decoder, and the rest of a TUI is nine escape
 * sequences written by hand in tty.mjs. A process that holds an `lsk_live_`
 * credential does not get to pull a dependency tree to draw a box.
 */

import { readConfig, writeConfig, resolveKey, resolveBase, gatewayUrl, CONFIG_PATH } from './config.mjs';
import { printReceipt, dim, bold, green, money, fail } from './render.mjs';
import { gwFetch, errorText, fetchModels, fetchUsage, streamCompletion } from './gateway.mjs';
import { startProxy } from './proxy.mjs';
import { detect } from './tty.mjs';
import { runTui, runLineMode, readAll } from './tui.mjs';
import { createInterface } from 'node:readline/promises';

const HELP = `${bold('lobstack')} - one key, every model, and what each call cost.

  ${bold('lobstack')}                       the interactive UI: watch the cost as it happens
  ${bold('lobstack init')}                  save an API key to ${CONFIG_PATH}
  ${bold('lobstack chat')} "<prompt>"       one call, streamed, with the receipt
  ${bold('lobstack models')}                what the gateway will serve, and at what price
  ${bold('lobstack spend')} [--days 7]      what you have spent, from the usage API
  ${bold('lobstack proxy')} [--port 8787]   a local OpenAI-compatible endpoint

${dim('Options')}
  --model <key>     default: auto (let the router choose)
  --key <lsk_...>   override the saved key for one command
  --base <url>      override the gateway host
  --json            machine-readable output where it makes sense
  --force           draw the UI even where the streams do not look like a terminal

${dim('Environment')}
  LOBSTACK_API_KEY, LOBSTACK_BASE_URL - both win over the saved config.
  NO_COLOR, TERM=dumb, LOBSTACK_ASCII - all respected.
`;

/** Flags that take no value. Everything else consumes the next argument. */
const BOOLEAN_FLAGS = new Set(['json', 'force']);

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && BOOLEAN_FLAGS.has(a.slice(2))) out.flags[a.slice(2)] = true;
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

  const { usage, receipt, model: served } = await streamCompletion(b, key, {
    model,
    messages: [{ role: 'user', content: prompt }],
    onText: (t) => process.stdout.write(t),
  });
  process.stdout.write('\n');
  if (flags.json) {
    process.stdout.write(JSON.stringify({ usage, x_lobstack: receipt }, null, 2) + '\n');
  } else {
    printReceipt({ receipt, usage, model: served });
  }
}

/* ── models ────────────────────────────────────────────────────────────── */

async function cmdModels(flags) {
  const rows = await fetchModels(base(flags), requireKey(flags));

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
  const days = Number(flags.days || 7);
  const body = await fetchUsage(base(flags), requireKey(flags), days);

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

/* ── tui ───────────────────────────────────────────────────────────────── */

/**
 * The interactive UI, and every way out of it.
 *
 * Four cases, in the order they have to be checked. The whole point is that
 * `lobstack` in a pipeline behaves like a Unix program and `lobstack` at a
 * keyboard behaves like an application, with no flag to remember either way.
 *
 *   1. stdout is not a terminal - redirected, piped, or a CI log. Never draw.
 *      If stdin is not a terminal either there is nothing interactive about
 *      this invocation at all, so whatever came in on stdin is the prompt and
 *      the one-shot `chat` path runs: `echo hi | lobstack > out.txt` puts the
 *      answer in the file and nothing else.
 *   2. stdout is a terminal but stdin is a pipe. Same thing: the prompt arrived
 *      on stdin, there is no keyboard to run a UI with.
 *   3. Both are terminals but TERM says `dumb` - no cursor addressing exists,
 *      so a full-screen frame is not a degraded experience, it is garbage. Line
 *      mode instead.
 *   4. Draw.
 */
async function cmdTui(args, flags) {
  const key = requireKey(flags);
  const b = base(flags);
  const model = flags.model || 'auto';
  const force = Boolean(flags.force) || process.env.LOBSTACK_TUI === '1';
  const caps = detect({ force });

  const pipedPrompt = async () => {
    const typed = args.join(' ').trim();
    if (typed) return typed;
    return (await readAll(process.stdin)).trim();
  };

  if (!caps.outTTY) {
    if (!process.stdin.isTTY) {
      const prompt = await pipedPrompt();
      if (!prompt) {
        fail(
          'no terminal to draw on, and nothing on stdin.',
          'Run `lobstack` in a terminal, or pipe a prompt in: echo "hi" | lobstack',
        );
      }
      return cmdChat([prompt], flags);
    }
    // A keyboard on stdin, a file on stdout. Drawing would fill the file with
    // escape sequences, so this is the plain loop: answers to stdout, prompts
    // and receipts to stderr.
    process.stderr.write(dim('- stdout is not a terminal, so this is line mode\n'));
    return runLineMode({ key, base: b, model });
  }

  if (!caps.inTTY) {
    const prompt = await pipedPrompt();
    if (prompt) return cmdChat([prompt], flags);
  }

  if (!caps.fullscreen) {
    // Say which of the three reasons it was. "line mode" with no explanation
    // reads as a bug, and the fix differs for each: set TERM, or stop piping.
    const why = caps.dumb
      ? `TERM=${process.env.TERM} cannot address a cursor`
      : !caps.inTTY
        ? 'stdin is not a terminal'
        : 'stdout is not a terminal';
    process.stderr.write(dim(`- ${why}, so this is line mode\n`));
    return runLineMode({ key, base: b, model });
  }

  return runTui({ key, base: b, model, caps, initial: args.join(' ').trim() || null });
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
    case 'tui':
    case 'ui':
      await cmdTui(rest, flags);
      break;
    case undefined:
      // Bare `lobstack` opens the UI, but only when opening it is obviously
      // what was meant: a terminal on both ends and a key already available.
      // In a pipeline, in CI, or on a first run with no key, it prints the same
      // help it always printed - which is also the screen that tells you to run
      // `init`, so the no-key case still lands somewhere useful.
      if (
        (flags.force || (process.stdout.isTTY && process.stdin.isTTY)) &&
        (flags.key || resolveKey())
      ) {
        await cmdTui([], flags);
        break;
      }
      process.stdout.write(HELP);
      break;
    case 'help':
      process.stdout.write(HELP);
      break;
    default:
      fail(`unknown command "${command}".`, 'Run `lobstack help`.');
  }
} catch (err) {
  // `hint` is how gateway.mjs carries the second line of an error message out
  // of a throw. Without it a redirect would report "the gateway redirected"
  // and lose the sentence explaining that a redirect strips your key.
  fail(err instanceof Error ? err.message : String(err), err?.hint);
}
