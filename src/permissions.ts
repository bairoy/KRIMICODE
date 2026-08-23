/**
 * The permission gate. ARCHITECTURE §8.
 *
 * Deliberately knows nothing about the terminal: the CLI supplies an `AskUser`
 * function. That keeps approval prompts in the CLI layer, where §2 puts them,
 * and makes the gate testable without a TTY.
 */

/** How dangerous an operation is. */
export type OperationClass =
  | 'READ'
  | 'READ_SENSITIVE'
  | 'WRITE'
  | 'EXECUTE'
  | 'DESTRUCTIVE'
  | 'GIT_STATE_CHANGE';

export type Decision = 'allow' | 'deny' | 'ask';

/** What the user is being asked to approve. */
export interface PermissionRequest {
  readonly toolName: string;
  readonly operation: OperationClass;
  /** One line describing exactly what will happen. Shown to the user. */
  readonly detail: string;
}

export type UserAnswer = 'once' | 'always' | 'no';

/** Supplied by the CLI. The gate never touches stdin or stdout itself. */
export type AskUser = (request: PermissionRequest) => Promise<UserAnswer>;

/**
 * Static policy. Only plain reads run unattended; everything that writes,
 * executes, or touches git state needs a human.
 */
export function classify(operation: OperationClass): Decision {
  switch (operation) {
    case 'READ':
      return 'allow';
    case 'READ_SENSITIVE':
    case 'WRITE':
    case 'EXECUTE':
    case 'DESTRUCTIVE':
    case 'GIT_STATE_CHANGE':
      return 'ask';
  }
}

export class PermissionGate {
  readonly #ask: AskUser;
  /** Tool names the user approved for the rest of the session. */
  readonly #sessionAllowed = new Set<string>();

  constructor(ask: AskUser) {
    this.#ask = ask;
  }

  async check(request: PermissionRequest): Promise<boolean> {
    const decision = classify(request.operation);
    if (decision === 'allow') return true;
    if (decision === 'deny') return false;

    // §8: "Destructive operations are never silently automatic." A standing
    // approval must never cover one, so it is excluded from both the lookup
    // and the recording below.
    const remembered = request.operation !== 'DESTRUCTIVE';

    if (remembered && this.#sessionAllowed.has(request.toolName)) return true;

    const answer = await this.#ask(request);

    if (answer === 'always' && remembered) {
      this.#sessionAllowed.add(request.toolName);
      return true;
    }
    // An "always" on a destructive op still approves this one call, no more.
    return answer === 'once' || answer === 'always';
  }
}
