/** A tool call from the model, fully accumulated from stream deltas. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw JSON string as the model produced it. NOT parsed — parse in a try/catch. */
  readonly argsJson: string;
}

/**
 * Our own message shape, deliberately not the SDK's.
 * ARCHITECTURE §2: the agent runtime must not contain provider-specific details.
 */
export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: readonly ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the parameters. */
  readonly parameters: Record<string, unknown>;
}

export interface ModelRequest {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSpec[];
  readonly signal?: AbortSignal;
}

export type ModelEvent =
  | { type: 'reasoning_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; argsJson: string }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; message: string };

export interface ModelProvider {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

/** ARCHITECTURE §5. Unused until Step 3. */
export type ToolResult =
  | { success: true; content: string }
  | { success: false; error: string; retryable: boolean };
