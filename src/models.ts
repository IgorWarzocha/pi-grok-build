import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";

export type GrokModelConfig = {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  description?: string;
  baseUrl?: string;
};

export const FALLBACK_MODELS: GrokModelConfig[] = [
  { id: "grok-4.5", name: "Grok 4.5", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null }, input: ["text", "image"], contextWindow: 500_000, maxTokens: 0, description: "Current Grok CLI model" },
  { id: "grok-composer-2.5-fast", name: "Composer 2.5", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 0, description: "Cursor's latest coding model" },
];

function readThinkingLevelMap(info: Record<string, any>): ThinkingLevelMap | undefined {
  if (info.supports_reasoning_effort !== true) return undefined;

  const efforts = Array.isArray(info.reasoning_efforts) ? info.reasoning_efforts : [];
  const values = new Set(efforts.map((effort) => String(effort?.value || effort?.id || "").trim()).filter(Boolean));
  if (values.size === 0 && typeof info.reasoning_effort === "string") values.add(info.reasoning_effort);

  return {
    off: null,
    minimal: null,
    low: values.has("low") ? "low" : null,
    medium: values.has("medium") ? "medium" : null,
    high: values.has("high") ? "high" : null,
    xhigh: null,
  };
}

export function readGrokCliVersion(): string {
  try {
    const versionPath = join(homedir(), ".grok", "version.json");
    const data = JSON.parse(readFileSync(versionPath, "utf8"));
    const version = String(data.version || "").trim();
    if (version) return version;
  } catch {}
  return "0.2.91";
}

export function readGrokModels(): GrokModelConfig[] {
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
      const thinkingLevelMap = readThinkingLevelMap(info);
      return [{
        id,
        name: String(info.name || id),
        reasoning: Boolean(thinkingLevelMap),
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        input: (id === "grok-4.5" ? ["text", "image"] : ["text"]) as GrokModelConfig["input"],
        contextWindow: Number(info.context_window) || 128_000,
        // Grok uses null when the client should not impose an output limit.
        maxTokens: Number(info.max_completion_tokens) > 0 ? Number(info.max_completion_tokens) : 0,
        description: typeof info.description === "string" ? info.description : undefined,
        baseUrl: typeof info.base_url === "string" ? info.base_url.replace(/\/$/, "") : undefined,
      }];
    });

    return result.length ? result : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}
