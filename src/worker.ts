import { createInitialFlowchart } from "./defaultData";
import type { ChapterLane, FlowchartData, FlowEdge, FlowNode, ProjectSummary } from "./types";

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ success: boolean }>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  DB?: D1Database;
  novel_chart_builder_db?: D1Database;
  ASSETS: Fetcher;
  /** 許可するGoogleメールアドレス（カンマ区切りで複数指定可。例: "user@gmail.com"） */
  ALLOWED_EMAILS?: string;
  ADMIN_EMAIL?: string;
  /** Cloudflare Zero Trust (Access) のチームドメイン（例: "yourteam.cloudflareaccess.com"） */
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Zero Trust (Access) の Application Audience (AUD) タグ */
  CF_ACCESS_AUD?: string;
  /** アプリ内Googleログインボタンを使う場合の Google OAuth Client ID */
  GOOGLE_CLIENT_ID?: string;
  /** セッションCookie署名用シークレット（未設定時は自動導出） */
  AUTH_SECRET?: string;
}

interface AuthResult {
  authenticated: boolean;
  forbidden?: boolean;
  email?: string;
  name?: string;
  picture?: string;
  authMode: "cloudflare-access" | "google-session" | "none";
  reason?: string;
}

const SESSION_COOKIE_NAME = "ncb_session";

function getDb(env: Env): D1Database {
  const db = env.novel_chart_builder_db ?? env.DB;
  if (!db) {
    throw new Error("D1 database binding (novel_chart_builder_db or DB) is not configured.");
  }
  return db;
}

function getAllowedEmails(env: Env): string[] {
  const raw = [env.ALLOWED_EMAILS ?? "", env.ADMIN_EMAIL ?? ""]
    .join(",")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(raw));
}

function isEmailAllowed(email: string, env: Env): boolean {
  const allowed = getAllowedEmails(env);
  if (allowed.length === 0) {
    // ALLOWED_EMAILS未設定時は認証プロバイダ（Cloudflare Accessポリシー等）で許可された全ユーザーを許可
    return true;
  }
  return allowed.includes(email.trim().toLowerCase());
}

function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeJwtPayload<T = Record<string, unknown>>(token: string): T | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const bytes = base64UrlToUint8Array(parts[1]!);
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/**
 * Verify Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`) against team JWKS endpoint
 * when CF_ACCESS_TEAM_DOMAIN is configured, or extract payload when handled by Cloudflare edge.
 */
async function verifyCloudflareAccessJwt(
  token: string,
  env: Env
): Promise<{ email?: string; sub?: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const header = (() => {
    try {
      return JSON.parse(
        new TextDecoder().decode(base64UrlToUint8Array(parts[0]!))
      ) as { kid?: string; alg?: string };
    } catch {
      return null;
    }
  })();

  const payload = decodeJwtPayload<{
    email?: string;
    sub?: string;
    aud?: string | string[];
    exp?: number;
  }>(token);

  if (!header || !payload) return null;

  if (payload.exp && Date.now() / 1000 > payload.exp) {
    return null;
  }

  if (env.CF_ACCESS_AUD) {
    const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audList.includes(env.CF_ACCESS_AUD)) {
      return null;
    }
  }

  if (env.CF_ACCESS_TEAM_DOMAIN) {
    const domain = env.CF_ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const certsUrl = `https://${domain}/cdn-cgi/access/certs`;
    try {
      const res = await fetch(certsUrl);
      if (!res.ok) return null;
      const data = (await res.json()) as {
        keys?: Array<JsonWebKey & { kid?: string }>;
      };
      const jwk = data.keys?.find((k) => k.kid === header.kid);
      if (!jwk) return null;

      const key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      );
      const dataBytes = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
      const sigBytes = base64UrlToUint8Array(parts[2]!);
      const valid = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        sigBytes.buffer as ArrayBuffer,
        dataBytes
      );
      if (!valid) return null;
    } catch {
      return null;
    }
  }

  return payload;
}

/**
 * Create & verify HMAC-SHA256 signed session tokens for built-in Google Sign-In fallback.
 */
