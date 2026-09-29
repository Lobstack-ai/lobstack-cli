/** Terminal output. Colour only when the stream is a TTY and NO_COLOR is unset. */
const ESC = '[';
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `${ESC}${code}m${s}${ESC}0m` : s);

export const dim = wrap('2');
export const bold = wrap('1');
export const red = wrap('31');
export const green = wrap('32');

export const money = (n) =>
  typeof n !== 'number' || !Number.isFinite(n)
    ? 'unpriced'
    : n >= 0.01
      ? `$${n.toFixed(4)}`
      : `$${n.toFixed(6)}`;

/**
 * Whether a saving may be called a saving, in one place.
 *
 * `baseline_reason` decides. "named" means the caller asked for a model and got
 * something cheaper -- a like-for-like comparison, and the only case that may
 * be labelled `saved`. "plan_ceiling" means they sent `auto` and the gateway
 * measured against the most expensive model their plan allows, which is a real
 * comparison but not one they asked for.
 *
 * This lives here rather than in each renderer because there are now three of
 * them -- the single-shot receipt, the proxy's per-request line and the TUI --
 * and three copies of a rule about overstating savings is three chances to
 * drift apart on the one thing this product is arguing about.
 *
 * @returns {{label:string, named:boolean, amount:number}|null}
 */
export function savingsLabel(receipt) {
  const amount = receipt?.savings_usd;
  if (typeof amount !== 'number' || !(amount > 0)) return null;
  const named = receipt.baseline_reason === 'named';
  return { label: named ? 'saved' : 'vs ceiling', named, amount };
}

/**
 * `/api/v1/usage`, as lines of text, for `lobstack spend` and the TUI's /spend.
 *
 * THE TOTAL IS THE CONSOLE'S. The endpoint returns two totals of one quantity:
 * `spend.cost_usd`, from the billing ledger the Console's Spend shows and
 * invoices are cut from, and `summary.cost_usd`, the request trace's own copy
 * of each price, kept for older callers. They are written separately and can
 * disagree. The ledger's figure is used, and each group's `ledger_cost_usd`;
 * the trace's copy only when the ledger figure is null (it could not be read)
 * or absent (an older deployment), and a note says so.
 *
 * SAVINGS ARE TWO FIGURES. `savings.named` is measured against models the
 * caller asked for; `savings.plan_ceiling` is what `auto` requests would have
 * cost on the priciest model the plan allows, which nobody asked for. They are
 * printed on separate lines and never added together.
 *
 * Plain strings, no colour, so both renderers can use them.
 *
 * @returns {{head: string, rows: string[], savings: string[], notes: string[]}}
 */
