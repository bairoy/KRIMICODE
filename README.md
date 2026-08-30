# krimicode

A terminal coding agent. It reads and edits files in your project, runs
commands, and answers questions about the code — asking your permission before
anything that writes, executes, or touches git.

Model access goes through any **OpenAI-compatible** endpoint. That is the point
of the design: a hosted API today, a self-hosted model tomorrow, without
changing the agent.

```
> what does the compaction code do when the summary fails?

⚒ read_file {"path":"src/context.ts"}
  ✓ 4821 chars

It falls back to a mechanical digest rather than ending the session…
```

## Requirements

- **Node.js 20.12 or newer**
- An OpenAI-compatible endpoint and a key for it
- **ripgrep** — optional on macOS and Linux (it falls back to `grep`),
  **required on Windows**, which has no `grep`

## Install

```sh
git clone https://github.com/bairoy/KRIMICODE.git
cd KRIMICODE
npm install
npm run build
npm install -g .        # puts `krimicode` on your PATH
```

To run it without installing globally, use `npm run dev` from the project
directory instead.

Remove it later with `npm rm -g krimicode`.

## Configure

Copy the example and fill it in:

```sh
cp .env.example .env
```

| Variable | Required | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | yes | Key for your endpoint |
| `OPENAI_BASE_URL` | yes | e.g. `https://api.openai.com/v1`, or `http://localhost:8000/v1` for a local server |
| `MODEL_NAME` | yes | Model id as your endpoint names it |
| `MAX_CONTEXT_TOKENS` | no | The model's context window. Defaults to 128000 |
| `EXTRA_BODY` | no | JSON object merged into each request, for vendor-specific fields |

`.env` is read from the directory you run in, so different projects can use
different models. Environment variables set in your shell take precedence in
production, where a `.env` file usually does not exist.

`MAX_CONTEXT_TOKENS` matters more than it looks. There is no portable way to
ask an OpenAI-compatible endpoint how large its window is, so it is
configuration rather than a guess. **Set it low if you are unsure** — guessing
low costs one extra summarization call, guessing high ends the session.

## Use

```sh
cd ~/your-project
krimicode
```

The directory you start in is the workspace. The agent cannot read or write
outside it.

```sh
krimicode --continue          # pick up the most recent conversation here
krimicode --resume <id>       # pick up a specific one
krimicode --list              # what has been saved for this directory
krimicode --help
```

### While it is running

| | |
|---|---|
| `/help` | list the commands |
| `/clear` | forget the conversation and start fresh |
| `/compact` | summarize older turns now, freeing context |
| `/model` | show the current model, or `/model <name>` to switch |
| `/tools` | list the tools the model can call |
| `/sessions` | saved conversations for this directory |
| `/exit` | quit |
| **Ctrl-C** | stop the current turn — press it again when idle to quit |

Ctrl-C during a turn stops the model mid-sentence and kills any command it
started, including that command's children. The conversation stays usable
afterwards.

## Permission

Every tool call is classified by **what it is about to do**, not by which tool
it is. `read_file` on `src/app.ts` is a plain read; `read_file` on `.env` is
not, and is treated as sensitive.

| Class | Default | When |
|---|---|---|
| `READ` | runs automatically | `read_file`, `list_files`, `search_code`, `git_status`, `git_diff` |
| `READ_SENSITIVE` | asks | reading a credential-shaped file — `.env`, `*.pem`, `id_rsa`, … |
| `WRITE` | asks | `edit_file`, `create_file` |
| `EXECUTE` | asks | `run_command`, `run_tests` |
| `DESTRUCTIVE` | asks, **every time** | writing to a credential file, or a command matching `rm -rf`, `sudo`, `mkfs`, `dd if=`, `shutdown`, `git push --force`, `git reset --hard`, `git clean -f`, `npm publish`, curl-piped-to-shell, and similar |

At a prompt, `y` allows this one call, `n` refuses, and `a` allows that tool
for the rest of the session. `a` is never offered for a destructive operation,
and a standing `a` never covers one — that approval has to be given each time.

