/**
 * A local OpenAI-compatible endpoint that forwards to the Gateway.
 *
 *   lobstack proxy            # http://127.0.0.1:8787/v1
 *
 * This is the shortest path from "I have a tool that speaks OpenAI" to routing
 * and metering: change one base URL in Cursor, Aider, Continue, or anything
 * else with an OpenAI-compatible setting, and every call it makes goes through
 * the router and lands in your Console. Nothing else about the tool changes,
 * and it never sees your Lobstack key.
 *
 * Three deliberate choices:
 *
 *   · It binds 127.0.0.1, not 0.0.0.0. This process holds a credential and
 *     answers unauthenticated requests, so anything that can reach the port can
 *     spend your money. Loopback keeps that to this machine.
 *   · It streams by piping the upstream body straight through. Buffering a
 *     stream to inspect it would make every token wait for the last one, which
 *     is the one thing an interactive tool cannot tolerate.
 *   · It prints a one-line receipt per request to stderr. The point of routing
 *     through here is knowing what it cost; a proxy that silently forwards is
 *     just a slower base URL.
 */

import { createServer } from 'node:http';
import { gatewayUrl } from './config.mjs';
import { dim, green, money, savingsLabel } from './render.mjs';

const HOST = '127.0.0.1';

/** Read a request body without assuming it fits in one chunk. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Pull the receipt out of a passing stream without holding it up.
 *
 * The bytes are forwarded the instant they arrive; a copy of the tail is kept
 * so the final frame can be parsed after the client already has everything.
 */
function receiptFromTail(tail) {
  const frames = tail.split('\n\n');
  for (let i = frames.length - 1; i >= 0; i--) {
    const line = frames[i].split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const frame = JSON.parse(payload);
      if (frame.x_lobstack || frame.usage) return { receipt: frame.x_lobstack, usage: frame.usage };
    } catch {
      /* keep looking backwards */
    }
  }
  return {};
}

function logReceipt(started, { receipt, usage }) {
  const ms = Date.now() - started;
  const parts = [`${dim('model')} ${receipt?.served_model ?? '?'}`];
  if (usage) parts.push(`${dim('tokens')} ${usage.prompt_tokens}/${usage.completion_tokens}`);
  parts.push(`${dim('cost')} ${money(receipt?.cost_usd)}`);
  // See render.mjs: a plan-ceiling baseline is not a like-for-like saving and
  // must not be printed as one. One rule, one implementation.
  const saving = savingsLabel(receipt);
  if (saving) parts.push(`${dim(saving.label)} ${green(money(saving.amount))}`);
  parts.push(`${dim('in')} ${ms}ms`);
  process.stderr.write(dim('- ') + parts.join(dim('  -  ')) + '\n');
}

/**
 * @param {object} o
 * @param {string} o.key      the Lobstack credential this process holds
 * @param {string} o.base     the gateway origin
 * @param {number} o.port     loopback port to listen on
 * @param {boolean} [o.quiet] return the server instead of printing a banner and
 *                            blocking forever. The TUI runs the proxy inside
 *                            itself and owns the screen, so it cannot have a
 *                            second writer on stderr or a call that never
 *                            returns.
 * @param {(r:{receipt:object|undefined,usage:object|undefined,ms:number,path:string}) => void} [o.onReceipt]
 *                            called per request instead of the stderr line.
 */
export async function startProxy({ key, base, port, quiet = false, onReceipt }) {
  const server = createServer(async (req, res) => {
    const started = Date.now();

    // Strip the caller's /v1 prefix; the Gateway lives under /api/gateway/v1.
    // Anything else 404s here rather than being forwarded, so a mistyped path
    // is a local error instead of a confusing one from upstream.
    const path = (req.url || '').replace(/^\/v1/, '');
    if (!path.startsWith('/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'this proxy serves the OpenAI paths under /v1' } }));
      return;
    }

    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      const upstream = await fetch(gatewayUrl(base, path), {
        method: req.method,
        redirect: 'manual',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': req.headers['content-type'] || 'application/json',
          'x-lobstack-client': 'lobstack-cli-proxy',
        },
        body,
      });

      const headers = {};
      upstream.headers.forEach((v, k) => {
        // Hop-by-hop headers describe the upstream connection, not this one.
        if (!['connection', 'keep-alive', 'transfer-encoding', 'content-encoding'].includes(k)) {
          headers[k] = v;
        }
      });
      res.writeHead(upstream.status, headers);

      if (!upstream.body) {
        res.end();
        return;
      }

      // Forward first, inspect after. Keep only the tail: a long conversation
      // is megabytes, and the receipt is always in the last frame.
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let tail = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
        tail = (tail + decoder.decode(value, { stream: true })).slice(-4096);
      }
      res.end();
      const parsed = receiptFromTail(tail);
      if (onReceipt) onReceipt({ ...parsed, ms: Date.now() - started, path });
      else logReceipt(started, parsed);
    } catch (err) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: { message: err instanceof Error ? err.message : 'proxy failure' } }),
      );
    }
  });

  // `listen` reports failure as an 'error' event, and an unhandled one on a
  // server is an uncaught exception - which inside the TUI would tear down the
  // screen over something as ordinary as a port already being in use.
  await new Promise((resolve, reject) => {
    server.once('error', (err) =>
      reject(
        new Error(
          err.code === 'EADDRINUSE'
            ? `port ${port} is already in use - pass a different --port.`
            : `could not listen on ${HOST}:${port}: ${err.message}`,
        ),
      ),
    );
    server.listen(port, HOST, resolve);
  });
  if (quiet) return server;

  process.stderr.write(
    `\n${green('Listening')} on http://${HOST}:${port}/v1  ${dim('-> ' + base)}\n\n` +
      `${dim('Point any OpenAI-compatible tool at it:')}\n` +
      `  OPENAI_BASE_URL=http://${HOST}:${port}/v1\n` +
      `  OPENAI_API_KEY=anything\n\n` +
      `${dim('Your Lobstack key stays in this process. Loopback only - anything that')}\n` +
      `${dim('can reach this port can spend on your account.')}\n\n`,
  );

  await new Promise(() => {}); // run until interrupted
}
