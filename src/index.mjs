#!/usr/bin/env node
/**
 * lobstack — the Gateway from a terminal.
 *
 *   npx lobstack                    the interactive UI, when there is a
 *                                   terminal on both ends and a key to use
 *   npx lobstack tui                the same thing, asked for by name
 *   npx lobstack init
 *   npx lobstack chat "say hello"
 *   npx lobstack embed "some text"
 *   npx lobstack search "a query"
 *   npx lobstack models
 *   npx lobstack spend --range month --group-by day
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
import { printReceipt, dim, bold, green, money, fail, spendReport } from './render.mjs';
import {
  gwFetch,
  apiError,
  fetchModels,
  fetchUsage,
  streamCompletion,
  embed,
  search,
  USAGE_RANGES,
  USAGE_GROUPS,
} from './gateway.mjs';
import { startProxy } from './proxy.mjs';
import { detect, sanitize } from './tty.mjs';
import { runTui, runLineMode, readAll } from './tui.mjs';
import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';

const HELP = `${bold('lobstack')} - one key for Anthropic, OpenAI, Google and xAI models, and what each call cost.

  ${bold('lobstack')}                        the interactive UI: watch the cost as it happens
  ${bold('lobstack init')}                   save an API key to ${CONFIG_PATH}
  ${bold('lobstack chat')} "<prompt>"        one call, streamed, with the receipt
  ${bold('lobstack embed')} "<text>"         embed text; prints the vector size and the cost
  ${bold('lobstack search')} "<query>"       web search through the Lobstack API, priced per search
  ${bold('lobstack models')}                 what the Lobstack API will serve, and at what price
  ${bold('lobstack spend')}                  what you have spent, from the usage API (needs usage:read)
  ${bold('lobstack proxy')} [--port 8787]    a local OpenAI-compatible endpoint, loopback only

${dim('spend')}
  --range <r>       ${USAGE_RANGES.join(' | ')}  (default 7d; month is the UTC month to date)
  --days <n>        shorthand for --range <n>d
  --group-by <g>    ${USAGE_GROUPS.join(' | ')}  (default model)
  --client <tag>    only calls made for this client tag

${dim('embed')}
  --model <id>      text-embedding-3-small (default) or text-embedding-3-large
  --dimensions <n>  shorten the vector

${dim('search')}
  --count <n>       results, 1-10 (default 5)

${dim('Options')}
  --model <id>      chat model; default auto (Nex 1, the router, picks one)
  --tag <client>    client tag for chat, embed and search, for cost attribution
  --key <lsk_...>   override the saved key for one command
  --base <url>      override the Lobstack API host
  --json            machine-readable output
  --force           draw the UI even where the streams do not look like a terminal

${dim('Environment')}
  LOBSTACK_API_KEY, LOBSTACK_BASE_URL - both win over the saved config.
  NO_COLOR, TERM=dumb, LOBSTACK_ASCII - all respected.
`;

/**
 * Read from package.json rather than declared here.
 *
 * A version constant beside a version field is two places to bump and one
 * place to forget; `npm version` writes the manifest and nothing else, so the
 * manifest is the one that is always right.
 */
const VERSION = (() => {
  try {
    return JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ).version;
  } catch {
    return '0.0.0';
  }
})();


/**
 * Flags that take no value. Everything else consumes the next argument.
 *
 * `help` and `version` have to be in here, and their absence was not a
 * cosmetic bug. Anything not listed swallows the next argv item, so
 * `lobstack chat --version "hi"` ate the prompt and answered "nothing to
 * send", and a bare `--help` fell through to the no-command branch — which, in
 * a terminal with a key saved, opens the chat UI instead of printing anything.
 * `npx lobstack --help` is the first thing a new user types.
 */
const BOOLEAN_FLAGS = new Set(['json', 'force', 'help', 'version']);

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
  if (!res.ok) {
    const err = await apiError(res);
    fail(`the Lobstack API rejected that key: ${err.message}`, err.hint);
  }

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
    clientTag: flags.tag,
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
      `${(m.id || '').padEnd(w)}  ${String(m.type === 'embedding' ? 'embedding' : m.tier || '').padEnd(9)}  ${price(p.input).padEnd(6)}  ${price(p.output)}\n`,
    );
  }
  process.stdout.write(
    `\n${dim(`${rows.length} models. Send "auto" and Nex 1, the router, picks one and tells you which.`)}\n` +
      `${dim('Embedding models are for `lobstack embed`, not chat. Prices are USD per million tokens.')}\n`,
  );
}

/* ── spend ─────────────────────────────────────────────────────────────── */

/**
 * The window and grouping, checked against what `/api/v1/usage` accepts.
 *
 * The server answers an unknown `range` with 7d rather than an error, so
 * `--days 5` would quietly report a week. Refusing it here, with the list,
 * is kinder than a total for a window nobody asked for.
 */
function spendOptions(flags) {
  let range = flags.range;
  if (!range && flags.days !== undefined) range = `${Number(flags.days)}d`;
  range = range || '7d';
  if (!USAGE_RANGES.includes(range)) {
    fail(`"${range}" is not a window the usage API serves.`, `Use --range ${USAGE_RANGES.join(' | ')}.`);
  }
  const groupBy = flags['group-by'] || 'model';
  if (!USAGE_GROUPS.includes(groupBy)) {
    fail(`"${groupBy}" is not a grouping the usage API serves.`, `Use --group-by ${USAGE_GROUPS.join(' | ')}.`);
  }
  return { range, groupBy, client: flags.client };
}

