# lobstack

One key, every model, and what each call cost.

```bash
npx lobstack init
npx lobstack chat "explain a b-tree in two sentences"
```

```
A B-tree keeps sorted data in a shallow, wide tree so a lookup touches
very few nodes... 

- model claude-haiku-4-5  -  asked claude-opus-5  -  tokens 400/140  -  cost $0.001100  -  saved $0.004400
```

That last line is the reason this exists. You asked for Opus, the router read
the prompt and decided it did not need one, and it told you what that decision
saved on **this request** — not a percentage, not a dashboard you check later.

## Commands

| | |
|---|---|
| `lobstack init` | Save a key to `~/.lobstack/config.json`, mode 0600. Verifies it before writing. |
| `lobstack chat "<prompt>"` | One call, streamed. Answer to stdout, receipt to stderr, so `> out.txt` gives you the answer alone. |
| `lobstack models` | What the gateway will serve, with prices. |
| `lobstack spend [--days 7]` | What you have spent. Needs a key with the `usage:read` scope. |
| `lobstack proxy [--port 8787]` | A local OpenAI-compatible endpoint. |

Flags: `--model` (default `auto`), `--key`, `--base`, `--json`.
`LOBSTACK_API_KEY` and `LOBSTACK_BASE_URL` win over the saved config.

## The proxy

```bash
lobstack proxy
```

```
Listening on http://127.0.0.1:8787/v1  -> https://www.lobstack.ai

Point any OpenAI-compatible tool at it:
  OPENAI_BASE_URL=http://127.0.0.1:8787/v1
  OPENAI_API_KEY=anything
```

Change one base URL in Cursor, Aider, Continue, or anything else with an
OpenAI-compatible setting, and every call it makes goes through the router and
lands in your Console — with a line per request telling you what it cost. The
tool never sees your Lobstack key; this process holds it.

It binds loopback only. This is a process that holds a credential and answers
unauthenticated requests, so anything that can reach the port can spend your
money.

## Notes on two things that look like details

**Zero dependencies.** `fetch`, `node:http` and `node:readline` are all in the
runtime, so `npx lobstack` starts immediately rather than resolving a tree
first — and there is no supply chain between your key and us.

**The bare domain is corrected, out loud.** `lobstack.ai` redirects to
`www.lobstack.ai`, and [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110#name-redirection-3xx)
requires every HTTP client to drop `Authorization` when a redirect changes host.
Point `--base` at the apex and you would get "missing credentials" while holding
a perfectly good key. So the CLI rewrites it and prints a line saying it did,
because a silent fix teaches you nothing about why your own code will fail the
same way.

## Cost is read, never computed

The gateway puts the price on the final SSE frame under `x_lobstack`, because on
a streamed response the headers are written before the provider has counted a
token. This CLI reads that number. It does not multiply token counts by a
bundled rate card — our own desktop client did exactly that, and printed
`$0.00` for three months next to a correct invoice, because its copy of the
rate card knew six models and the gateway serves far more.

`cost_usd` is `null`, never `0`, when the gateway could not price a call. This
prints `unpriced`. A zero renders as "free", and writing off a real charge is
the most expensive way to be wrong about money.

## Get a key

<https://www.lobstack.ai/start> — free, no card, about a minute.

MIT.
