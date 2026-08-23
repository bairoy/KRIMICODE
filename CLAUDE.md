# CLAUDE.md

Terminal coding agent (Claude Code-style) built for a client. Node.js + TypeScript.
Model access goes through an OpenAI-compatible endpoint so the backend can later
swap to a self-hosted model without touching agent logic.

Full architecture spec (interfaces, extension roadmap, event taxonomy, testing
workflow) lives in `ARCHITECTURE.md`. Read it before implementing a new
interface, tool, or subsystem — don't duplicate that detail here, and don't
treat it as a checklist of things to build now. Most of it is post-MVP.

## IMPORTANT — non-negotiables

- Never call the model provider or spawn shell commands directly from tool
  code. Always go through `ModelProvider` / `runCommand`.
- `edit_file` always does exact string replacement (`old_str -> new_str`),
  never a full-file rewrite. Fail if `old_str` is missing or matches more
  than once, unless multiple replacement is explicitly requested.
- Any tool that writes, deletes, executes, or touches git state must pass
  the permission gate. Don't add a tool that bypasses confirmation without
  discussing it with me first.
- Never print, log, or commit `OPENAI_API_KEY` or any secret. Redact
  anything that looks like a secret before it reaches model context or logs.
- Kill spawned shell commands by process group
  (`process.kill(-pid, signal)`), not `child.kill()` alone — children
  survive the shell dying otherwise.
- Tool-call arguments from the model arrive as a JSON string — always
  `JSON.parse` inside a try/catch. A malformed call must not crash the loop.
- Do not implement anything from ARCHITECTURE.md's interface list
  (`ExecutionBackend`, `SearchService`, etc.) until there's a second real
  implementation that needs it. One concrete implementation first, always.

## Development modes

- **"manual implementation mode"** — explain the design and give me exact
  code/steps to write myself. Don't create or edit source files. Review
  what I write after, and point out problems, but don't fix it for me
  unless I ask.
- **"implementation mode"** — you may create and edit files directly,
  subject to the rules above.
- If I haven't said either, ask which mode before writing files.

## Commands

- `npm run dev` — run directly with tsx, use this while developing
- `npm run build` — compile to `dist/`
- `npm start` — run the compiled build
- (add test/lint commands here once they exist — keep this accurate, delete
  anything stale)

## Environment

`OPENAI_API_KEY`, `OPENAI_BASE_URL` (provider-agnostic — never assume
OpenAI cloud specifically), `MODEL_NAME`

## Current tool set

`read_file`, `edit_file`, `list_files`, `search_code`, `run_command`,
`git_status`, `git_diff`, `run_tests`

Don't add tools beyond what the current task actually needs.

## Code style

TypeScript strict mode, ES modules, NodeNext resolution, no CommonJS
`require`. No `any` without a comment justifying it. Validate anything
crossing a system boundary (model output, tool-call args, env vars, config,
API responses) with Zod or similar — don't trust it just because TypeScript
has a type for it.

## Key files

- `src/agent.ts` — the agent loop
- `src/tools/` — one file per tool
- `src/tools/index.ts` — tool registry, source of truth for what's callable

## Gotchas

- Killing a spawned shell process doesn't kill its children — always kill
  the process group.
- Never allow uncontrolled command output or file content to consume the
  whole context window — every tool needs an output cap.
- Never operate outside the current workspace without explicit permission —
  watch for `../`, absolute paths, symlinks, `.env`, credential files.
