/**
 * The terminal UI: the frame, the capability detection, and the ugly exits.
 *
 *   node --test cli/test/
 *
 * The frame is a pure function of state, so most of this reads the screen as
 * text at a given width - which is exactly what a person does - rather than
 * poking at internals. The rest spawns the real binary, because "restores the
 * terminal after SIGINT" is not a claim you can make from inside the process
 * that would have failed to do it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { startFakeGateway } from './fake-gateway.mjs';

import {
  detect,
  styler,
  width,
  clip,
  wrapText,
  sanitize,
  usableWidth,
  Screen,
  Terminal,
  ANSI,
} from '../src/tty.mjs';
import {
  frame,
  receiptRows,
  compose,
  sessionSegments,
  newSession,
  accrue,
  layoutInput,
} from '../src/tui-view.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
const TTY_MJS = fileURLToPath(new URL('../src/tty.mjs', import.meta.url));
const KEY = 'lsk_live_' + 'a'.repeat(56);
const ESC = String.fromCharCode(27);

const ENV = {
  HOME: '/tmp/lobstack-cli-test-home',
  USERPROFILE: '/tmp/lobstack-cli-test-home',
  LOBSTACK_API_KEY: KEY,
  NO_COLOR: '1',
};

/** Strip every escape sequence, so an assertion reads what a person would see. */
const strip = (s) => s.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g'), '');

/* ── fixtures ──────────────────────────────────────────────────────────── */

const NAMED = {
  request_id: 'req_test',
  served_model: 'claude-haiku-4-5',
  requested_model: 'claude-opus-5',
  routed: true,
  cost_usd: 0.0011,
  savings_usd: 0.0044,
  priced: true,
  baseline_reason: 'named',
  baseline_model: 'claude-opus-5',
};
const CEILING = {
  ...NAMED,
  requested_model: 'auto',
  baseline_reason: 'plan_ceiling',
  baseline_model: 'claude-fable-5-1',
};
const UNPRICED = { ...NAMED, cost_usd: null, savings_usd: null, priced: false };
const USAGE = { prompt_tokens: 400, completion_tokens: 140 };

const CAPS = { unicode: true, color: 0 };
const NO_SGR = (_style, text) => text;

function stateWith(receipt, { messages = [], model = 'auto' } = {}) {
  const last = { receipt, usage: USAGE, model: receipt?.served_model, ms: 137 };
  const session = accrue(newSession(), { receipt, usage: USAGE });
  return {
    model,
    messages,
    input: '',
    caret: 0,
    history: [],
    historyAt: -1,
    scroll: 0,
    overlay: null,
    overlayScroll: 0,
    picker: null,
    streaming: false,
    streamStartedAt: 0,
    streamChars: 0,
    last,
    session,
    proxy: null,
  };
}

/** The screen, as plain text rows, at a given size. */
const screen = (state, columns, rows = 24) =>
  frame(state, { columns, rows, caps: CAPS, sgr: NO_SGR }).lines;

/* ── the frame, at the two widths that matter ──────────────────────────── */

test('at 80 columns the whole receipt is on screen, not clipped', async () => {
  const lines = screen(stateWith(NAMED), 80);
  const text = lines.join('\n');

  // Every field of the receipt, in full. The first version of this layout put
  // the receipt on one row and clipped it at 80 columns, and the part that fell
  // off the end was the saving -- the single number the product argues about.
  assert.match(text, /model claude-haiku-4-5/);
  assert.match(text, /asked claude-opus-5/);
  assert.match(text, /tokens 400\/140/);
  assert.match(text, /cost \$0\.001100/);
  assert.match(text, /saved \$0\.004400/);
  assert.match(text, /the model you named/);

  // The running total, which is the reason to keep this window open.
  assert.match(lines[0], /1 call/);
  assert.match(lines[0], /\$0\.001100/);
  assert.match(lines[0], /saved \$0\.004400/);
});

