export type NodeType = "rect" | "diamond";

export type VariableType = "string" | "number" | "boolean";

export interface FlowchartVariable {
  id: string;
  name: string;
  type: VariableType;
  defaultValue: string | number | boolean;
}

export type VariableEffectOp = "set" | "add" | "subtract" | "toggle";

export interface VariableEffect {
  id: string;
  variableId: string;
  /**
   * 操作種別:
   * - "set": 代入 (=) — string / number / boolean
   * - "add": 加算 (+=) — number
   * - "subtract": 減算 (-=) — number
   * - "toggle": 反転 (!) — boolean
   */
  op: VariableEffectOp;
  value: string | number | boolean;
  /**
   * 特定の分岐スロットを進んだ時のみ適用する場合は 0 以上のスロット番号。
   * null または undefined の場合は、この図形（節・分岐）を通過した時点で適用。
   */
  branchSlot?: number | null;
}

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
  /** この図形（四角・ひし形）で発生するフラグ・変数の変更リスト */
  effects?: VariableEffect[];
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
  /** プロジェクト内で定義されたフラグ・変数一覧 */
  variables?: FlowchartVariable[];
  updatedAt?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
}
