import type { ToolSpec } from '../types.js';
import type { RegisteredTool } from './define.js';
import { createFileTool } from './create_file.js';
import { editFileTool } from './edit_file.js';
import { gitDiffTool } from './git_diff.js';
import { gitStatusTool } from './git_status.js';
import { listFilesTool } from './list_files.js';
import { readFileTool } from './read_file.js';
import { runCommandTool } from './run_command.js';
import { runTestsTool } from './run_tests.js';
import { searchCodeTool } from './search_code.js';

/**
 * Source of truth for what the model can call. A tool that is not in this
 * array does not exist as far as the agent is concerned.
 */
const TOOLS: readonly RegisteredTool[] = [
  listFilesTool,
  searchCodeTool,
  readFileTool,
  editFileTool,
  createFileTool,
  gitStatusTool,
  gitDiffTool,
  runTestsTool,
  runCommandTool,
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function getTool(name: string): RegisteredTool | undefined {
  return BY_NAME.get(name);
}

/** The tool list as sent to the model. */
export function toolSpecs(): ToolSpec[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export type { RegisteredTool, Tool, ToolContext } from './define.js';
