# lobstack

The Lobstack API from your terminal: one key, every model, and what each call
cost.

```bash
npx lobstack init
npx lobstack             # the UI
```

```
 lobstack  auto                             2 calls  $0.002200  saved $0.008800
───────────────────────────────────────────────────────────────────────────────
 you explain a b-tree

 lob A B-tree keeps sorted data in a shallow, wide tree, so a lookup touches
     very few nodes even when the table is enormous. Each node holds many keys
     and many child pointers, which is what keeps the height down to three or
     four levels for tables with billions of rows.
───────────────────────────────────────────────────────────────────────────────
 model claude-haiku-4-5  asked claude-opus-5
 tokens 400/140  cost $0.001100  saved $0.004400  in 123ms
   against claude-opus-5, the model you named
›
 ^C quit   Tab model   PgUp scroll   ^L redraw   /help for the rest
```

The bottom two panes are the reason this exists. A chat window on its own is
worth nothing — every tool has one. What you cannot get anywhere else is the
price of the call you just made, pinned under the conversation, and a running
total in the corner that moves while you work.

## The UI

`lobstack` with no arguments opens it, when — and only when — there is a
terminal on both ends and a key already available. In a pipeline, in CI, or on a
first run before `init`, bare `lobstack` prints the same help it always printed,
which is also the screen that tells you to run `init`. `lobstack tui` asks for it
by name and is the stable spelling for a script or a shortcut.

### Keys