export function spendReport(body, days) {
  const s = body?.summary || {};
  const ledger = body?.spend && typeof body.spend === 'object' ? body.spend : null;
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const fromLedger = ledger !== null && isNum(ledger.cost_usd);
  const cost = fromLedger ? ledger.cost_usd : isNum(s.cost_usd) ? s.cost_usd : null;
  const unpriced = fromLedger ? ledger.unpriced_rows ?? 0 : s.unpriced_requests ?? 0;
  const priceable = fromLedger ? ledger.rows ?? 0 : s.requests ?? 0;
  const costText = priceable > 0 && unpriced >= priceable ? 'unpriced' : money(cost);
  const n = (count, one) => `${count} ${one}${count === 1 ? '' : 's'}`;

  // The window the server actually summed. It answers an unknown range with
  // 7d, so `--days 5` is labelled for what came back, not what was asked.
  const served = typeof body?.range === 'string' ? body.range : `${days}d`;
  const label = served === 'month' ? 'this month' : /^\d+d$/.test(served) ? `last ${parseInt(served, 10)} days` : `last ${days} days`;
  const head = `${label}: ${n(s.requests ?? 0, 'request')}, ${costText}`;
  const rows = (body?.groups ?? []).map((g) => {
    const gCost = isNum(g.ledger_cost_usd) ? g.ledger_cost_usd : isNum(g.cost_usd) ? g.cost_usd : null;
    const gUnpriced = isNum(g.ledger_cost_usd) ? g.ledger_unpriced_rows ?? 0 : g.unpriced_requests ?? 0;
    return (
      `  ${String(g.key ?? '').padEnd(24)} ${String(g.requests ?? 0).padStart(6)}  ${money(gCost)}` +
      (gUnpriced ? `  (${gUnpriced} unpriced)` : '')
    );
  });

  const savings = [];
  const named = body?.savings?.named;
  const ceiling = body?.savings?.plan_ceiling;
  if (named && named.requests > 0 && isNum(named.difference_usd)) {
    savings.push(
      named.difference_usd < 0
        ? `routing cost ${money(-named.difference_usd)} more than the models you named, on ${n(named.requests, 'request')}`
        : `saved ${money(named.difference_usd)} on models you named, on ${n(named.requests, 'request')}`,
    );
  }
  if (ceiling && ceiling.requests > 0 && isNum(ceiling.difference_usd)) {
    savings.push(
      `vs ceiling ${money(ceiling.difference_usd)} on ${n(ceiling.requests, 'auto request')} - ` +
        'compared with the best model your plan allows, which you did not ask for; not a saving',
    );
  }

  const notes = [];
  if (!fromLedger) {
    notes.push(
      (ledger === null && body && 'spend' in body
        ? 'the billing ledger could not be read'
        : 'this deployment does not report the billing ledger') +
        ", so this total is the request trace's copy of each price (the legacy summary.cost_usd) and can differ from the Console",
    );
  }
  if (unpriced > 0) {
    notes.push(`${n(unpriced, fromLedger ? 'row' : 'request')} could not be priced, so the total is a floor, not a total`);
  }
  if (body?.truncated || (fromLedger && ledger.truncated)) {
    notes.push('the row cap bound on this range, so older requests are not counted');
  }
  return { head, rows, savings, notes };
}

/**
 * Print the receipt.
 *
 * `cost_usd` is null, never zero, when the Gateway could not price the call.
 * Rendering that null as $0.00 would write off a real charge — which is the
 * whole reason the field is nullable — so "unpriced" is printed instead.
 *
 * It goes to stderr, so `lobstack chat "..." > out.txt` gives you the answer
 * and nothing else while you still see what it cost.
 */
export function printReceipt({ receipt, usage, model }) {
  const served = receipt?.served_model || model || 'unknown';
  const asked = receipt?.requested_model;
  const parts = [];

  parts.push(`${dim('model')} ${served}`);
  if (asked && receipt?.routed) parts.push(`${dim('asked')} ${asked}`);
  if (usage) parts.push(`${dim('tokens')} ${usage.prompt_tokens}/${usage.completion_tokens}`);
  parts.push(`${dim('cost')} ${money(receipt?.cost_usd)}`);

  // Printing a plan-ceiling comparison as a like-for-like saving is the
  // overstatement the receipt exists to prevent. `savingsLabel` decides.
  const saving = savingsLabel(receipt);
  if (saving) parts.push(`${dim(saving.label)} ${green(money(saving.amount))}`);

  process.stderr.write('\n' + dim('- ') + parts.join(dim('  -  ')) + '\n');

  if (receipt?.baseline_reason === 'plan_ceiling' && receipt.baseline_model) {
    process.stderr.write(
      dim(`  measured against ${receipt.baseline_model}, the priciest model your plan allows - you sent auto, not that model\n`),
    );
  }
  if (receipt && receipt.priced === false) {
    process.stderr.write(dim('  the Lobstack API could not price this model, so no cost is claimed\n'));
  }
  if (!receipt) {
    // An older Gateway, or a non-Lobstack base URL. Say so rather than
    // silently showing nothing where a price belongs.
    process.stderr.write(dim('  no receipt on this response - the endpoint did not send one\n'));
  }
}

export function fail(message, hint) {
  process.stderr.write(`${red('error')} ${message}\n`);
  if (hint) process.stderr.write(dim(`  ${hint}\n`));
  process.exit(1);
}
