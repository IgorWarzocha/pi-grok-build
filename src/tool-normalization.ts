import {
  createAssistantMessageEventStream,
  streamSimpleOpenAIResponses,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type SimpleStreamOptions,
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

function resolveToolName(name: string, context: Context): string {
  const tools = context.tools ?? [];
  const exact = tools.find((tool) => tool.name === name);
  if (exact) return name;

  const lowerName = name.toLowerCase();
  const aliased = TOOL_ALIASES[lowerName];
  if (aliased && tools.some((tool) => tool.name === aliased)) return aliased;

  const caseInsensitive = tools.find((tool) => tool.name.toLowerCase() === lowerName);
  if (caseInsensitive) return caseInsensitive.name;

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

function normalizeToolCall(toolCall: ToolCall, context: Context): ToolCall {
  const normalized = resolveToolName(toolCall.name, context);
  const normalizedArguments = normalizeToolArguments(normalized, toolCall.arguments);
  return normalized === toolCall.name && normalizedArguments === toolCall.arguments
    ? toolCall
    : { ...toolCall, name: normalized, arguments: normalizedArguments };
}

function normalizeAssistantMessage(message: AssistantMessage, context: Context): AssistantMessage {
  let changed = false;
  const content = message.content.map((part) => {
    if (part.type !== "toolCall") return part;
    const normalized = normalizeToolCall(part, context);
    if (normalized !== part) changed = true;
    return normalized;
  });
  return changed ? { ...message, content } : message;
}

function normalizeAssistantEvent(event: AssistantMessageEvent, context: Context): AssistantMessageEvent {
  if (event.type === "toolcall_end") {
    return {
      ...event,
      toolCall: normalizeToolCall(event.toolCall, context),
      partial: normalizeAssistantMessage(event.partial, context),
    };
  }
  if (event.type === "done") return { ...event, message: normalizeAssistantMessage(event.message, context) };
  if (event.type === "error") return { ...event, error: normalizeAssistantMessage(event.error, context) };
  if ("partial" in event) return { ...event, partial: normalizeAssistantMessage(event.partial, context) };
  return event;
}

export function streamSimpleGrok(model: Model<"openai-responses">, context: Context, options?: SimpleStreamOptions) {
  const upstream = streamSimpleOpenAIResponses(model, context, options);
  const stream = createAssistantMessageEventStream();

  void (async () => {
    for await (const event of upstream) {
      stream.push(normalizeAssistantEvent(event, context));
    }
  })().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    stream.push({
      type: "error",
      reason: "error",
      error: {
        role: "assistant",
        content: [{ type: "text", text: message }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "error",
        errorMessage: message,
        timestamp: Date.now(),
      },
    });
  });

  return stream;
}
