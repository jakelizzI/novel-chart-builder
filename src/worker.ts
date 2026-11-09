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
  DB: D1Database;
  ASSETS: Fetcher;
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

    if (url.pathname === "/api/projects" && request.method === "GET") {
      await ensureSchema(env.DB);
      const { results } = await env.DB.prepare(
        "SELECT id, name, updated_at as updatedAt FROM projects ORDER BY updated_at DESC"
      ).all<ProjectSummary>();

      if (results.length === 0) {
        const initial = createInitialFlowchart("default", "サンプルノベル企画");
        const saved = await saveFlowchartD1(env.DB, initial);
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
      await ensureSchema(env.DB);
      const id = decodeURIComponent(url.pathname.slice("/api/flowchart/".length));

      if (request.method === "GET") {
        const chart = await getFlowchartD1(env.DB, id);
        if (!chart) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        return Response.json(chart);
      }

      if (request.method === "PUT") {
        const body = (await request.json()) as FlowchartData;
        const saved = await saveFlowchartD1(env.DB, {
          ...body,
          id: id || body.id || "default",
        });
        return Response.json(saved);
      }

      if (request.method === "DELETE") {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM chapters WHERE project_id = ?").bind(id),
          env.DB.prepare("DELETE FROM nodes WHERE project_id = ?").bind(id),
          env.DB.prepare("DELETE FROM edges WHERE project_id = ?").bind(id),
          env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id),
        ]);
        return Response.json({ deleted: true });
      }
    }

    // Serve static frontend assets built in ./dist
    return env.ASSETS.fetch(request);
  },
};
