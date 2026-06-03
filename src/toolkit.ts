import {
  createFindTool,
  createGrepTool,
  createLsTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

function createDiscoveryTools(cwd: string) {
  return {
    find: createFindTool(cwd),
    grep: createGrepTool(cwd),
    ls: createLsTool(cwd),
  };
}

const discoveryToolCache = new Map<string, ReturnType<typeof createDiscoveryTools>>();

function getDiscoveryTools(cwd: string) {
  let tools = discoveryToolCache.get(cwd);
  if (!tools) {
    tools = createDiscoveryTools(cwd);
    discoveryToolCache.set(cwd, tools);
  }
  return tools;
}

export function registerCursorStyleTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "grep",
    label: "grep",
    description: "Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore.",
    promptSnippet: "Search file contents for patterns (respects .gitignore)",
    parameters: getDiscoveryTools(process.cwd()).grep.parameters,
    execute(toolCallId, params, signal, onUpdate, ctx) {
      return getDiscoveryTools(ctx.cwd).grep.execute(toolCallId, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    name: "find",
    label: "find",
    description: "Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore.",
    promptSnippet: "Find files by glob pattern (respects .gitignore)",
    parameters: getDiscoveryTools(process.cwd()).find.parameters,
    execute(toolCallId, params, signal, onUpdate, ctx) {
      return getDiscoveryTools(ctx.cwd).find.execute(toolCallId, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    name: "glob",
    label: "glob",
    description: "Alias for find. Search for files by glob pattern. Use pattern, optional path, and optional limit.",
    promptSnippet: "Find files by glob pattern (alias for find)",
    parameters: getDiscoveryTools(process.cwd()).find.parameters,
    execute(toolCallId, params, signal, onUpdate, ctx) {
      return getDiscoveryTools(ctx.cwd).find.execute(toolCallId, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    name: "ls",
    label: "ls",
    description: "List directory contents. Includes dotfiles and marks directories with a trailing slash.",
    promptSnippet: "List directory contents",
    parameters: getDiscoveryTools(process.cwd()).ls.parameters,
    execute(toolCallId, params, signal, onUpdate, ctx) {
      return getDiscoveryTools(ctx.cwd).ls.execute(toolCallId, params, signal, onUpdate);
    },
  });
}
