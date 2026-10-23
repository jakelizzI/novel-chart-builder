import { describe, expect, test } from "bun:test";
import { cloneFlowchart, deleteNodesFromChart, sortFlowchartLayout } from "./App";
import { deleteProject, getFlowchart, listProjects, saveFlowchart } from "./db";
import { createInitialFlowchart, createMinimalFlowchart } from "./defaultData";
import type { FlowchartData } from "./types";

describe("SQLite Flowchart Persistence & Auto-Sort Layout", () => {
  test("creates and retrieves a flowchart with rect/diamond branches and edge comments", () => {
    const testId = "test-proj-1";
    const chart = createMinimalFlowchart(testId, "テスト企画");

    chart.nodes[0]!.branchCount = 2;

    chart.nodes.push({
      id: "node-branch-1",
      type: "diamond",
      title: "テスト分岐",
      content: "選択肢A / 選択肢B",
      x: 520,
      y: 280,
      branchCount: 3,
    });

    chart.edges.push({
      id: "edge-test-1",
      sourceId: "node-start",
      sourceSlot: 0,
      targetId: "node-branch-1",
      label: "SAN値が80以下の場合",
    });

    saveFlowchart(chart);

    const loaded = getFlowchart(testId);
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe("テスト企画");
    expect(loaded?.chapters.length).toBe(2);
    expect(loaded?.nodes.length).toBe(2);

    const rect = loaded?.nodes.find((n) => n.id === "node-start");
    expect(rect?.type).toBe("rect");
    expect(rect?.branchCount).toBe(2);

    const diamond = loaded?.nodes.find((n) => n.id === "node-branch-1");
    expect(diamond?.type).toBe("diamond");
    expect(diamond?.branchCount).toBe(3);

    expect(loaded?.edges.length).toBe(1);
    expect(loaded?.edges[0]?.targetId).toBe("node-branch-1");
    expect(loaded?.edges[0]?.label).toBe("SAN値が80以下の場合");

    const projects = listProjects();
    expect(projects.some((p) => p.id === testId)).toBe(true);

    const deleted = deleteProject(testId);
    expect(deleted).toBe(true);
  });

  test("sortFlowchartLayout prevents skip-level edge (導入 -> 3節) from hiding behind 2節 (導入 -> 2節 -> 3節)", () => {
    const chart: FlowchartData = {
      id: "test-sort",
      name: "スキップ接続テスト",
      chapters: [{ id: "c1", title: "第1章", height: 600, order: 0 }],
      nodes: [
        { id: "n1", type: "rect", title: "導入", content: "", x: 520, y: 100, branchCount: 2 },
        { id: "n2", type: "rect", title: "2節", content: "", x: 520, y: 280, branchCount: 1 },
        { id: "n3", type: "rect", title: "3節", content: "", x: 520, y: 460, branchCount: 1 },
      ],
      edges: [
        { id: "e1", sourceId: "n1", sourceSlot: 0, targetId: "n2" },
        { id: "e2", sourceId: "n2", sourceSlot: 0, targetId: "n3" },
        { id: "e3", sourceId: "n1", sourceSlot: 1, targetId: "n3" },
      ],
    };

    const sorted = sortFlowchartLayout(chart);
    const n1 = sorted.nodes.find((n) => n.id === "n1")!;
    const n2 = sorted.nodes.find((n) => n.id === "n2")!;
    const n3 = sorted.nodes.find((n) => n.id === "n3")!;

    expect(n1.y).toBeLessThan(n2.y);
    expect(n2.y).toBeLessThan(n3.y);

    const lineXAtN2 = n1.x + (n3.x - n1.x) * ((n2.y - n1.y) / (n3.y - n1.y));
    expect(Math.abs(n2.x - lineXAtN2)).toBeGreaterThanOrEqual(150);
  });

  test("bulk node deletion removes selected nodes and incident edges, and snapshot restores all data", () => {
    const original = createInitialFlowchart("test-bulk", "一括削除テスト");
    const snapshot = cloneFlowchart(original);

    // Bulk delete node-3 and node-5
    const afterDelete = deleteNodesFromChart(original, ["node-3", "node-5"]);
    expect(afterDelete.nodes.length).toBe(original.nodes.length - 2);
    expect(afterDelete.nodes.some((n) => n.id === "node-3")).toBe(false);
    expect(afterDelete.nodes.some((n) => n.id === "node-5")).toBe(false);
    // Incident edges to node-3 or node-5 are also removed
    expect(
      afterDelete.edges.some(
        (e) =>
          e.sourceId === "node-3" ||
          e.targetId === "node-3" ||
          e.sourceId === "node-5" ||
          e.targetId === "node-5"
      )
    ).toBe(false);

    // Undo snapshot remains completely intact with all nodes, edges, and labels
    expect(snapshot.nodes.length).toBe(6);
    expect(snapshot.edges.length).toBe(5);
    expect(snapshot.edges.find((e) => e.id === "edge-3")?.label).toBe("SAN値が80以下の場合");
  });
});
