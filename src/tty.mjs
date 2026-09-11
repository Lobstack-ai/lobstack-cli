/**
 * The terminal, by hand.
 *
 * No ink, no blessed, no chalk. This process holds an `lsk_live_` credential;
 * the reason `lobstack` has no dependencies is that there should be nothing
 * between a user's key and us, and a TUI is not a good enough reason to change
 * that. `node:readline` already ships a battle-tested escape-sequence decoder
 * (`emitKeypressEvents`), the rest of a full-screen UI is nine escape
 * sequences, and both are in the runtime.
 *
 * Everything here is deliberately conservative. The clever sequence and the
 * safe sequence usually differ only in how badly they fail, and the worst
 * outcome this program can produce is not an ugly frame - it is handing the
 * user back a shell with the cursor hidden, raw mode on, and mouse reporting
 * spraying escape bytes at their prompt.
 *
 * What is used, and what is refused:
 *
 *   - `?1049h/l` for the alternate screen. One sequence, and it saves and
 *     restores the cursor itself. The older `?47h` + `?1048` pair needs two
 *     sequences and leaves the cursor wherever the app left it, and `?47` is
 *     the one tmux and screen historically mangled.
 *   - `?25l/h` to hide and show the cursor. Universal.
 *   - `CUP` + `EL` per changed line. No full clear per frame, because a full
 *     clear flickers in every terminal that does not implement synchronised
 *     output - which is most of them.
 *   - NO mouse reporting (`?1000`, `?1002`, `?1003`, `?1006`). JetBrains and
 *     several tmux configurations break click-to-select once it is on, and a
 *     process that dies before sending the disable sequence leaves the user's
 *     shell receiving mouse packets as keystrokes. Keyboard-only costs this
 *     program nothing.
 *   - NO synchronised output (`?2026`) and NO focus reporting (`?1004`). They
 *     are private modes that most terminals ignore politely and a few (older
 *     ConEmu, some JetBrains builds) echo as literal text into the frame.
 *     Per-line diffing removes the flicker they would have fixed.
 *   - NO application cursor keys (`?1h`). `emitKeypressEvents` decodes both
 *     the normal and the application form, so turning it on buys nothing and
 *     is one more mode to restore.
 *   - NO DECAWM off (`?7l`). Instead the last column is never written. See
 *     `usableWidth`.
 */

import { emitKeypressEvents } from 'node:readline';

/* -- escape sequences --------------------------------------------------- */

const ESC = String.fromCharCode(27);
const CSI = ESC + '[';
const BEL = String.fromCharCode(7);

export const ANSI = {
  enterAlt: `${CSI}?1049h`,
  leaveAlt: `${CSI}?1049l`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  clearScreen: `${CSI}2J`,
  resetSgr: `${CSI}0m`,
  /** 1-based, like the terminal counts. */
  moveTo: (row, col) => `${CSI}${row};${col}H`,
  clearLine: `${CSI}2K`,
};

/**
 * The narrowest width this UI claims to look right at. Below it the layout
 * stacks instead of tabulating; it never writes past the edge either way.
 */
export const MIN_WIDTH = 40;

/**
 * One column is left unwritten on every row, always.
 *
 * Writing the final cell is only safe on terminals with deferred wrap: they
 * park the cursor in the margin and wrap on the *next* printable character.
 * ConPTY and a few emulators wrap eagerly instead, and an eager wrap on the
 * bottom row scrolls the alternate screen, which corrupts every frame after
 * it. A column is cheap; a whole class of platform-specific corruption is not.
 */
export const usableWidth = (columns) => Math.max(1, columns - 1);

/* -- capability detection ----------------------------------------------- */

/**
 * What this terminal can actually do. Nothing here is assumed from the fact
 * that a TTY exists.
 *
 * `force` makes the streams count as terminals when they are not. It exists
 * for the real cases where `isTTY` lies - a wrapper, a pty-less runner that is
 * nonetheless watched by a human, `docker run` without `-t` - and it is what
 * the tests use to drive the UI without a pty.
 */
