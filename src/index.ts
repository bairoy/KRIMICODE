#!/usr/bin/env node
import { Agent } from './agent/agent.js';
import {
  formatSessionLine,
  latestSession,
  listSessions,
  loadSession,
} from './agent/session.js';
import type { SavedSession } from './agent/session.js';
import { parseCliArgs, USAGE } from './cli/args.js';
import { createApprovalPrompt } from './cli/approve.js';
import { createRenderer } from './cli/renderer.js';
import { createRepl } from './cli/repl.js';
import { loadConfig, loadEnvFile } from './config.js';
import { PermissionGate } from './permissions.js';
import { OpenAICompatibleProvider } from './provider.js';
import { registerSecret } from './redact.js';

/**
 * The composition root: everything is built here and nowhere else, in
 * dependency order. Each layer below is unaware of the ones above it
 * (ARCHITECTURE §2), so this is the only file that knows how they fit
 * together — and the only one that has to change when they are rewired.
 */
async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));

  // Before loadConfig, so `--help` still works for someone who has not set up
  // an API key yet — which is exactly who most needs to read it.
  if (cli.help) {
    console.log(USAGE);
    return;
  }

  loadEnvFile();
  const config = loadConfig();

  // Scrub the exact key from anything a tool returns, on top of the
  // pattern heuristics in redact.ts.
  registerSecret(config.apiKey);

  // --list is a query, not a session: print and leave without touching the
  // terminal mode or opening a connection to the model.
  if (cli.list) {
    const sessions = await listSessions(config.workspaceRoot);
    if (sessions.length === 0) {
      console.log('No saved sessions for this directory.');
    } else {
      for (const session of sessions) console.log(formatSessionLine(session));
    }
    return;
  }

  const resumed = await resolveResume(cli, config.workspaceRoot);
  const render = createRenderer();

  // The terminal is built before the agent: the permission gate needs
  // somewhere to ask, and the agent needs the gate. `close()` sits in a
  // finally so a failure anywhere below still restores the user's shell.
  const repl = createRepl({ config, render });
  try {
    const gate = new PermissionGate(createApprovalPrompt(repl.terminal));

    const agent = new Agent({
      provider: new OpenAICompatibleProvider(config),
      // A resumed session keeps the model it was held with, so continuing a
      // conversation does not silently change who is answering.
      model: resumed?.model ?? config.model,
      ...(resumed
        ? {
            initialState: {
              history: resumed.history,
              summary: resumed.summary,
            },
          }
        : {}),
      workspaceRoot: config.workspaceRoot,
      gate,
      onText: (text) => render.text(text),
      onReasoning: (text) => render.reasoning(text),
      onToolStart: (name, argsJson) => render.toolStart(name, argsJson),
      onToolEnd: (_name, result) => {
        render.toolEnd(result);
        render.waiting(); // back to waiting on the model
      },
      maxContextTokens: config.maxContextTokens,
      onCompact: (info) => {
        render.compacted(info);
        render.waiting();
      },
    });

    await repl.run(agent, resumed);
  } finally {
    repl.close();
  }
}

/**
 * Resolved before the agent is built, so restored history can be handed to the
 * constructor rather than pushed in afterwards.
 */
async function resolveResume(
  cli: { readonly resume?: string; readonly continue: boolean },
  workspaceRoot: string,
): Promise<SavedSession | null> {
  if (cli.resume !== undefined) {
    const session = await loadSession(cli.resume, undefined);
    if (!session) {
      throw new Error(
        `No session "${cli.resume}". Run with --list to see what there is.`,
      );
    }
    return session;
  }

  if (!cli.continue) return null;

  const session = await latestSession(workspaceRoot);
  if (!session) {
    console.log('No session to continue in this directory; starting fresh.');
  }
  return session;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
