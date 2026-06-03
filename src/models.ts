import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type GrokModelConfig = {
  id: string;
  name: string;
  reasoning: false;
  input: ["text"];
  contextWindow: number;
  maxTokens: number;
  description?: string;
  baseUrl?: string;
};

export const FALLBACK_MODELS: GrokModelConfig[] = [
  { id: "grok-build", name: "Grok Build", reasoning: false, input: ["text"], contextWindow: 512_000, maxTokens: 16_384, description: "Best for advanced coding tasks" },
  { id: "grok-composer-2.5-fast", name: "Composer 2.5", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 16_384, description: "Cursor's latest coding model" },
];

export function readGrokCliVersion(): string {
  try {
    const versionPath = join(homedir(), ".grok", "version.json");
    const data = JSON.parse(readFileSync(versionPath, "utf8"));
    const version = String(data.version || "").trim();
    if (version) return version;
  } catch {}
  return "0.2.16";
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
