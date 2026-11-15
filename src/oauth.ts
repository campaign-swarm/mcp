/**
 * OAuth 2.1 authorization server for the hosted Campaign Swarm MCP endpoint.
 *
 * The MCP server already accepts Campaign Swarm API keys. Claude and OpenAI
 * require an OAuth authorization-code + PKCE flow, so this module adds a
 * standards-compliant authorization server in front of the same endpoint:
 *
 * - CIMD and DCR client registration
 * - S256 PKCE, RFC 8707 resource binding, RFC 9207 issuer responses
 * - RFC 9728 protected-resource metadata and RFC 8414 AS metadata
 * - an API-key consent screen (the key never appears in a URL)
 * - encrypted API-key material in the server-side token store
 *
 * The package is MIT-licensed and self-hosted; no identity vendor is needed.
 * Set OAUTH_ENCRYPTION_KEY (32 bytes, base64url/base64/hex) to enable it.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import {
  MemoryOAuthServerModel,
  OAuthServer,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
  redirectUriMatches,
  requireBearerAuth,
  type AccessToken,
  type AuthorizationCode,
  type ClientIdMetadataDocument,
  type GrantId,
  type OAuthClientInformationFull,
  type RefreshToken,
} from "mcp-oauth-server";

const SCOPES = ["mcp:tools"];
const PUBLIC_BASE_DEFAULT = "https://mcp.campaignswarm.com";
const CIMD_HOSTS = new Set([
  "claude.ai",
  "claude.com",
  "anthropic.com",
  "chatgpt.com",
  "chat.openai.com",
  "openai.com",
  "cursor.com",
  "www.cursor.com",
]);

export type ApiKeyVerifier = (key: string) => Promise<{ orgId: string; role: string }>;

export type OAuthRuntime = {
  enabled: boolean;
  issuer?: string;
  resource: URL;
  prmUrl: string;
  bearer?: RequestHandler;
  openUserId?: (userId: string) => { apiKey: string; orgId: string; role: string };
};

function publicBase(): string {
  return (process.env.MCP_PUBLIC_URL ?? PUBLIC_BASE_DEFAULT).replace(/\/+$/, "");
}

function readEncryptionKey(): Buffer | undefined {
  const raw = process.env.OAUTH_ENCRYPTION_KEY?.trim();
  if (!raw) return undefined;
  const candidates = [
    Buffer.from(raw, "base64url"),
    Buffer.from(raw, "base64"),
    Buffer.from(raw, "hex"),
  ];
  const key = candidates.find((candidate) => candidate.length === 32);
  if (!key) {
    throw new Error(
      "OAUTH_ENCRYPTION_KEY must be exactly 32 bytes, encoded as base64url, base64, or hex"
    );
  }
  return key;
}

function b64(value: Buffer): string {
  return value.toString("base64url");
}

/**
 * The in-memory model stores timestamps as ISO strings. A JSON round-trip
 * therefore loses the Date type that the verifier expects. Restore every
 * date-shaped field when loading the snapshot, including nested client and
 * grant records.
 */
function reviveDates<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => reviveDates(item)) as T;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === "string" && /At$/.test(key)) {
        const date = new Date(child);
        if (!Number.isNaN(date.getTime())) {
          (value as Record<string, unknown>)[key] = date;
          continue;
        }
      }
      (value as Record<string, unknown>)[key] = reviveDates(child);
    }
  }
  return value;
}

export function seal(value: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", b64(iv), b64(cipher.getAuthTag()), b64(ciphertext)].join(".");
}

export function unseal(value: string, key: Buffer): string {
  const [version, ivText, tagText, ciphertextText] = value.split(".");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) {
    throw new Error("invalid sealed value");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

type ConsentFields = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scope?: string;
  resource?: string;
};