test('at 40 columns nothing is corrupted and no figure is truncated', async () => {
  const lines = screen(stateWith(NAMED), 40);
  const text = lines.join('\n');

  // One column is deliberately never written; see usableWidth in tty.mjs.
  for (const line of lines) assert.ok(width(line) <= 39, `row too wide: ${JSON.stringify(line)}`);
  assert.equal(lines.length, 24);

  // A clipped money value is a *different, smaller* number. "$0.004400" cut to
  // "$0.004" would misreport the saving by an order of magnitude, so the layout
  // drops labels and then whole fields rather than truncate a figure.
  assert.match(text, /\$0\.001100/);
  assert.match(text, /saved \$0\.004400/);
  assert.doesNotMatch(text, /\$0\.0044(?!00)/);
  assert.doesNotMatch(text, /\$0\.0011(?!00)/);

  // The session total survives too: at this width the word "lobstack" goes
  // before the money does.
  assert.match(lines[0], /\$0\.001100/);
});

test('below the minimum width it degrades instead of corrupting', async () => {
  for (const columns of [30, 24, 16, 12, 8]) {
    const lines = screen(stateWith(NAMED), columns, 24);
    for (const line of lines) {
      assert.ok(
        width(line) <= usableWidth(columns),
        `${columns} cols: row too wide: ${JSON.stringify(line)}`,
      );
    }
    assert.equal(lines.length, 24, `${columns} cols: wrong row count`);
  }
});

test('a very short terminal keeps the price and the prompt', async () => {
  for (const rows of [1, 2, 3, 5, 8, 10, 13]) {
    const lines = screen(stateWith(NAMED), 80, rows);
    assert.equal(lines.length, rows, `${rows} rows: wrong row count`);
    if (rows >= 2) {
      // Rows are allocated to the receipt before the transcript: history can be
      // scrolled back for, a price you never saw cannot.
      assert.match(lines.join('\n'), /\$0\.001100/, `${rows} rows: lost the cost`);
    }
  }
});

/* ── the honesty rules, which are the point ────────────────────────────── */

test('an unpriced call never renders as $0.00, anywhere on the screen', async () => {
  const lines = screen(stateWith(UNPRICED), 80);
  const text = lines.join('\n');

  // cost_usd is null, never zero, when the gateway could not price a call.
  // Rendering that null as a zero writes off a real charge -- the exact bug
  // that ran for three months in the desktop client.
  assert.match(text, /cost unpriced/);
  assert.match(text, /API could not price/);
  assert.doesNotMatch(text, /gateway/i);
  assert.doesNotMatch(text, /\$0\.00/);
  assert.doesNotMatch(text, /\$0\b/);

  // And the session total says "unpriced" rather than summing a null as zero.
  assert.match(lines[0], /unpriced/);
  assert.doesNotMatch(lines[0], /\$/);
});

test('a session mixing priced and unpriced calls counts the unpriced out loud', async () => {
  const s = newSession();
  accrue(s, { receipt: NAMED, usage: USAGE });
  accrue(s, { receipt: UNPRICED, usage: USAGE });
  const text = compose(sessionSegments(s), 200, NO_SGR);

  assert.match(text, /2 calls/);
  assert.match(text, /\$0\.001100/); // only the call that had a price
  assert.match(text, /\+1 unpriced/); // and the one that did not, said plainly
  assert.equal(s.costUsd, 0.0011, 'a null cost must not be coerced into the total');
});

test('a plan_ceiling saving is never called "saved"', async () => {
  const lines = screen(stateWith(CEILING), 80);
  const text = lines.join('\n');

  // `baseline_reason` decides. "plan_ceiling" means the gateway measured
  // against the priciest model the plan allows because the caller sent `auto`.
  // It is a real comparison and it is not the same claim as beating a model the
  // caller named, so it may not wear the same word. render.mjs has the rule and
  // a test pinning it; this is the same rule on the same screen.
  assert.match(text, /vs ceiling \$0\.004400/);
  assert.doesNotMatch(text, /\bsaved\b/);
  assert.match(text, /claude-fable-5-1/);
  assert.match(text, /plan allows/);

  // Including in the running total: two separate tallies, never added together.
  assert.match(lines[0], /vs ceiling/);
  assert.doesNotMatch(lines[0], /\bsaved\b/);
});