| | |
|---|---|
| `Enter` | send |
| `\` at end of line | keep typing on a new line. `Alt+Enter` too, where the terminal sends it |
| `Ctrl+C` | cancel a streaming answer; quit when nothing is streaming |
| `Ctrl+D` | quit on an empty line |
| `Tab` | complete a slash command, or open the model picker on an empty line |
| `Up` / `Down` | walk back through what you sent |
| `PgUp` / `PgDn` | scroll the transcript. `Esc` returns to the live tail |
| `Ctrl+L` | repaint, for when something else wrote over the screen |
| `Ctrl+A` `Ctrl+E` `Ctrl+U` `Ctrl+K` `Ctrl+W` | the readline edits you already know |

Shift+Enter is not bound: most terminals send nothing a program can tell apart
from a plain Enter, and promising a key that silently does the wrong thing is
worse than not having it.

### Commands

| | |
|---|---|
| `/model [name]` | set the model, or open the picker |
| `/models` | what the API will serve, with prices. `auto` — Nex 1, the router — is first, priced `—` because it costs whatever it picks |
| `/spend [days]` | what you have actually spent, from the usage API |
| `/receipt` | every field of the last receipt, verbatim, plus the session tally |
| `/proxy [port]` | serve the OpenAI-compatible endpoint from this process |
| `/new` | forget the conversation, keep the session totals |
| `/clear` | clear the screen, keep the conversation |
| `/help` `/quit` | |

`/proxy` is the one worth knowing about. Point Cursor or Aider at the port it
prints and every call those tools make appears in this transcript with its
price, in the same running total as what you type by hand.

## Every terminal, and every way out of one

The UI is the interesting case; the boring ones are where a TUI usually breaks.

| | |
|---|---|
| Piped or redirected | Never draws. `echo "hi" \| lobstack > out.txt` treats stdin as the prompt and puts the answer, and only the answer, in the file. |
| Keyboard in, file out | `lobstack tui > log.txt` runs a plain prompt loop: answers on stdout, prompts and receipts on stderr, so the file stays clean. |
| `TERM=dumb` | A dumb terminal has no cursor addressing, so a full-screen frame is not a degraded experience, it is garbage. Same plain loop, and it says why. |
| `NO_COLOR` | No escapes at all. The colour depth is a number — 0, 16, 256, or truecolour — and the frame is assembled the same way at every one of them. |
| No UTF-8 locale | Box drawing falls back to `-` and `>`. Force it with `LOBSTACK_ASCII=1`. |
| Resize | `SIGWINCH` drops the diff baseline and repaints whole, because every row's content depends on the width. |
| Narrow | 40 columns is the width it aims at. Below that the layout stacks instead of tabulating, and a figure is never truncated — `$0.004400` clipped to `$0.004` is not a shorter number, it is a wrong one, so labels and then whole fields drop first. |
| Short | Rows go to the receipt before the transcript. You can scroll back for history; you cannot scroll back for a price you never saw. |
| Ctrl+C, SIGTERM, SIGHUP, a crash | The terminal comes back. Every exit path — including `process.exit` from anywhere and an uncaught throw — runs the same restore, and a crash still prints its stack. |

`--force` draws the UI where `isTTY` says there is no terminal but a person is
watching anyway: a wrapper, `docker run` without `-t`, an unusual runner.

Mouse reporting is never switched on. It breaks click-to-select in JetBrains and
in some tmux configurations, and a process that dies before disabling it leaves
your shell reading mouse packets as keystrokes. Nothing here needs a mouse.

## Commands outside the UI

| | |
|---|---|
| `lobstack init` | Save a key to `~/.lobstack/config.json`, mode 0600. Verifies it before writing. |
| `lobstack chat "<prompt>"` | One call, streamed. Answer to stdout, receipt to stderr, so `> out.txt` gives you the answer alone. |
| `lobstack models` | What the API will serve, with prices. `auto` — Nex 1 — leads the list with no price of its own. Also public at <https://www.lobstack.ai/models>. |
| `lobstack spend [--days 7]` | What you have spent: the billing ledger's total, the same figure the Console shows, with routing savings as two separate figures. Needs a key with the `usage:read` scope. |
| `lobstack proxy [--port 8787]` | A local OpenAI-compatible endpoint. |

Flags: `--model` (default `auto`, which is **Nex 1**, the router), `--key`, `--base`, `--json`, `--force`.
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

## Notes on three things that look like details

**Zero dependencies, including the UI.** `fetch`, `node:http` and
`node:readline` are all in the runtime, so `npx lobstack` starts immediately
rather than resolving a tree first — and there is no supply chain between your
key and us. That did not change to add a full-screen interface: `node:readline`
already has the escape-sequence decoder, and the rest is nine escape sequences
written out by hand in `src/tty.mjs`, with a comment on each about why the
conservative one was chosen over the clever one. A process holding an
`lsk_live_` credential does not get to pull a dependency tree to draw a box.

**The bare domain is corrected, out loud.** `lobstack.ai` redirects to
`www.lobstack.ai`, and [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110#name-redirection-3xx)
requires every HTTP client to drop `Authorization` when a redirect changes host.
Point `--base` at the apex and you would get "missing credentials" while holding
a perfectly good key. So the CLI rewrites it and prints a line saying it did,
because a silent fix teaches you nothing about why your own code will fail the
same way.

**Text from a model is sanitised before it is drawn.** A completion is
attacker-influenced text about to be pasted into a terminal. Left alone, an
`ESC[2J` inside an answer wipes the frame and an OSC sequence rewrites your
window title. Escapes are removed, not rendered.

## Cost is read, never computed

The Lobstack API puts the price on the final SSE frame under `x_lobstack`, because on
a streamed response the headers are written before the provider has counted a
token. This CLI reads that number. It does not multiply token counts by a
bundled rate card — our own desktop client did exactly that, and printed
`$0.00` for three months next to a correct invoice, because its copy of the
rate card knew six models and the API serves several times that.

That is also why the UI shows no running dollar figure *during* a stream. Until
the last frame lands there is no price to show, so it shows elapsed time and how
much text arrived, and says the price is still coming.

Three rules follow, and they hold on every screen:

- `cost_usd` is `null`, never `0`, when the API could not price a call. That
  prints `unpriced`. A zero renders as "free", and writing off a real charge is
  the most expensive way to be wrong about money. A session whose calls were all
  unpriced shows `unpriced` as its total, not `$0.000000`; a session with some of
  each shows the priced total and counts the rest out loud — `+1 unpriced`.
- `saved` means the router beat a model **you named**. `vs ceiling` means you
  sent `auto` and the API measured against the priciest model your plan
  allows. `baseline_reason` says which, the receipt says which, and the two are
  separate running totals that are never added together.
- No figure is ever truncated to fit.

## Get a key

<https://www.lobstack.ai/start> — free, no card, about a minute.

MIT.