async function getHmacKey(env: Env): Promise<CryptoKey> {
  const secret =
    env.AUTH_SECRET ||
    `ncb-default-secret-${env.GOOGLE_CLIENT_ID || ""}-${env.ALLOWED_EMAILS || "novel-chart"}`;
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function createSessionToken(
  user: { email: string; name?: string; picture?: string },
  env: Env
): Promise<string> {
  const payload = {
    ...user,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7, // 7 days
  };
  const payloadB64 = uint8ArrayToBase64Url(
    new TextEncoder().encode(JSON.stringify(payload))
  );
  const key = await getHmacKey(env);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadB64)
  );
  const sigB64 = uint8ArrayToBase64Url(new Uint8Array(sig));
  return `${payloadB64}.${sigB64}`;
}

async function verifySessionToken(
  token: string,
  env: Env
): Promise<{ email: string; name?: string; picture?: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts as [string, string];
  try {
    const key = await getHmacKey(env);
    const sigBytes = base64UrlToUint8Array(sigB64);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes.buffer as ArrayBuffer,
      new TextEncoder().encode(payloadB64)
    );
    if (!valid) return null;
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlToUint8Array(payloadB64))
    ) as { email: string; name?: string; picture?: string; exp?: number };
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function getCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/**
 * Authenticate incoming request via:
 * 1. Cloudflare Zero Trust (Access) headers / JWT (`Cf-Access-Jwt-Assertion` or `CF_Authorization` cookie)
 * 2. Signed session cookie (`ncb_session`) from Google Sign-In
 */
async function authenticateRequest(request: Request, env: Env): Promise<AuthResult> {
  // 1. Check Cloudflare Access JWT header or CF_Authorization cookie
  const cfJwt =
    request.headers.get("Cf-Access-Jwt-Assertion") ||
    getCookie(request, "CF_Authorization");
  const cfEmailHeader = request.headers.get("Cf-Access-Authenticated-User-Email");

  if (cfJwt) {
    const verified = await verifyCloudflareAccessJwt(cfJwt, env);
    const email = verified?.email || cfEmailHeader;
    if (email) {
      if (!isEmailAllowed(email, env)) {
        return {
          authenticated: false,
          forbidden: true,
          email,
          authMode: "cloudflare-access",
          reason: `アカウント (${email}) は許可リストに含まれていません。`,
        };
      }
      return {
        authenticated: true,
        email,
        authMode: "cloudflare-access",
      };
    }
  } else if (cfEmailHeader && !env.CF_ACCESS_TEAM_DOMAIN) {
    if (!isEmailAllowed(cfEmailHeader, env)) {
      return {
        authenticated: false,
        forbidden: true,
        email: cfEmailHeader,
        authMode: "cloudflare-access",
        reason: `アカウント (${cfEmailHeader}) は許可リストに含まれていません。`,
      };
    }
    return {
      authenticated: true,
      email: cfEmailHeader,
      authMode: "cloudflare-access",
    };
  }

  // 2. Check signed session cookie from built-in Google Sign-In
  const sessionCookie = getCookie(request, SESSION_COOKIE_NAME);
  if (sessionCookie) {
    const sessionUser = await verifySessionToken(sessionCookie, env);
    if (sessionUser?.email) {
      if (!isEmailAllowed(sessionUser.email, env)) {
        return {
          authenticated: false,
          forbidden: true,
          email: sessionUser.email,
          authMode: "google-session",
          reason: `アカウント (${sessionUser.email}) は許可リストに含まれていません。`,
        };
      }
      return {
        authenticated: true,
        email: sessionUser.email,
        name: sessionUser.name,
        picture: sessionUser.picture,
        authMode: "google-session",
      };
    }
  }

  return {
    authenticated: false,
    authMode: "none",
  };
}

let schemaInitialized = false;