test('the two savings tallies are never merged into one number', async () => {
  const s = newSession();
  accrue(s, { receipt: NAMED, usage: USAGE });
  accrue(s, { receipt: CEILING, usage: USAGE });
  assert.equal(s.savedNamed, 0.0044);
  assert.equal(s.savedCeiling, 0.0044);
  const text = compose(sessionSegments(s), 200, NO_SGR);
  assert.match(text, /saved \$0\.004400/);
  assert.match(text, /vs ceiling \$0\.004400/);
  // A combined $0.0088 would be the overstatement the receipt exists to stop.
  assert.doesNotMatch(text, /\$0\.008800/);
});

test('a response with no receipt at all says so rather than showing nothing', async () => {
  const state = stateWith(undefined);
  state.last = { receipt: undefined, usage: USAGE, model: 'claude-haiku-4-5', ms: 20 };
  const text = screen(state, 80).join('\n');
  assert.match(text, /cost unpriced/);
  assert.match(text, /no receipt on this response/);
});

test('while a stream is open it reports time and text, never a computed price', async () => {
  const state = stateWith(NAMED);
  state.streaming = true;
  state.streamStartedAt = Date.now() - 1400;
  state.streamChars = 143;
  const rows = receiptRows(state, 79, 3, CAPS).map((r) => compose(r, 79, NO_SGR));
  const text = rows.join('\n');

  assert.match(text, /streaming/);
  assert.match(text, /143 chars/);
  assert.match(text, /1\.[0-9]s/);
  // Cost is read off the gateway's last frame, never multiplied out of token
  // counts against a bundled rate card. So there is no dollar figure here yet,
  // and the screen says why instead of guessing.
  assert.doesNotMatch(text, /\$/);
  assert.match(text, /price arrives with the last frame/);
});

/* ── capability detection ──────────────────────────────────────────────── */

