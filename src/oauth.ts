import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
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

export function readGrokAuth(): { access: string; refresh?: string; expires?: number } {
  const authPath = join(homedir(), ".grok", "auth.json");
  const data = JSON.parse(readFileSync(authPath, "utf8"));
  const entry = data[GROK_SCOPE] || data["https://accounts.x.ai/sign-in"];
  const access = String(entry?.key || "").trim();
  if (!access) throw new Error(`No Grok login found in ${authPath}. Run: grok login`);
  const refresh = String(entry?.refresh_token || "").trim() || undefined;
  const expiresAt = entry?.expires_at ? Date.parse(String(entry.expires_at)) : undefined;
  return { access, refresh, expires: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 60 * 60 * 1000 };
}

export function readGrokApiKeyForStartup(): string | undefined {
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

export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
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

  callbacks.onAuth({ url: authUrl });

  let url: URL;
  try {
    const callback = await waitForLoopbackCallback(state);
    url = callback.url;
    callback.close();
  } catch {
    const callbackUrl = await callbacks.onPrompt({ message: "Paste the full 127.0.0.1 callback URL from the failed browser tab:" });
    url = new URL(callbackUrl.trim());
  }

  const upstreamError = url.searchParams.get("error");
  if (upstreamError) throw new Error(`xAI OAuth failed: ${upstreamError} ${url.searchParams.get("error_description") || ""}`.trim());
  if (url.searchParams.get("state") !== state) throw new Error("xAI OAuth state mismatch");
  const code = url.searchParams.get("code");
  if (!code) throw new Error("xAI OAuth callback did not include a code");

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

export async function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
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
