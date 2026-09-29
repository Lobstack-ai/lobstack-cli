/**
 * The frame, as a pure function of state.
 *
 * `frame(state, opts)` takes the whole UI state and returns the exact array of
 * rows to paint plus where the caret goes. It touches no terminal and no
 * globals, which is what makes the layout testable: the tests render at 80
 * columns and at 40 columns with `sgr` set to the identity and read the result
 * as text, the same way a human reads the screen.
 *
 * The rule that shapes every line here: the receipt is not decoration. A chat
 * pane is worth nothing on its own - every tool has one - so the price of the
 * last call and the running total for the session are the two things that are
 * never scrolled away, never collapsed to save a row, and never rounded into
 * something friendlier than the truth.
 */

import { money, savingsLabel } from './render.mjs';
import { MIN_WIDTH, usableWidth, clip, width, wrapText } from './tty.mjs';

/* -- composition -------------------------------------------------------- */

/** A styled run of text. `style` is a key `styler()` understands, or null. */
export const seg = (text, style = null) => ({ text: String(text), style });

/**
 * Join segments into one row, clipping to `w` cells and styling as it goes.
 *
 * Clipping happens on the plain text before any escape is added, so a style
 * never counts towards the width and a truncated row never ends inside an
 * escape sequence.
 */
export function compose(segments, w, sgr) {
  let out = '';
  let used = 0;
  for (const s of segments) {
    if (used >= w) break;
    const text = width(s.text) > w - used ? clip(s.text, w - used) : s.text;
    if (!text) continue;
    out += s.style ? sgr(s.style, text) : text;
    used += width(text);
  }
  return out;
}

/**
 * Left group against right group, first pair that fits.
 *
 * The candidates are ordered by what matters, not by what is on the left: the
 * running total is the reason to look at this screen, so a narrow terminal
 * gives up the word "lobstack" and then the model name before it gives up the
 * money. A right group is never silently clipped - it is swapped for a shorter
 * one, or the pair is abandoned for the next candidate.
 */
function spread(candidates, w, sgr) {
  for (const [left, right] of candidates) {
    const lw = segW(left);
    const rw = segW(right);
    if (!rw) {
      if (lw <= w) return compose(left, w, sgr);
      continue;
    }
    if (lw + 2 + rw <= w) return compose([...left, seg(' '.repeat(w - lw - rw)), ...right], w, sgr);
  }
  return compose(candidates[0][0], w, sgr);
}

const rule = (w, caps, sgr) => sgr('dim', (caps.unicode ? '─' : '-').repeat(w));

/* -- the running session total ------------------------------------------ */

/**
 * The number in the top right, and the whole reason to watch this screen.
 *
 * Three honesty constraints, all of them load-bearing:
 *
 *   - A session whose only calls came back unpriced shows `unpriced`, not
 *     `$0.000000`. Summing nulls as zero is how you end up confidently
 *     reporting a free afternoon against a real invoice.
 *   - Unpriced calls are counted out loud next to a priced total, so the total
 *     is never mistaken for "everything so far".
 *   - `saved` and `vs ceiling` are separate tallies and are never added
 *     together. They answer different questions - see render.mjs - and one
 *     combined "total saved" would be the overstatement the receipt exists to
 *     prevent.
 */
export function sessionSegments(s, { long = true, savings = true } = {}) {
  const out = [];
  if (!s.calls) return [seg('no calls yet', 'dim')];

  out.push(seg(`${s.calls}${long ? (s.calls === 1 ? ' call' : ' calls') : 'x'}`, 'dim'));
  out.push(seg('  '));
  out.push(seg(s.priced ? money(s.costUsd) : 'unpriced', s.priced ? 'bold' : 'warn'));
  if (s.priced && s.unpriced) {
    out.push(seg(`  +${s.unpriced} unpriced`, 'warn'));
  }
  if (savings && s.savedNamed > 0) {
    out.push(seg('  saved ', 'dim'), seg(money(s.savedNamed), 'good'));
  }
  if (savings && s.savedCeiling > 0) {
    out.push(seg('  vs ceiling ', 'dim'), seg(money(s.savedCeiling), 'accent'));
  }
  return out;
}

