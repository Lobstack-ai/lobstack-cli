/**
 * Talking to the Gateway, in one place.
 *
 * These four calls used to live inline in `index.mjs`, which was fine while
 * there was one caller per command. The TUI needs the same requests, the same
 * refusal to follow a redirect and the same error text, and two copies of
 * "never follow a redirect with a credential attached" is one copy too many.
 *
 * Nothing here calls `process.exit`. A failure throws a `GatewayError` that
 * carries the hint alongside the message, so the one-shot commands can print
 * it and die exactly as they did before while the TUI puts the same words in
 * the transcript and stays up.
 */

import { gatewayUrl } from './config.mjs';
import { consume } from './stream.mjs';

export class GatewayError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'GatewayError';
    this.hint = hint;
  }
}

export async function gwFetch(url, key, init = {}) {
  const { client, headers, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'x-lobstack-client': client || 'lobstack-cli',
      ...(headers || {}),
    },
  });
  if (res.status >= 300 && res.status < 400) {
    // Not followed, and not quietly. A redirect that changes host makes every
    // HTTP client drop Authorization, so the gateway would answer a perfectly
    // good key with "missing credentials" - the failure that made this look
    // broken for three months.
    throw new GatewayError(
      `the Lobstack API redirected to ${res.headers.get('location') || 'somewhere else'}.`,
      'A redirect strips your key. Point --base at the host that answers directly.',
    );
  }
  return res;
}

export async function errorText(res) {
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

/** `/models`, as the array the gateway sends. */
export async function fetchModels(base, key, init) {
  const res = await gwFetch(gatewayUrl(base, '/models'), key, init);
  if (!res.ok) throw new GatewayError(await errorText(res));
  return (await res.json()).data ?? [];
}

/** `/api/v1/usage`, grouped by model. */
export async function fetchUsage(base, key, days, init) {
  const res = await gwFetch(`${base}/api/v1/usage?range=${days}d&group_by=model`, key, init);
  if (!res.ok) {
    throw new GatewayError(
      await errorText(res),
      res.status === 403
        ? 'This key needs the "usage:read" scope. Mint one in Console > API keys.'
        : undefined,
    );
  }
  return res.json();
}

/**
 * One streamed completion, and the receipt off its last frame.
 *
 * `include_usage` is not optional: without it the gateway has no frame to
 * attach `x_lobstack` to, and the price never arrives.
 */
export async function streamCompletion(base, key, { model, messages, signal, onText, client }) {
  const res = await gwFetch(gatewayUrl(base, '/chat/completions'), key, {
    method: 'POST',
    signal,
    client,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!res.ok || !res.body) throw new GatewayError(await errorText(res));
  return consume(res.body, onText);
}
