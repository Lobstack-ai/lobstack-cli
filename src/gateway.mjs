/**
 * Talking to the Gateway, in one place.
 *
 * These calls used to live inline in `index.mjs`, which was fine while
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

/**
 * The API's error classes, by status, with the one thing to do about each.
 *
 * Mirrors the table on https://www.lobstack.ai/docs/gateway/errors, which is
 * generated from the Gateway's own `ERROR_CLASSES`. A status maps to a class,
 * the class says whether a retry can help, and the hint is one line a person
 * can act on. A machine-readable `error_code` on the body is more specific
 * than the status, so it wins when the CLI knows it.
 */
export const ERROR_CLASSES = new Set(['auth', 'quota', 'validation', 'provider', 'timeout', 'internal']);

export function classForStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || status === 429) return 'quota';
  if (status === 400 || status === 409 || status === 422) return 'validation';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 500) return 'internal';
  if (status >= 500) return 'provider';
  return 'internal';
}

const CODE_HINTS = {
  RATE_LIMITED: 'Over the per-key rate limit. Wait for Retry-After, then retry.',
  SEARCH_RATE_LIMITED: 'Over the per-key search limit. Wait for Retry-After, then retry.',
  CONCURRENCY_LIMIT: 'Too many calls running at once for this plan. Retry in a second.',
  SPEND_IN_FLIGHT: 'Calls already running have reserved what is left. Retry when they finish.',
  FREE_CREDIT_USED: 'The Free plan credit is used and does not reset. Upgrade in Console > Billing.',
  ALLOWANCE_EXHAUSTED: 'The plan allowance and credit are used. Top up or upgrade in Console > Billing.',
  INSUFFICIENT_ALLOWANCE: 'What is left will not cover this call. Top up in Console > Billing.',
  KEY_CAP_REACHED: 'This key hit its monthly spend cap. Raise it in Console > API keys.',
  PERSON_CAP_REACHED: "The key creator's monthly spend cap is reached. Raise it in Console > Settings.",
  CLIENT_BUDGET_EXHAUSTED: "That client tag's monthly budget is spent. Raise it in Console > Clients.",
  CLIENT_TAG_INVALID: "A client tag is 1-64 characters of a-z, 0-9, '.', '_' or '-', starting with a letter or digit.",
  INVALID_PARAMETER: 'A parameter has the wrong type or range; the message names it.',
  SEARCH_UNAVAILABLE: 'Web search is not configured on this deployment. Use another search; retry later.',
  MANAGED_DISABLED: "Calls on Lobstack's provider keys are paused. Retry later.",
  PROVIDER_ACCOUNT_UNAVAILABLE: "Lobstack's provider account refused the call. Ours to fix; retry later.",
};

const STATUS_HINTS = {
  401: 'The key was rejected: missing, malformed, revoked or expired. Run `lobstack init` with a fresh key.',
  403: 'This key lacks the scope for this call. Mint one with the right scope in Console > API keys.',
  402: 'The allowance is used. Top up or upgrade in Console > Billing, or wait for the reset.',
  429: 'Rate limited. Wait for Retry-After, then retry.',
  400: 'The request was refused as malformed. Retrying will fail the same way.',
  409: 'The request conflicts with current state. Retrying will fail the same way.',
  422: 'The request was refused as malformed. Retrying will fail the same way.',
  408: 'The API gave up waiting. Retry; the first attempt may have completed.',
  504: 'The API gave up waiting. Retry; the first attempt may have completed.',
  500: 'An error on our side. Retry once, then report the request id.',
};

/**
 * A non-2xx response as a `GatewayError`: the API's message, its request id,
 * the error class, and a one-line hint. `scopeHint` overrides the generic 403
 * line when the caller knows which scope the endpoint needs.
 */
export async function apiError(res, { scopeHint } = {}) {
  const id = res.headers.get('x-lobstack-request-id');
  let msg = `HTTP ${res.status}`;
  let code = null;
  let klass = null;
  try {
    const body = await res.json();
    const e = body?.error;
    msg = (typeof e === 'string' ? e : e?.message) || msg;
    code = (typeof e === 'object' && e?.error_code) || body?.error_code || body?.code || null;
    if (typeof code !== 'string') code = null;
    klass = typeof e === 'object' && typeof e?.type === 'string' ? e.type : null;
  } catch {
    /* not JSON */
  }
  const cls = klass && ERROR_CLASSES.has(klass) ? klass : classForStatus(res.status);
  const retryAfter = res.headers.get('retry-after');
  let hint =
    (code && CODE_HINTS[code]) ||
    (res.status === 403 && scopeHint) ||
    STATUS_HINTS[res.status] ||
    (res.status >= 500 ? 'The upstream provider failed. Retry with backoff.' : undefined);
  if (hint && retryAfter && /Retry-After/.test(hint)) hint = hint.replace('Retry-After', `${retryAfter}s`);
  const tags = [cls, code].filter(Boolean).join(' ');
  const message = `${msg} [${res.status} ${tags}]${id ? ` (request ${id})` : ''}`;
  const err = new GatewayError(message, hint);
  err.status = res.status;
  err.code = code;
  err.errorClass = cls;
  err.requestId = id;
  return err;
}