/** A fresh, empty session tally. */
export const newSession = () => ({
  calls: 0,
  priced: 0,
  unpriced: 0,
  costUsd: 0,
  savedNamed: 0,
  savedCeiling: 0,
  inTok: 0,
  outTok: 0,
});

/**
 * Fold one receipt into the session tally.
 *
 * A null `cost_usd` increments `unpriced` and adds nothing to `costUsd`; it is
 * never coerced. The saving lands in exactly one of the two buckets, chosen by
 * the same `savingsLabel` the single-shot receipt uses.
 */
export function accrue(session, { receipt, usage }) {
  session.calls += 1;
  if (typeof receipt?.cost_usd === 'number') {
    session.priced += 1;
    session.costUsd += receipt.cost_usd;
  } else {
    session.unpriced += 1;
  }
  const saving = savingsLabel(receipt);
  if (saving) {
    if (saving.named) session.savedNamed += saving.amount;
    else session.savedCeiling += saving.amount;
  }
  if (usage) {
    session.inTok += Number(usage.prompt_tokens || 0);
    session.outTok += Number(usage.completion_tokens || 0);
  }
  return session;
}

/* -- the receipt pane --------------------------------------------------- */

/**
 * The persistent receipt for the last call, as exactly `maxRows` rows.
 *
 * This is the only part of the screen that is measured before it is drawn
 * rather than clipped after. At 80 columns - the width that actually matters -
 * the full receipt is 103 cells and does not fit on one row, and the first
 * thing a naive clip throws away is the end of the line, which is where the
 * saving is. So the content is assembled as three pieces, each with a fallback
 * that is shorter rather than truncated, and the layout picks the widest set
 * that fits:
 *
 *   identity  what was served, and what was asked for
 *   price     tokens, cost, saving, latency - the cost and the saving never
 *             drop, the tokens and the latency do
 *   caveat    why the saving is or is not a like-for-like comparison, or why
 *             there is no price at all. Never dropped while there is a row.
 */
export function receiptRows(state, w, maxRows, caps) {
  if (state.streaming) return fold(streamingRows(state, caps), maxRows);
  const last = state.last;
  if (!last) {
    return fold(
      [[seg(' no call yet.', 'dim'), seg(' Type a prompt and press Enter.', 'dim')]],
      maxRows,
    );
  }

  const r = last.receipt;
  const served = r?.served_model || last.model || 'unknown';
  const asked = r?.requested_model;
  const saving = savingsLabel(r);
  const priced = typeof r?.cost_usd === 'number';

  /* identity */
  const idFull = [seg(' '), seg('model ', 'dim'), seg(served, 'heading')];
  const idWithAsked =
    asked && r?.routed ? [...idFull, seg('  asked ', 'dim'), seg(asked)] : idFull;
  const identity = segW(idWithAsked) <= w ? idWithAsked : idFull;

  /* price. `money(null)` is the word "unpriced": a null cost is a charge the
     gateway could not price, not a free call, and $0.00 would write it off. */
  const cost = [seg('cost ', 'dim'), seg(money(r?.cost_usd), priced ? 'bold' : 'warn')];
  if (saving) {
    cost.push(
      seg(`  ${saving.label} `, 'dim'),
      seg(money(saving.amount), saving.named ? 'good' : 'accent'),
    );
  }
  const tokens = last.usage
    ? [
        seg('tokens ', 'dim'),
        seg(`${last.usage.prompt_tokens ?? '?'}/${last.usage.completion_tokens ?? '?'}`),
        seg('  '),
      ]
    : [];
  const latency = last.ms ? [seg(`  in ${last.ms}ms`, 'dim')] : [];
  // A clipped money value is not a shortened number, it is a different and
  // smaller one: "$0.004400" cut to "$0.004" reads as four tenths of the real
  // saving. So the fallbacks drop labels, then the tokens, then the saving
  // itself - anything rather than let a figure be truncated.
  const bare = cost.map((c, i) => (i === 0 ? seg('', null) : c));
  const price = widest(w, [
    [seg(' '), ...tokens, ...cost, ...latency],
    [seg(' '), ...tokens, ...cost],
    [seg(' '), ...cost],
    [seg(' '), ...bare],
    [seg(' '), seg(money(r?.cost_usd), priced ? 'bold' : 'warn')],
  ]);

  /* caveat */
  const caveat = caveatRow(r, saving, w);

  /* fit */
  const merged = [...identity, seg('  '), ...price.slice(1)];
  const fits = segW(merged) <= w;
  if (maxRows >= 3) {
    return fold(fits ? [merged, caveat, footnote(state, r)] : [identity, price, caveat], maxRows);
  }
  if (maxRows === 2) {
    return fold(fits ? [merged, caveat] : [compactRow(served, cost), caveat], maxRows);
  }
  return fold([fits ? merged : compactRow(served, cost)], maxRows);
}