async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaInitialized) return;
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS chapters (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        height REAL NOT NULL,
        sort_order INTEGER NOT NULL,
        PRIMARY KEY (project_id, id)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        is_end INTEGER NOT NULL DEFAULT 0,
        branch_count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (project_id, id)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS edges (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_slot INTEGER NOT NULL,
        target_id TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (project_id, id)
      )
    `),
  ]);
  schemaInitialized = true;
}

async function saveFlowchartD1(db: D1Database, data: FlowchartData): Promise<FlowchartData> {
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO projects (id, name, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`
      )
      .bind(data.id, data.name, now),
    db.prepare("DELETE FROM chapters WHERE project_id = ?").bind(data.id),
    db.prepare("DELETE FROM nodes WHERE project_id = ?").bind(data.id),
    db.prepare("DELETE FROM edges WHERE project_id = ?").bind(data.id),
  ];

  for (let i = 0; i < data.chapters.length; i++) {
    const ch = data.chapters[i]!;
    statements.push(
      db
        .prepare(
          "INSERT INTO chapters (id, project_id, title, height, sort_order) VALUES (?, ?, ?, ?, ?)"
        )
        .bind(ch.id, data.id, ch.title, ch.height, i)
    );
  }

  for (const node of data.nodes) {
    statements.push(
      db
        .prepare(
          "INSERT INTO nodes (id, project_id, type, title, content, x, y, is_end, branch_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(
          node.id,
          data.id,
          node.type,
          node.title,
          node.content,
          node.x,
          node.y,
          node.type === "rect" && node.isEnd ? 1 : 0,
          node.branchCount ?? (node.type === "diamond" ? 2 : 1)
        )
    );
  }

  for (const edge of data.edges) {
    statements.push(
      db
        .prepare(
          "INSERT INTO edges (id, project_id, source_id, source_slot, target_id, label) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(
          edge.id,
          data.id,
          edge.sourceId,
          edge.sourceSlot,
          edge.targetId,
          edge.label ?? ""
        )
    );
  }

  await db.batch(statements);
  return { ...data, updatedAt: now };
}

