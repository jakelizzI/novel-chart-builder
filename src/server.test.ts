import { describe, expect, test } from "bun:test";
import {
  advanceRouteUntilBranch,
  cloneFlowchart,
  deleteNodesFromChart,
  evaluateRouteVariables,
  moveNodesInChart,
  sortFlowchartLayout,
} from "./App";
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

    const afterDelete = deleteNodesFromChart(original, ["node-3", "node-5"]);
    expect(afterDelete.nodes.length).toBe(original.nodes.length - 2);
    expect(afterDelete.nodes.some((n) => n.id === "node-3")).toBe(false);
    expect(afterDelete.nodes.some((n) => n.id === "node-5")).toBe(false);
    expect(
      afterDelete.edges.some(
        (e) =>
          e.sourceId === "node-3" ||
          e.targetId === "node-3" ||
          e.sourceId === "node-5" ||
          e.targetId === "node-5"
      )
    ).toBe(false);

    expect(snapshot.nodes.length).toBe(6);
    expect(snapshot.edges.length).toBe(5);
    expect(snapshot.edges.find((e) => e.id === "edge-3")?.label).toBe("SAN値が80以下の場合");
  });

  test("moveNodesInChart moves multiple selected nodes together preserving relative distances even at boundaries", () => {
    const original = createInitialFlowchart("test-move", "グループ移動テスト");
    const n3Orig = original.nodes.find((n) => n.id === "node-3")!;
    const n4Orig = original.nodes.find((n) => n.id === "node-4")!;
    const origDeltaX = n4Orig.x - n3Orig.x;
    const origDeltaY = n4Orig.y - n3Orig.y;

    const origPositions = new Map<string, { x: number; y: number }>([
      ["node-3", { x: n3Orig.x, y: n3Orig.y }],
      ["node-4", { x: n4Orig.x, y: n4Orig.y }],
    ]);

    // Move right by 120px, down by 80px
    const moved = moveNodesInChart(original, origPositions, 120, 80);
    const n3Moved = moved.nodes.find((n) => n.id === "node-3")!;
    const n4Moved = moved.nodes.find((n) => n.id === "node-4")!;
    expect(n3Moved.x).toBe(n3Orig.x + 120);
    expect(n3Moved.y).toBe(n3Orig.y + 80);
    expect(n4Moved.x - n3Moved.x).toBe(origDeltaX);
    expect(n4Moved.y - n3Moved.y).toBe(origDeltaY);

    // Move far past top-left boundary (-2000, -2000) and verify relative distance is still preserved
    const clamped = moveNodesInChart(original, origPositions, -2000, -2000);
    const n3Clamped = clamped.nodes.find((n) => n.id === "node-3")!;
    const n4Clamped = clamped.nodes.find((n) => n.id === "node-4")!;
    expect(n4Clamped.x - n3Clamped.x).toBe(origDeltaX);
    expect(n4Clamped.y - n3Clamped.y).toBe(origDeltaY);
  });

  test("persists variables (string, number, boolean) and evaluates route variable changes across branches", () => {
    const testId = "test-vars-route";
    const chart = createInitialFlowchart(testId, "変数・ルート検証企画");

    saveFlowchart(chart);
    const loaded = getFlowchart(testId)!;
    expect(loaded).not.toBeNull();
    expect(loaded.variables?.length).toBe(3);

    // 1. Start at node-1: auto-advances to first diamond (node-2)
    const step1 = advanceRouteUntilBranch(loaded, ["node-1"], []);
    expect(step1.nodeIds).toEqual(["node-1", "node-2"]);
    expect(step1.edgeIds).toEqual(["edge-1"]);

    // 2. Choose Branch 0 (edge-2: 左の扉へ -> node-3 -> auto-advances to node-5)
    const afterLeftBranch = advanceRouteUntilBranch(
      loaded,
      [...step1.nodeIds, "node-3"],
      [...step1.edgeIds, "edge-2"]
    );
    expect(afterLeftBranch.nodeIds).toEqual(["node-1", "node-2", "node-3", "node-5"]);
    expect(afterLeftBranch.edgeIds).toEqual(["edge-1", "edge-2", "edge-4"]);

    const evalLeft = evaluateRouteVariables(
      loaded,
      afterLeftBranch.nodeIds,
      afterLeftBranch.edgeIds
    );
    const keyVar = evalLeft.variableStates.find((v) => v.variable.id === "var-key")!;
    const routeVar = evalLeft.variableStates.find((v) => v.variable.id === "var-route")!;
    const sanVar = evalLeft.variableStates.find((v) => v.variable.id === "var-san")!;
    expect(keyVar.currentValue).toBe(true);
    expect(keyVar.isChanged).toBe(true);
    expect(routeVar.currentValue).toBe("書斎ルート");
    expect(sanVar.currentValue).toBe(100);

    // 3. Alternatively, from step1 choose Branch 1 (edge-3: 右の扉へ -> node-4)
    const afterRightBranch = advanceRouteUntilBranch(
      loaded,
      [...step1.nodeIds, "node-4"],
      [...step1.edgeIds, "edge-3"]
    );
    const evalRight = evaluateRouteVariables(
      loaded,
      afterRightBranch.nodeIds,
      afterRightBranch.edgeIds
    );
    const sanRight = evalRight.variableStates.find((v) => v.variable.id === "var-san")!;
    const routeRight = evalRight.variableStates.find((v) => v.variable.id === "var-route")!;
    const keyRight = evalRight.variableStates.find((v) => v.variable.id === "var-key")!;
    // Branch 1 on node-2 subtracts 20, and entering node-4 subtracts 15 => 100 - 20 - 15 = 65
    expect(sanRight.currentValue).toBe(65);
    expect(routeRight.currentValue).toBe("地下室ルート");
    expect(keyRight.currentValue).toBe(false);

    deleteProject(testId);
  });
});