/**
 * While a stream is open.
 *
 * There is no running dollar figure here, on purpose. Cost is read off the
 * gateway's last frame, never computed from token counts against a local rate
 * card - that is exactly the bug that printed $0.00 for three months next to a
 * correct invoice. So until the receipt lands this reports only what it
 * honestly knows: elapsed time, and how much text has arrived.
 */
function streamingRows(state, caps) {
  const secs = ((Date.now() - state.streamStartedAt) / 1000).toFixed(1);
  return [
    [
      seg(` ${caps.unicode ? '\u00b7' : '*'} `, 'accent'),
      seg('streaming', 'accent'),
      seg('  asked ', 'dim'),
      seg(state.model),
      seg(`  ${secs}s  ${state.streamChars} chars`, 'dim'),
    ],
    [seg('   the price arrives with the last frame of the stream', 'dim')],
  ];
}

/** Model and price only: the fallback when a row has to carry both. */
const compactRow = (served, cost) => [seg(' '), seg(served, 'heading'), seg('  '), ...cost];

/**
 * Every caveat has a long form and a short one, so a narrow terminal loses
 * words rather than meaning. The `plan_ceiling` note in particular has to
 * survive at 40 columns: a saving measured against a model nobody asked for is
 * the one thing this receipt exists to be honest about.
 */
function caveatRow(r, saving, w) {
  const pick = (forms, style = 'dim') => {
    for (const f of forms) if (width(f) <= w) return [seg(f, style)];
    return [seg(forms[forms.length - 1], style)];
  };
  if (r?.baseline_reason === 'plan_ceiling' && r.baseline_model) {
    return pick([
      `   vs ${r.baseline_model}, the priciest model your plan allows - not one you asked for`,
      `   vs ${r.baseline_model}, the priciest model your plan allows`,
      `   ceiling baseline: ${r.baseline_model}`,
    ]);
  }
  if (r && r.priced === false) {
    return pick([
      '   the Lobstack API could not price this model, so no cost is claimed',
      '   the API could not price this model',
    ]);
  }
  if (!r) {
    return pick(
      [
        '   no receipt on this response - the endpoint did not send one',
        '   no receipt on this response',
      ],
      'warn',
    );
  }
  if (saving?.named && r.baseline_model) {
    return pick([
      `   against ${r.baseline_model}, the model you named`,
      `   named: ${r.baseline_model}`,
    ]);
  }
  return [];
}

/** The spare row at wide widths: the request id, and the session's tokens. */
function footnote(state, r) {
  const bits = [];
  if (r?.request_id) bits.push(`request ${r.request_id}`);
  const s = state.session;
  if (s.inTok || s.outTok) bits.push(`session ${s.inTok}/${s.outTok} tokens`);
  return bits.length ? [seg(`   ${bits.join('   ')}`, 'dim')] : [];
}

const segW = (segments) => segments.reduce((n, s) => n + width(s.text), 0);

/** The first candidate that fits, or the last one, clipped. */
function widest(w, candidates) {
  for (const c of candidates) if (segW(c) <= w) return c;
  return candidates[candidates.length - 1];
}

/** Pad or trim to exactly `maxRows`, so the layout above never shifts. */
function fold(rows, maxRows) {
  const out = rows.slice(0, maxRows);
  while (out.length < maxRows) out.push([]);
  return out;
}

