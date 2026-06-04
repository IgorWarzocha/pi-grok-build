import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readGrokCliVersion, readGrokModels } from "./models.ts";
import { login, readGrokApiKeyForStartup, refreshToken } from "./oauth.ts";
import { streamSimpleGrok } from "./tool-normalization.ts";

const GROK_CLI_VERSION = readGrokCliVersion();
const BASE_URL = process.env.GROK_CLI_CHAT_PROXY_BASE_URL?.replace(/\/$/, "") || "https://cli-chat-proxy.grok.com/v1";
const MODELS = readGrokModels();

export default function (pi: ExtensionAPI) {
  pi.registerProvider("grok-cli", {
    name: "Grok Build (grok login)",
    baseUrl: BASE_URL,
    api: "openai-responses",
    streamSimple: streamSimpleGrok,
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
      name: "Grok Build (reuse ~/.grok/auth.json)",
      login,
      refreshToken,
      getApiKey: (credentials) => credentials.access,
    },
  });
}