async function cmdSpend(flags) {
  const opts = spendOptions(flags);
  const body = await fetchUsage(base(flags), requireKey(flags), opts);

  if (flags.json) {
    process.stdout.write(JSON.stringify(body, null, 2) + '\n');
    return;
  }
  if (body.enabled === false) {
    fail(body.message || 'usage reporting is not enabled on this deployment.');
  }

  const days = opts.range === 'month' ? 31 : parseInt(opts.range, 10);
  const r = spendReport(body, days);
  process.stdout.write(
    `${bold(r.head.charAt(0).toUpperCase() + r.head.slice(1))}\n\n` +
      (r.rows.length ? `  ${dim(String(body.group_by || opts.groupBy).toUpperCase())}\n` : '') +
      r.rows.map((row) => `${row}\n`).join('') +
      (r.savings.length ? `\n${r.savings.map((l) => `  ${l.startsWith('saved') ? green(l) : l}\n`).join('')}` : '') +
      (r.notes.length ? `\n${r.notes.map((l) => dim(`  ${l}\n`)).join('')}` : ''),
  );
}

/* ── embed ─────────────────────────────────────────────────────────────── */

/** One line of receipt for the two non-streamed endpoints, on stderr. */
function headerReceipt(receipt, extra = []) {
  const parts = [`${dim('model')} ${receipt.model || '?'}`, ...extra, `${dim('cost')} ${money(receipt.cost_usd)}`];
  if (receipt.cache) parts.push(`${dim('cache')} ${receipt.cache}`);
  process.stderr.write(dim('- ') + parts.join(dim('  -  ')) + '\n');
  if (receipt.cost_usd === null) {
    process.stderr.write(dim('  the Lobstack API could not price this call, so no cost is claimed\n'));
  }
  if (receipt.request_id) process.stderr.write(dim(`  request ${receipt.request_id}\n`));
}

async function cmdEmbed(args, flags) {
  const text = args.join(' ').trim() || (!process.stdin.isTTY ? (await readAll(process.stdin)).trim() : '');
  if (!text) fail('nothing to embed.', 'lobstack embed "your text here", or pipe it in on stdin.');
  const dimensions = flags.dimensions !== undefined ? Number(flags.dimensions) : undefined;
  if (dimensions !== undefined && !(Number.isInteger(dimensions) && dimensions > 0)) {
    fail('--dimensions must be a positive integer.');
  }

  const { body, receipt } = await embed(base(flags), requireKey(flags), {
    input: text,
    model: flags.model,
    dimensions,
    clientTag: flags.tag,
  });
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ...body, x_lobstack: receipt }, null, 2) + '\n');
    return;
  }
  const vec = body?.data?.[0]?.embedding;
  const len = Array.isArray(vec) ? vec.length : null;
  process.stdout.write(
    `${len ?? '?'} dimensions` +
      (Array.isArray(vec) ? `  [${vec.slice(0, 4).map((v) => Number(v).toFixed(4)).join(', ')}, ...]` : '') +
      `\n${dim('Use --json for the full vector.')}\n`,
  );
  headerReceipt(receipt, body?.usage ? [`${dim('tokens')} ${body.usage.prompt_tokens}`] : []);
}

/* ── search ────────────────────────────────────────────────────────────── */

async function cmdSearch(args, flags) {
  const query = args.join(' ').trim();
  if (!query) fail('nothing to search for.', 'lobstack search "your query here"');
  const count = flags.count !== undefined ? Number(flags.count) : undefined;
  if (count !== undefined && !(Number.isInteger(count) && count >= 1 && count <= 10)) {
    fail('--count must be an integer from 1 to 10.');
  }

  const { body, receipt } = await search(base(flags), requireKey(flags), { query, count, clientTag: flags.tag });
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ...body, x_lobstack: receipt }, null, 2) + '\n');
    return;
  }
  const results = Array.isArray(body?.results) ? body.results : [];
  if (!results.length) process.stdout.write('No results.\n');
  results.forEach((r, i) => {
    // Titles and snippets are third-party text headed for a terminal: escapes
    // are removed, as they are from model output.
    const clean = (v) => sanitize(String(v ?? '')).replace(/\s+/g, ' ').trim();
    process.stdout.write(`${i + 1}. ${bold(clean(r.title))}\n   ${clean(r.url)}\n`);
    if (r.snippet) process.stdout.write(`   ${dim(clean(r.snippet))}\n`);
  });
  headerReceipt(receipt, [`${dim('results')} ${results.length}`]);
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

// Answered before the switch, so they work with or without a command and
// cannot be captured by the bare-`lobstack` branch below.
if (flags.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (flags.version) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

try {
  switch (command) {
    case 'init':
      await cmdInit(flags);
      break;
    case 'chat':
      await cmdChat(rest, flags);
      break;
    case 'embed':
      await cmdEmbed(rest, flags);
      break;
    case 'search':
      await cmdSearch(rest, flags);
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
  // of a throw. Without it a redirect would report "the Lobstack API redirected"
  // and lose the sentence explaining that a redirect strips your key.
  fail(err instanceof Error ? err.message : String(err), err?.hint);
}