/* -- the transcript ----------------------------------------------------- */

const LABEL = { user: 'you', assistant: 'lob', system: 'sys', error: 'err' };
const LABEL_STYLE = { user: 'you', assistant: 'accent', system: 'dim', error: 'bad' };

/** Every transcript row, oldest first, already wrapped to `w`. */
export function transcriptRows(state, w) {
  const gutter = w >= 16 ? 5 : 0;
  const textW = Math.max(1, w - gutter - 1);
  const rows = [];
  for (const m of state.messages) {
    const label = LABEL[m.role] || 'sys';
    const style = LABEL_STYLE[m.role] || 'dim';
    const lines = wrapText(m.text, textW);
    for (let i = 0; i < lines.length; i++) {
      const head = gutter
        ? [seg(' '), seg(i === 0 ? label.padEnd(gutter - 1) : ' '.repeat(gutter - 1), style)]
        : [];
      rows.push([...head, seg(lines[i], m.role === 'error' ? 'bad' : null)]);
    }
    rows.push([]); // one blank row between turns, so a long answer has an edge
  }
  if (rows.length) rows.pop();
  return rows;
}

/* -- overlays ----------------------------------------------------------- */

const KEYS = [
  ['Enter', 'send the prompt'],
  ['\\ at end of line', 'keep typing on a new line (Alt+Enter too, where the terminal sends it)'],
  ['Ctrl+C', 'cancel a streaming answer; quit when nothing is streaming'],
  ['Ctrl+D', 'quit'],
  ['Tab', 'complete a slash command, or open the model picker on an empty line'],
  ['Up / Down', 'walk back through what you sent'],
  ['PgUp / PgDn', 'scroll the transcript; Esc returns to the live tail'],
  ['Ctrl+L', 'repaint, for when something else wrote over the screen'],
  ['Ctrl+A / Ctrl+E', 'start / end of line'],
  ['Ctrl+U / Ctrl+K / Ctrl+W', 'clear line / kill to end / delete a word'],
];

const COMMANDS = [
  ['/model [name]', 'set the model, or open the picker'],
  ['/models', 'what the Lobstack API will serve, with prices'],
  ['/spend [days]', 'what you have actually spent, from the usage API'],
  ['/receipt', 'every field of the last receipt, verbatim'],
  ['/proxy [port]', 'serve the OpenAI-compatible endpoint here, and watch it bill'],
  ['/new', 'forget the conversation; keep the session totals'],
  ['/clear', 'clear the screen; keep the conversation'],
  ['/help', 'this'],
  ['/quit', 'leave'],
];

function helpRows(w) {
  const rows = [[seg(' Keys', 'heading')]];
  const pad = w >= 64 ? 26 : 0;
  for (const [k, v] of KEYS) {
    if (pad) rows.push([seg('   '), seg(k.padEnd(pad), 'bold'), seg(v, 'dim')]);
    else rows.push([seg('   '), seg(k, 'bold')], [seg('     '), seg(v, 'dim')]);
  }
  rows.push([], [seg(' Commands', 'heading')]);
  for (const [k, v] of COMMANDS) {
    if (pad) rows.push([seg('   '), seg(k.padEnd(pad), 'bold'), seg(v, 'dim')]);
    else rows.push([seg('   '), seg(k, 'bold')], [seg('     '), seg(v, 'dim')]);
  }
  rows.push([], [seg(' Esc or any key closes this.', 'dim')]);
  return rows;
}

function pickerRows(state, w) {
  const p = state.picker;
  const rows = [
    [
      seg(' pick a model', 'heading'),
      seg(p.filter ? `   filter ${p.filter}` : '   type to filter, Enter to choose', 'dim'),
    ],
    [],
  ];
  const items = p.items;
  if (!items.length) {
    rows.push([seg('   nothing matches ', 'dim'), seg(p.filter)]);
    return rows;
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const on = i === p.index;
    // A marker, not just a colour. On NO_COLOR and TERM=dumb the highlight is
    // the only thing telling you which row Enter will take.
    const mark = on ? '>' : ' ';
    const cells = [
      seg(` ${mark} `, on ? 'accent' : 'dim'),
      seg(w >= 56 ? it.id.padEnd(28) : it.id, on ? 'bold' : null),
    ];
    if (w >= 56) {
      cells.push(seg(String(it.tier || '').padEnd(10), 'dim'), seg(it.price || '', 'dim'));
    }
    rows.push(cells);
  }
  return rows;
}