The destructive list is a safety net, not a security boundary: it exists so the
genuinely dangerous cases are re-confirmed every time rather than waved through
by an approval you gave ten minutes ago. It is not a sandbox, and it does not
try to be exhaustive. **Read what you are approving.**

Anything resolving outside the workspace — via `../`, an absolute path, or a
symlink — is refused outright rather than prompted for.

## Tools

| | |
|---|---|
| `read_file` | read a UTF-8 text file from the workspace |
| `list_files` | list a directory, optionally recursively |
| `search_code` | search with ripgrep, falling back to grep |
| `edit_file` | replace an exact string — never a whole-file rewrite |
| `create_file` | create a new file — never overwrites an existing one |
| `run_command` | run a shell command |
| `run_tests` | run the project's `npm test` |
| `git_status` | working tree status |
| `git_diff` | unstaged or staged changes, optionally scoped to a path |

`edit_file` deliberately fails rather than guessing: if `old_str` is not found,
or appears more than once without `replace_all`, the edit is refused with a
message saying why. Those checks run *before* you are asked to approve, so you
are never prompted for an edit that cannot succeed — and the diff you see is
the change that will actually happen.

The two write tools are deliberate mirrors: `edit_file` refuses to create,
`create_file` refuses to overwrite. Neither can replace a file wholesale.

## Saved conversations

Conversations are written to `~/.krimicode/sessions/`, keyed by the directory
they happened in, with owner-only permissions. They stay out of your repository
so a transcript is never committed by accident.

Anything that looks like a secret is redacted before it reaches disk — including
what **you** typed, since pasting a key into a prompt to ask about it is a
normal thing to do.

## Long conversations

The agent tracks how close the conversation is to the context window. Before it
would overflow, older turns are folded into a running summary and the recent
ones kept verbatim. You will see a line like:

```
⟳ compacted context: ~119400 → ~38200 tokens, 24 messages summarized
```

History is only ever cut at a point where a complete exchange has finished, so
a tool result is never separated from the call that asked for it.

`/compact` does the same thing on demand. Automatic compaction always arrives
at the worst moment — part-way through a turn you are waiting on — so it is
worth folding deliberately before asking for something expensive. Either way
the two most recent turns are kept verbatim, so a `/compact` cannot lose what
you are in the middle of.

## Development

```sh
npm run dev          # run from source
npm test             # 306 tests, node --test, no framework
npm run typecheck    # tsc --noEmit, includes tests
npm run lint         # biome
npm run format       # biome, writing fixes
npm run build        # compile to dist/
```

CI runs typecheck, lint, tests, and build on Linux, macOS, and Windows.

## Limitations

Worth knowing before you rely on it:

- **Windows kills differently.** On macOS and Linux a stopped command gets
  `SIGTERM` and three seconds to clean up before `SIGKILL`. Windows has no
  graceful signal that console programs reliably honour, so `taskkill /T /F`
  terminates the tree immediately. A command interrupted on Windows does not
  get to run its cleanup.
- **`search_code` needs ripgrep on Windows.** The `grep` fallback does not
  exist there.
- **Permission approvals are per-session.** `a` is forgotten when you quit;
  there is no policy file yet.
- **One endpoint at a time.** The provider is chosen by configuration at
  startup, not per request.
- **The backend-swap promise is designed for but not yet proven.** The
  provider interface is deliberately one method wide and is tested against a
  fake, but the agent has not yet been run against a second real endpoint.

## Layout

```
src/
  index.ts        the terminal: input, rendering, approval prompts
  agent.ts        the loop
  context.ts      token budget, compaction, summarization
  provider.ts     the OpenAI-compatible client
  permissions.ts  the gate
  workspace.ts    path resolution and the workspace boundary
  platform.ts     everything that differs on Windows
  session.ts      saving and resuming conversations
  exec.ts         the only place a process is spawned
  redact.ts       secret redaction
  normalize.ts    the single road every tool result takes back
  tools/          one file per tool
```

`learning/` holds a long-form walkthrough of how all of this works and why,
written as three days of notes.
