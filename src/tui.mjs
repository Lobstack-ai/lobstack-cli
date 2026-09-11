/**
 * The interactive surface, and the two things it degrades into.
 *
 * Three code paths, chosen by what the terminal actually is:
 *
 *   1. `runTui` - a terminal on both ends and a TERM that can address a cursor.
 *      Alternate screen, raw keys, a persistent receipt and a running total.
 *   2. `runLineMode` - a terminal, but not one that can be drawn on: TERM=dumb,
 *      or stdout redirected while stdin is still a keyboard. A plain prompt
 *      loop. Answers on stdout, receipts on stderr, exactly like `chat`.
 *   3. `readAll` + `chat` - not a terminal at all. Handled by index.mjs, which
 *      treats piped stdin as the prompt and runs the one-shot path, so
 *      `echo hi | lobstack > out.txt` still puts only the answer in the file.
 *
 * The state lives here and the pixels live in tui-view.mjs. Keeping the frame
 * a pure function of state is what lets the tests read the screen as text at
 * any width without a pty.
 */

import { createInterface } from 'node:readline/promises';
import { streamCompletion, fetchModels, fetchUsage, GatewayError } from './gateway.mjs';
import { printReceipt, money, savingsLabel } from './render.mjs';
import { startProxy } from './proxy.mjs';
import { Terminal, detect, styler, MIN_WIDTH } from './tty.mjs';
import { frame, newSession, accrue } from './tui-view.mjs';

/** Read a whole stream. Used when stdin is a pipe, not a keyboard. */
export async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/* -- the full-screen UI ------------------------------------------------- */

class Tui {
  constructor({ key, base, model, caps, stdout, stdin, initial }) {
    this.key = key;
    this.initial = initial || null;
    this.base = base;
    this.caps = caps;
    this.sgr = styler(caps.color);
    this.term = new Terminal({ stdout, stdin, caps });
    this.models = null; // cached /models listing, fetched on first need
    this.dirty = false;
    this.paintTimer = null;
    this.ticker = null;
    this.abort = null;
    this.proxyServer = null;
    this.lastKeyAt = 0;
    this.sincePrevKey = Infinity;
    this.state = {
      model: model || 'auto',
      messages: [
        {
          role: 'system',
          text:
            'Every answer here comes back with a receipt: what the gateway served, what it ' +
            'cost, and what the routing decision saved. Type a prompt, or /help.',
        },
      ],
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
      last: null,
      session: newSession(),
      proxy: null,
    };
  }

  /* -- lifecycle -- */

  async run() {
    this.term.enter();
    this.term.onResize = () => this.paint(true);
    this.term.onKey((str, key) => {
      try {
        this.onKey(str, key || {});
      } catch (err) {
        // A key handler that throws must not take the terminal with it.
        this.say('error', err instanceof Error ? err.message : String(err));
        this.paint();
      }
    });
    this.paint(true);
    // `lobstack tui "a question"` opens the UI with that turn already in
    // flight. Not awaited: the key loop has to be live while it streams.
    if (this.initial) void this.send(this.initial);
    await new Promise((resolve) => {
      this.done = resolve;
    });
    this.stopTicker();
    this.proxyServer?.close();
    this.term.restore();
  }

  quit() {
    this.abort?.abort();
    this.done?.();
  }

  /* -- painting -- */

  /** Coalesce repaints. A stream can deliver dozens of deltas per frame time. */
  paint(now = false) {
    // Once the terminal is back in the user's hands, nothing may write to it.
    // A cancelled stream settles *after* `run()` has restored, and its final
    // repaint would otherwise spray escape sequences over their shell prompt.
    if (this.term.restored) return;
    if (now) {
      clearTimeout(this.paintTimer);
      this.paintTimer = null;
      this.#paintNow();
      return;
    }
    this.dirty = true;
    if (this.paintTimer) return;
    this.paintTimer = setTimeout(() => {
      this.paintTimer = null;
      if (this.dirty) this.#paintNow();
    }, 24);
  }

