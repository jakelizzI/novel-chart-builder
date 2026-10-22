export type NodeType = "rect" | "diamond";

export interface ChapterLane {
  id: string;
  title: string;
  height: number;
  order: number;
}

export interface FlowNode {
  id: string;
  type: NodeType;
  title: string;
  content: string;
  x: number;
  y: number;
  /** 四角（節）ノード専用: ENDフラグ */
  isEnd?: boolean;
  /** 分岐先の個数（四角の場合はデフォルト1、ひし形の場合はデフォルト2） */
  branchCount?: number;
}

export interface FlowEdge {
  id: string;
  sourceId: string;
  /** 0 〜 (branchCount - 1) */
  sourceSlot: number;
  targetId: string;
  /** 分岐の線に表示するコメント（例：「SAN値が80以下の場合」） */
  label?: string;
}

export interface FlowchartData {
  id: string;
  name: string;
  chapters: ChapterLane[];
  nodes: FlowNode[];
  edges: FlowEdge[];
  updatedAt?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
}
