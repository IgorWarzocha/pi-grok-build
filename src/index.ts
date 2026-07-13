import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readGrokCliVersion, readGrokModels } from "./models.ts";
import { login, readGrokApiKeyForStartup, refreshToken } from "./oauth.ts";
import { normalizeGrokAssistantEvent, normalizeGrokAssistantMessage } from "./tool-normalization.ts";

const GROK_CLI_VERSION = readGrokCliVersion();
const BASE_URL = process.env.GROK_CLI_CHAT_PROXY_BASE_URL?.replace(/\/$/, "") || "https://cli-chat-proxy.grok.com/v1";
const MODELS = readGrokModels();

export default function (pi: ExtensionAPI) {
  let turnTools: string[] = [];

  pi.registerProvider("grok-cli", {
    name: "Grok CLI (grok login)",
    baseUrl: BASE_URL,
    api: "openai-responses",
    apiKey: readGrokApiKeyForStartup(),
    authHeader: true,
    headers: {
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-grok-client-version": GROK_CLI_VERSION,
    },
    models: MODELS.map((m) => ({
      ...m,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      headers: { "x-grok-model-override": m.id },
      compat: { supportsReasoningEffort: false, supportsUsageInStreaming: true, supportsDeveloperRole: false },
    })),
    oauth: {
      name: "Grok CLI (reuse ~/.grok/auth.json)",
      login,
      refreshToken,
      getApiKey: (credentials) => credentials.access,
    },
  });

  pi.on("turn_start", () => {
    // Keep alias resolution tied to the tool set sent with this request.
    turnTools = pi.getActiveTools();
  });

  pi.on("message_update", (event) => {
    const message = event.message;
    if (message.role !== "assistant" || message.provider !== "grok-cli") return;

    const normalized = normalizeGrokAssistantMessage(message, turnTools);
    // Streaming events are notification-only, so update the event in place for
    // the TUI/RPC listeners that run after extensions.
    if (normalized !== message) message.content = normalized.content;

    const normalizedEvent = normalizeGrokAssistantEvent(event.assistantMessageEvent, turnTools);
    if (normalizedEvent !== event.assistantMessageEvent) {
      Object.assign(event.assistantMessageEvent, normalizedEvent);
    }
  });

  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant" || message.provider !== "grok-cli") return;

    const normalized = normalizeGrokAssistantMessage(message, turnTools);
    if (normalized !== message) return { message: normalized };
  });
}
