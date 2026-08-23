import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig } from './config.js';
import { OpenAICompatibleProvider } from './provider.js';
import { Agent } from './agent.js';
import { registerSecret } from './redact.js';
import { PermissionGate } from './permissions.js';
import type { AskUser, OperationClass, UserAnswer } from './permissions.js';
import type { ToolResult } from './types.js';

/** Short human labels for the approval prompt. */
const OPERATION_LABEL: Record<OperationClass, string> = {
  READ: 'read',
  READ_SENSITIVE: 'read credential file',
  WRITE: 'write',
  EXECUTE: 'run command',
  DESTRUCTIVE: 'DESTRUCTIVE',
  GIT_STATE_CHANGE: 'change git state',
};

/**
 * Owns every byte written to stdout during a turn: the waiting spinner, dimmed
 * reasoning, and the answer. ARCHITECTURE §2 — rendering belongs to the CLI,
 * not the agent runtime.
 */
function createRenderer() {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinner: NodeJS.Timeout | null = null;
  let inReasoning = false;

  const clearSpinner = (): void => {
    if (!spinner) return;
    clearInterval(spinner);
    spinner = null;
    stdout.write('\r\x1b[K'); // return to column 0, clear to end of line
  };

  return {
    /** Nothing has arrived yet — there is no content to show, only a pulse. */
    waiting(): void {
      if (!stdout.isTTY) return;
      let i = 0;
      spinner = setInterval(() => {
        stdout.write(`\r${frames[i++ % frames.length] ?? ''} thinking…`);
      }, 80);
    },
    reasoning(text: string): void {
      // Don't open a dim block for whitespace — models often emit a stray
      // newline of "reasoning" even when they did none.
      if (!inReasoning && text.trim() === '') return;
      clearSpinner();
      if (!inReasoning) {
        stdout.write('\x1b[2m'); // dim
        inReasoning = true;
      }
      stdout.write(text);
    },
    text(text: string): void {
      clearSpinner();
      if (inReasoning) {
        stdout.write('\x1b[0m\n\n'); // reset, then separate from the answer
        inReasoning = false;
      }
      stdout.write(text);
    },
    toolStart(name: string, argsJson: string): void {
      clearSpinner();
      if (inReasoning) {
        stdout.write('\x1b[0m\n');
        inReasoning = false;
      }
      const args =
        argsJson.length > 120 ? `${argsJson.slice(0, 120)}…` : argsJson;
      stdout.write(`\n\x1b[36m⚒ ${name}\x1b[0m \x1b[2m${args}\x1b[0m\n`);
    },
    toolEnd(result: ToolResult): void {
      stdout.write(
        result.success
          ? `  \x1b[32m✓\x1b[0m \x1b[2m${result.content.length} chars\x1b[0m\n\n`
          : `  \x1b[31m✗\x1b[0m \x1b[2m${result.error}\x1b[0m\n\n`,
      );
    },
    /** Must run on every path, including errors, or dim leaks into the shell. */
    end(): void {
      clearSpinner();
      if (inReasoning) {
        stdout.write('\x1b[0m');
        inReasoning = false;
      }
      stdout.write('\n\n');
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig();

  // Scrub the exact key from anything a tool returns, on top of the
  // pattern heuristics in redact.ts.
  registerSecret(config.apiKey);

  const render = createRenderer();
  const rl = readline.createInterface({ input: stdin, output: stdout });

  /**
   * The approval prompt. Anything other than an explicit yes is a refusal —
   * including a closed stdin, so a non-interactive run can never be
   * auto-approved into writing or executing something.
   */
  const askUser: AskUser = async (request): Promise<UserAnswer> => {
    const label = OPERATION_LABEL[request.operation];
    stdout.write(`\n\x1b[33m⚠ permission: ${label}\x1b[0m\n`);
    stdout.write(`  ${request.detail}\n`);

    let answer: string;
    try {
      answer = (
        await rl.question('  allow? [y]es / [n]o / [a]lways: ')
      ).trim().toLowerCase();
    } catch {
      return 'no'; // stdin closed mid-prompt
    }

    if (answer === 'a' || answer === 'always') return 'always';
    if (answer === 'y' || answer === 'yes') return 'once';
    return 'no';
  };

  const gate = new PermissionGate(askUser);

  const agent = new Agent({
    provider: new OpenAICompatibleProvider(config),
    model: config.model,
    workspaceRoot: config.workspaceRoot,
    gate,
    onText: (text) => render.text(text),
    onReasoning: (text) => render.reasoning(text),
    onToolStart: (name, argsJson) => render.toolStart(name, argsJson),
    onToolEnd: (_name, result) => {
      render.toolEnd(result);
      render.waiting(); // back to waiting on the model
    },
  });

  // baseURL and model are not secrets. apiKey is never printed.
  console.log(`krimicode — ${config.model} @ ${config.baseURL}`);
  console.log('/exit or Ctrl-C to quit.\n');

  try {
    for (; ;) {
      let line: string;
      try {
        line = (await rl.question('> ')).trim();
      } catch {
        break; // stdin closed: Ctrl-D, or piped input exhausted.
      }
      if (!line) continue;
      if (line === '/exit') break;

      render.waiting();
      try {
        await agent.send(line);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const hint = /ECONNREFUSED|fetch failed|ENOTFOUND/i.test(msg)
          ? ` (could not reach ${config.baseURL})`
          : '';
        console.error(`\nerror: ${msg}${hint}\n`);
      } finally {
        render.end();
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
