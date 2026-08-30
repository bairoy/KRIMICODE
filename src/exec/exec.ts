import { spawn } from 'node:child_process';
import {
  type Invocation,
  isWindows,
  shellInvocation,
  shimInvocation,
  taskkillArgs,
} from './platform.js';

/** ARCHITECTURE §3. */
export interface CommandResult {
  readonly success: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** Killed because the caller aborted, as opposed to hitting the timeout. */
  readonly cancelled: boolean;
  readonly durationMs: number;
}

export interface RunCommandOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Per-stream character budget. Bounds memory while the command runs. */
  readonly maxOutputChars?: number;
  /**
   * Kills the process group when aborted. Without this, Ctrl-C leaves a long
   * `npm test` or `sleep 300` running with nothing left to reap it.
   */
  readonly signal?: AbortSignal;
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
 * Signal an entire process tree.
 *
 * CLAUDE.md: killing the shell alone leaves its children running. `sh -c "sleep
 * 300 & sleep 300"` spawns grandchildren that outlive the shell, so on POSIX we
 * signal the negative pid — which is read as "the group led by this pid".
 * `detached: true` at spawn time is what makes the child a group leader.
 *
 * Windows has no process groups in that sense, so `taskkill /T` walks the tree
 * instead. `taskkill` is the one process spawned outside `spawnAndCollect`, and
 * it stays inside this module because `exec.ts` is the spawn chokepoint.
 */
function killTree(pid: number, signal: NodeJS.Signals): void {
  if (isWindows(process.platform)) {
    try {
      // Detached and fully ignored: this is fire-and-forget cleanup, and a
      // failure here means the target is already gone.
      const killer = spawn('taskkill', taskkillArgs(pid), {
        stdio: 'ignore',
        detached: false,
      });
      killer.on('error', () => {});
    } catch {
      // taskkill missing or the process is already gone.
    }
    return;
  }

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
function spawnAndCollect(
  invocation: Invocation,
  options: RunCommandOptions,
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const startedAt = Date.now();

  // Already cancelled before we got here: don't spawn at all. Starting a
  // process only to immediately kill it can still leave side effects behind.
  if (options.signal?.aborted) {
    return Promise.resolve({
      success: false,
      stdout: '',
      stderr: 'Cancelled before the command started.',
      exitCode: null,
      timedOut: false,
      cancelled: true,
      durationMs: 0,
    });
  }

  return new Promise<CommandResult>((resolve) => {
    const child = spawn(invocation.file, [...invocation.args], {
      cwd: options.cwd,
      // POSIX only: makes the child a process-group leader so the whole tree
      // can be signalled. On Windows `detached` means "own console window"
      // instead, which is not what we want and can flash a window on screen —
      // there, `taskkill /T` walks the tree without any spawn-time setup.
      detached: !isWindows(process.platform),
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(),
    });

    const out = createCollector(maxOutputChars);
    const err = createCollector(maxOutputChars);
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    /** Both kill paths are identical; only the reason recorded differs. */
    const terminate = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;

      killTree(pid, 'SIGTERM');
      // Escalate for anything that ignores SIGTERM. unref() so this timer
      // alone cannot keep the process alive.
      //
      // POSIX only. `taskkill /F` is already unconditional, and Windows has no
      // graceful signal that console applications reliably honour, so there is
      // nothing to escalate from — the first kill is the forced one.
      if (!isWindows(process.platform)) {
        setTimeout(() => killTree(pid, 'SIGKILL'), GRACE_MS).unref();
      }
    };

    const onAbort = (): void => {
      cancelled = true;
      terminate();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => out.push(chunk));
    child.stderr?.on('data', (chunk: string) => err.push(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);

    const finish = (exitCode: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Detach from the signal. A single AbortController covers every command
      // in one turn, so leaving these attached would accumulate listeners
      // across a long-running session.
      options.signal?.removeEventListener('abort', onAbort);

      const stderr = spawnError
        ? `${err.value()}${err.value() ? '\n' : ''}${spawnError}`
        : err.value();

      resolve({
        success: !timedOut && !cancelled && exitCode === 0,
        stdout: out.value(),
        stderr,
        exitCode,
        timedOut,
        cancelled,
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

/**
 * Runs a shell command, so it supports pipes, redirection, and globbing.
 * Interpreted by `/bin/sh -c`, or by `cmd.exe /d /s /c` on Windows — which
 * means the *syntax* a command may use differs by platform.
 *
 * Only for commands the user has approved as a whole. Never build one of these
 * by interpolating model-supplied text — use `runProgram` instead.
 */
export function runCommand(
  command: string,
  options: RunCommandOptions,
): Promise<CommandResult> {
  return spawnAndCollect(shellInvocation(command, process.platform), options);
}

/**
 * Runs a program directly with an argv array and **no shell**.
 *
 * Use this whenever any argument comes from the model. Arguments are passed to
 * execve as separate strings, so shell metacharacters in them are inert: a
 * search pattern like `foo"; rm -rf ~; echo "` is just a pattern, never code.
 * The same string routed through `runCommand` would execute.
 */
export function runProgram(
  file: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  return spawnAndCollect(
    { file, args, windowsVerbatimArguments: false },
    options,
  );
}

/**
 * Runs a program that is a batch-file shim on Windows — `npm` and friends.
 *
 * Separate from `runProgram` because on Windows it has to go through `cmd.exe`,
 * which reintroduces a shell. `shimInvocation` refuses any argv that could be
 * interpreted as shell syntax, so this cannot be used to smuggle model input
 * into a command line: pass model-supplied arguments to `runProgram` instead.
 */
export function runShim(
  file: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  return spawnAndCollect(shimInvocation(file, args, process.platform), options);
}
