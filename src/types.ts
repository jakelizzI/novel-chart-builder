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
  /** ひし形（分岐）ノード専用: 分岐先の個数 */
  branchCount?: number;
}

export interface FlowEdge {
  id: string;
  sourceId: string;
  /** 四角の場合は常に 0、ひし形の場合は 0 〜 (branchCount - 1) */
  sourceSlot: number;
  targetId: string;
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
