import { describe, expect, test } from "bun:test";
import { deleteProject, getFlowchart, listProjects, saveFlowchart } from "./db";
import { createMinimalFlowchart } from "./defaultData";

describe("SQLite Flowchart Persistence", () => {
  test("creates and retrieves a flowchart with rect/diamond branches and edge comments", () => {
    const testId = "test-proj-1";
    const chart = createMinimalFlowchart(testId, "テスト企画");

    // Set rectangle to have 2 branches
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

    // Clean up test project
    const deleted = deleteProject(testId);
    expect(deleted).toBe(true);
  });
});
