import { createFindTool, createGrepTool, createLsTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  streamSimpleOpenAIResponses,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type SimpleStreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ISSUER = "https://auth.x.ai";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;

// Public xAI OAuth client used by Grok/OpenClaw-style loopback PKCE flows.
// Source: Nous Hermes xai-oauth provider and xAI Grok CLI installer scope key.
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPES = "openid profile email offline_access grok-cli:access api:access";
const REDIRECT_URI = "http://127.0.0.1:56121/callback";
const GROK_SCOPE = `${ISSUER}::${CLIENT_ID}`;
function readGrokCliVersion(): string {
  try {
    const versionPath = join(homedir(), ".grok", "version.json");
    const data = JSON.parse(readFileSync(versionPath, "utf8"));
    const version = String(data.version || "").trim();
    if (version) return version;
  } catch {}
  return "0.2.16";
}

const GROK_CLI_VERSION = readGrokCliVersion();
const BASE_URL = process.env.GROK_CLI_CHAT_PROXY_BASE_URL?.replace(/\/$/, "") || "https://cli-chat-proxy.grok.com/v1";

type GrokModelConfig = {
  id: string;
  name: string;
  reasoning: false;
  input: ["text"];
  contextWindow: number;
  maxTokens: number;
  description?: string;
  baseUrl?: string;
};

const FALLBACK_MODELS: GrokModelConfig[] = [
  { id: "grok-build", name: "Grok Build", reasoning: false, input: ["text"], contextWindow: 512_000, maxTokens: 16_384, description: "Best for advanced coding tasks" },
  { id: "grok-composer-2.5-fast", name: "Composer 2.5", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 16_384, description: "Cursor's latest coding model" },
];

function readGrokModels(): GrokModelConfig[] {
  try {
    const cachePath = join(homedir(), ".grok", "models_cache.json");
    const data = JSON.parse(readFileSync(cachePath, "utf8"));
    const models = data?.models;
    if (!models || typeof models !== "object") return FALLBACK_MODELS;

    const result = Object.entries(models).flatMap(([key, value]) => {
      const info = (value as any)?.info ?? {};
      if (info.hidden === true || info.supported_in_api === false) return [];
      const id = String(info.model || key || "").trim();
      if (!id) return [];
      return [{
        id,
        name: String(info.name || id),
        reasoning: false as const,
        input: ["text"] as ["text"],
        contextWindow: Number(info.context_window) || 128_000,
        maxTokens: Number(info.max_completion_tokens) || 16_384,
        description: typeof info.description === "string" ? info.description : undefined,
        baseUrl: typeof info.base_url === "string" ? info.base_url.replace(/\/$/, "") : undefined,
      }];
    });

    return result.length ? result : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

const MODELS = readGrokModels();

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

function resolveToolName(name: string, context: Context): string {
  const tools = context.tools ?? [];
  const exact = tools.find((tool) => tool.name === name);
  if (exact) return name;

  const lowerName = name.toLowerCase();
  const caseInsensitive = tools.find((tool) => tool.name.toLowerCase() === lowerName);
  if (caseInsensitive) return caseInsensitive.name;

  if (lowerName === "shell" && tools.some((tool) => tool.name === "bash")) return "bash";

  return name;
}

function normalizeToolCall(toolCall: ToolCall, context: Context): ToolCall {
  const normalized = resolveToolName(toolCall.name, context);
  return normalized === toolCall.name ? toolCall : { ...toolCall, name: normalized };
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

function streamSimpleGrok(model: Model<"openai-responses">, context: Context, options?: SimpleStreamOptions) {
  const upstream = streamSimpleOpenAIResponses(model, context, options);
  const stream = createAssistantMessageEventStream();

  void (async () => {
    for await (const event of upstream) {
      stream.push(normalizeAssistantEvent(event, context));
    }
  })().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    const now = Date.now();
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
        timestamp: now,
      },
    });
  });

  return stream;
}

function readGrokAuth(): { access: string; refresh?: string; expires?: number } {
  const authPath = join(homedir(), ".grok", "auth.json");
  const data = JSON.parse(readFileSync(authPath, "utf8"));
  const entry = data[GROK_SCOPE] || data["https://accounts.x.ai/sign-in"];
  const access = String(entry?.key || "").trim();
  if (!access) throw new Error(`No Grok login found in ${authPath}. Run: grok login`);
  const refresh = String(entry?.refresh_token || "").trim() || undefined;
  const expiresAt = entry?.expires_at ? Date.parse(String(entry.expires_at)) : undefined;
  return { access, refresh, expires: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 60 * 60 * 1000 };
}