  #paintNow() {
    this.dirty = false;
    const { lines, caret } = frame(this.state, {
      columns: this.term.columns,
      rows: this.term.rows,
      caps: this.caps,
      sgr: this.sgr,
    });
    this.term.paint(lines, caret);
  }

  /** While a stream is open the elapsed-time readout has to keep moving. */
  startTicker() {
    this.stopTicker();
    this.ticker = setInterval(() => this.paint(true), 200);
  }

  stopTicker() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  /* -- transcript -- */

  say(role, text) {
    this.state.messages.push({ role, text });
    this.state.scroll = 0;
  }

  /** The conversation as the gateway needs it: display-only rows dropped. */
  conversation() {
    return this.state.messages
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim())
      .map((m) => ({ role: m.role, content: m.text }));
  }

  /* -- keys -- */

  onKey(str, key) {
    const s = this.state;
    const name = key.name;
    // How long since the previous keystroke, before this one updates it. See
    // `enter()`: it is the only way this program tells a paste from typing.
    this.sincePrevKey = Date.now() - this.lastKeyAt;
    this.lastKeyAt = Date.now();

    if (s.picker) return this.pickerKey(str, key);

    if (s.overlay) {
      if (name === 'pageup') s.overlayScroll = Math.max(0, s.overlayScroll - this.page());
      else if (name === 'pagedown') s.overlayScroll += this.page();
      else {
        s.overlay = null;
        s.overlayScroll = 0;
      }
      return this.paint(true);
    }

    if (key.ctrl) {
      switch (name) {
        case 'c':
          // Cancel first, quit second. Killing the process on the keystroke
          // that was meant to stop a runaway answer loses the receipt for a
          // call that has already been billed.
          if (s.streaming) {
            this.abort?.abort();
            return;
          }
          return this.quit();
        case 'd':
          if (!s.input) return this.quit();
          s.input = s.input.slice(0, s.caret) + s.input.slice(s.caret + 1);
          return this.paint();
        case 'l':
          this.term.screen.invalidate();
          return this.paint(true);
        case 'a':
          s.caret = 0;
          return this.paint();
        case 'e':
          s.caret = s.input.length;
          return this.paint();
        case 'u':
          s.input = s.input.slice(s.caret);
          s.caret = 0;
          return this.paint();
        case 'k':
          s.input = s.input.slice(0, s.caret);
          return this.paint();
        case 'w': {
          const head = s.input.slice(0, s.caret).replace(/\s*\S*$/, '');
          s.input = head + s.input.slice(s.caret);
          s.caret = head.length;
          return this.paint();
        }
        default:
          return;
      }
    }

    switch (name) {
      case 'return':
      case 'enter':
        return this.enter(key);
      case 'backspace':
        if (s.caret > 0) {
          s.input = s.input.slice(0, s.caret - 1) + s.input.slice(s.caret);
          s.caret -= 1;
        }
        return this.paint();
      case 'delete':
        s.input = s.input.slice(0, s.caret) + s.input.slice(s.caret + 1);
        return this.paint();
      case 'left':
        s.caret = Math.max(0, s.caret - 1);
        return this.paint();
      case 'right':
        s.caret = Math.min(s.input.length, s.caret + 1);
        return this.paint();
      case 'home':
        s.caret = 0;
        return this.paint();
      case 'end':
        s.caret = s.input.length;
        return this.paint();
      case 'up':
        return this.recall(1);
      case 'down':
        return this.recall(-1);
      case 'pageup':
        s.scroll += this.page();
        return this.paint(true);
      case 'pagedown':
        s.scroll = Math.max(0, s.scroll - this.page());
        return this.paint(true);
      case 'escape':
        s.scroll = 0;
        return this.paint(true);
      case 'tab':
        return this.complete();
      default:
        break;
    }

    // Printable input. `str` can be several characters when a terminal
    // delivers a paste or a multi-byte sequence in one go.
    if (str && !key.meta && !/^[\u0000-\u001f\u007f]$/.test(str)) {
      s.input = s.input.slice(0, s.caret) + str + s.input.slice(s.caret);
      s.caret += str.length;
      return this.paint();
    }
  }

  page() {
    return Math.max(1, this.term.rows - 10);
  }

  /**
   * Enter: send, or add a newline.
   *
   * A trailing backslash means "keep going", and Alt+Enter does too where the
   * terminal sends it (many do not send anything distinguishable for
   * Shift+Enter, so that one is not promised).
   *
   * The timing check is for pastes. Bracketed paste mode would be the tidy
   * answer, but it is another private mode to leave switched on if this process
   * dies badly, and the failure there is a terminal that wraps every future
   * paste in escape markers. Instead: a newline arriving within 10ms of a
   * printable character was not typed by a human - 100 characters a second is
   * not a person - so it is treated as part of the paste rather than as send.
   * Only when raw mode is actually on, since without it everything arrives in
   * one burst by definition.
   */
  enter(key) {
    const s = this.state;
    const pasted = Boolean(this.term.in.isTTY) && this.sincePrevKey < 10;
    const continued = s.input.endsWith('\\');
    if (key.meta || continued || pasted) {
      if (continued) {
        s.input = s.input.slice(0, -1);
        s.caret = Math.min(s.caret, s.input.length);
      }
      s.input = s.input.slice(0, s.caret) + '\n' + s.input.slice(s.caret);
      s.caret += 1;
      return this.paint();
    }
    const line = s.input;
    if (!line.trim()) return;
    s.input = '';
    s.caret = 0;
    s.history.unshift(line);
    s.historyAt = -1;
    s.scroll = 0;
    if (line.trim().startsWith('/')) return void this.command(line.trim());
    if (s.streaming) {
      this.say('system', 'still streaming the last answer - Ctrl+C cancels it.');
      return this.paint(true);
    }
    return void this.send(line);
  }

  recall(step) {
    const s = this.state;
    const next = s.historyAt + step;
    if (next < -1 || next >= s.history.length) return;
    s.historyAt = next;
    s.input = next === -1 ? '' : s.history[next];
    s.caret = s.input.length;
    this.paint();
  }

  /** Tab: finish a slash command, or open the picker on an empty line. */
  complete() {
    const s = this.state;
    if (!s.input.trim()) return void this.openPicker();
    if (!s.input.startsWith('/')) return;
    const names = [
      '/model',
      '/models',
      '/spend',
      '/receipt',
      '/proxy',
      '/new',
      '/clear',
      '/help',
      '/quit',
    ];
    const hit = names.filter((n) => n.startsWith(s.input.trim()));
    if (hit.length === 1) {
      s.input = `${hit[0]} `;
      s.caret = s.input.length;
    } else if (hit.length > 1) {
      this.say('system', hit.join('  '));
    }
    this.paint(true);
  }

  /* -- the model picker -- */

  async openPicker(filter = '') {
    if (!this.models) {
      this.say('system', 'fetching the model list...');
      this.paint(true);
      try {
        this.models = await fetchModels(this.base, this.key);
      } catch (err) {
        this.models = [];
        return this.fail(err);
      }
    }
    this.state.picker = { filter, index: 0, items: this.pickerItems(filter) };
    this.paint(true);
  }

  pickerItems(filter) {
    const f = filter.toLowerCase();
    const price = (m) => {
      const p = m.price_per_mtok || {};
      const n = (v) => (typeof v === 'number' ? `$${v}` : '-');
      return `${n(p.input)} / ${n(p.output)} per Mtok`;
    };
    const rows = [
      { id: 'auto', tier: 'router', price: 'the router picks, and the receipt says which' },
      ...(this.models || []).map((m) => ({ id: m.id, tier: m.tier || '', price: price(m) })),
    ];
    return rows.filter((r) => r.id.toLowerCase().includes(f));
  }

  pickerKey(str, key) {
    const p = this.state.picker;
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      this.state.picker = null;
      return this.paint(true);
    }
    if (key.name === 'up') p.index = Math.max(0, p.index - 1);
    else if (key.name === 'down') p.index = Math.min(p.items.length - 1, p.index + 1);
    else if (key.name === 'return' || key.name === 'enter') {
      const picked = p.items[p.index];
      this.state.picker = null;
      if (picked) {
        this.state.model = picked.id;
        this.say('system', `model set to ${picked.id}.`);
      }
    } else if (key.name === 'backspace') {
      p.filter = p.filter.slice(0, -1);
      p.items = this.pickerItems(p.filter);
      p.index = 0;
    } else if (str && !key.ctrl && !key.meta && !/^[\u0000-\u001f\u007f]$/.test(str)) {
      p.filter += str;
      p.items = this.pickerItems(p.filter);
      p.index = 0;
    }
    this.paint(true);
  }

  /* -- commands -- */

  async command(line) {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    const s = this.state;
    try {
      switch (cmd) {
        case 'help':
        case '?':
          s.overlay = 'help';
          s.overlayScroll = 0;
          break;
        case 'quit':
        case 'exit':
        case 'q':
          return this.quit();
        case 'clear':
          s.messages = [];
          this.term.screen.invalidate();
          break;
        case 'new':
          s.messages = [{ role: 'system', text: 'new conversation. Session totals kept.' }];
          break;
        case 'model':
          if (!arg) return void this.openPicker();
          s.model = arg;
          this.say('system', `model set to ${arg}.`);
          break;
        case 'models':
          await this.showModels();
          break;
        case 'spend':
          await this.showSpend(Number(arg || 7));
          break;
        case 'receipt':
          this.showReceipt();
          break;
        case 'proxy':
          await this.startProxy(Number(arg || 8787));
          break;
        default:
          this.say('error', `no such command "/${cmd}". /help lists them.`);
      }
    } catch (err) {
      this.fail(err);
    }
    this.paint(true);
  }

  async showModels() {
    this.models = await fetchModels(this.base, this.key);
    const w = Math.max(...this.models.map((m) => (m.id || '').length), 5);
    const price = (v) => (typeof v === 'number' ? `$${v}` : '-');
    const lines = this.models.map((m) => {
      const p = m.price_per_mtok || {};
      return `${(m.id || '').padEnd(w)}  ${String(m.tier || '').padEnd(9)}  ${price(p.input).padEnd(6)}  ${price(p.output)}`;
    });
    this.say(
      'system',
      [`${'MODEL'.padEnd(w)}  ${'TIER'.padEnd(9)}  IN/M    OUT/M`, ...lines].join('\n'),
    );
  }

  async showSpend(days) {
    const body = await fetchUsage(this.base, this.key, Number.isFinite(days) ? days : 7);
    if (body.enabled === false) {
      this.say('error', body.message || 'usage reporting is not enabled on this deployment.');
      return;
    }
    const sum = body.summary || {};
    // Same rule as everywhere else: a saving the gateway measured against a
    // plan ceiling is not the same claim as one against a model you named. The
    // usage API reports a single figure, so it is labelled for what it is
    // rather than being called a saving outright.
    const head =
      `last ${days} days: ${sum.requests ?? 0} requests, ${money(Number(sum.cost_usd ?? 0))}` +
      (Number(sum.savings_usd ?? 0) > 0
        ? `, routing saved ${money(Number(sum.savings_usd))} against the baselines the gateway recorded`
        : '');
    const rows = (body.groups ?? []).map(
      (g) =>
        `  ${String(g.key ?? '').padEnd(24)} ${String(g.requests ?? 0).padStart(6)}  ${money(Number(g.cost_usd ?? 0))}`,
    );
    this.say('system', [head, ...rows].join('\n'));
  }

  showReceipt() {
    const last = this.state.last;
    if (!last) return this.say('system', 'no call yet.');
    const s = this.state.session;
    this.say(
      'system',
      [
        JSON.stringify({ x_lobstack: last.receipt, usage: last.usage }, null, 2),
        '',
        `session: ${s.calls} calls, ` +
          `${s.priced ? money(s.costUsd) : 'unpriced'}` +
          `${s.priced && s.unpriced ? ` plus ${s.unpriced} unpriced` : ''}, ` +
          `${s.inTok}/${s.outTok} tokens` +
          (s.savedNamed > 0 ? `, saved ${money(s.savedNamed)} against models you named` : '') +
          (s.savedCeiling > 0
            ? `, ${money(s.savedCeiling)} against your plan ceiling (a different claim)`
            : ''),
      ].join('\n'),
    );
  }

  /**
   * Run the OpenAI-compatible proxy inside this process.
   *
   * This is the reason the TUI is worth more than a chat window: point Cursor
   * or Aider at the port and every call it makes lands in this transcript with
   * its price, in the same running total as what you type here.
   */
  async startProxy(port) {
    if (this.proxyServer) {
      this.say('system', `already serving on ${this.state.proxy.port}.`);
      return;
    }
    this.proxyServer = await startProxy({
      key: this.key,
      base: this.base,
      port,
      quiet: true,
      onReceipt: ({ receipt, usage, ms, path }) => {
        this.state.last = { receipt, usage, model: receipt?.served_model, ms };
        accrue(this.state.session, { receipt, usage });
        const saving = savingsLabel(receipt);
        this.say(
          'system',
          `proxy ${path} -> ${receipt?.served_model ?? '?'}  ${money(receipt?.cost_usd)}` +
            (saving ? `  ${saving.label} ${money(saving.amount)}` : ''),
        );
        this.paint(true);
      },
    });
    this.state.proxy = { port };
    this.say(
      'system',
      `serving http://127.0.0.1:${port}/v1 - loopback only, and your key stays in this ` +
        `process. Set OPENAI_BASE_URL to it and OPENAI_API_KEY to anything.`,
    );
  }

  fail(err) {
    if (err instanceof GatewayError) {
      this.say('error', err.hint ? `${err.message}\n${err.hint}` : err.message);
    } else {
      this.say('error', err instanceof Error ? err.message : String(err));
    }
  }

  /* -- a call -- */

  async send(text) {
    const s = this.state;
    this.say('user', text);
    const bubble = { role: 'assistant', text: '' };
    s.messages.push(bubble);
    s.streaming = true;
    s.streamStartedAt = Date.now();
    s.streamChars = 0;
    this.abort = new AbortController();
    this.startTicker();
    this.paint(true);

    try {
      const out = await streamCompletion(this.base, this.key, {
        model: s.model,
        // `conversation()` already ends with the turn just pushed, and skips
        // the empty assistant bubble the stream is about to fill.
        messages: this.conversation(),
        signal: this.abort.signal,
        client: 'lobstack-cli-tui',
        onText: (t) => {
          bubble.text += t;
          s.streamChars += t.length;
          this.paint();
        },
      });
      s.last = {
        receipt: out.receipt,
        usage: out.usage,
        model: out.model,
        ms: Date.now() - s.streamStartedAt,
      };
      accrue(s.session, out);
      if (!out.receipt) {
        this.say('system', 'no receipt on that response - the endpoint did not send one.');
      }
    } catch (err) {
      if (this.abort.signal.aborted) {
        // The tokens up to the cancel were produced and will be billed. Saying
        // "cancelled" and showing no cost would be the friendlier lie.
        this.say('system', 'cancelled. Whatever the provider already generated was still billed.');
      } else {
        if (!bubble.text) s.messages.splice(s.messages.indexOf(bubble), 1);
        this.fail(err);
      }
    } finally {
      s.streaming = false;
      this.abort = null;
      this.stopTicker();
      this.paint(true);
    }
  }
}

