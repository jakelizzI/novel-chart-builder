import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { createInitialFlowchart } from "./defaultData";
import type { ChapterLane, FlowchartData, FlowEdge, FlowNode, ProjectSummary } from "./types";

mkdirSync("data", { recursive: true });

const db = new Database("data/flowchart.sqlite", { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chapters (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    height REAL NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (project_id, id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    is_end INTEGER NOT NULL DEFAULT 0,
    branch_count INTEGER NOT NULL DEFAULT 2,
    PRIMARY KEY (project_id, id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS edges (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_slot INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    PRIMARY KEY (project_id, id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
`);

export function listProjects(): ProjectSummary[] {
  const rows = db
    .query("SELECT id, name, updated_at as updatedAt FROM projects ORDER BY updated_at DESC")
    .all() as ProjectSummary[];

  if (rows.length === 0) {
    const initial = createInitialFlowchart("default", "サンプルノベル企画");
    saveFlowchart(initial);
    return [
      {
        id: initial.id,
        name: initial.name,
        updatedAt: new Date().toISOString(),
      },
    ];
  }
  return rows;
}

export function getFlowchart(projectId: string): FlowchartData | null {
  const project = db
    .query("SELECT id, name, updated_at as updatedAt FROM projects WHERE id = ?")
    .get(projectId) as ProjectSummary | null;

  if (!project) {
    if (projectId === "default") {
      const initial = createInitialFlowchart("default", "サンプルノベル企画");
      saveFlowchart(initial);
      return initial;
    }
    return null;
  }

  const chapterRows = db
    .query(
      "SELECT id, title, height, sort_order as \"order\" FROM chapters WHERE project_id = ? ORDER BY sort_order ASC"
    )
    .all(projectId) as ChapterLane[];

  const nodeRows = db
    .query(
      "SELECT id, type, title, content, x, y, is_end, branch_count FROM nodes WHERE project_id = ?"
    )
    .all(projectId) as Array<{
    id: string;
    type: "rect" | "diamond";
    title: string;
    content: string;
    x: number;
    y: number;
    is_end: number;
    branch_count: number;
  }>;

  const nodes: FlowNode[] = nodeRows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    content: r.content,
    x: r.x,
    y: r.y,
    ...(r.type === "rect" ? { isEnd: Boolean(r.is_end) } : {}),
    ...(r.type === "diamond" ? { branchCount: r.branch_count } : {}),
  }));

  const edges = db
    .query(
      "SELECT id, source_id as sourceId, source_slot as sourceSlot, target_id as targetId FROM edges WHERE project_id = ?"
    )
    .all(projectId) as FlowEdge[];

  return {
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    chapters: chapterRows,
    nodes,
    edges,
  };
}

const saveTx = db.transaction((data: FlowchartData, now: string) => {
  db.query(
    `INSERT INTO projects (id, name, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`
  ).run(data.id, data.name, now);

  db.query("DELETE FROM chapters WHERE project_id = ?").run(data.id);
  db.query("DELETE FROM nodes WHERE project_id = ?").run(data.id);
  db.query("DELETE FROM edges WHERE project_id = ?").run(data.id);

  const insertChapter = db.query(
    "INSERT INTO chapters (id, project_id, title, height, sort_order) VALUES (?, ?, ?, ?, ?)"
  );
  for (let i = 0; i < data.chapters.length; i++) {
    const ch = data.chapters[i]!;
    insertChapter.run(ch.id, data.id, ch.title, ch.height, i);
  }

  const insertNode = db.query(
    "INSERT INTO nodes (id, project_id, type, title, content, x, y, is_end, branch_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const node of data.nodes) {
    insertNode.run(
      node.id,
      data.id,
      node.type,
      node.title,
      node.content,
      node.x,
      node.y,
      node.type === "rect" && node.isEnd ? 1 : 0,
      node.type === "diamond" ? (node.branchCount ?? 2) : 1
    );
  }

  const insertEdge = db.query(
    "INSERT INTO edges (id, project_id, source_id, source_slot, target_id) VALUES (?, ?, ?, ?, ?)"
  );
  for (const edge of data.edges) {
    insertEdge.run(edge.id, data.id, edge.sourceId, edge.sourceSlot, edge.targetId);
  }
});

export function saveFlowchart(data: FlowchartData): FlowchartData {
  const now = new Date().toISOString();
  saveTx(data, now);
  return {
    ...data,
    updatedAt: now,
  };
}

export function deleteProject(projectId: string): boolean {
  const res = db.query("DELETE FROM projects WHERE id = ?").run(projectId);
  return res.changes > 0;
}