export function detect({
  stdout = process.stdout,
  stdin = process.stdin,
  env = process.env,
  force = false,
} = {}) {
  const outTTY = force || Boolean(stdout.isTTY);
  const inTTY = force || Boolean(stdin.isTTY);
  const term = String(env.TERM || '').toLowerCase();

  // `dumb` and `unknown` are the two terminfo names that promise no cursor
  // addressing. An *unset* TERM is not one of them: containers and IDE
  // terminals routinely leave it empty while being perfectly ANSI, and
  // `isTTY` has already told us a terminal is there.
  const dumb = term === 'dumb' || term === 'unknown';

  // NO_COLOR, read the same way render.mjs reads it, so one process never
  // disagrees with itself about whether colour is allowed.
  const noColor = Boolean(env.NO_COLOR);

  let color = 0;
  if (outTTY && !noColor && !dumb) {
    const ct = String(env.COLORTERM || '').toLowerCase();
    if (ct === 'truecolor' || ct === '24bit') color = 24;
    else if (/256/.test(term)) color = 8;
    else color = 4;
  }

  return {
    outTTY,
    inTTY,
    dumb,
    /** 0 = none, 4 = the original sixteen, 8 = 256, 24 = truecolour. */
    color,
    unicode: detectUnicode(env),
    /** Full-screen drawing is possible: a terminal on both ends, addressable. */
    fullscreen: outTTY && inTTY && !dumb,
    columns: Math.max(1, stdout.columns || 80),
    rows: Math.max(1, stdout.rows || 24),
  };
}

/**
 * Whether box-drawing characters will render or turn into mojibake.
 *
 * A wrong "yes" is two garbage bytes per rule; a wrong "no" is a slightly
 * plainer frame. So this leans towards no on POSIX unless the locale says
 * UTF-8, and towards yes on the two platforms that have no other option.
 */
function detectUnicode(env) {
  if (env.LOBSTACK_ASCII) return false;
  const locale = `${env.LC_ALL || ''} ${env.LC_CTYPE || ''} ${env.LANG || ''}`.toLowerCase();
  if (/utf-?8/.test(locale)) return true;
  if (process.platform === 'darwin') return true; // UTF-8 only for a decade
  if (process.platform === 'win32') {
    // Windows Terminal, VS Code and ConEmu are UTF-8 capable. A bare
    // conhost.exe in a legacy code page is not, and that is still the default.
    return Boolean(env.WT_SESSION || env.TERM_PROGRAM === 'vscode' || env.ConEmuANSI === 'ON');
  }
  return false;
}

/* -- colour ------------------------------------------------------------- */

/**
 * A styling function for a given colour depth.
 *
 * Returns `(style, text) => string`. At depth 0 it is the identity, which is
 * what makes the view renderable as plain text in a test and on a `TERM=dumb`
 * terminal from the same code path.
 */
export function styler(depth) {
  if (!depth) return (_style, text) => text;

  // SGR 2 (faint) is the honest way to say "chrome, not content", but a
  // handful of terminals render it as invisible or ignore it outright. Where
  // 256 colours are available a mid grey is more predictable.
  const wide = depth >= 8;
  const table = {
    dim: wide ? '38;5;245' : '2',
    bold: '1',
    heading: wide ? '1;38;5;252' : '1',
    accent: wide ? '38;5;80' : '36',
    good: wide ? '38;5;78' : '32',
    warn: wide ? '38;5;179' : '33',
    bad: wide ? '38;5;210' : '31',
    you: wide ? '1;38;5;110' : '1;34',
  };
  return (style, text) => {
    const code = table[style];
    return code ? `${CSI}${code}m${text}${ANSI.resetSgr}` : text;
  };
}

/* -- text measurement and sanitising ------------------------------------ */

/**
 * Display width of a string in cells.
 *
 * A pragmatic subset of UAX #11, not a full implementation: combining marks
 * are zero, the East Asian Wide and Fullwidth blocks plus emoji presentation
 * are two, everything else is one. It gets CJK, Hangul, Kana and the common
 * emoji right, which is what actually turns up in a model's answer. Merely
 * close is still far better than `String.length`, which is wrong by a factor
 * of two on a line of Japanese and pushes every following frame sideways.
 */