async function getFlowchartD1(db: D1Database, projectId: string): Promise<FlowchartData | null> {
  const project = await db
    .prepare("SELECT id, name, updated_at as updatedAt FROM projects WHERE id = ?")
    .bind(projectId)
    .first<ProjectSummary>();

  if (!project) {
    if (projectId === "default") {
      const initial = createInitialFlowchart("default", "サンプルノベル企画");
      return await saveFlowchartD1(db, initial);
    }
    return null;
  }

  const chapterRes = await db
    .prepare(
      'SELECT id, title, height, sort_order as "order" FROM chapters WHERE project_id = ? ORDER BY sort_order ASC'
    )
    .bind(projectId)
    .all<ChapterLane>();

  const nodeRes = await db
    .prepare(
      "SELECT id, type, title, content, x, y, is_end, branch_count FROM nodes WHERE project_id = ?"
    )
    .bind(projectId)
    .all<{
      id: string;
      type: "rect" | "diamond";
      title: string;
      content: string;
      x: number;
      y: number;
      is_end: number;
      branch_count: number;
    }>();

  const nodes: FlowNode[] = nodeRes.results.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    content: r.content,
    x: r.x,
    y: r.y,
    ...(r.type === "rect" ? { isEnd: Boolean(r.is_end) } : {}),
    branchCount: r.branch_count ?? (r.type === "diamond" ? 2 : 1),
  }));

  const edgeRes = await db
    .prepare(
      "SELECT id, source_id as sourceId, source_slot as sourceSlot, target_id as targetId, label FROM edges WHERE project_id = ?"
    )
    .bind(projectId)
    .all<FlowEdge>();

  return {
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    chapters: chapterRes.results,
    nodes,
    edges: edgeRes.results,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 1. Auth Status Endpoint (/api/auth/me)
    if (url.pathname === "/api/auth/me" && request.method === "GET") {
      const auth = await authenticateRequest(request, env);
      return Response.json(
        {
          ...auth,
          googleClientId: env.GOOGLE_CLIENT_ID || null,
          hasCloudflareAccess: Boolean(env.CF_ACCESS_TEAM_DOMAIN),
        },
        { status: auth.authenticated ? 200 : auth.forbidden ? 403 : 401 }
      );
    }

    // 2. Built-in Google ID Token verification endpoint (/api/auth/google)
    if (url.pathname === "/api/auth/google" && request.method === "POST") {
      if (!env.GOOGLE_CLIENT_ID) {
        return Response.json(
          { error: "GOOGLE_CLIENT_ID is not configured" },
          { status: 400 }
        );
      }
      const body = (await request.json()) as { credential?: string };
      if (!body.credential) {
        return Response.json({ error: "Missing credential" }, { status: 400 });
      }

      // Verify ID token via Google's official tokeninfo endpoint
      const verifyRes = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(
          body.credential
        )}`
      );
      if (!verifyRes.ok) {
        return Response.json({ error: "Invalid Google ID token" }, { status: 401 });
      }

      const tokenInfo = (await verifyRes.json()) as {
        aud?: string;
        email?: string;
        email_verified?: string;
        name?: string;
        picture?: string;
      };

      if (
        tokenInfo.aud !== env.GOOGLE_CLIENT_ID ||
        tokenInfo.email_verified !== "true" ||
        !tokenInfo.email
      ) {
        return Response.json(
          { error: "Google token audience or email verification failed" },
          { status: 401 }
        );
      }

      if (!isEmailAllowed(tokenInfo.email, env)) {
        return Response.json(
          {
            authenticated: false,
            forbidden: true,
            email: tokenInfo.email,
            reason: `このGoogleアカウント (${tokenInfo.email}) にはアクセス権限がありません。`,
          },
          { status: 403 }
        );
      }

      const sessionToken = await createSessionToken(
        {
          email: tokenInfo.email,
          name: tokenInfo.name,
          picture: tokenInfo.picture,
        },
        env
      );

      return new Response(
        JSON.stringify({
          authenticated: true,
          email: tokenInfo.email,
          name: tokenInfo.name,
          picture: tokenInfo.picture,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": `${SESSION_COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${
              60 * 60 * 24 * 7
            }`,
          },
        }
      );
    }

    // 3. Logout endpoint (/api/auth/logout)
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      return new Response(JSON.stringify({ loggedOut: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
        },
      });
    }

    // 4. Protect all /api/* routes with Google authentication
    if (url.pathname.startsWith("/api/")) {
      const auth = await authenticateRequest(request, env);
      if (!auth.authenticated) {
        return Response.json(
          {
            error: auth.forbidden ? "Forbidden" : "Unauthorized",
            reason: auth.reason ?? "Google認証が必要です。",
          },
          { status: auth.forbidden ? 403 : 401 }
        );
      }

      const db = getDb(env);
      await ensureSchema(db);

      if (url.pathname === "/api/projects" && request.method === "GET") {
        const { results } = await db
          .prepare(
            "SELECT id, name, updated_at as updatedAt FROM projects ORDER BY updated_at DESC"
          )
          .all<ProjectSummary>();

        if (results.length === 0) {
          const initial = createInitialFlowchart("default", "サンプルノベル企画");
          const saved = await saveFlowchartD1(db, initial);
          return Response.json([
            {
              id: saved.id,
              name: saved.name,
              updatedAt: saved.updatedAt ?? new Date().toISOString(),
            },
          ]);
        }
        return Response.json(results);
      }

      if (url.pathname.startsWith("/api/flowchart/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/flowchart/".length));

        if (request.method === "GET") {
          const chart = await getFlowchartD1(db, id);
          if (!chart) {
            return Response.json({ error: "Not found" }, { status: 404 });
          }
          return Response.json(chart);
        }

        if (request.method === "PUT") {
          const body = (await request.json()) as FlowchartData;
          const saved = await saveFlowchartD1(db, {
            ...body,
            id: id || body.id || "default",
          });
          return Response.json(saved);
        }

        if (request.method === "DELETE") {
          await db.batch([
            db.prepare("DELETE FROM chapters WHERE project_id = ?").bind(id),
            db.prepare("DELETE FROM nodes WHERE project_id = ?").bind(id),
            db.prepare("DELETE FROM edges WHERE project_id = ?").bind(id),
            db.prepare("DELETE FROM projects WHERE id = ?").bind(id),
          ]);
          return Response.json({ deleted: true });
        }
      }
    }

    // Serve static frontend assets built in ./dist
    return env.ASSETS.fetch(request);
  },
};
