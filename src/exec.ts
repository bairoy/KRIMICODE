import { spawn } from 'node:child_process';

/** ARCHITECTURE §3. */
export interface CommandResult {
  readonly success: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export interface RunCommandOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Per-stream character budget. Bounds memory while the command runs. */
  readonly maxOutputChars?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;
/** How long a process gets to honour SIGTERM before SIGKILL. */
const GRACE_MS = 3_000;

/**
 * Environment variable names likely to hold a secret. Stripped from the child
 * environment so a spawned command cannot read our API key — `env`,
 * `printenv`, or `echo $OPENAI_API_KEY` would otherwise expose it, and the
 * output would flow straight back into model context.
 */
const SECRET_ENV_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (SECRET_ENV_NAME.test(name)) continue;
    env[name] = value;
  }
  return env;
}

/**
 * Collects stream output up to a limit.
 *
 * Capping as it arrives, rather than truncating at the end, is what stops a
 * command like `yes` from exhausting memory before it is killed.
 */
function createCollector(limit: number) {
  let text = '';
  let dropped = 0;

  return {
    push(chunk: string): void {
      const room = limit - text.length;
      if (room <= 0) {
        dropped += chunk.length;
        return;
      }
      if (chunk.length <= room) {
        text += chunk;
        return;
      }
      text += chunk.slice(0, room);
      dropped += chunk.length - room;
    },
    value(): string {
      return dropped > 0
        ? `${text}\n[... ${dropped} more characters dropped ...]`
        : text;
    },
  };
}

/**
 * Signal an entire process group.
 *
 * CLAUDE.md: killing the shell alone leaves its children running. `sh -c "sleep
 * 300 & sleep 300"` spawns grandchildren that outlive the shell, so we signal
 * the negative pid — which POSIX reads as "the group led by this pid".
 * `detached: true` at spawn time is what makes the child a group leader.
 */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already exited, or the group is gone. Nothing left to kill.
  }
}

/**
 * The only place in the codebase that spawns a process (CLAUDE.md).
 *
 * A non-zero exit is a normal outcome, not an exception: it comes back as a
 * CommandResult with `success: false` so the model can read and react to it.
 */
export function runCommand(
  command: string,
  options: RunCommandOptions,
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const startedAt = Date.now();

  return new Promise<CommandResult>((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: options.cwd,
      detached: true, // new process group, so we can kill the whole tree
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(),
    });

    const out = createCollector(maxOutputChars);
    const err = createCollector(maxOutputChars);
    let timedOut = false;
    let settled = false;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => out.push(chunk));
    child.stderr?.on('data', (chunk: string) => err.push(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      if (pid === undefined) return;

      killGroup(pid, 'SIGTERM');
      // Escalate for anything that ignores SIGTERM. unref() so this timer
      // alone cannot keep the process alive.
      setTimeout(() => killGroup(pid, 'SIGKILL'), GRACE_MS).unref();
    }, timeoutMs);

    const finish = (exitCode: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const stderr = spawnError
        ? `${err.value()}${err.value() ? '\n' : ''}${spawnError}`
        : err.value();

      resolve({
        success: !timedOut && exitCode === 0,
        stdout: out.value(),
        stderr,
        exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };

    // Failure to spawn at all — bad cwd, /bin/sh missing.
    child.on('error', (error: Error) => finish(null, error.message));
    // 'close' rather than 'exit': it fires after the stdio streams have
    // flushed, so no trailing output is lost.
    child.on('close', (code) => finish(code));
  });
}