/* -- the input line ---------------------------------------------------- */

/**
 * Hard-wrap the input by cells and say exactly where the caret lands.
 *
 * Word wrapping is wrong here: the caret has to sit over the character it will
 * edit, so the only correct wrap is the one the terminal itself would do.
 */
export function layoutInput(text, caret, w, prompt) {
  const lines = [];
  let cur = '';
  let curW = 0;
  let off = 0;
  let cRow = 0;
  let cCol = width(prompt);
  const avail = Math.max(1, w - width(prompt));

  const mark = () => {
    cRow = lines.length;
    cCol = (lines.length === 0 ? width(prompt) : 0) + curW;
  };

  for (const ch of text) {
    const cw = width(ch);
    const limit = lines.length === 0 ? avail : w;
    if (curW + cw > limit) {
      lines.push(cur);
      cur = '';
      curW = 0;
    }
    if (off === caret) mark();
    cur += ch;
    curW += cw;
    off += ch.length;
  }
  if (off === caret) mark();
  lines.push(cur);
  return { lines, caretRow: cRow, caretCol: cCol };
}

/* -- the frame ---------------------------------------------------------- */

/**
 * Rows are allocated from the bottom up, and the receipt is allocated before
 * the transcript. A 10-row terminal loses conversation history, not the price
 * of the last call, because the price is the thing you cannot get back by
 * scrolling.
 */