test('capabilities are detected, never assumed', async () => {
  const tty = { isTTY: true, columns: 100, rows: 30 };
  const pipe = { isTTY: false };

  const full = detect({ stdout: tty, stdin: tty, env: { TERM: 'xterm-256color' } });
  assert.equal(full.fullscreen, true);
  assert.equal(full.color, 8);

  assert.equal(
    detect({ stdout: tty, stdin: tty, env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' } })
      .color,
    24,
  );
  assert.equal(detect({ stdout: tty, stdin: tty, env: { TERM: 'xterm' } }).color, 4);

  // NO_COLOR, read exactly the way render.mjs reads it.
  assert.equal(detect({ stdout: tty, stdin: tty, env: { TERM: 'xterm-256color', NO_COLOR: '1' } }).color, 0);

  // TERM=dumb promises no cursor addressing, so there is nothing to draw on.
  const dumb = detect({ stdout: tty, stdin: tty, env: { TERM: 'dumb' } });
  assert.equal(dumb.fullscreen, false);
  assert.equal(dumb.color, 0);

  // An *unset* TERM is not the same promise: containers and IDE terminals leave
  // it empty while being perfectly ANSI, and isTTY already said a terminal is
  // there. Refusing to draw on those would be the wrong call.
  assert.equal(detect({ stdout: tty, stdin: tty, env: {} }).fullscreen, true);

  // A pipe on either end is not an interactive session.
  assert.equal(detect({ stdout: pipe, stdin: tty, env: { TERM: 'xterm' } }).fullscreen, false);
  assert.equal(detect({ stdout: tty, stdin: pipe, env: { TERM: 'xterm' } }).fullscreen, false);

  // ...unless it is forced, which is what a wrapper or a pty-less runner needs.
  assert.equal(detect({ stdout: pipe, stdin: pipe, env: { TERM: 'xterm' }, force: true }).fullscreen, true);

  // Box drawing is opt-out as well as opt-in.
  assert.equal(detect({ stdout: tty, stdin: tty, env: { LANG: 'en_US.UTF-8' } }).unicode, true);
  assert.equal(
    detect({ stdout: tty, stdin: tty, env: { LANG: 'en_US.UTF-8', LOBSTACK_ASCII: '1' } }).unicode,
    false,
  );
});

test('at colour depth 0 the styler is the identity, so one code path draws both', async () => {
  assert.equal(styler(0)('good', 'x'), 'x');
  assert.match(styler(4)('good', 'x'), /x/);
  assert.notEqual(styler(4)('good', 'x'), 'x');
});

/* ── text handling ─────────────────────────────────────────────────────── */

test('escape sequences in model output are stripped, not rendered', async () => {
  // This is a security boundary. A completion is attacker-influenced text about
  // to be pasted into a terminal; left alone, a clear-screen sequence inside an
  // answer wipes the frame and an OSC sequence rewrites the window title.
  const nasty = `hello${ESC}[2Jworld${ESC}]0;pwned${String.fromCharCode(7)}!`;
  const clean = sanitize(nasty);
  assert.equal(clean.includes(ESC), false);
  assert.match(clean, /helloworld/);
  assert.equal(clean.includes('pwned'), false);

  // And it survives the wrapper, which is what actually reaches the screen.
  const state = stateWith(NAMED, { messages: [{ role: 'assistant', text: nasty }] });
  for (const line of screen(state, 80)) assert.equal(line.includes(`${ESC}[2J`), false);
});

test('width counts cells, not code units', async () => {
  assert.equal(width('abc'), 3);
  assert.equal(width('日本語'), 6); // wide
  assert.equal(width('é'), 1); // combining mark adds nothing
  assert.equal(clip('日本語', 4), '日本');
  assert.equal(clip('日本語', 3), '日'); // never half a cell
});

test('wrapping breaks on spaces and hard-breaks what will not fit', async () => {
  assert.deepEqual(wrapText('one two three', 7), ['one two', 'three']);
  assert.deepEqual(wrapText('a\n\nb', 10), ['a', '', 'b']);
  const long = wrapText('x'.repeat(25), 10);
  assert.deepEqual(long, ['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
  for (const l of wrapText('https://example.com/' + 'y'.repeat(80), 20)) {
    assert.ok(width(l) <= 20);
  }
});

test('the caret lands on the character it will edit, even after a wrap', async () => {
  const a = layoutInput('hello', 5, 20, '> ');
  assert.deepEqual(a.lines, ['hello']);
  assert.equal(a.caretRow, 0);
  assert.equal(a.caretCol, 7); // two for the prompt, five for the text

  const b = layoutInput('abcdefghij', 10, 6, '> ');
  // First row holds width - prompt characters; the rest get the full width.
  assert.equal(b.lines[0], 'abcd');
  assert.equal(b.caretRow, b.lines.length - 1);
  assert.equal(b.lines.join(''), 'abcdefghij');
});

/* ── the frame writer ──────────────────────────────────────────────────── */

test('only the rows that changed are rewritten', async () => {
  const writes = [];
  const scr = new Screen({ write: (s) => writes.push(s) });
  scr.paint(['aaa', 'bbb', 'ccc'], null);
  writes.length = 0;

  scr.paint(['aaa', 'XXX', 'ccc'], null);
  const second = writes.join('');
  assert.match(second, /XXX/);
  // A full-screen repaint per frame flickers in every terminal without
  // synchronised output, and a streaming answer touches one or two rows.
  assert.equal(second.includes('aaa'), false);
  assert.equal(second.includes(ANSI.clearScreen), false);

  // A shorter frame erases what it no longer covers.
  writes.length = 0;
  scr.paint(['aaa'], null);
  assert.match(writes.join(''), /2;1H/);
});

/* ── the ugly exits ────────────────────────────────────────────────────── */

function fakeTty() {
  const out = new PassThrough();
  out.isTTY = true;
  out.columns = 80;
  out.rows = 24;
  let sink = '';
  out.on('data', (d) => (sink += d));
  const stdin = new PassThrough();
  stdin.isTTY = true;
  let raw = null;
  stdin.setRawMode = (v) => {
    raw = v;
    return stdin;
  };
  return { out, stdin, read: () => sink, rawMode: () => raw };
}

test('restore is idempotent, and gives every mode back', async () => {
  const io = fakeTty();
  const term = new Terminal({ stdout: io.out, stdin: io.stdin });
  try {
    term.enter();
    assert.equal(io.rawMode(), true);
    assert.match(io.read(), /\?1049h/);
    assert.match(io.read(), /\?25l/);
    // Mouse reporting is never switched on: JetBrains and some tmux configs
    // break click-to-select once it is, and a process that dies before
    // disabling it leaves the user's shell eating mouse packets.
    assert.doesNotMatch(io.read(), /\?100\dh/);
  } finally {
    term.restore();
  }
  const after = io.read();
  assert.equal(io.rawMode(), false);
  assert.ok(after.endsWith(`${ESC}[0m${ESC}[?25h${ESC}[?1049l`));

  term.restore();
  term.restore();
  assert.equal(io.read(), after, 'a second restore must write nothing');
  assert.equal(term.handlers.length, 0, 'and must leave no process listeners behind');
});

test('a resize drops the diff baseline, so the next frame is painted whole', async () => {
  const io = fakeTty();
  const term = new Terminal({ stdout: io.out, stdin: io.stdin });
  try {
    term.enter();
    let resized = 0;
    term.onResize = () => (resized += 1);
    term.paint(['one', 'two'], null);
    io.out.columns = 40;
    io.out.emit('resize');
    assert.equal(resized, 1);
    // Every row's content depends on the width, so nothing on screen is
    // reusable and the baseline has to go.
    assert.deepEqual(term.screen.prev, []);
  } finally {
    term.restore();
  }
});

test('the terminal is restored after SIGINT', async () => {
  const gw = await startFakeGateway();
  try {
    const out = await new Promise((resolve) => {
      const p = spawn('node', [CLI, 'tui', '--force', '--base', gw.url], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...ENV, TERM: 'xterm-256color' },
      });
      let stdout = '';
      p.stdout.on('data', (d) => (stdout += d));
      setTimeout(() => p.kill('SIGINT'), 600);
      p.on('exit', (code) => resolve({ stdout, code }));
    });

    // Leaving a user in the alternate screen with a hidden cursor and raw mode
    // still on is the worst thing this program can do, so the signal handler
    // finishes the job itself -- installing a listener suppresses Node's
    // default handling, including the exit status.
    assert.equal(out.code, 130, 'SIGINT must exit 128 + 2');
    assert.ok(out.stdout.includes(`${ESC}[?1049h`), 'it did enter the alternate screen');
    assert.ok(
      out.stdout.endsWith(`${ESC}[0m${ESC}[?25h${ESC}[?1049l`),
      `the last bytes must hand the terminal back, got ${JSON.stringify(out.stdout.slice(-40))}`,
    );
  } finally {
    gw.close();
  }
});

test('the terminal is restored after an uncaught throw, and the stack still prints', async () => {
  // The failure mode this guards against: a bug anywhere in a render leaves the
  // user in the alternate screen with no cursor and no explanation. Installing
  // an uncaughtException listener means Node stops printing the error, so the
  // handler has to print it too.
  const src = `
    import { Terminal } from ${JSON.stringify(TTY_MJS)};
    const t = new Terminal();
    t.enter();
    setTimeout(() => { throw new Error('deliberate boom'); }, 10);
  `;
  await assert.rejects(
    () => run('node', ['--input-type=module', '-e', src], { env: { ...process.env, ...ENV } }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /deliberate boom/);
      assert.ok(
        err.stdout.endsWith(`${ESC}[0m${ESC}[?25h${ESC}[?1049l`),
        `terminal not restored: ${JSON.stringify(err.stdout.slice(-40))}`,
      );
      return true;
    },
  );
});

/* ── falling back out of the UI ────────────────────────────────────────── */

test('not a TTY: it falls back to the plain path and stdout stays clean', async () => {
  const gw = await startFakeGateway();
  try {
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const p = execFile(
        'node',
        [CLI, 'tui', '--base', gw.url],
        { env: { ...process.env, ...ENV } },
        (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })),
      );
      p.stdin.end('say hello\n');
    });

    // Piped in, piped out: the prompt came from stdin and the answer is the
    // only thing on stdout. `echo hi | lobstack > out.txt` has to keep working.
    assert.equal(stdout.trim(), 'Hello there');
    assert.equal(stdout.includes(ESC), false, 'no escape sequences down a pipe');
    // The receipt still happens, on stderr, where it does not pollute the file.
    assert.match(stderr, /claude-haiku-4-5/);
    assert.match(stderr, /\$0\.001100/);
  } finally {
    gw.close();
  }
});