function readGrokApiKeyForStartup(): string | undefined {
  try {
    return readGrokAuth().access;
  } catch {
    return undefined;
  }
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const verifier = base64Url(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

function validateXaiEndpoint(raw: unknown, field: string): string {
  const value = String(raw || "");
  const url = new URL(value);
  if (url.protocol !== "https:" || !(url.hostname === "x.ai" || url.hostname.endsWith(".x.ai"))) {
    throw new Error(`xAI OIDC discovery returned invalid ${field}: ${value}`);
  }
  return value;
}

async function discovery(): Promise<{ authorization_endpoint: string; token_endpoint: string }> {
  const res = await fetch(DISCOVERY_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`xAI OIDC discovery failed: HTTP ${res.status} ${await res.text()}`);
  const json = (await res.json()) as Record<string, unknown>;
  return {
    authorization_endpoint: validateXaiEndpoint(json.authorization_endpoint, "authorization_endpoint"),
    token_endpoint: validateXaiEndpoint(json.token_endpoint, "token_endpoint"),
  };
}

async function exchange(tokenEndpoint: string, data: Record<string, string>): Promise<Record<string, any>> {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(data).toString(),
  });
  if (!res.ok) throw new Error(`xAI token request failed: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as Record<string, any>;
}

function waitForLoopbackCallback(expectedState: string): Promise<{ url: URL; close: () => void }> {
  let server: Server | undefined;
  const close = () => {
    try { server?.close(); } catch {}
  };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      close();
      reject(new Error("Timed out waiting for xAI OAuth callback on http://127.0.0.1:56121/callback"));
    }, 15 * 60 * 1000);

    server = createServer((req, res) => {
      const requestUrl = new URL(req.url || "/", REDIRECT_URI);
      if (requestUrl.pathname !== "/callback") {
        res.writeHead(404).end("Not found");
        return;
      }

      const state = requestUrl.searchParams.get("state");
      const code = requestUrl.searchParams.get("code");
      const error = requestUrl.searchParams.get("error");
      const ok = state === expectedState && (code || error);

      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(ok
        ? "<html><body><h1>xAI authorization received.</h1><p>You can close this tab and return to Pi.</p></body></html>"
        : "<html><body><h1>xAI authorization failed.</h1><p>State mismatch or missing code.</p></body></html>");

      if (ok) {
        clearTimeout(timeout);
        resolve({ url: requestUrl, close });
      }
    });

    server.once("error", (err) => {
      clearTimeout(timeout);
      close();
      reject(err);
    });
    server.listen(56121, "127.0.0.1");
  });
}

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  try {
    const existing = readGrokAuth();
    callbacks.onDeviceCode({ userCode: "already logged in", verificationUri: "grok login" });
    return { access: existing.access, refresh: existing.refresh || existing.access, expires: existing.expires };
  } catch {
    // Fall through to browser PKCE as a backup for machines without `grok login`.
  }

  const endpoints = await discovery();
  const { verifier, challenge } = await pkce();
  const state = crypto.randomUUID().replace(/-/g, "");
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const authUrl = `${endpoints.authorization_endpoint}?${new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
    plan: "generic",
    referrer: "pi-coding-agent",
  }).toString()}`;

  let callbackPromise: Promise<{ url: URL; close: () => void }> | undefined;
  try {
    callbackPromise = waitForLoopbackCallback(state);
  } catch {
    callbackPromise = undefined;
  }

  callbacks.onAuth({ url: authUrl });

  let url: URL;
  if (callbackPromise) {
    try {
      const callback = await callbackPromise;
      url = callback.url;
      callback.close();
    } catch (_err) {
      const callbackUrl = await callbacks.onPrompt({ message: "Paste the full 127.0.0.1 callback URL from the failed browser tab:" });
      url = new URL(callbackUrl.trim());
    }
  } else {
    const callbackUrl = await callbacks.onPrompt({ message: "Paste the full 127.0.0.1 callback URL from the failed browser tab:" });
    url = new URL(callbackUrl.trim());
  }

  const upstreamError = url.searchParams.get("error");
  if (upstreamError) throw new Error(`xAI OAuth failed: ${upstreamError} ${url.searchParams.get("error_description") || ""}`.trim());
  if (url.searchParams.get("state") !== state) throw new Error("xAI OAuth state mismatch");
  const code = url.searchParams.get("code");
  if (!code) throw new Error(`xAI OAuth callback did not include a code: ${callbackUrl}`);

  const payload = await exchange(endpoints.token_endpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
    // xAI currently expects these echoed at token exchange too.
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (!payload.access_token || !payload.refresh_token) throw new Error("xAI token response missing access_token or refresh_token");
  return { access: String(payload.access_token), refresh: String(payload.refresh_token), expires: Date.now() + Number(payload.expires_in || 3600) * 1000 };
}

async function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  try {
    const existing = readGrokAuth();
    return { access: existing.access, refresh: existing.refresh || credentials.refresh, expires: existing.expires };
  } catch {
    // Fall through to direct OAuth refresh.
  }

  const endpoints = await discovery();
  const payload = await exchange(endpoints.token_endpoint, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: credentials.refresh,
  });
  return {
    access: String(payload.access_token),
    refresh: String(payload.refresh_token || credentials.refresh),
    expires: Date.now() + Number(payload.expires_in || 3600) * 1000,
  };
}

export default function (pi: ExtensionAPI) {
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