export function frame(state, { columns, rows, caps, sgr }) {
  const w = usableWidth(columns);
  const h = Math.max(1, rows);
  const out = [];

  // A terminal this small cannot hold the layout. Rather than corrupt it, drop
  // to the two rows that matter - the price and the prompt - and spend anything
  // left over on the tail of the conversation. Still correct, still usable.
  if (h <= 3 || w < 12) {
    const receipt = receiptRows(state, w, 1, caps).map((r) => compose(r, w, sgr));
    const prompt = promptFor(state, caps);
    const inp = layoutInput(state.input, state.caret, w, prompt);
    const input = compose(
      [seg(prompt, 'accent'), seg(inp.lines[inp.lines.length - 1])],
      w,
      sgr,
    );
    const budget = Math.max(0, h - receipt.length - 1);
    const all = transcriptRows(state, w);
    const tail = all.slice(Math.max(0, all.length - budget)).map((r) => compose(r, w, sgr));
    while (tail.length < budget) tail.unshift('');
    const lines = [...tail, ...receipt, input].slice(-h);
    return { lines, caret: { row: lines.length, col: Math.min(w, inp.caretCol) + 1 } };
  }

  // Measured against the real terminal width, not the one reserved column
  // fewer, so a 40-column window is not treated as narrower than the minimum.
  const showFooter = h >= 14 && columns >= MIN_WIDTH;
  const showRules = h >= 10;
  // Three rows when there is room: identity, price, caveat. See receiptRows.
  const receiptH = h >= 14 ? 3 : h >= 11 ? 2 : 1;
  const inputMax = h >= 14 ? 4 : 2;

  const prompt = promptFor(state, caps);
  const inp = layoutInput(state.input, state.caret, w, prompt);
  // Keep the caret on screen when the prompt is taller than its window.
  const firstInput = Math.max(0, Math.min(inp.caretRow - inputMax + 1, inp.lines.length - inputMax));
  const inputLines = inp.lines.slice(firstInput, firstInput + inputMax);
  const inputH = inputLines.length;

  const chromeH = 1 + (showRules ? 2 : 0) + receiptH + inputH + (showFooter ? 1 : 0);
  const bodyH = Math.max(0, h - chromeH);

  /* header */
  const badges = [];
  if (state.proxy) badges.push(seg(`  proxy :${state.proxy.port}`, 'good'));
  if (state.scroll > 0) badges.push(seg(`  scrolled ${state.scroll}`, 'warn'));
  const titled = [seg(' lobstack', 'heading'), seg('  '), seg(state.model, 'accent'), ...badges];
  const bare = [seg(' '), seg(state.model, 'accent'), ...badges];
  const sess = (o) => sessionSegments(state.session, o);
  out.push(
    spread(
      [
        [titled, sess({ long: true })],
        [titled, sess({ long: false })],
        [bare, sess({ long: false })],
        [bare, sess({ long: false, savings: false })],
        [[seg(' ')], sess({ long: false, savings: false })],
      ],
      w,
      sgr,
    ),
  );
  if (showRules) out.push(rule(w, caps, sgr));

  /* body: an overlay if one is open, otherwise the transcript */
  if (bodyH > 0) {
    const body = state.overlay === 'help' ? helpRows(w) : state.picker ? pickerRows(state, w) : null;
    if (body) {
      // Overlays keep their own scroll-free window: the top matters most.
      const start = state.picker
        ? Math.max(0, Math.min(state.picker.index - bodyH + 4, body.length - bodyH))
        : Math.min(state.overlayScroll || 0, Math.max(0, body.length - bodyH));
      for (let i = 0; i < bodyH; i++) {
        const row = body[start + i];
        out.push(row ? compose(row, w, sgr) : '');
      }
    } else {
      const all = transcriptRows(state, w);
      // `scroll` counts rows held back from the bottom, so 0 is always the
      // live tail and a streaming answer stays pinned there.
      const maxScroll = Math.max(0, all.length - bodyH);
      const back = Math.min(state.scroll, maxScroll);
      const end = all.length - back;
      const start = Math.max(0, end - bodyH);
      const slice = all.slice(start, end);
      // Pad at the top so the conversation grows down from the rule instead of
      // jumping when the first answer arrives.
      for (let i = slice.length; i < bodyH; i++) out.push('');
      for (const row of slice) out.push(compose(row, w, sgr));
    }
  }

  /* receipt */
  if (showRules) out.push(rule(w, caps, sgr));
  for (const row of receiptRows(state, w, receiptH, caps)) out.push(compose(row, w, sgr));

  /* input */
  const inputStart = out.length;
  for (let i = 0; i < inputH; i++) {
    const isFirst = firstInput + i === 0;
    out.push(
      compose(
        [seg(isFirst ? prompt : ' '.repeat(width(prompt)), 'accent'), seg(inputLines[i])],
        w,
        sgr,
      ),
    );
  }

  /* footer */
  if (showFooter) out.push(compose(footerSegments(state, w), w, sgr));

  const caretRow = inputStart + (inp.caretRow - firstInput) + 1;
  const caret =
    state.picker || state.overlay
      ? null
      : { row: Math.min(caretRow, h), col: Math.min(w, inp.caretCol) + 1 };

  return { lines: out.slice(0, h), caret };
}

function promptFor(state, caps) {
  if (state.streaming) return caps.unicode ? '… ' : '. ';
  return caps.unicode ? '› ' : '> ';
}

function footerSegments(state, w) {
  const hint = (k, v) => [seg(k, 'bold'), seg(` ${v}`, 'dim'), seg('   ')];
  if (state.picker) {
    return [seg(' '), ...hint('Enter', 'choose'), ...hint('Esc', 'cancel'), ...hint('Up/Dn', 'move')];
  }
  if (state.overlay) return [seg(' '), ...hint('Esc', 'close')];
  if (w < 56) {
    return [
      seg(' '),
      ...hint('^C', state.streaming ? 'cancel' : 'quit'),
      ...hint('Tab', 'model'),
      seg('/help', 'bold'),
    ];
  }
  return [
    seg(' '),
    ...hint('^C', state.streaming ? 'cancel' : 'quit'),
    ...hint('Tab', 'model'),
    ...hint('PgUp', 'scroll'),
    ...hint('^L', 'redraw'),
    seg('/help', 'bold'),
    seg(' for the rest', 'dim'),
  ];
}