export function width(str) {
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue; // control: never drawn
    if (
      (cp >= 0x0300 && cp <= 0x036f) || // combining diacriticals
      (cp >= 0x200b && cp <= 0x200f) || // zero-width space and marks
      cp === 0xfe0f ||
      cp === 0xfe0e || // variation selectors
      (cp >= 0x20d0 && cp <= 0x20f0)
    ) {
      continue;
    }
    if (
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals through Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility
      (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
      (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji and pictographs
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd) // CJK extension B and later
    ) {
      w += 2;
      continue;
    }
    w += 1;
  }
  return w;
}

/** Truncate to `max` display cells, counting the same way `width` does. */
export function clip(str, max) {
  if (max <= 0) return '';
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = width(ch);
    if (w + cw > max) break;
    out += ch;
    w += cw;
  }
  return out;
}

/**
 * Strip anything that would move the cursor or change colour.
 *
 * This is a security boundary, not tidiness. Model output, a gateway error
 * message and a proxied request body are all attacker-influenced text that
 * this program is about to paste into a terminal. Left alone, a clear-screen
 * sequence inside a completion wipes the frame, and an OSC sequence rewrites
 * the window title. Escapes are removed rather than escaped, because there is
 * no reason to render them at all.
 */
export function sanitize(str) {
  const oscTerm = `${BEL}${ESC}`;
  return String(str)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(new RegExp(`${ESC}\\][^${oscTerm}]*(?:${BEL}|${ESC}\\\\)`, 'g'), '') // OSC
    .replace(new RegExp(`${ESC}[[\\]()#;?]*[0-9;]*[A-Za-z]?`, 'g'), '') // CSI and friends
    .replace(/[^\n -~ -￿]/g, '');
}

/**
 * Wrap text to `max` cells, breaking on spaces and hard-breaking a word that
 * is wider than the line. Returns at least one (possibly empty) line.
 */
