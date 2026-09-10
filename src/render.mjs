/** Terminal output. Colour only when the stream is a TTY and NO_COLOR is unset. */
const ESC = '[';
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `${ESC}${code}m${s}${ESC}0m` : s);

export const dim = wrap('2');
export const bold = wrap('1');
export const red = wrap('31');
export const green = wrap('32');

export const money = (n) =>
  n === null || n === undefined ? 'unpriced' : n >= 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(6)}`;

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

  if (typeof receipt?.savings_usd === 'number' && receipt.savings_usd > 0) {
    parts.push(`${dim('saved')} ${green(money(receipt.savings_usd))}`);
  }

  process.stderr.write('\n' + dim('- ') + parts.join(dim('  -  ')) + '\n');

  if (receipt && receipt.priced === false) {
    process.stderr.write(dim('  the gateway could not price this model, so no cost is claimed\n'));
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