export async function runTui({ key, base, model, caps, stdout, stdin, initial }) {
  const tui = new Tui({
    key,
    base,
    model,
    initial,
    caps: caps || detect(),
    stdout: stdout || process.stdout,
    stdin: stdin || process.stdin,
  });
  if (tui.term.columns < MIN_WIDTH) {
    // Not a refusal - the layout stacks below MIN_WIDTH and stays correct. It
    // is worth saying once, because a cramped frame looks like a bug.
    tui.say(
      'system',
      `this window is ${tui.term.columns} columns; the layout stacks below ${MIN_WIDTH}.`,
    );
  }
  await tui.run();
}

/* -- line mode ---------------------------------------------------------- */

/**
 * The fallback for a terminal that cannot be drawn on.
 *
 * TERM=dumb has no cursor addressing, and stdout redirected to a file must not
 * receive escape sequences. Both still deserve a conversation, so this is the
 * one-shot `chat` path in a loop: the prompt and the receipt on stderr, the
 * answer on stdout, which keeps `lobstack tui > transcript.txt` honest.
 */
export async function runLineMode({ key, base, model }) {
  const session = newSession();
  const rl = createInterface({
    input: process.stdin,
    // stderr, not stdout: stdout may be a file the user wants to keep clean.
    output: process.stderr,
    terminal: Boolean(process.stdin.isTTY),
  });
  process.stderr.write(
    `lobstack - line mode (this terminal cannot be drawn on; the full UI needs cursor addressing)\n` +
      `model ${model}. Blank line or Ctrl+D to leave.\n\n`,
  );

  for (;;) {
    let line;
    try {
      line = await rl.question('> ');
    } catch {
      break; // Ctrl+D closes the interface
    }
    if (!line || !line.trim()) break;
    try {
      const out = await streamCompletion(base, key, {
        model,
        messages: [{ role: 'user', content: line }],
        onText: (t) => process.stdout.write(t),
      });
      process.stdout.write('\n');
      printReceipt({ receipt: out.receipt, usage: out.usage, model: out.model });
      accrue(session, out);
      process.stderr.write(
        `  session ${session.calls} calls  ` +
          `${session.priced ? money(session.costUsd) : 'unpriced'}` +
          `${session.priced && session.unpriced ? `  +${session.unpriced} unpriced` : ''}` +
          `${session.savedNamed > 0 ? `  saved ${money(session.savedNamed)}` : ''}` +
          `${session.savedCeiling > 0 ? `  vs ceiling ${money(session.savedCeiling)}` : ''}\n\n`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error ${msg}\n${err?.hint ? `  ${err.hint}\n` : ''}`);
    }
  }
  rl.close();
}