function signConsent(fields: ConsentFields, key: Buffer): string {
  const payload = Buffer.from(
    JSON.stringify({ ...fields, exp: Date.now() + 10 * 60 * 1000 }),
    "utf8"
  ).toString("base64url");
  const signature = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyConsent(value: string, key: Buffer): ConsentFields | undefined {
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return undefined;
  const expected = crypto.createHmac("sha256", key).update(payload).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as
      | (ConsentFields & { exp?: number })
      | null;
    if (!parsed || typeof parsed.exp !== "number" || parsed.exp < Date.now()) return undefined;
    if (
      typeof parsed.clientId !== "string" ||
      typeof parsed.redirectUri !== "string" ||
      typeof parsed.codeChallenge !== "string"
    ) {
      return undefined;
    }
    return {
      clientId: parsed.clientId,
      redirectUri: parsed.redirectUri,
      codeChallenge: parsed.codeChallenge,
      state: typeof parsed.state === "string" ? parsed.state : undefined,
      scope: typeof parsed.scope === "string" ? parsed.scope : undefined,
      resource: typeof parsed.resource === "string" ? parsed.resource : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * A MemoryOAuthServerModel that snapshots every mutation to a mode-600 JSON
 * file. It is deliberately single-process: the MCP service is one process, and
 * the state is small (clients, codes, token records). The snapshot contains
 * only opaque tokens and encrypted API-key material, never a plaintext key.
 */
class FileOAuthServerModel extends MemoryOAuthServerModel {
  private readonly file: string;

  constructor(file: string) {
    super();
    this.file = file;
    this.load();
  }

  private maps(): Record<string, Map<string, any>> {
    const self = this as any;
    return {
      clients: self.clients,
      authorizationCodes: self.authorizationCodes,
      accessTokens: self.accessTokens,
      refreshTokens: self.refreshTokens,
      consumedRefreshTokens: self.consumedRefreshTokens,
      clientIdMetadataDocuments: self.clientIdMetadataDocuments,
    };
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    const text = fs.readFileSync(this.file, "utf8");
    const parsed = JSON.parse(text, (_key, value) => {
      if (value && typeof value === "object" && typeof value.__date === "string") {
        return new Date(value.__date);
      }
      return value;
    }) as Record<string, Array<[string, any]>>;
    reviveDates(parsed);
    const maps = this.maps();
    for (const [name, entries] of Object.entries(parsed)) {
      const map = maps[name];
      if (!map || !Array.isArray(entries)) continue;
      for (const [key, value] of entries) map.set(key, value);
    }
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // The file may live on a filesystem that does not expose POSIX modes.
    }
  }

  private persist(): void {
    const snapshot: Record<string, Array<[string, any]>> = {};
    for (const [name, map] of Object.entries(this.maps())) {
      snapshot[name] = [...map.entries()];
    }
    const text = JSON.stringify(snapshot, (_key, value) =>
      value instanceof Date ? { __date: value.toISOString() } : value
    );
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, text, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // See load().
    }
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    const result = await super.registerClient(client);
    this.persist();
    return result;
  }

  async saveAuthorizationCode(
    code: AuthorizationCode,
    client?: OAuthClientInformationFull
  ): Promise<void> {
    await super.saveAuthorizationCode(code, client);
    this.persist();
  }

  async consumeAuthorizationCode(code: string, clientId: string): Promise<AuthorizationCode | undefined> {
    const result = await super.consumeAuthorizationCode(code, clientId);
    if (result) this.persist();
    return result;
  }

  async revokeAuthorizationCode(code: string): Promise<void> {
    await super.revokeAuthorizationCode(code);
    this.persist();
  }

  async saveAccessToken(token: AccessToken, client: OAuthClientInformationFull): Promise<void> {
    await super.saveAccessToken(token, client);
    this.persist();
  }

  async revokeAccessToken(token: string, clientId: string): Promise<AccessToken | undefined> {
    const result = await super.revokeAccessToken(token, clientId);
    if (result) this.persist();
    return result;
  }

  async saveRefreshToken(token: RefreshToken, client: OAuthClientInformationFull): Promise<void> {
    await super.saveRefreshToken(token, client);
    this.persist();
  }

  async consumeRefreshToken(token: string, clientId: string): Promise<RefreshToken | undefined> {
    const result = await super.consumeRefreshToken(token, clientId);
    if (result) this.persist();
    return result;
  }

  async revokeRefreshToken(token: string, clientId: string): Promise<RefreshToken | undefined> {
    const result = await super.revokeRefreshToken(token, clientId);
    if (result) this.persist();
    return result;
  }

  async revokeGrant(grantId: GrantId): Promise<void> {
    await super.revokeGrant(grantId);
    this.persist();
  }

  async saveClientIdMetadataDocument(document: ClientIdMetadataDocument): Promise<void> {
    await super.saveClientIdMetadataDocument(document);
    this.persist();
  }

  purgeExpired(now?: Date): number {
    const removed = super.purgeExpired(now);
    if (removed > 0) this.persist();
    return removed;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; --ink:#171717; --muted:#5b5b5b; --line:#d9d9d9; --accent:#0b6b53; --bg:#f7f5ef; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px; background:var(--bg); color:var(--ink); font:16px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(100%,560px); background:#fff; border:1px solid var(--line); border-radius:16px; padding:32px; box-shadow:0 12px 40px rgba(23,23,23,.06); }
    .brand { font-weight:800; letter-spacing:.02em; margin:0 0 4px; }
    .kicker { color:var(--muted); font-size:13px; text-transform:uppercase; letter-spacing:.12em; margin:0 0 22px; }
    h1 { font-size:25px; line-height:1.2; margin:0 0 10px; }
    p { margin:0 0 14px; }
    .muted { color:var(--muted); font-size:14px; }
    .client { border:1px solid var(--line); border-radius:10px; padding:14px; margin:18px 0; background:#faf9f5; }
    .client strong { display:block; }
    code { background:#f1efe8; border-radius:5px; padding:2px 5px; font-size:13px; overflow-wrap:anywhere; }
    label { display:block; font-weight:650; margin:16px 0 6px; }
    input[type=password] { width:100%; border:1px solid #bdbdbd; border-radius:9px; padding:11px 12px; font:inherit; }
    input[type=password]:focus { outline:3px solid rgba(11,107,83,.18); border-color:var(--accent); }
    button { width:100%; margin-top:16px; border:0; border-radius:9px; padding:12px 14px; background:var(--accent); color:#fff; font:inherit; font-weight:700; cursor:pointer; }
    .error { border:1px solid #e3b4ae; background:#fff4f2; color:#8a2d20; border-radius:9px; padding:11px 12px; margin:14px 0; font-size:14px; }
    .foot { margin-top:18px; color:var(--muted); font-size:12px; }
    a { color:var(--accent); }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function errorPage(message: string, status: number, res: Response): void {
  res
    .status(status)
    .type("html")
    .send(
      page(
        "Campaign Swarm authorization",
        `<p class="brand">Campaign Swarm</p>
         <p class="kicker">MCP authorization</p>
         <h1>Could not continue</h1>
         <div class="error">${escapeHtml(message)}</div>
         <p class="muted">Return to your MCP client and start the connection again.</p>`
      )
    );
}

function consentPage(
  fields: ConsentFields,
  nonce: string,
  clientName: string,
  error?: string
): string {
  const redirectHost = (() => {
    try {
      const url = new URL(fields.redirectUri);
      return `${url.host}${url.pathname}`;
    } catch {
      return fields.redirectUri;
    }
  })();
  return page(
    "Authorize Campaign Swarm",
    `<p class="brand">Campaign Swarm</p>
     <p class="kicker">MCP authorization</p>
     <h1>Connect ${escapeHtml(clientName)}</h1>
     <p>This lets the client use Campaign Swarm tools on your organization's behalf.</p>
     <div class="client">
       <strong>${escapeHtml(clientName)}</strong>
       <span class="muted">will return to <code>${escapeHtml(redirectHost)}</code></span>
     </div>
     <p class="muted">Requested permission: <code>${escapeHtml((fields.scope || SCOPES.join(" ")).trim())}</code></p>
     ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
     <form method="post" action="/oauth/consent" autocomplete="off">
       <input type="hidden" name="consent" value="${escapeHtml(nonce)}">
       <label for="api_key">Campaign Swarm API key</label>
       <input id="api_key" name="api_key" type="password" required autocomplete="off" spellcheck="false" placeholder="csw_...">
       <p class="muted" style="margin-top:8px">Use a read-only key for evaluation. The key is sent only to Campaign Swarm, encrypted in the authorization store, and never put in a URL.</p>
       <button type="submit">Authorize access</button>
     </form>
     <p class="foot">You can revoke this connection from the MCP client at any time. Campaign Swarm support: <a href="mailto:support@campaignswarm.com">support@campaignswarm.com</a>.</p>`
  );
}

export function installOAuth(app: Express, verifyKey: ApiKeyVerifier): OAuthRuntime {
  const base = publicBase();
  const resource = new URL(process.env.OAUTH_RESOURCE_URL ?? `${base}/mcp`);
  const issuer = new URL(process.env.OAUTH_ISSUER_URL ?? base);
  const consentUrl = new URL(process.env.OAUTH_CONSENT_URL ?? "/oauth/consent", issuer);
  const prmUrl = getOAuthProtectedResourceMetadataUrl(resource);
  const encryptionKey = readEncryptionKey();

  if (!encryptionKey) {
    console.warn(
      "OAuth disabled: set OAUTH_ENCRYPTION_KEY to a 32-byte base64url/base64/hex secret to enable Claude/OpenAI OAuth."
    );
    return { enabled: false, resource, prmUrl };
  }

  const model = new FileOAuthServerModel(
    process.env.OAUTH_STATE_FILE ?? path.join(process.cwd(), ".oauth-state.json")
  );
  const oauth = new OAuthServer({
    model,
    issuerUrl: issuer,
    authorizationUrl: consentUrl,
    resourceServerUrl: resource,
    scopesSupported: SCOPES,
    grantTypes: ["authorization_code", "refresh_token"],
    dynamicClientRegistration: true,
    clientIdMetadataDocuments: {
      validateClientIdUrl: (url) => {
        const hostname = url.hostname.toLowerCase();
        return (
          CIMD_HOSTS.has(hostname) ||
          hostname.endsWith(".openai.com") ||
          hostname.endsWith(".anthropic.com")
        );
      },
    },
    accessTokenLifetime: 60 * 60,
    refreshTokenLifetime: 30 * 24 * 60 * 60,
    authorizationCodeLifetime: 5 * 60,
    revokeGrantOnRefreshTokenReuse: true,
    strictResource: true,
    errorHandler: (step, error, params) => {
      // Never log the API key: it is not part of the OAuth params.
      console.error(`oauth ${step} failed: ${error.message}`, params ? { params } : "");
    },
  });

  app.use(
    mcpAuthRouter({
      provider: oauth,
      baseUrl: issuer,
      resourceServerUrl: resource,
      resourceName: "Campaign Swarm MCP",
      serviceDocumentationUrl: new URL("https://campaignswarm.com"),
      scopesSupported: SCOPES,
    })
  );

  // Some clients probe the root document even when the MCP path is /mcp.
  const resourceMetadata = {
    resource: resource.href,
    authorization_servers: [issuer.href],
    scopes_supported: SCOPES,
    resource_name: "Campaign Swarm MCP",
    resource_documentation: "https://campaignswarm.com",
  };
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(resourceMetadata);
  });

  const consentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "too_many_requests", error_description: "Too many consent attempts" },
  });

  app.get(
    "/oauth/consent",
    consentLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const clientId = typeof req.query.client_id === "string" ? req.query.client_id : "";
      const redirectUri = typeof req.query.redirect_uri === "string" ? req.query.redirect_uri : "";
      const codeChallenge =
        typeof req.query.code_challenge === "string" ? req.query.code_challenge : "";
      const responseType =
        typeof req.query.response_type === "string" ? req.query.response_type : "";
      const resourceValue =
        typeof req.query.resource === "string" ? req.query.resource : "";

      if (!clientId || !redirectUri || !codeChallenge || responseType !== "code") {
        errorPage("The authorization request is incomplete.", 400, res);
        return;
      }
      if (resourceValue && resourceValue !== resource.href) {
        errorPage("The authorization request is for a different resource.", 400, res);
        return;
      }
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
        errorPage("The authorization request has an invalid PKCE challenge.", 400, res);
        return;
      }

      let client: OAuthClientInformationFull | undefined;
      try {
        client = await oauth.getClient(clientId);
      } catch {
        errorPage("The client could not be loaded.", 400, res);
        return;
      }
      if (!client) {
        errorPage("This OAuth client is not registered.", 400, res);
        return;
      }
      if (!client.redirect_uris.some((registered) => redirectUriMatches(redirectUri, registered))) {
        errorPage("The client's redirect URI is not registered.", 400, res);
        return;
      }

      const fields: ConsentFields = {
        clientId,
        redirectUri,
        codeChallenge,
        state: typeof req.query.state === "string" ? req.query.state : undefined,
        scope: typeof req.query.scope === "string" ? req.query.scope : undefined,
        resource: resourceValue || undefined,
      };
      const nonce = signConsent(fields, encryptionKey);
      res
        .status(200)
        .type("html")
        .send(consentPage(fields, nonce, client.client_name ?? "MCP client"));
    }
  );

  app.post(
    "/oauth/consent",
    consentLimiter,
    express.urlencoded({ extended: false, limit: "16kb" }),
    async (req: Request, res: Response): Promise<void> => {
      const fields = verifyConsent(String(req.body?.consent ?? ""), encryptionKey);
      if (!fields) {
        errorPage("This authorization request expired. Start the connection again.", 400, res);
        return;
      }
      const apiKey = String(req.body?.api_key ?? "").trim();
      if (!apiKey) {
        const client = await oauth.getClient(fields.clientId).catch(() => undefined);
        res
          .status(400)
          .type("html")
          .send(
            consentPage(
              fields,
              signConsent(fields, encryptionKey),
              client?.client_name ?? "MCP client",
              "Enter a Campaign Swarm API key."
            )
          );
        return;
      }

      let caller: { orgId: string; role: string };
      try {
        caller = await verifyKey(apiKey);
      } catch (error: any) {
        const client = await oauth.getClient(fields.clientId).catch(() => undefined);
        res
          .status(401)
          .type("html")
          .send(
            consentPage(
              fields,
              signConsent(fields, encryptionKey),
              client?.client_name ?? "MCP client",
              error?.message ?? "That API key was not accepted."
            )
          );
        return;
      }

      const client = await oauth.getClient(fields.clientId).catch(() => undefined);
      if (!client) {
        errorPage("This OAuth client is not registered.", 400, res);
        return;
      }

      const sealedUser = seal(
        JSON.stringify({ apiKey, orgId: caller.orgId, role: caller.role }),
        encryptionKey
      );
      try {
        await oauth.authenticate(
          client,
          {
            state: fields.state,
            scopes: fields.scope ? fields.scope.split(/\s+/).filter(Boolean) : undefined,
            codeChallenge: fields.codeChallenge,
            redirectUri: fields.redirectUri,
            resource: fields.resource ? new URL(fields.resource) : undefined,
          },
          sealedUser,
          res
        );
      } catch (error: any) {
        errorPage(error?.message ?? "The authorization request could not be completed.", 400, res);
      }
    }
  );

  const bearer = requireBearerAuth({
    verifier: oauth,
    requiredScopes: SCOPES,
    resourceMetadataUrl: prmUrl,
    resource,
  });

  return {
    enabled: true,
    issuer: issuer.href,
    resource,
    prmUrl,
    bearer,
    openUserId: (userId: string) => {
      const parsed = JSON.parse(unseal(userId, encryptionKey)) as {
        apiKey?: unknown;
        orgId?: unknown;
        role?: unknown;
      };
      if (
        typeof parsed.apiKey !== "string" ||
        !parsed.apiKey.startsWith("csw_") ||
        typeof parsed.orgId !== "string" ||
        typeof parsed.role !== "string"
      ) {
        throw new Error("invalid authorization record");
      }
      return { apiKey: parsed.apiKey, orgId: parsed.orgId, role: parsed.role };
    },
  };
}