export function wrapText(str, max) {
  if (max <= 0) return [''];
  const out = [];
  for (const paragraph of sanitize(str).split('\n')) {
    let line = '';
    let lineW = 0;
    for (const word of paragraph.split(' ')) {
      const wordW = width(word);
      if (lineW && lineW + 1 + wordW > max) {
        out.push(line);
        line = '';
        lineW = 0;
      }
      if (wordW > max) {
        // A URL or a base64 blob. Break it rather than overflow the row.
        let rest = word;
        if (lineW) {
          out.push(line);
          line = '';
          lineW = 0;
        }
        while (width(rest) > max) {
          const head = clip(rest, max);
          if (!head) break;
          out.push(head);
          rest = rest.slice(head.length);
        }
        line = rest;
        lineW = width(rest);
        continue;
      }
      line = lineW ? `${line} ${word}` : word;
      lineW += (lineW ? 1 : 0) + wordW;
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

/* -- the frame writer --------------------------------------------------- */

/**
 * Paints an array of ready-made lines, writing only what changed.
 *
 * Line diffing is what keeps this readable in a terminal with no synchronised
 * output: a streaming answer touches one or two rows per frame, so one or two
 * rows get repainted, and nothing else on screen so much as flickers.
 */
export class Screen {
  constructor(out) {
    this.out = out;
    this.prev = [];
  }

  /** Forget what is on screen. Call after a resize, or on a requested redraw. */
  invalidate() {
    this.prev = [];
  }

  /**
   * @param {string[]} lines one entry per row, already styled and clipped
   * @param {{row:number,col:number}|null} caret 1-based; null hides the cursor
   */
  paint(lines, caret) {
    let buf = ANSI.hideCursor;
    if (!this.prev.length) buf += ANSI.clearScreen;

    for (let i = 0; i < lines.length; i++) {
      if (this.prev[i] === lines[i]) continue;
      // Erase the whole row before writing it: the new content may be shorter
      // than the old, and the absolute move that follows the write cancels any
      // deferred wrap the write may have armed.
      buf += ANSI.moveTo(i + 1, 1) + ANSI.clearLine + lines[i];
    }
    for (let i = lines.length; i < this.prev.length; i++) {
      buf += ANSI.moveTo(i + 1, 1) + ANSI.clearLine;
    }

    if (caret) buf += ANSI.moveTo(caret.row, caret.col) + ANSI.showCursor;
    else buf += ANSI.moveTo(Math.max(1, lines.length), 1);

    this.out.write(buf);
    this.prev = lines.slice();
  }
}

/* -- lifecycle ---------------------------------------------------------- */

/**
 * Owns the terminal's modes, and gives them all back.
 *
 * `restore()` is idempotent and is wired to every exit this process has: a
 * normal return, `process.exit` from anywhere (including `fail()` in
 * render.mjs), SIGINT, SIGTERM, SIGHUP, SIGQUIT, an uncaught throw and an
 * unhandled rejection. The `exit` listener is the one that cannot be skipped,
 * so it is the backstop; on a TTY `process.stdout.write` is synchronous, which
 * is the only reason writing escape sequences from an `exit` handler works.
 *
 * Installing signal listeners suppresses Node's default handling, so each one
 * has to finish the job itself and exit with the conventional 128 + signal.
 */
export class Terminal {
  constructor({ stdout = process.stdout, stdin = process.stdin, caps } = {}) {
    this.out = stdout;
    this.in = stdin;
    this.caps = caps || detect({ stdout, stdin });
    this.screen = new Screen(stdout);
    this.entered = false;
    this.restored = false;
    this.handlers = [];
    this.onResize = null;
  }

  get columns() {
    return Math.max(1, this.out.columns || this.caps.columns || 80);
  }

  get rows() {
    return Math.max(1, this.out.rows || this.caps.rows || 24);
  }

  /** Raw mode, alternate screen, cursor hidden, and every way out guarded. */
  enter() {
    if (this.entered) return this;
    this.entered = true;

    // Guards go on *before* any mode is changed, so a throw between here and
    // the end of this method still hands the terminal back.
    this.#guard();

    this.out.write(ANSI.enterAlt + ANSI.hideCursor);

    // `--force` with a pipe on stdin has no raw mode to set. Everything else
    // still works; keystrokes simply arrive line-buffered.
    if (typeof this.in.setRawMode === 'function' && this.in.isTTY) this.in.setRawMode(true);
    emitKeypressEvents(this.in);
    this.in.resume();

    this.resizeListener = () => {
      // Every row's content depends on the width, so nothing on screen is
      // reusable. Drop the diff baseline and repaint from scratch.
      this.screen.invalidate();
      this.onResize?.();
    };
    this.out.on('resize', this.resizeListener);
    return this;
  }

  onKey(handler) {
    this.keyListener = handler;
    this.in.on('keypress', handler);
    return this;
  }

  paint(lines, caret) {
    this.screen.paint(lines, caret);
  }

  /** Idempotent, and safe to call from a signal handler or an `exit` hook. */
  restore() {
    if (this.restored || !this.entered) return;
    this.restored = true;

    try {
      if (this.keyListener) this.in.removeListener('keypress', this.keyListener);
      if (this.resizeListener) this.out.removeListener('resize', this.resizeListener);
      if (typeof this.in.setRawMode === 'function' && this.in.isTTY) this.in.setRawMode(false);
      this.in.pause();
      // Order matters: reset colour and show the cursor *inside* the alternate
      // screen, then leave it. Leaving first and writing after would print the
      // sequences onto whatever row the user's scrollback had ended on.
      this.out.write(ANSI.resetSgr + ANSI.showCursor + ANSI.leaveAlt);
    } catch {
      // A closed or broken stdout during shutdown is not worth a second error
      // on top of whatever is already going wrong.
    }
    for (const off of this.handlers) {
      try {
        off();
      } catch {
        /* removing a listener cannot usefully fail */
      }
    }
    this.handlers = [];
  }

  #guard() {
    const on = (event, fn) => {
      process.on(event, fn);
      this.handlers.push(() => process.removeListener(event, fn));
    };

    // The backstop. Runs for a normal return and for every `process.exit`,
    // including the one inside `fail()`.
    on('exit', () => this.restore());

    for (const [sig, code] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
      ['SIGHUP', 129],
      ['SIGQUIT', 131],
    ]) {
      on(sig, () => {
        this.restore();
        process.exit(code);
      });
    }

    on('uncaughtException', (err) => {
      this.restore();
      // Having a listener means Node will not print this itself, so print it -
      // a UI that vanishes without saying why is worse than a stack trace.
      process.stderr.write(`\n${(err && err.stack) || err}\n`);
      process.exit(1);
    });
    on('unhandledRejection', (err) => {
      this.restore();
      process.stderr.write(`\n${(err && err.stack) || err}\n`);
      process.exit(1);
    });
  }
}
