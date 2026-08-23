# ARCHITECTURE.md

Reference spec for the terminal coding agent. This is a design document, not
an instruction file — Claude Code doesn't load this automatically. Read it
deliberately when implementing something that touches these boundaries.

**A note on the interfaces below**: they describe target seams, not a build
order. Implement the concrete version first (one `ModelProvider`, one
`ExecutionBackend`). Only extract the interface when a second real
implementation actually needs it. Defining all of these on day one is
speculative generality that will eat your 15-day budget for no benefit —
see CLAUDE.md's non-negotiables.

---

## 1. Core loop

The system is a loop, not a pipeline. The model decides whether to call a
tool at all — permission and tool execution only activate on that branch,
and the result feeds back into the same loop, not forward into a new stage.

```text
User task -> Session/state -> Context builder -> Agent runtime -> LLM gateway
                                                                       |
                                                        +--------------+--------------+
                                                        |                             |
                                                  Final answer                   Tool call
                                                        |                             |
                                                        v                       Permission gate
                                                      User                            |
                                                                                 Tool system
                                                                                       |
                                                                                Tool execution
                                                                                       |
                                                                                 Context update
                                                                                       |
                                                                                Agent runtime (loop)
```

The model may make many tool calls before producing a final answer. Don't
flatten this into a fixed sequence when adding features.

## 2. Responsibility boundaries

| Layer | Owns | Must not contain |
|---|---|---|
| CLI/UI | input, rendering, streaming display, approval prompts, cancellation | agent/business logic |
| Session | history, state, save/resume, checkpoints | — |
| Context engine | assembling model context, token budgeting, compaction | — |
| Agent runtime | the loop, orchestration, calling the model, handling tool calls | provider-specific or tool-specific details |
| ModelProvider | model requests, streaming, tool-call responses, provider errors | — |
| Tool system | registration, discovery, schema validation, result normalization | agent-loop logic |
| Permission gate | allow/deny/ask-user, dangerous-operation detection | — |
| Execution layer | filesystem ops, shell processes, git commands, process lifecycle | — |

## 3. Target interfaces (implement concretely first — see note above)

```text
ModelProvider, Tool, ToolRegistry, ContextManager, ExecutionBackend,
PermissionPolicy, SessionStore, EventBus, SearchService,
RepositoryService, GitService
```

Example future fan-out behind each seam:

```text
ModelProvider   -> OpenAICompatibleProvider, VLLMProvider, OllamaProvider
ExecutionBackend -> LocalExecution, DockerSandbox, RemoteSandbox
SearchService   -> RipgrepSearch, SemanticSearch
```

`ModelProvider` shape:

```ts
interface ModelProvider {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
```

`Tool` shape:

```ts
interface Tool<TInput, TOutput> {
  name: string;
  description: string;
  inputSchema: ZodSchema<TInput>;
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}
```

`CommandResult` shape:

```ts
interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}
```

## 4. Tool execution lifecycle

```text
Model tool call -> parse arguments -> schema validation -> permission gate
-> tool handler -> normalize result -> output limiting -> context update
-> agent loop
```

Don't bypass or reorder these stages without discussion.

## 5. Tool error handling

Expected operational failures (a failing test, a bad command) become
structured results the model can see and react to:

```json
{ "success": false, "error": "...", "retryable": false }
```

Unexpected internal/infrastructure errors may throw and get handled at the
runtime boundary — don't silently swallow those.

## 6. edit_file rules

1. File must exist; `old_str` must exist in it.
2. If `old_str` matches more than once, fail unless multiple replacement is
   explicitly requested — never silently pick the first match.
3. Never rewrite the whole file; preserve unrelated content.
4. Write only after permission approval.
5. Return enough detail for the model to know whether the edit landed.

Never implement editing by asking the model to regenerate the entire file.

## 7. Context engine

Responsible for what the model sees: task, repo structure, relevant files,
history, prior tool results, token budget, compaction.

```text
task -> repository structure -> search -> relevant files -> relevant code -> model context
```

Don't send the whole repository. When context nears the usable limit,
summarize older material but never blindly truncate from the start if it
would lose live task state.

## 8. Permission model

Operations classify roughly as `READ`, `WRITE`, `EXECUTE`, `DESTRUCTIVE`,
`NETWORK`, `GIT_STATE_CHANGE`, decided as `ALLOW` / `DENY` / `ASK_USER`.
Destructive operations are never silently automatic.

## 9. Events (future — not needed for MVP)

Structured lifecycle events (`agent.started`, `tool.completed`,
`permission.requested`, etc.) so the CLI and future consumers (logger,
metrics, replay) subscribe instead of reaching into runtime internals. Build
this when you have a second event consumer, not before.

## 10. Testing workflow

```text
understand -> search -> edit -> run targeted test -> inspect failure -> fix
-> re-run -> run broader tests -> inspect diff -> respond
```

Don't report a task as solved because the edit succeeded — prefer evidence
(tests passed, build passed, diff reviewed).

## 11. Future extension points (post-MVP roadmap, not a task list)

```text
Docker sandbox, remote execution, multi-model routing, self-hosted models,
LSP, MCP, semantic search, vector DB, repo indexing, long-term memory,
skills, subagents, parallel/background execution, checkpoints, replay,
API server, IDE integration, CI/CD integration
```

Implement none of these unless a specific task needs it. When one is
eventually needed, implement it behind an existing seam rather than
modifying the agent loop.

## 12. Decision rule for new features

1. Does this belong in the agent runtime, or somewhere else?
2. Can it be isolated behind an existing interface?
3. Does it cross a security boundary or need permission?
4. Does it affect model context or need an event?
5. Can it be tested independently?
6. Will this make future replacement harder?

Prefer the smallest implementation that preserves the boundary. Don't
over-engineer for hypothetical requirements; don't under-engineer by
bypassing an established seam.

## 13. Final principle

The goal isn't feature parity with Claude Code. It's a small, reliable,
extensible agent core. Priority order: correctness -> reliability -> safety
-> context quality -> tool quality -> everything else. Keep the loop small;
let the surrounding interfaces carry the extensibility.
