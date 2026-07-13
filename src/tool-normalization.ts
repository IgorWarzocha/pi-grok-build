import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type ToolCall,
} from "@earendil-works/pi-ai";

const TOOL_ALIASES: Record<string, string> = {
  glob: "find",
  read_file: "read",
  run_terminal_cmd: "bash",
  search_replace: "edit",
  shell: "bash",
  strreplace: "edit",
};

function resolveToolName(name: string, availableTools: readonly string[]): string {
  if (availableTools.includes(name)) return name;

  const lowerName = name.toLowerCase();
  const aliased = TOOL_ALIASES[lowerName];
  if (aliased && availableTools.includes(aliased)) return aliased;

  const caseInsensitive = availableTools.find((tool) => tool.toLowerCase() === lowerName);
  if (caseInsensitive) return caseInsensitive;

  return name;
}

function objectArgs(args: Record<string, any>): Record<string, any> {
  return args && typeof args === "object" && !Array.isArray(args) ? args : {};
}

function normalizeToolArguments(name: string, args: Record<string, any>): Record<string, any> {
  const input = objectArgs(args);
  if (name === "glob" || name === "find") {
    return {
      ...input,
      pattern: input.pattern ?? input.glob_pattern ?? input.glob,
      path: input.path ?? input.target_directory,
    };
  }
  if (name === "write") {
    return {
      ...input,
      path: input.path ?? input.file_path,
      content: input.content ?? input.contents,
    };
  }
  if (name === "read") {
    return {
      ...input,
      path: input.path ?? input.target_file ?? input.file_path,
    };
  }
  if (name === "edit") {
    if (Array.isArray(input.edits)) return input;
    return {
      path: input.path ?? input.file_path,
      edits: [{ oldText: input.oldText ?? input.old_string, newText: input.newText ?? input.new_string }],
    };
  }
  return input;
}

function normalizeToolCall(toolCall: ToolCall, availableTools: readonly string[]): ToolCall {
  const normalized = resolveToolName(toolCall.name, availableTools);
  const normalizedArguments = normalizeToolArguments(normalized, toolCall.arguments);
  return normalized === toolCall.name && normalizedArguments === toolCall.arguments
    ? toolCall
    : { ...toolCall, name: normalized, arguments: normalizedArguments };
}

export function normalizeGrokAssistantMessage(
  message: AssistantMessage,
  availableTools: readonly string[],
): AssistantMessage {
  let changed = false;
  const content = message.content.map((part) => {
    if (part.type !== "toolCall") return part;
    const normalized = normalizeToolCall(part, availableTools);
    if (normalized !== part) changed = true;
    return normalized;
  });
  return changed ? { ...message, content } : message;
}

export function normalizeGrokAssistantEvent(
  event: AssistantMessageEvent,
  availableTools: readonly string[],
): AssistantMessageEvent {
  if (event.type === "toolcall_end") {
    return {
      ...event,
      toolCall: normalizeToolCall(event.toolCall, availableTools),
      partial: normalizeGrokAssistantMessage(event.partial, availableTools),
    };
  }
  if (event.type === "done") {
    return { ...event, message: normalizeGrokAssistantMessage(event.message, availableTools) };
  }
  if (event.type === "error") {
    return { ...event, error: normalizeGrokAssistantMessage(event.error, availableTools) };
  }
  if ("partial" in event) {
    return { ...event, partial: normalizeGrokAssistantMessage(event.partial, availableTools) };
  }
  return event;
}