test('TERM=dumb drops to line mode instead of drawing a frame nobody can see', async () => {
  const gw = await startFakeGateway();
  try {
    const out = await new Promise((resolve) => {
      const p = spawn('node', [CLI, 'tui', '--force', '--base', gw.url], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...ENV, TERM: 'dumb' },
      });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      setTimeout(() => p.stdin.write('hi\n'), 300);
      setTimeout(() => p.stdin.write('\n'), 1400);
      p.on('exit', (code) => resolve({ stdout, stderr, code }));
    });

    assert.equal(out.code, 0);
    assert.match(out.stderr, /line mode/);
    // A dumb terminal has no cursor addressing at all, so a full-screen frame
    // is not a degraded experience, it is garbage on the wire.
    assert.equal(out.stdout.includes(ESC), false);
    assert.match(out.stdout, /Hello there/);
    assert.match(out.stderr, /cost \$0\.001100/);
    assert.match(out.stderr, /session 1 calls/);
  } finally {
    gw.close();
  }
});

test('the UI streams an answer split mid-frame, and prices it', async () => {
  // The fixture cuts a JSON frame in half between two writes. In the one-shot
  // path a dropped half shows up as a truncated answer; in the UI it shows up
  // as a frame that never gets a receipt, because `x_lobstack` is on the last
  // frame of all.
  const gw = await startFakeGateway({ long: true, slow: 80 });
  try {
    const out = await new Promise((resolve) => {
      const p = spawn('node', [CLI, 'tui', '--force', '--base', gw.url], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...ENV, TERM: 'xterm-256color' },
      });
      let stdout = '';
      p.stdout.on('data', (d) => (stdout += d));
      setTimeout(() => p.stdin.write('explain a b-tree\n'), 400);
      setTimeout(() => p.kill('SIGINT'), 2200);
      p.on('exit', () => resolve(strip(stdout)));
    });

    assert.match(out, /lookup touches/, 'the first half of the stream');
    assert.match(out, /one level of descent is one read/, 'and the half after the cut');
    assert.match(out, /cost \$0\.001100/, 'and the receipt off the final frame');
    assert.match(out, /saved \$0\.004400/);
    assert.doesNotMatch(out, /\$0\.0000/);
  } finally {
    gw.close();
  }
});

test('bare `lobstack` in a pipeline still prints help, not a UI', async () => {
  const { stdout } = await run('node', [CLI], { env: { ...process.env, ...ENV } });
  assert.match(stdout, /one key, every model/);
  assert.match(stdout, /lobstack init/);
  assert.equal(stdout.includes(ESC), false);
});