/** The message alone, for callers that only want text. */
export async function errorText(res) {
  return (await apiError(res)).message;
}

/** `/models`, as the array the gateway sends. */
export async function fetchModels(base, key, init) {
  const res = await gwFetch(gatewayUrl(base, '/models'), key, init);
  if (!res.ok) throw await apiError(res);
  return (await res.json()).data ?? [];
}

/** The windows `/api/v1/usage` accepts. Anything else is answered as 7d. */
export const USAGE_RANGES = ['month', '1d', '7d', '14d', '30d', '90d', '365d'];
/** The groupings `/api/v1/usage` accepts. */
export const USAGE_GROUPS = ['day', 'model', 'key', 'agent', 'provider', 'mode', 'client', 'app'];

/**
 * `/api/v1/usage`.
 *
 * The third argument is a number of days (what the TUI's `/spend 7` passes)
 * or `{ range, groupBy, client }`. A number is sent as `<n>d`; the server
 * answers an unknown window with 7d and says so in `range`.
 */
export async function fetchUsage(base, key, opts, init) {
  const o = typeof opts === 'number' || opts === undefined ? { range: `${opts ?? 7}d` } : opts;
  const q = new URLSearchParams({ range: o.range || '7d', group_by: o.groupBy || 'model' });
  if (o.client) q.set('client', o.client);
  const res = await gwFetch(`${base}/api/v1/usage?${q}`, key, init);
  if (!res.ok) {
    throw await apiError(res, {
      scopeHint: 'This key needs the "usage:read" scope. Mint one in Console > API keys.',
    });
  }
  return res.json();
}

/**
 * The receipt off response headers, for the two endpoints that answer in one
 * JSON body rather than a stream: `/embeddings` and `/search`.
 *
 * `x-lobstack-cost-usd` is an empty string when the call could not be priced.
 * That is read as null, never as zero.
 */
export function receiptFromHeaders(h) {
  const num = (v) => {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    request_id: h.get('x-lobstack-request-id'),
    model: h.get('x-lobstack-model'),
    cost_usd: num(h.get('x-lobstack-cost-usd')),
    priced: h.get('x-lobstack-priced') === 'true',
    metered: h.get('x-lobstack-metered') === null ? null : h.get('x-lobstack-metered') === 'true',
    cache: h.get('x-lobstack-cache'),
    mode: h.get('x-lobstack-mode'),
    client_tag: h.get('x-lobstack-client-tag'),
  };
}

/** The client tag a call is made for, as the header the Gateway reads. */
const tagHeader = (clientTag) => (clientTag ? { 'x-lobstack-client-tag': clientTag } : undefined);

/** `POST /embeddings`. Returns the OpenAI-shaped body and the header receipt. */
export async function embed(base, key, { input, model, dimensions, clientTag }) {
  const res = await gwFetch(gatewayUrl(base, '/embeddings'), key, {
    method: 'POST',
    headers: tagHeader(clientTag),
    body: JSON.stringify({
      input,
      ...(model ? { model } : {}),
      ...(dimensions ? { dimensions } : {}),
    }),
  });
  if (!res.ok) throw await apiError(res);
  return { body: await res.json(), receipt: receiptFromHeaders(res.headers) };
}

/** `POST /search`. Returns `{ query, results }` and the header receipt. */
export async function search(base, key, { query, count, clientTag }) {
  const res = await gwFetch(gatewayUrl(base, '/search'), key, {
    method: 'POST',
    headers: tagHeader(clientTag),
    body: JSON.stringify({ query, ...(count ? { count } : {}) }),
  });
  if (!res.ok) throw await apiError(res);
  return { body: await res.json(), receipt: receiptFromHeaders(res.headers) };
}

/**
 * One streamed completion, and the receipt off its last frame.
 *
 * `include_usage` is not optional: without it the gateway has no frame to
 * attach `x_lobstack` to, and the price never arrives.
 */
export async function streamCompletion(base, key, { model, messages, signal, onText, client, clientTag }) {
  const res = await gwFetch(gatewayUrl(base, '/chat/completions'), key, {
    method: 'POST',
    signal,
    client,
    headers: tagHeader(clientTag),
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!res.ok || !res.body) throw await apiError(res);
  return consume(res.body, onText);
}
