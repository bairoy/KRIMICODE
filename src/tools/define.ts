import { z } from 'zod';
import type {
  ContentChange,
  OperationClass,
  PermissionGate,
} from '../permissions.js';
import type { ToolResult } from '../types.js';

/**
 * What a tool is allowed to know about its surroundings.
 *
 * Note the gate is NOT here. A tool must not be able to consult, re-run, or
 * bypass its own permission check — that happens in `run()` below, before
 * `execute` is ever called.
 */
export interface ToolContext {
  readonly workspaceRoot: string;
  /**
   * Aborted when the user cancels the turn. Tools that spawn a process must
   * forward it to `runCommand`/`runProgram`, or a cancelled `npm test` keeps
   * running with nothing left to reap it.
   */
  readonly signal?: AbortSignal;
}

/** How a specific call should be classified, given its validated input. */
export interface CallClassification {
  readonly operation: OperationClass;
  /** The target, in one short line: a path, or a command. */
  readonly detail: string;
  /** Optional before/after text, rendered as a diff by the CLI. */
  readonly diff?: ContentChange;
}

/** A tool with its input type intact. ARCHITECTURE §3. */
export interface Tool<TInput> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  /**
   * Classify this call. Runs after validation, before the gate, so the input
   * is trustworthy and the prompt can describe exactly what will happen.
   */
  classify(input: TInput): CallClassification;
  execute(input: TInput, context: ToolContext): Promise<ToolResult>;
}

/** Input type erased, so the registry can hold a heterogeneous set. */
export interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema derived from `inputSchema`. */
  readonly parameters: Record<string, unknown>;
  run(
    argsJson: string,
    context: ToolContext,
    gate: PermissionGate,
  ): Promise<ToolResult>;
}

/**
 * Wraps a typed tool so that argument parsing and validation happen in exactly
 * one place. Every tool call in the system passes through this `run`, which is
 * what makes "a malformed call must not crash the loop" enforceable rather
 * than a convention each tool has to remember.
 */
export function defineTool<TInput>(tool: Tool<TInput>): RegisteredTool {
  const parameters = z.toJSONSchema(tool.inputSchema) as Record<
    string,
    unknown
  >;
  // Providers reject unknown top-level keys in a function's parameter schema.
  delete parameters['$schema'];

  return {
    name: tool.name,
    description: tool.description,
    parameters,

    async run(argsJson, context, gate): Promise<ToolResult> {
      // Arguments arrive as a model-generated JSON string. CLAUDE.md: always
      // parse inside a try/catch.
      let raw: unknown;
      try {
        raw = JSON.parse(argsJson.trim() === '' ? '{}' : argsJson);
      } catch {
        return {
          success: false,
          error: `Arguments were not valid JSON. Received: ${argsJson.slice(0, 200)}`,
          retryable: true,
        };
      }

      const parsed = tool.inputSchema.safeParse(raw);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        return {
          success: false,
          error: `Invalid arguments: ${detail}`,
          retryable: true,
        };
      }

      // Checked before the gate, so cancelling a turn cannot leave an approval
      // prompt on screen for work that will never run.
      if (context.signal?.aborted) {
        return {
          success: false,
          error: 'Cancelled by the user before the call ran.',
          retryable: false,
        };
      }

      // ARCHITECTURE §4: parse -> validate -> PERMISSION GATE -> handler.
      // Placing it here rather than inside each tool is what makes
      // "no tool bypasses confirmation" structural instead of a convention.
      const classification = tool.classify(parsed.data);
      const approved = await gate.check({
        toolName: tool.name,
        operation: classification.operation,
        detail: classification.detail,
        ...(classification.diff ? { diff: classification.diff } : {}),
      });
      if (!approved) {
        return {
          success: false,
          error: `Denied by the user: ${classification.detail}`,
          retryable: false,
        };
      }

      try {
        return await tool.execute(parsed.data, context);
      } catch (err) {
        // A tool bug or unexpected I/O failure. Reported to the model as a
        // result rather than thrown, so one broken tool cannot end the
        // session. Not silent — the user sees it in the transcript.
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          retryable: false,
        };
      }
    },
  };
}
