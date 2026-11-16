import React, { useEffect, useMemo, useRef, useState } from "react";
import { createInitialFlowchart, createMinimalFlowchart } from "./defaultData";
import type {
  ChapterLane,
  FlowchartData,
  FlowchartVariable,
  FlowEdge,
  FlowNode,
  NodeType,
  ProjectSummary,
  VariableEffect,
  VariableEffectOp,
  VariableType,
} from "./types";

const RECT_WIDTH = 210;
const RECT_HEIGHT = 76;
const DIAMOND_WIDTH = 220;
const DIAMOND_HEIGHT = 112;
const PLUS_OFFSET_Y = 38;
const PLUS_RADIUS = 13;
const CHAPTER_HEADER_WIDTH = 240;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.0;
const ZOOM_STEP = 0.1;
const MAX_UNDO_HISTORY = 50;
const LOCAL_STORAGE_KEY = "novel-chart-builder:current";

interface ActivePlusMenu {
  nodeId: string;
  slot: number;
  x: number;
  y: number;
}

interface MergeModeState {
  sourceId: string;
  sourceSlot: number;
}

interface MarqueeSelectionState {
  startX: number;
  startY: number;
  currX: number;
  currY: number;
  additive: boolean;
  initialSelectedIds: string[];
  hasDragged: boolean;
}

export interface VariableChangeLogItem {
  stepIndex: number;
  nodeId: string;
  nodeTitle: string;
  variableId: string;
  variableName: string;
  prevValue: string | number | boolean;
  nextValue: string | number | boolean;
  op: VariableEffectOp;
  branchSlot?: number | null;
}

export interface EvaluatedVariableState {
  variable: FlowchartVariable;
  currentValue: string | number | boolean;
  isChanged: boolean;
  history: VariableChangeLogItem[];
}

export interface RouteEvaluationResult {
  variableStates: EvaluatedVariableState[];
  stepChanges: Map<number, VariableChangeLogItem[]>;
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
}

export function cloneFlowchart(chart: FlowchartData): FlowchartData {
  return {
    ...chart,
    variables: (chart.variables ?? []).map((v) => ({ ...v })),
    chapters: chart.chapters.map((c) => ({ ...c })),
    nodes: chart.nodes.map((n) => ({
      ...n,
      effects: (n.effects ?? []).map((eff) => ({ ...eff })),
    })),
    edges: chart.edges.map((e) => ({ ...e })),
  };
}

export function applyVariableEffect(
  varDef: FlowchartVariable,
  currentVal: string | number | boolean,
  eff: VariableEffect
): string | number | boolean {
  if (varDef.type === "number") {
    const curr = Number(currentVal) || 0;
    const operand = Number(eff.value) || 0;
    if (eff.op === "add") return curr + operand;
    if (eff.op === "subtract") return curr - operand;
    return operand;
  }
  if (varDef.type === "boolean") {
    if (eff.op === "toggle") return !Boolean(currentVal);
    return eff.value === true || eff.value === "true";
  }
  return String(eff.value ?? "");
}

export function formatEffectSummary(
  eff: VariableEffect,
  varDef: FlowchartVariable | undefined
): string {
  const varName = varDef?.name || "未設定変数";
  const prefix =
    eff.branchSlot !== null && eff.branchSlot !== undefined
      ? `[分岐${eff.branchSlot + 1}] `
      : "";
  if (eff.op === "add") {
    return `${prefix}${varName} +${eff.value}`;
  }
  if (eff.op === "subtract") {
    return `${prefix}${varName} -${eff.value}`;
  }
  if (eff.op === "toggle") {
    return `${prefix}${varName} 反転`;
  }
  return `${prefix}${varName} = ${String(eff.value)}`;
}

export function evaluateRouteVariables(
  chart: FlowchartData,
  routeNodeIds: string[],
  routeEdgeIds: string[]
): RouteEvaluationResult {
  const variables = chart.variables ?? [];
  const varMap = new Map<string, FlowchartVariable>();
  const currentValues = new Map<string, string | number | boolean>();
  const historyByVar = new Map<string, VariableChangeLogItem[]>();

  for (const v of variables) {
    varMap.set(v.id, v);
    currentValues.set(v.id, v.defaultValue);
    historyByVar.set(v.id, []);
  }

  const nodeMap = new Map<string, FlowNode>();
  for (const n of chart.nodes) {
    nodeMap.set(n.id, n);
  }

  const edgeMap = new Map<string, FlowEdge>();
  for (const e of chart.edges) {
    edgeMap.set(e.id, e);
  }

  const stepChanges = new Map<number, VariableChangeLogItem[]>();

  for (let i = 0; i < routeNodeIds.length; i++) {
    const nodeId = routeNodeIds[i]!;
    const node = nodeMap.get(nodeId);
    if (!node) continue;

    const outgoingEdge = i < routeEdgeIds.length ? edgeMap.get(routeEdgeIds[i]!) : undefined;
    const chosenSlot =
      outgoingEdge && outgoingEdge.sourceId === node.id ? outgoingEdge.sourceSlot : null;

    const nodeEffects = node.effects ?? [];
    const changesAtStep: VariableChangeLogItem[] = [];

    for (const eff of nodeEffects) {
      // ひし形（分岐）自体には変数処理は無く、選択した分岐（chosenSlot）に対する変更のみ適用
      const isNodeLevel =
        node.type === "rect" &&
        (eff.branchSlot === null || eff.branchSlot === undefined);
      const isChosenBranchLevel =
        eff.branchSlot !== null &&
        eff.branchSlot !== undefined &&
        chosenSlot !== null &&
        eff.branchSlot === chosenSlot;

      if (!isNodeLevel && !isChosenBranchLevel) continue;

      const varDef = varMap.get(eff.variableId);
      if (!varDef) continue;

      const prevValue = currentValues.get(varDef.id) ?? varDef.defaultValue;
      const nextValue = applyVariableEffect(varDef, prevValue, eff);
      currentValues.set(varDef.id, nextValue);

      const logItem: VariableChangeLogItem = {
        stepIndex: i,
        nodeId: node.id,
        nodeTitle: node.title || "（無題）",
        variableId: varDef.id,
        variableName: varDef.name,
        prevValue,
        nextValue,
        op: eff.op,
        branchSlot: eff.branchSlot ?? null,
      };
      changesAtStep.push(logItem);
      historyByVar.get(varDef.id)?.push(logItem);
    }

    if (changesAtStep.length > 0) {
      stepChanges.set(i, changesAtStep);
    }
  }

  const variableStates: EvaluatedVariableState[] = variables.map((v) => {
    const currentValue = currentValues.get(v.id) ?? v.defaultValue;
    return {
      variable: v,
      currentValue,
      isChanged: currentValue !== v.defaultValue,
      history: historyByVar.get(v.id) ?? [],
    };
  });

  return {
    variableStates,
    stepChanges,
  };
}

export function findDefaultStartNodeId(chart: FlowchartData): string | null {
  if (chart.nodes.length === 0) return null;
  const incomingCount = new Map<string, number>();
  for (const n of chart.nodes) {
    incomingCount.set(n.id, 0);
  }
  for (const e of chart.edges) {
    if (incomingCount.has(e.targetId) && incomingCount.has(e.sourceId)) {
      incomingCount.set(e.targetId, (incomingCount.get(e.targetId) ?? 0) + 1);
    }
  }
  const roots = chart.nodes
    .filter((n) => (incomingCount.get(n.id) ?? 0) === 0)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  if (roots.length > 0) {
    return roots[0]!.id;
  }
  const sorted = [...chart.nodes].sort((a, b) => a.y - b.y || a.x - b.x);
  return sorted[0]?.id ?? null;
}

export function advanceRouteUntilBranch(
  chart: FlowchartData,
  initialNodeIds: string[],
  initialEdgeIds: string[],
  preferredChoices?: Readonly<Record<string, number>>
): { nodeIds: string[]; edgeIds: string[] } {
  const nodeIds = [...initialNodeIds];
  const edgeIds = [...initialEdgeIds];
  if (nodeIds.length === 0) return { nodeIds, edgeIds };

  const nodeMap = new Map<string, FlowNode>();
  for (const n of chart.nodes) {
    nodeMap.set(n.id, n);
  }

  const visitedInAutoAdvance = new Set<string>(nodeIds);

  while (nodeIds.length > 0) {
    const currentId = nodeIds[nodeIds.length - 1]!;
    const currentNode = nodeMap.get(currentId);
    if (!currentNode) break;
    if (currentNode.type === "rect" && currentNode.isEnd) break;

    const slotCount =
      currentNode.type === "diamond"
        ? Math.max(1, currentNode.branchCount ?? 2)
        : Math.max(1, currentNode.branchCount ?? 1);

    if (slotCount > 1) {
      // If user previously chose a branch at this node (e.g. when switching an earlier branch),
      // automatically follow that remembered branch choice if it is connected!
      const preferredSlot = preferredChoices?.[currentId];
      if (preferredSlot === undefined) break;

      const rememberedEdge = chart.edges.find(
        (e) =>
          e.sourceId === currentId &&
          e.sourceSlot === preferredSlot &&
          nodeMap.has(e.targetId)
      );
      if (!rememberedEdge || visitedInAutoAdvance.has(rememberedEdge.targetId)) {
        break;
      }
      visitedInAutoAdvance.add(rememberedEdge.targetId);
      edgeIds.push(rememberedEdge.id);
      nodeIds.push(rememberedEdge.targetId);
      continue;
    }

    const outgoingEdges = chart.edges.filter(
      (e) =>
        e.sourceId === currentId &&
        e.sourceSlot === 0 &&
        nodeMap.has(e.targetId)
    );
    if (outgoingEdges.length !== 1) break;

    const nextEdge = outgoingEdges[0]!;
    if (visitedInAutoAdvance.has(nextEdge.targetId)) break;

    visitedInAutoAdvance.add(nextEdge.targetId);
    edgeIds.push(nextEdge.id);
    nodeIds.push(nextEdge.targetId);
  }

  return { nodeIds, edgeIds };
}

/**
 * Switches the branch choice at `stepIdx` (where `routeNodeIds[stepIdx]` is `newEdge.sourceId`)
 * without requiring the user to start over from the root, while remembering downstream choices.
 */
export function switchRouteBranchAtStep(
  chart: FlowchartData,
  routeNodeIds: string[],
  routeEdgeIds: string[],
  stepIdx: number,
  newEdge: FlowEdge,
  existingChoices: Readonly<Record<string, number>> = {}
): {
  nodeIds: string[];
  edgeIds: string[];
  updatedChoices: Record<string, number>;
} {
  const updatedChoices: Record<string, number> = { ...existingChoices };
  // Record all currently active branch choices along the route first
  for (let i = 0; i < routeEdgeIds.length && i < routeNodeIds.length; i++) {
    const e = chart.edges.find((item) => item.id === routeEdgeIds[i]);
    if (e) {
      updatedChoices[e.sourceId] = e.sourceSlot;
    }
  }
  // Override the branch choice at stepIdx
  updatedChoices[newEdge.sourceId] = newEdge.sourceSlot;

  const prefixNodes = routeNodeIds.slice(0, stepIdx + 1);
  const prefixEdges = routeEdgeIds.slice(0, stepIdx);

  const nextNodes = [...prefixNodes, newEdge.targetId];
  const nextEdges = [...prefixEdges, newEdge.id];

  const advanced = advanceRouteUntilBranch(chart, nextNodes, nextEdges, updatedChoices);
  return {
    nodeIds: advanced.nodeIds,
    edgeIds: advanced.edgeIds,
    updatedChoices,
  };
}

export function deleteNodesFromChart(
  chart: FlowchartData,
  nodeIdsToRemove: Iterable<string>
): FlowchartData {
  const removeSet = new Set(nodeIdsToRemove);
  if (removeSet.size === 0) return chart;
  return {
    ...chart,
    nodes: chart.nodes.filter((n) => !removeSet.has(n.id)),
    edges: chart.edges.filter(
      (e) => !removeSet.has(e.sourceId) && !removeSet.has(e.targetId)
    ),
  };
}

/**
 * Moves one or multiple nodes by (rawDx, rawDy) while strictly preserving
 * their relative positions even when hitting the left/top canvas bounds.
 */
export function moveNodesInChart(
  chart: FlowchartData,
  origPositions: ReadonlyMap<string, { x: number; y: number }>,
  rawDx: number,
  rawDy: number
): FlowchartData {
  if (origPositions.size === 0) return chart;

  let minOrigX = Infinity;
  let minOrigY = Infinity;
  for (const pos of origPositions.values()) {
    if (pos.x < minOrigX) minOrigX = pos.x;
    if (pos.y < minOrigY) minOrigY = pos.y;
  }

  const minAllowedX = CHAPTER_HEADER_WIDTH + 120;
  const minAllowedY = 55;

  // Clamp group delta as a single vector so relative offsets between selected nodes never distort
  const clampedDx = Math.round(Math.max(minAllowedX - minOrigX, rawDx));
  const clampedDy = Math.round(Math.max(minAllowedY - minOrigY, rawDy));

  let maxMovedY = 0;
  const nextNodes = chart.nodes.map((n) => {
    const orig = origPositions.get(n.id);
    if (!orig) return n;
    const nextX = orig.x + clampedDx;
    const nextY = orig.y + clampedDy;
    if (nextY > maxMovedY) maxMovedY = nextY;
    return { ...n, x: nextX, y: nextY };
  });

  // Expand bottom chapter lane if moved nodes extend past current total chapter height
  const totalH = chart.chapters.reduce((sum, c) => sum + c.height, 0);
  let updatedChapters = chart.chapters;
  if (maxMovedY + 120 > totalH && chart.chapters.length > 0) {
    const extra = maxMovedY + 120 - totalH;
    updatedChapters = chart.chapters.map((c, idx) =>
      idx === chart.chapters.length - 1 ? { ...c, height: c.height + extra } : c
    );
  }

  return {
    ...chart,
    chapters: updatedChapters,
    nodes: nextNodes,
  };
}

function getNodeSlotCount(node: FlowNode): number {
  if (node.type === "rect") {
    if (node.isEnd) return 0;
    return Math.max(1, node.branchCount ?? 1);
  }
  return Math.max(1, node.branchCount ?? 2);
}

function getNodeTopPoint(node: FlowNode): { x: number; y: number } {
  const halfH = node.type === "rect" ? RECT_HEIGHT / 2 : DIAMOND_HEIGHT / 2;
  return { x: node.x, y: node.y - halfH };
}

function getNodeBottomPoint(node: FlowNode): { x: number; y: number } {
  const halfH = node.type === "rect" ? RECT_HEIGHT / 2 : DIAMOND_HEIGHT / 2;
  return { x: node.x, y: node.y + halfH };
}

function getSlotPlusPosition(node: FlowNode, slot: number): { x: number; y: number } {
  const bottom = getNodeBottomPoint(node);
  const count = getNodeSlotCount(node);
  if (count <= 1) {
    return { x: bottom.x, y: bottom.y + PLUS_OFFSET_Y };
  }
  const spacing = count <= 3 ? 64 : count <= 5 ? 50 : 40;
  const offsetX = (slot - (count - 1) / 2) * spacing;
  return { x: bottom.x + offsetX, y: bottom.y + PLUS_OFFSET_Y };
}

/**
 * Compute cubic Bezier path and midpoint for an edge, automatically detouring
 * around any intermediate nodes that would otherwise hide the line.
 */
function computeEdgeGeometry(
  edge: FlowEdge,
  sourceNode: FlowNode,
  targetNode: FlowNode,
  allNodes: FlowNode[]
): { pathD: string; midX: number; midY: number } {
  const startPos = getSlotPlusPosition(sourceNode, edge.sourceSlot);
  const sx = startPos.x;
  const sy = startPos.y + PLUS_RADIUS;
  const endPos = getNodeTopPoint(targetNode);
  const tx = endPos.x;
  const ty = endPos.y;

  const dy = ty - sy;
  const minY = Math.min(sy, ty);
  const maxY = Math.max(sy, ty);

  const obstacles = allNodes.filter((n) => {
    if (n.id === sourceNode.id || n.id === targetNode.id) return false;
    return n.y > minY + 15 && n.y < maxY - 15;
  });

  let cx1 = sx;
  let cy1 = dy >= 10 ? sy + Math.max(45, Math.abs(dy) * 0.45) : sy + 70;
  let cx2 = tx;
  let cy2 = dy >= 10 ? ty - Math.max(45, Math.abs(dy) * 0.45) : ty - 70;

  for (const obs of obstacles) {
    const ratio = (obs.y - sy) / (ty - sy || 1);
    const lineXAtObs = sx + (tx - sx) * ratio;
    const dist = lineXAtObs - obs.x;
    const clearance = (obs.type === "diamond" ? DIAMOND_WIDTH : RECT_WIDTH) / 2 + 45;

    if (Math.abs(dist) < clearance) {
      const dir =
        Math.abs(dist) > 4
          ? Math.sign(dist)
          : edge.sourceSlot > 0
          ? 1
          : -1;
      const desiredMidX = obs.x + dir * (clearance + 25);
      const controlX = (desiredMidX - 0.125 * (sx + tx)) / 0.75;
      cx1 = controlX;
      cx2 = controlX;
      cy1 = sy + (ty - sy) * 0.3;
      cy2 = sy + (ty - sy) * 0.7;
    }
  }

  const pathD = `M ${sx} ${sy} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${tx} ${ty}`;
  const midX = 0.125 * sx + 0.375 * cx1 + 0.375 * cx2 + 0.125 * tx;
  const midY = 0.125 * sy + 0.375 * cy1 + 0.375 * cy2 + 0.125 * ty;

  return { pathD, midX, midY };
}

/**
 * Hierarchical DAG Auto-Sort (Sugiyama-style with dummy pass-through nodes
 * and explicit line-vs-node collision avoidance so skip-level edges never hide behind nodes).
 */
export function sortFlowchartLayout(prev: FlowchartData): FlowchartData {
  if (prev.nodes.length === 0) return prev;

  const validIds = new Set(prev.nodes.map((n) => n.id));
  const validEdges = prev.edges.filter(
    (e) => validIds.has(e.sourceId) && validIds.has(e.targetId) && e.sourceId !== e.targetId
  );

  const inDegree = new Map<string, number>();
  const outEdges = new Map<string, FlowEdge[]>();

  for (const n of prev.nodes) {
    inDegree.set(n.id, 0);
    outEdges.set(n.id, []);
  }

  for (const e of validEdges) {
    inDegree.set(e.targetId, (inDegree.get(e.targetId) ?? 0) + 1);
    outEdges.get(e.sourceId)?.push(e);
  }

  for (const list of outEdges.values()) {
    list.sort((a, b) => a.sourceSlot - b.sourceSlot);
  }

  let roots = prev.nodes
    .filter((n) => (inDegree.get(n.id) ?? 0) === 0)
    .sort((a, b) => a.y - b.y || a.x - b.x);

  if (roots.length === 0) {
    const sortedByY = [...prev.nodes].sort((a, b) => a.y - b.y || a.x - b.x);
    roots = [sortedByY[0]!];
  }

  const layerMap = new Map<string, number>();
  const queue: Array<{ id: string; depth: number; path: Set<string> }> = [];

  for (const r of roots) {
    layerMap.set(r.id, 0);
    queue.push({ id: r.id, depth: 0, path: new Set([r.id]) });
  }

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const edgesFromCurr = outEdges.get(curr.id) ?? [];
    for (const edge of edgesFromCurr) {
      if (curr.path.has(edge.targetId)) continue;
      const nextDepth = curr.depth + 1;
      const prevDepth = layerMap.get(edge.targetId) ?? -1;
      if (nextDepth > prevDepth) {
        layerMap.set(edge.targetId, nextDepth);
        const nextPath = new Set(curr.path);
        nextPath.add(edge.targetId);
        queue.push({ id: edge.targetId, depth: nextDepth, path: nextPath });
      }
    }
  }

  for (const n of prev.nodes) {
    if (!layerMap.has(n.id)) {
      layerMap.set(n.id, 0);
    }
  }

  const maxLayer = Math.max(0, ...Array.from(layerMap.values()));

  interface LayoutItem {
    id: string;
    isDummy: boolean;
    layer: number;
    origX: number;
  }

  interface LayoutSegment {
    fromId: string;
    toId: string;
    slot: number;
  }

  const itemsById = new Map<string, LayoutItem>();
  const layerItems: LayoutItem[][] = Array.from({ length: maxLayer + 1 }, () => []);
  const segmentsIn = new Map<string, LayoutSegment[]>();
  const segmentsOut = new Map<string, LayoutSegment[]>();

  for (const n of prev.nodes) {
    const l = layerMap.get(n.id) ?? 0;
    const item: LayoutItem = { id: n.id, isDummy: false, layer: l, origX: n.x };
    itemsById.set(n.id, item);
    layerItems[l]!.push(item);
    segmentsIn.set(n.id, []);
    segmentsOut.set(n.id, []);
  }

  let dummyCounter = 0;
  for (const e of validEdges) {
    const uLayer = layerMap.get(e.sourceId) ?? 0;
    const vLayer = layerMap.get(e.targetId) ?? 0;
    if (vLayer <= uLayer) continue;

    if (vLayer - uLayer === 1) {
      const seg: LayoutSegment = {
        fromId: e.sourceId,
        toId: e.targetId,
        slot: e.sourceSlot,
      };
      segmentsOut.get(e.sourceId)?.push(seg);
      segmentsIn.get(e.targetId)?.push(seg);
    } else {
      let prevId = e.sourceId;
      let prevSlot = e.sourceSlot;
      const uNode = itemsById.get(e.sourceId)!;

      for (let l = uLayer + 1; l < vLayer; l++) {
        const dummyId = `__dummy_${++dummyCounter}`;
        const dummyItem: LayoutItem = {
          id: dummyId,
          isDummy: true,
          layer: l,
          origX: uNode.origX + (e.sourceSlot + 1) * 50,
        };
        itemsById.set(dummyId, dummyItem);
        layerItems[l]!.push(dummyItem);
        segmentsIn.set(dummyId, []);
        segmentsOut.set(dummyId, []);

        const seg: LayoutSegment = { fromId: prevId, toId: dummyId, slot: prevSlot };
        segmentsOut.get(prevId)?.push(seg);
        segmentsIn.get(dummyId)?.push(seg);

        prevId = dummyId;
        prevSlot = 0;
      }

      const lastSeg: LayoutSegment = {
        fromId: prevId,
        toId: e.targetId,
        slot: prevSlot,
      };
      segmentsOut.get(prevId)?.push(lastSeg);
      segmentsIn.get(e.targetId)?.push(lastSeg);
    }
  }

  const orderInLayer = new Map<string, number>();
  layerItems[0]!.sort((a, b) => a.origX - b.origX);
  layerItems[0]!.forEach((item, idx) => orderInLayer.set(item.id, idx));

  for (let l = 1; l <= maxLayer; l++) {
    const items = layerItems[l]!;
    items.sort((a, b) => {
      const aIn = segmentsIn.get(a.id) ?? [];
      const bIn = segmentsIn.get(b.id) ?? [];
      const aScore =
        aIn.length > 0
          ? aIn.reduce(
              (sum, s) => sum + (orderInLayer.get(s.fromId) ?? 0) * 100 + s.slot * 15,
              0
            ) / aIn.length
          : a.origX;
      const bScore =
        bIn.length > 0
          ? bIn.reduce(
              (sum, s) => sum + (orderInLayer.get(s.fromId) ?? 0) * 100 + s.slot * 15,
              0
            ) / bIn.length
          : b.origX;

      if (Math.abs(aScore - bScore) < 0.01 && a.isDummy !== b.isDummy) {
        return a.isDummy ? 1 : -1;
      }
      return aScore - bScore || a.origX - b.origX;
    });
    items.forEach((item, idx) => orderInLayer.set(item.id, idx));
  }

  const H_GAP = 265;
  const V_START = 95;
  const V_GAP = 190;
  const BASE_CENTER_X = 640;

  const treeChildren = new Map<string, string[]>();
  for (const item of itemsById.values()) {
    treeChildren.set(item.id, []);
  }

  for (let l = 1; l <= maxLayer; l++) {
    for (const item of layerItems[l]!) {
      const incoming = [...(segmentsIn.get(item.id) ?? [])].sort(
        (a, b) =>
          (orderInLayer.get(a.fromId) ?? 0) - (orderInLayer.get(b.fromId) ?? 0) ||
          a.slot - b.slot
      );
      if (incoming[0]) {
        treeChildren.get(incoming[0].fromId)?.push(item.id);
      }
    }
  }

  const subtreeWidth = new Map<string, number>();
  function calcWidth(id: string): number {
    const ch = treeChildren.get(id) ?? [];
    if (ch.length === 0) {
      subtreeWidth.set(id, H_GAP);
      return H_GAP;
    }
    const sum = ch.reduce((acc, cid) => acc + calcWidth(cid), 0);
    const w = Math.max(H_GAP, sum);
    subtreeWidth.set(id, w);
    return w;
  }

  for (const r of layerItems[0]!) {
    calcWidth(r.id);
  }
  for (const item of itemsById.values()) {
    if (!subtreeWidth.has(item.id)) {
      calcWidth(item.id);
    }
  }

  const posX = new Map<string, number>();
  function placeTree(id: string, centerX: number) {
    posX.set(id, centerX);
    const ch = treeChildren.get(id) ?? [];
    if (ch.length === 0) return;
    const totalW = ch.reduce((acc, cid) => acc + (subtreeWidth.get(cid) ?? H_GAP), 0);
    let cursor = centerX - totalW / 2;
    for (const cid of ch) {
      const w = subtreeWidth.get(cid) ?? H_GAP;
      placeTree(cid, cursor + w / 2);
      cursor += w;
    }
  }

  const totalRootsW = layerItems[0]!.reduce(
    (acc, r) => acc + (subtreeWidth.get(r.id) ?? H_GAP),
    0
  );
  const startCenterX = Math.max(CHAPTER_HEADER_WIDTH + 160 + totalRootsW / 2, BASE_CENTER_X);
  let rootCursor = startCenterX - totalRootsW / 2;
  for (const r of layerItems[0]!) {
    const w = subtreeWidth.get(r.id) ?? H_GAP;
    placeTree(r.id, rootCursor + w / 2);
    rootCursor += w;
  }

  for (let l = 1; l <= maxLayer; l++) {
    const items = layerItems[l]!;
    for (const item of items) {
      const incoming = segmentsIn.get(item.id) ?? [];
      if (incoming.length >= 2) {
        const avgParentX =
          incoming.reduce((sum, s) => sum + (posX.get(s.fromId) ?? startCenterX), 0) /
          incoming.length;
        posX.set(item.id, avgParentX);
      }
    }

    items.sort((a, b) => (posX.get(a.id) ?? 0) - (posX.get(b.id) ?? 0));
    if (items.length > 1) {
      const groupCenter =
        items.reduce((sum, item) => sum + (posX.get(item.id) ?? startCenterX), 0) /
        items.length;
      for (let i = 1; i < items.length; i++) {
        const prevId = items[i - 1]!.id;
        const currId = items[i]!.id;
        const prevVal = posX.get(prevId) ?? startCenterX;
        const currVal = posX.get(currId) ?? startCenterX;
        if (currVal - prevVal < H_GAP) {
          posX.set(currId, prevVal + H_GAP);
        }
      }
      const newCenter =
        items.reduce((sum, item) => sum + (posX.get(item.id) ?? startCenterX), 0) /
        items.length;
      const delta = groupCenter - newCenter;
      for (const item of items) {
        posX.set(item.id, (posX.get(item.id) ?? startCenterX) + delta);
      }
    }
  }

  const tempNodeById = new Map<string, FlowNode>();
  for (const n of prev.nodes) {
    const l = layerMap.get(n.id) ?? 0;
    tempNodeById.set(n.id, {
      ...n,
      x: Math.round(posX.get(n.id) ?? n.x),
      y: Math.round(V_START + l * V_GAP),
    });
  }

  const MIN_LINE_CLEARANCE = 175;
  for (const e of validEdges) {
    const u = tempNodeById.get(e.sourceId);
    const v = tempNodeById.get(e.targetId);
    if (!u || !v) continue;
    const uLayer = layerMap.get(u.id) ?? 0;
    const vLayer = layerMap.get(v.id) ?? 0;
    if (vLayer - uLayer <= 1) continue;

    const startPos = getSlotPlusPosition(u, e.sourceSlot);
    const sx = startPos.x;
    const sy = startPos.y + PLUS_RADIUS;
    const endPos = getNodeTopPoint(v);
    const tx = endPos.x;
    const ty = endPos.y;

    for (let l = uLayer + 1; l < vLayer; l++) {
      const realItemsInLayer = layerItems[l]!.filter((it) => !it.isDummy);
      for (const it of realItemsInLayer) {
        const w = tempNodeById.get(it.id);
        if (!w) continue;
        const ratio = (w.y - sy) / (ty - sy || 1);
        const lineX = sx + (tx - sx) * ratio;
        const diff = w.x - lineX;
        if (Math.abs(diff) < MIN_LINE_CLEARANCE) {
          const pushDir = diff < 0 ? -1 : e.sourceSlot > 0 ? -1 : 1;
          w.x = Math.round(lineX + pushDir * MIN_LINE_CLEARANCE);
        }
      }
    }
  }

  const minX = Math.min(...Array.from(tempNodeById.values()).map((n) => n.x));
  const minAllowedX = CHAPTER_HEADER_WIDTH + 150;
  const shiftRight = minX < minAllowedX ? minAllowedX - minX : 0;

  const updatedNodes = prev.nodes.map((n) => {
    const placed = tempNodeById.get(n.id)!;
    return {
      ...n,
      x: Math.round(placed.x + shiftRight),
      y: placed.y,
    };
  });

  const maxRequiredY = V_START + maxLayer * V_GAP + 150;
  const currentChaptersH = prev.chapters.reduce((sum, c) => sum + c.height, 0);
  let updatedChapters = prev.chapters;
  if (maxRequiredY > currentChaptersH && prev.chapters.length > 0) {
    const extra = maxRequiredY - currentChaptersH;
    updatedChapters = prev.chapters.map((c, idx) =>
      idx === prev.chapters.length - 1 ? { ...c, height: c.height + extra } : c
    );
  }

  return {
    ...prev,
    chapters: updatedChapters,
    nodes: updatedNodes,
  };
}

export function App() {
  const [chart, setChart] = useState<FlowchartData>(() => {
    try {
      const cached = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as FlowchartData;
        if (parsed && Array.isArray(parsed.chapters) && Array.isArray(parsed.nodes)) {
          return parsed;
        }
      }
    } catch {
      // ignore localStorage parse errors
    }
    return createInitialFlowchart();
  });

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [plusMenu, setPlusMenu] = useState<ActivePlusMenu | null>(null);
  const [mergeMode, setMergeMode] = useState<MergeModeState | null>(null);
  const [marquee, setMarquee] = useState<MarqueeSelectionState | null>(null);
  const [isMultiSelectMode, setIsMultiSelectMode] = useState<boolean>(false);
  const [showVariableModal, setShowVariableModal] = useState<boolean>(false);
  const [routeTraceMode, setRouteTraceMode] = useState<boolean>(false);
  const [routeNodeIds, setRouteNodeIds] = useState<string[]>([]);
  const [routeEdgeIds, setRouteEdgeIds] = useState<string[]>([]);
  const [routeBranchChoices, setRouteBranchChoices] = useState<Record<string, number>>(
    {}
  );
  const [routeDrawerMinimized, setRouteDrawerMinimized] = useState<boolean>(false);
  const [zoom, setZoom] = useState<number>(() =>
    typeof window !== "undefined" && window.innerWidth <= 768 ? 0.8 : 1.0
  );
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "offline">("saved");

  // Authentication state (Cloudflare Zero Trust Access or Google Sign-In)
  const [authState, setAuthState] = useState<
    "checking" | "authenticated" | "unauthenticated" | "forbidden"
  >("checking");
  const [authUser, setAuthUser] = useState<{
    email?: string;
    name?: string;
    authMode?: string;
    reason?: string;
    googleClientId?: string | null;
  } | null>(null);
  const googleBtnRef = useRef<HTMLDivElement | null>(null);

  // Undo / Redo history stacks & Toast notification
  const [undoStack, setUndoStack] = useState<FlowchartData[]>([]);
  const [redoStack, setRedoStack] = useState<FlowchartData[]>([]);
  const [undoToast, setUndoToast] = useState<{ message: string; id: number } | null>(null);

  // Dragging node(s) state (supports single node OR multi-selected group while keeping relative layout)
  const [draggingNodes, setDraggingNodes] = useState<{
    clickedNodeId: string;
    wasAlreadyMultiSelected: boolean;
    startX: number;
    startY: number;
    origPositions: Map<string, { x: number; y: number }>;
    snapshotBeforeDrag: FlowchartData;
    hasMoved: boolean;
  } | null>(null);

  // Resizing chapter lane state
  const [resizingChapter, setResizingChapter] = useState<{
    chapterId: string;
    startY: number;
    origHeight: number;
    chapterBottomYAtStart: number;
    shiftNodesBelow: boolean;
    snapshotBeforeResize: FlowchartData;
    hasResized: boolean;
  } | null>(null);

  // Ref to track whether the last mousedown->mouseup gesture actually dragged nodes
  const suppressClickAfterDragRef = useRef(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canvasScrollRef = useRef<HTMLDivElement | null>(null);
  const flowchartCanvasRef = useRef<HTMLDivElement | null>(null);
  const initialLoadDone = useRef(false);

  // Helper to push a snapshot onto undoStack before destructive/structural/move changes
  function pushUndoSnapshot(snapshot: FlowchartData) {
    setUndoStack((prev) => {
      const next = [...prev, cloneFlowchart(snapshot)];
      if (next.length > MAX_UNDO_HISTORY) {
        return next.slice(next.length - MAX_UNDO_HISTORY);
      }
      return next;
    });
    setRedoStack([]);
  }

  // Undo last action
  function handleUndo() {
    setUndoStack((prevUndo) => {
      if (prevUndo.length === 0) return prevUndo;
      const lastSnapshot = prevUndo[prevUndo.length - 1]!;
      setRedoStack((prevRedo) => [...prevRedo, cloneFlowchart(chart)]);
      setChart(lastSnapshot);
      setUndoToast(null);
      setPlusMenu(null);
      const validIds = new Set(lastSnapshot.nodes.map((n) => n.id));
      setSelectedNodeIds((ids) => ids.filter((id) => validIds.has(id)));
      return prevUndo.slice(0, -1);
    });
  }

  // Redo last undone action
  function handleRedo() {
    setRedoStack((prevRedo) => {
      if (prevRedo.length === 0) return prevRedo;
      const nextSnapshot = prevRedo[prevRedo.length - 1]!;
      setUndoStack((prevUndo) => [...prevUndo, cloneFlowchart(chart)]);
      setChart(nextSnapshot);
      setUndoToast(null);
      setPlusMenu(null);
      const validIds = new Set(nextSnapshot.nodes.map((n) => n.id));
      setSelectedNodeIds((ids) => ids.filter((id) => validIds.has(id)));
      return prevRedo.slice(0, -1);
    });
  }

  // Auto-hide undoToast after 8 seconds
  useEffect(() => {
    if (!undoToast) return;
    const timer = setTimeout(() => {
      setUndoToast(null);
    }, 8000);
    return () => clearTimeout(timer);
  }, [undoToast]);

  // Load project list and initial flowchart after authentication succeeds
  async function fetchProjectsAndInitialChart() {
    try {
      const projRes = await fetch("/api/projects");
      if (projRes.status === 401) {
        setAuthState("unauthenticated");
        return;
      }
      if (projRes.status === 403) {
        setAuthState("forbidden");
        return;
      }
      if (projRes.ok) {
        const list = (await projRes.json()) as ProjectSummary[];
        setProjects(list);
        const targetId = list[0]?.id ?? "default";
        const chartRes = await fetch(`/api/flowchart/${encodeURIComponent(targetId)}`);
        if (chartRes.ok) {
          const serverChart = (await chartRes.json()) as FlowchartData;
          setChart(serverChart);
          localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(serverChart));
        }
      }
      initialLoadDone.current = true;
    } catch {
      setSaveStatus("offline");
      initialLoadDone.current = true;
    }
  }

  // Check authentication & load initial project from server on startup
  useEffect(() => {
    async function initAuthAndLoad() {
      try {
        const authRes = await fetch("/api/auth/me");
        if (authRes.status === 401) {
          const info = await authRes.json().catch(() => ({}));
          setAuthUser(info);
          setAuthState("unauthenticated");
          return;
        }
        if (authRes.status === 403) {
          const info = await authRes.json().catch(() => ({}));
          setAuthUser(info);
          setAuthState("forbidden");
          return;
        }
        if (authRes.ok) {
          const info = await authRes.json().catch(() => ({}));
          setAuthUser(info);
          setAuthState("authenticated");
          await fetchProjectsAndInitialChart();
          return;
        }
        // Fallback if /api/auth/me is not present
        setAuthState("authenticated");
        await fetchProjectsAndInitialChart();
      } catch {
        // Offline / static local fallback
        setAuthState("authenticated");
        setSaveStatus("offline");
        initialLoadDone.current = true;
      }
    }
    initAuthAndLoad();
  }, []);

  // Render Google Identity Services Sign-In button when GOOGLE_CLIENT_ID is configured
  useEffect(() => {
    if (authState !== "unauthenticated" || !authUser?.googleClientId) return;
    const clientId = authUser.googleClientId;

    function renderGoogleButton() {
      const g = (window as unknown as {
        google?: {
          accounts?: {
            id?: {
              initialize: (cfg: {
                client_id: string;
                callback: (resp: { credential?: string }) => void;
              }) => void;
              renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
            };
          };
        };
      }).google;

      if (!g?.accounts?.id || !googleBtnRef.current) return;

      g.accounts.id.initialize({
        client_id: clientId,
        callback: async (response) => {
          if (!response.credential) return;
          try {
            const res = await fetch("/api/auth/google", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ credential: response.credential }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.authenticated) {
              setAuthUser(data);
              setAuthState("authenticated");
              await fetchProjectsAndInitialChart();
            } else if (res.status === 403) {
              setAuthUser(data);
              setAuthState("forbidden");
            } else {
              setAuthUser({
                ...authUser,
                reason: data.error || "Google認証に失敗しました。",
              });
            }
          } catch {
            setAuthUser({
              ...authUser,
              reason: "認証サーバーとの通信に失敗しました。",
            });
          }
        },
      });

      googleBtnRef.current.innerHTML = "";
      g.accounts.id.renderButton(googleBtnRef.current, {
        theme: "outline",
        size: "large",
        text: "signin_with",
        shape: "rectangular",
        width: 280,
      });
    }

    const existingScript = document.querySelector(
      'script[src="https://accounts.google.com/gsi/client"]'
    );
    if (existingScript) {
      renderGoogleButton();
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = renderGoogleButton;
    document.head.appendChild(script);
  }, [authState, authUser?.googleClientId]);

  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }
    if (authUser?.authMode === "cloudflare-access") {
      window.location.href = "/cdn-cgi/access/logout";
      return;
    }
    initialLoadDone.current = false;
    setAuthState("unauthenticated");
  }

  // Auto-save to localStorage & SQLite backend
  useEffect(() => {
    if (authState !== "authenticated") return;
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(chart));
    } catch {
      // ignore
    }

    if (!initialLoadDone.current) return;

    setSaveStatus("saving");
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/flowchart/${encodeURIComponent(chart.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(chart),
        });
        if (res.ok) {
          setSaveStatus("saved");
          const projRes = await fetch("/api/projects");
          if (projRes.ok) {
            setProjects((await projRes.json()) as ProjectSummary[]);
          }
        } else {
          setSaveStatus("offline");
        }
      } catch {
        setSaveStatus("offline");
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [chart, authState]);

  // Compute cumulative Y ranges for each chapter lane
  const chapterRanges = useMemo(() => {
    let currentTop = 0;
    return chart.chapters.map((ch, idx) => {
      const top = currentTop;
      const bottom = top + ch.height;
      currentTop = bottom;
      return {
        ...ch,
        index: idx,
        top,
        bottom,
      };
    });
  }, [chart.chapters]);

  const totalCanvasHeight = useMemo(() => {
    const chaptersSum = chapterRanges.reduce((acc, c) => Math.max(acc, c.bottom), 0);
    const maxNodeY = chart.nodes.reduce((acc, n) => Math.max(acc, n.y + 180), 0);
    return Math.max(chaptersSum + 100, maxNodeY, 720);
  }, [chapterRanges, chart.nodes]);

  const totalCanvasWidth = useMemo(() => {
    const maxNodeX = chart.nodes.reduce((acc, n) => Math.max(acc, n.x + 280), 0);
    return Math.max(1280, maxNodeX);
  }, [chart.nodes]);

  const nodeMap = useMemo(() => {
    const map = new Map<string, FlowNode>();
    for (const n of chart.nodes) {
      map.set(n.id, n);
    }
    return map;
  }, [chart.nodes]);

  const selectedNodeSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);

  // Right Drawer opens only when a single node is selected (and not in Route Trace Mode)
  const selectedNode = useMemo(
    () =>
      !routeTraceMode && selectedNodeIds.length === 1
        ? nodeMap.get(selectedNodeIds[0]!) ?? null
        : null,
    [routeTraceMode, selectedNodeIds, nodeMap]
  );

  const variableMap = useMemo(() => {
    const map = new Map<string, FlowchartVariable>();
    for (const v of chart.variables ?? []) {
      map.set(v.id, v);
    }
    return map;
  }, [chart.variables]);

  // Route Trace computed state
  const routeStepIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    routeNodeIds.forEach((id, idx) => {
      map.set(id, idx);
    });
    return map;
  }, [routeNodeIds]);

  const routeEdgeSet = useMemo(() => new Set(routeEdgeIds), [routeEdgeIds]);

  const currentRouteNodeId =
    routeNodeIds.length > 0 ? routeNodeIds[routeNodeIds.length - 1]! : null;
  const currentRouteNode = currentRouteNodeId ? nodeMap.get(currentRouteNodeId) ?? null : null;

  const nextRouteBranchEdges = useMemo(() => {
    if (!routeTraceMode || !currentRouteNode) return [];
    if (currentRouteNode.type === "rect" && currentRouteNode.isEnd) return [];
    const slotCount = getNodeSlotCount(currentRouteNode);
    return chart.edges
      .filter(
        (e) =>
          e.sourceId === currentRouteNode.id &&
          e.sourceSlot >= 0 &&
          e.sourceSlot < slotCount &&
          nodeMap.has(e.targetId)
      )
      .sort((a, b) => a.sourceSlot - b.sourceSlot);
  }, [routeTraceMode, currentRouteNode, chart.edges, nodeMap]);

  const nextBranchEdgeByTargetId = useMemo(() => {
    const map = new Map<string, FlowEdge>();
    for (const e of nextRouteBranchEdges) {
      if (!map.has(e.targetId)) {
        map.set(e.targetId, e);
      }
    }
    return map;
  }, [nextRouteBranchEdges]);

  const nextBranchEdgeSet = useMemo(
    () => new Set(nextRouteBranchEdges.map((e) => e.id)),
    [nextRouteBranchEdges]
  );

  // Intermediate branch switchers: for any branch node already passed on the route (0 <= stepIdx < routeNodeIds.length - 1),
  // collect its alternative (unchosen) connected outgoing edges so the user can switch A ⇄ B in 1 click!
  const switchableBranchByEdgeId = useMemo(() => {
    const map = new Map<string, { stepIdx: number; edge: FlowEdge }>();
    if (!routeTraceMode) return map;
    for (let i = 0; i < routeNodeIds.length - 1; i++) {
      const nodeId = routeNodeIds[i]!;
      const node = nodeMap.get(nodeId);
      if (!node) continue;
      if (node.type === "rect" && node.isEnd) continue;
      const slotCount = getNodeSlotCount(node);
      if (slotCount <= 1) continue;

      const takenEdgeId = routeEdgeIds[i];
      for (const e of chart.edges) {
        if (
          e.sourceId === nodeId &&
          e.sourceSlot >= 0 &&
          e.sourceSlot < slotCount &&
          e.id !== takenEdgeId &&
          nodeMap.has(e.targetId)
        ) {
          map.set(e.id, { stepIdx: i, edge: e });
        }
      }
    }
    return map;
  }, [routeTraceMode, routeNodeIds, routeEdgeIds, chart.edges, nodeMap]);

  const switchableBranchByTargetId = useMemo(() => {
    const map = new Map<string, { stepIdx: number; edge: FlowEdge }>();
    for (const item of switchableBranchByEdgeId.values()) {
      if (!map.has(item.edge.targetId) && !routeStepIndexMap.has(item.edge.targetId)) {
        map.set(item.edge.targetId, item);
      }
    }
    return map;
  }, [switchableBranchByEdgeId, routeStepIndexMap]);

  const routeEvaluation = useMemo(
    () => evaluateRouteVariables(chart, routeNodeIds, routeEdgeIds),
    [chart, routeNodeIds, routeEdgeIds]
  );

  // Start or toggle Route Trace Mode
  function handleStartRouteFromNode(startNodeId: string) {
    const advanced = advanceRouteUntilBranch(
      chart,
      [startNodeId],
      [],
      routeBranchChoices
    );
    setRouteNodeIds(advanced.nodeIds);
    setRouteEdgeIds(advanced.edgeIds);
    setRouteDrawerMinimized(false);
  }

  function handleToggleRouteTraceMode() {
    if (routeTraceMode) {
      setRouteTraceMode(false);
      return;
    }
    const startId =
      (selectedNodeIds.length === 1 && nodeMap.has(selectedNodeIds[0]!)
        ? selectedNodeIds[0]!
        : null) ?? findDefaultStartNodeId(chart);
    setRouteTraceMode(true);
    setIsMultiSelectMode(false);
    setMergeMode(null);
    setPlusMenu(null);
    setSelectedEdgeId(null);
    setSelectedNodeIds([]);
    setRouteDrawerMinimized(false);
    if (startId) {
      const advanced = advanceRouteUntilBranch(
        chart,
        [startId],
        [],
        routeBranchChoices
      );
      setRouteNodeIds(advanced.nodeIds);
      setRouteEdgeIds(advanced.edgeIds);
    } else {
      setRouteNodeIds([]);
      setRouteEdgeIds([]);
    }
  }

  function handleChooseRouteBranch(edge: FlowEdge) {
    const nextChoices = {
      ...routeBranchChoices,
      [edge.sourceId]: edge.sourceSlot,
    };
    setRouteBranchChoices(nextChoices);
    const nextNodes = [...routeNodeIds, edge.targetId];
    const nextEdges = [...routeEdgeIds, edge.id];
    const advanced = advanceRouteUntilBranch(chart, nextNodes, nextEdges, nextChoices);
    setRouteNodeIds(advanced.nodeIds);
    setRouteEdgeIds(advanced.edgeIds);
  }

  function handleSwitchBranchAtStep(stepIdx: number, newEdge: FlowEdge) {
    const result = switchRouteBranchAtStep(
      chart,
      routeNodeIds,
      routeEdgeIds,
      stepIdx,
      newEdge,
      routeBranchChoices
    );
    setRouteBranchChoices(result.updatedChoices);
    setRouteNodeIds(result.nodeIds);
    setRouteEdgeIds(result.edgeIds);
  }

  function handleRewindRouteToStep(stepIdx: number) {
    if (stepIdx < 0 || stepIdx >= routeNodeIds.length) return;
    setRouteNodeIds(routeNodeIds.slice(0, stepIdx + 1));
    setRouteEdgeIds(routeEdgeIds.slice(0, stepIdx));
  }

  function handleResetRouteTrace() {
    setRouteBranchChoices({});
    const startId = routeNodeIds[0] ?? findDefaultStartNodeId(chart);
    const targetStartId =
      startId && nodeMap.has(startId) ? startId : findDefaultStartNodeId(chart);
    if (targetStartId) {
      const advanced = advanceRouteUntilBranch(chart, [targetStartId], [], {});
      setRouteNodeIds(advanced.nodeIds);
      setRouteEdgeIds(advanced.edgeIds);
    }
  }

  // Variable & Flag CRUD
  function handleAddVariable() {
    pushUndoSnapshot(chart);
    const existingCount = (chart.variables ?? []).length + 1;
    const newVar: FlowchartVariable = {
      id: uid("var"),
      name: `flag_${existingCount}`,
      type: "boolean",
      defaultValue: false,
    };
    setChart((prev) => ({
      ...prev,
      variables: [...(prev.variables ?? []), newVar],
    }));
  }

  function handleUpdateVariable(varId: string, patch: Partial<FlowchartVariable>) {
    setChart((prev) => {
      const nextVars = (prev.variables ?? []).map((v) => {
        if (v.id !== varId) return v;
        const updated: FlowchartVariable = { ...v, ...patch };
        if (patch.type && patch.type !== v.type && patch.defaultValue === undefined) {
          updated.defaultValue =
            patch.type === "number" ? 0 : patch.type === "boolean" ? false : "";
        }
        return updated;
      });

      // If variable type changed, normalize any effects referencing it
      let nextNodes = prev.nodes;
      if (patch.type) {
        const newType = patch.type;
        nextNodes = prev.nodes.map((n) => {
          if (!n.effects || n.effects.length === 0) return n;
          return {
            ...n,
            effects: n.effects.map((eff) => {
              if (eff.variableId !== varId) return eff;
              const nextOp: VariableEffectOp =
                newType === "number"
                  ? eff.op === "add" || eff.op === "subtract"
                    ? eff.op
                    : "set"
                  : newType === "boolean"
                    ? eff.op === "toggle"
                      ? "toggle"
                      : "set"
                    : "set";
              const nextVal =
                newType === "number"
                  ? Number(eff.value) || 0
                  : newType === "boolean"
                    ? Boolean(eff.value)
                    : String(eff.value ?? "");
              return { ...eff, op: nextOp, value: nextVal };
            }),
          };
        });
      }

      return {
        ...prev,
        variables: nextVars,
        nodes: nextNodes,
      };
    });
  }

  function handleDeleteVariable(varId: string) {
    pushUndoSnapshot(chart);
    setChart((prev) => ({
      ...prev,
      variables: (prev.variables ?? []).filter((v) => v.id !== varId),
      nodes: prev.nodes.map((n) => ({
        ...n,
        effects: (n.effects ?? []).filter((eff) => eff.variableId !== varId),
      })),
    }));
  }

  // Node Variable Effect CRUD
  function handleAddNodeEffect(nodeId: string, branchSlot: number | null = null) {
    const vars = chart.variables ?? [];
    if (vars.length === 0) {
      setShowVariableModal(true);
      return;
    }
    pushUndoSnapshot(chart);
    const firstVar = vars[0]!;
    const newEff: VariableEffect = {
      id: uid("eff"),
      variableId: firstVar.id,
      op: "set",
      value:
        firstVar.type === "number"
          ? 0
          : firstVar.type === "boolean"
            ? true
            : "",
      branchSlot,
    };
    setChart((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) =>
        n.id === nodeId ? { ...n, effects: [...(n.effects ?? []), newEff] } : n
      ),
    }));
  }

  function handleUpdateNodeEffect(
    nodeId: string,
    effectId: string,
    patch: Partial<VariableEffect>
  ) {
    setChart((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        return {
          ...n,
          effects: (n.effects ?? []).map((eff) => {
            if (eff.id !== effectId) return eff;
            const nextEff = { ...eff, ...patch };
            // If variableId changed, coerce op and value to match the target variable's type
            if (patch.variableId && patch.variableId !== eff.variableId) {
              const targetVar = variableMap.get(patch.variableId);
              if (targetVar) {
                nextEff.op = "set";
                nextEff.value =
                  targetVar.type === "number"
                    ? 0
                    : targetVar.type === "boolean"
                      ? true
                      : "";
              }
            }
            return nextEff;
          }),
        };
      }),
    }));
  }

  function handleDeleteNodeEffect(nodeId: string, effectId: string) {
    pushUndoSnapshot(chart);
    setChart((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, effects: (n.effects ?? []).filter((eff) => eff.id !== effectId) }
          : n
      ),
    }));
  }

  // Bulk or single delete with Undo snapshot & Toast notification
  function handleDeleteNodes(targetIds: string[]) {
    const validTargetIds = targetIds.filter((id) => nodeMap.has(id));
    if (validTargetIds.length === 0) return;

    pushUndoSnapshot(chart);
    setChart((prev) => deleteNodesFromChart(prev, validTargetIds));
    setSelectedNodeIds((prev) => prev.filter((id) => !validTargetIds.includes(id)));
    setPlusMenu(null);
    setSelectedEdgeId(null);

    const label =
      validTargetIds.length === 1
        ? `「${nodeMap.get(validTargetIds[0]!)?.title || "無題"}」を削除しました`
        : `${validTargetIds.length} 個の図形をまとめて削除しました`;
    setUndoToast({ message: label, id: Date.now() });
  }

  // Keyboard shortcuts: Escape, Delete/Backspace (bulk delete), Ctrl+Z (Undo), Ctrl+Y (Redo)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isEditingInput =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);

      if (e.key === "Escape") {
        setMergeMode(null);
        setPlusMenu(null);
        setSelectedEdgeId(null);
        setSelectedNodeIds([]);
        return;
      }

      if (isEditingInput) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        handleRedo();
        return;
      }

      if ((e.key === "Delete" || e.key === "Backspace") && selectedNodeIds.length > 0) {
        e.preventDefault();
        handleDeleteNodes(selectedNodeIds);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  // Ctrl + Scroll Wheel AND 2-finger pinch-to-zoom on the canvas
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    const container = canvasScrollRef.current;
    if (!container) return;

    function handleWheel(e: WheelEvent) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
        setZoom((prev) => clampZoom(prev + delta));
      }
    }

    let pinchStartDist: number | null = null;
    let pinchStartZoom = 1.0;

    function getTouchDistance(t1: Touch, t2: Touch): number {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.hypot(dx, dy);
    }

    function handleTouchStart(e: TouchEvent) {
      if (e.touches.length === 2) {
        pinchStartDist = getTouchDistance(e.touches[0]!, e.touches[1]!);
        pinchStartZoom = zoomRef.current;
      }
    }

    function handleTouchMove(e: TouchEvent) {
      if (e.touches.length === 2 && pinchStartDist && pinchStartDist > 10) {
        if (e.cancelable) e.preventDefault();
        const currDist = getTouchDistance(e.touches[0]!, e.touches[1]!);
        const nextZoom = clampZoom(pinchStartZoom * (currDist / pinchStartDist));
        setZoom(nextZoom);
      }
    }

    function handleTouchEnd(e: TouchEvent) {
      if (e.touches.length < 2) {
        pinchStartDist = null;
      }
    }

    container.addEventListener("wheel", handleWheel, { passive: false });
    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    container.addEventListener("touchmove", handleTouchMove, { passive: false });
    container.addEventListener("touchend", handleTouchEnd);
    container.addEventListener("touchcancel", handleTouchEnd);
    return () => {
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [authState]);

  // Center horizontal scroll on mobile on initial render so root node is immediately in view
  useEffect(() => {
    if (authState !== "authenticated") return;
    if (typeof window === "undefined" || window.innerWidth > 768) return;
    const container = canvasScrollRef.current;
    if (!container || chart.nodes.length === 0) return;

    const topNode = chart.nodes.reduce(
      (best, n) => (n.y < best.y ? n : best),
      chart.nodes[0]!
    );
    const targetScrollLeft = Math.max(
      0,
      Math.round(topNode.x * zoomRef.current - window.innerWidth / 2 + 20)
    );
    container.scrollLeft = targetScrollLeft;
  }, [authState]);

  // Convert viewport mouse/touch coordinates (clientX, clientY) to logical canvas coordinates
  function clientToCanvasCoords(clientX: number, clientY: number): { x: number; y: number } {
    const el = flowchartCanvasRef.current;
    if (!el) return { x: clientX, y: clientY };
    const rect = el.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / zoom,
      y: (clientY - rect.top) / zoom,
    };
  }

  // Determine which chapter lane a given Y coordinate falls into
  function getChapterForY(y: number) {
    for (const ch of chapterRanges) {
      if (y >= ch.top && y <= ch.bottom) {
        return ch;
      }
    }
    return chapterRanges[chapterRanges.length - 1] ?? null;
  }

  // Shared helper to initiate dragging of a single node or multi-selected group
  function startNodeDragSession(clientX: number, clientY: number, node: FlowNode) {
    const isPartOfSelection = selectedNodeSet.has(node.id);
    const movingIds =
      isPartOfSelection && selectedNodeIds.length >= 2 ? selectedNodeIds : [node.id];

    const origPositions = new Map<string, { x: number; y: number }>();
    for (const id of movingIds) {
      const target = nodeMap.get(id);
      if (target) {
        origPositions.set(id, { x: target.x, y: target.y });
      }
    }

    suppressClickAfterDragRef.current = false;
    setDraggingNodes({
      clickedNodeId: node.id,
      wasAlreadyMultiSelected: isPartOfSelection && selectedNodeIds.length >= 2,
      startX: clientX,
      startY: clientY,
      origPositions,
      snapshotBeforeDrag: cloneFlowchart(chart),
      hasMoved: false,
    });
  }

  // Start dragging via Mouse
  function handleNodeMouseDown(e: React.MouseEvent, node: FlowNode) {
    if (e.button !== 0) return;
    e.stopPropagation();

    if (routeTraceMode) {
      return;
    }

    if (mergeMode) {
      if (mergeMode.sourceId !== node.id) {
        handleConnectToExistingNode(mergeMode.sourceId, mergeMode.sourceSlot, node.id);
      }
      return;
    }

    if (e.ctrlKey || e.metaKey || isMultiSelectMode) {
      return;
    }

    startNodeDragSession(e.clientX, e.clientY, node);
  }

  // Start dragging via Touch (smartphone / tablet)
  function handleNodeTouchStart(e: React.TouchEvent, node: FlowNode) {
    if (e.touches.length !== 1) return;
    e.stopPropagation();

    if (routeTraceMode) {
      return;
    }

    if (mergeMode) {
      if (mergeMode.sourceId !== node.id) {
        handleConnectToExistingNode(mergeMode.sourceId, mergeMode.sourceSlot, node.id);
      }
      return;
    }

    // If tapping an unselected node while in multi-select mode, let onClick toggle selection;
    // if tapping an already-selected node, allow dragging the selected group!
    if (isMultiSelectMode && !selectedNodeSet.has(node.id)) {
      return;
    }

    const touch = e.touches[0]!;
    startNodeDragSession(touch.clientX, touch.clientY, node);
  }

  // Handle mouse & touch move / up for node(s) dragging, chapter resizing, and marquee selection
  useEffect(() => {
    if (!draggingNodes && !resizingChapter && !marquee) return;

    function handlePointerMove(
      clientX: number,
      clientY: number,
      preventDefaultScroll?: () => void
    ) {
      if (draggingNodes) {
        const rawDx = (clientX - draggingNodes.startX) / zoom;
        const rawDy = (clientY - draggingNodes.startY) / zoom;
        const moved = draggingNodes.hasMoved || Math.abs(rawDx) > 3 || Math.abs(rawDy) > 3;

        if (moved) {
          preventDefaultScroll?.();
        }

        if (moved && !draggingNodes.hasMoved) {
          suppressClickAfterDragRef.current = true;
          pushUndoSnapshot(draggingNodes.snapshotBeforeDrag);
          setDraggingNodes((prev) => (prev ? { ...prev, hasMoved: true } : null));
        }

        if (moved) {
          setChart((prev) =>
            moveNodesInChart(prev, draggingNodes.origPositions, rawDx, rawDy)
          );
        }
      }

      if (resizingChapter) {
        preventDefaultScroll?.();
        const dy = (clientY - resizingChapter.startY) / zoom;
        const newHeight = Math.max(160, Math.round(resizingChapter.origHeight + dy));
        const actualDiff = newHeight - resizingChapter.origHeight;

        if (Math.abs(actualDiff) > 2 && !resizingChapter.hasResized) {
          pushUndoSnapshot(resizingChapter.snapshotBeforeResize);
          setResizingChapter((prev) => (prev ? { ...prev, hasResized: true } : null));
        }

        setChart((prev) => {
          const prevChapter = prev.chapters.find((c) => c.id === resizingChapter.chapterId);
          const incrementalDiff = prevChapter ? newHeight - prevChapter.height : 0;
          if (incrementalDiff === 0) return prev;

          return {
            ...prev,
            chapters: prev.chapters.map((c) =>
              c.id === resizingChapter.chapterId ? { ...c, height: newHeight } : c
            ),
            nodes: resizingChapter.shiftNodesBelow
              ? prev.nodes.map((n) =>
                  n.y >= resizingChapter.chapterBottomYAtStart + (actualDiff - incrementalDiff)
                    ? { ...n, y: n.y + incrementalDiff }
                    : n
                )
              : prev.nodes,
          };
        });
      }

      if (marquee) {
        const coords = clientToCanvasCoords(clientX, clientY);
        const hasDragged =
          marquee.hasDragged ||
          Math.abs(coords.x - marquee.startX) > 4 ||
          Math.abs(coords.y - marquee.startY) > 4;

        if (hasDragged) {
          preventDefaultScroll?.();
        }

        const minX = Math.min(marquee.startX, coords.x);
        const maxX = Math.max(marquee.startX, coords.x);
        const minY = Math.min(marquee.startY, coords.y);
        const maxY = Math.max(marquee.startY, coords.y);

        if (hasDragged) {
          const hitIds = chart.nodes
            .filter((node) => {
              const halfW = (node.type === "rect" ? RECT_WIDTH : DIAMOND_WIDTH) / 2;
              const halfH = (node.type === "rect" ? RECT_HEIGHT : DIAMOND_HEIGHT) / 2;
              return (
                node.x + halfW >= minX &&
                node.x - halfW <= maxX &&
                node.y + halfH >= minY &&
                node.y - halfH <= maxY
              );
            })
            .map((n) => n.id);

          const nextIds = marquee.additive
            ? Array.from(new Set([...marquee.initialSelectedIds, ...hitIds]))
            : hitIds;
          setSelectedNodeIds(nextIds);
        }

        setMarquee((prev) =>
          prev
            ? {
                ...prev,
                currX: coords.x,
                currY: coords.y,
                hasDragged,
              }
            : null
        );
      }
    }

    function onMouseMove(e: MouseEvent) {
      handlePointerMove(e.clientX, e.clientY);
    }

    function onTouchMove(e: TouchEvent) {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0]!;
      handlePointerMove(touch.clientX, touch.clientY, () => {
        if (e.cancelable) e.preventDefault();
      });
    }

    function onPointerEnd() {
      if (marquee && !marquee.hasDragged && !marquee.additive) {
        setSelectedNodeIds([]);
      }
      setDraggingNodes(null);
      setResizingChapter(null);
      setMarquee(null);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onPointerEnd);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onPointerEnd);
    window.addEventListener("touchcancel", onPointerEnd);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onPointerEnd);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onPointerEnd);
      window.removeEventListener("touchcancel", onPointerEnd);
    };
  }, [draggingNodes, resizingChapter, marquee, zoom, chart.nodes]);

  // Check branch connection state of a node
  function getNodeBranchState(node: FlowNode) {
    const branchCount = getNodeSlotCount(node);
    const connectedSlots = new Set<number>();
    for (const edge of chart.edges) {
      if (
        edge.sourceId === node.id &&
        edge.sourceSlot >= 0 &&
        edge.sourceSlot < branchCount &&
        nodeMap.has(edge.targetId)
      ) {
        connectedSlots.add(edge.sourceSlot);
      }
    }
    const connectedCount = connectedSlots.size;
    const isIncomplete = connectedCount < branchCount;
    return {
      branchCount,
      connectedCount,
      isIncomplete,
      connectedSlots,
    };
  }

  // Trigger automatic hierarchical layout
  function handleAutoSort() {
    pushUndoSnapshot(chart);
    setChart((prev) => sortFlowchartLayout(prev));
  }

  // Create a new child node (rect or diamond) from a source node's slot
  function handleCreateChildNode(sourceId: string, sourceSlot: number, targetType: NodeType) {
    const sourceNode = nodeMap.get(sourceId);
    if (!sourceNode) return;

    pushUndoSnapshot(chart);

    const count = getNodeSlotCount(sourceNode);
    const horizontalSpread = count > 1 ? (sourceSlot - (count - 1) / 2) * 250 : 0;
    let targetX = Math.max(CHAPTER_HEADER_WIDTH + 135, Math.round(sourceNode.x + horizontalSpread));
    const targetY = Math.round(sourceNode.y + 185);

    while (
      chart.nodes.some(
        (n) => Math.abs(n.x - targetX) < 190 && Math.abs(n.y - targetY) < 90
      )
    ) {
      targetX += 230;
    }

    const newNodeId = uid("node");
    const rectCount = chart.nodes.filter((n) => n.type === "rect").length + 1;
    const diamondCount = chart.nodes.filter((n) => n.type === "diamond").length + 1;

    const newNode: FlowNode =
      targetType === "rect"
        ? {
            id: newNodeId,
            type: "rect",
            title: `第${rectCount}節`,
            content: "",
            x: targetX,
            y: targetY,
            isEnd: false,
            branchCount: 1,
          }
        : {
            id: newNodeId,
            type: "diamond",
            title: `分岐 ${diamondCount}`,
            content: "",
            x: targetX,
            y: targetY,
            branchCount: 2,
          };

    setChart((prev) => {
      const existingEdge = prev.edges.find(
        (e) => e.sourceId === sourceId && e.sourceSlot === sourceSlot
      );

      const nextEdges = prev.edges.filter(
        (e) => !(e.sourceId === sourceId && e.sourceSlot === sourceSlot)
      );

      nextEdges.push({
        id: uid("edge"),
        sourceId,
        sourceSlot,
        targetId: newNodeId,
        label: existingEdge?.label ?? "",
      });

      if (existingEdge && nodeMap.has(existingEdge.targetId)) {
        nextEdges.push({
          id: uid("edge"),
          sourceId: newNodeId,
          sourceSlot: 0,
          targetId: existingEdge.targetId,
          label: "",
        });
      }

      const totalH = prev.chapters.reduce((sum, c) => sum + c.height, 0);
      let nextChapters = prev.chapters;
      if (targetY + 140 > totalH && prev.chapters.length > 0) {
        const extra = targetY + 140 - totalH;
        nextChapters = prev.chapters.map((c, idx) =>
          idx === prev.chapters.length - 1 ? { ...c, height: c.height + extra } : c
        );
      }

      return {
        ...prev,
        chapters: nextChapters,
        nodes: [...prev.nodes, newNode],
        edges: nextEdges,
      };
    });

    setPlusMenu(null);
    setSelectedNodeIds([newNodeId]);
    setSelectedEdgeId(null);
  }

  // Connect (merge) a slot to an existing node
  function handleConnectToExistingNode(sourceId: string, sourceSlot: number, targetId: string) {
    if (sourceId === targetId) return;
    pushUndoSnapshot(chart);
    setChart((prev) => {
      const existing = prev.edges.find(
        (e) => e.sourceId === sourceId && e.sourceSlot === sourceSlot
      );
      const filtered = prev.edges.filter(
        (e) => !(e.sourceId === sourceId && e.sourceSlot === sourceSlot)
      );
      return {
        ...prev,
        edges: [
          ...filtered,
          {
            id: uid("edge"),
            sourceId,
            sourceSlot,
            targetId,
            label: existing?.label ?? "",
          },
        ],
      };
    });
    setMergeMode(null);
    setPlusMenu(null);
  }

  // Update edge label (分岐線のコメント)
  function handleUpdateEdgeLabel(edgeId: string, label: string) {
    setChart((prev) => ({
      ...prev,
      edges: prev.edges.map((e) => (e.id === edgeId ? { ...e, label } : e)),
    }));
  }

  // Disconnect an edge from a specific slot
  function handleDisconnectSlot(sourceId: string, sourceSlot: number) {
    pushUndoSnapshot(chart);
    setChart((prev) => ({
      ...prev,
      edges: prev.edges.filter(
        (e) => !(e.sourceId === sourceId && e.sourceSlot === sourceSlot)
      ),
    }));
    setPlusMenu(null);
  }

  // Update selected node fields from the Right Drawer
  function updateNode(nodeId: string, patch: Partial<FlowNode>) {
    setChart((prev) => {
      const nextNodes = prev.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n));
      let nextEdges = prev.edges;

      if (patch.isEnd === true) {
        nextEdges = nextEdges.filter((e) => e.sourceId !== nodeId);
      }

      if (typeof patch.branchCount === "number") {
        const validCount = Math.max(1, patch.branchCount);
        nextEdges = nextEdges.filter(
          (e) => !(e.sourceId === nodeId && e.sourceSlot >= validCount)
        );
        for (let i = 0; i < nextNodes.length; i++) {
          const n = nextNodes[i]!;
          if (n.id === nodeId && n.effects && n.effects.length > 0) {
            nextNodes[i] = {
              ...n,
              effects: n.effects.filter(
                (eff) =>
                  eff.branchSlot === null ||
                  eff.branchSlot === undefined ||
                  eff.branchSlot < validCount
              ),
            };
          }
        }
      }

      return {
        ...prev,
        nodes: nextNodes,
        edges: nextEdges,
      };
    });
  }

  // Delete a single node (uses handleDeleteNodes so Undo & Toast work identically)
  function handleDeleteNode(nodeId: string) {
    handleDeleteNodes([nodeId]);
  }

  // Chapter Lane management
  function handleAddChapter(afterIndex?: number) {
    pushUndoSnapshot(chart);
    setChart((prev) => {
      const insertIdx =
        typeof afterIndex === "number" ? afterIndex + 1 : prev.chapters.length;
      const newChapter: ChapterLane = {
        id: uid("chap"),
        title: `第${prev.chapters.length + 1}章：新規チャプター`,
        height: 340,
        order: insertIdx,
      };
      const nextChapters = [...prev.chapters];
      nextChapters.splice(insertIdx, 0, newChapter);
      return {
        ...prev,
        chapters: nextChapters.map((c, idx) => ({ ...c, order: idx })),
      };
    });
  }

  function handleUpdateChapterTitle(chapterId: string, title: string) {
    setChart((prev) => ({
      ...prev,
      chapters: prev.chapters.map((c) => (c.id === chapterId ? { ...c, title } : c)),
    }));
  }

  function handleDeleteChapter(chapterId: string) {
    if (chart.chapters.length <= 1) return;
    pushUndoSnapshot(chart);
    setChart((prev) => {
      const filtered = prev.chapters.filter((c) => c.id !== chapterId);
      return {
        ...prev,
        chapters: filtered.map((c, idx) => ({ ...c, order: idx })),
      };
    });
  }

  // Export JSON
  function handleExportJson() {
    const blob = new Blob([JSON.stringify(chart, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${chart.name || "novel-flowchart"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Import JSON
  function handleImportJson(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as FlowchartData;
        if (parsed && Array.isArray(parsed.chapters) && Array.isArray(parsed.nodes)) {
          pushUndoSnapshot(chart);
          setChart({
            ...parsed,
            id: parsed.id || chart.id || uid("proj"),
            name: parsed.name || file.name.replace(/\.json$/i, ""),
          });
          setSelectedNodeIds([]);
          setPlusMenu(null);
        }
      } catch {
        alert("JSONファイルの読み込みに失敗しました。");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  // Create a brand new minimal project
  function handleNewProject() {
    const newId = uid("proj");
    const minimal = createMinimalFlowchart(newId, `新規ノベル企画 (${projects.length + 1})`);
    setUndoStack([]);
    setRedoStack([]);
    setChart(minimal);
    setSelectedNodeIds(["node-start"]);
    setPlusMenu(null);
    setMergeMode(null);
  }

  // Switch project from SQLite list
  async function handleSelectProject(projectId: string) {
    try {
      const res = await fetch(`/api/flowchart/${encodeURIComponent(projectId)}`);
      if (res.ok) {
        const data = (await res.json()) as FlowchartData;
        setUndoStack([]);
        setRedoStack([]);
        setChart(data);
        setSelectedNodeIds([]);
        setPlusMenu(null);
        setMergeMode(null);
      }
    } catch {
      // ignore
    }
  }

  // Add a root node if all nodes were deleted
  function handleAddRootNode() {
    pushUndoSnapshot(chart);
    const newId = uid("node");
    const newNode: FlowNode = {
      id: newId,
      type: "rect",
      title: "第1節：始まり",
      content: "",
      x: 540,
      y: 110,
      isEnd: false,
      branchCount: 1,
    };
    setChart((prev) => ({
      ...prev,
      nodes: [...prev.nodes, newNode],
    }));
    setSelectedNodeIds([newId]);
  }

  // Handle clicking or Ctrl+clicking a node (or selecting a branch / rewinding in Route Trace Mode)
  function handleNodeClick(e: React.MouseEvent, nodeId: string) {
    e.stopPropagation();
    if (mergeMode) return;

    if (routeTraceMode) {
      const nextChoiceEdge = nextBranchEdgeByTargetId.get(nodeId);
      if (nextChoiceEdge) {
        handleChooseRouteBranch(nextChoiceEdge);
        return;
      }
      const switchableItem = switchableBranchByTargetId.get(nodeId);
      if (switchableItem) {
        handleSwitchBranchAtStep(switchableItem.stepIdx, switchableItem.edge);
        return;
      }
      const visitedStepIdx = routeStepIndexMap.get(nodeId);
      if (visitedStepIdx !== undefined) {
        handleRewindRouteToStep(visitedStepIdx);
        return;
      }
      handleStartRouteFromNode(nodeId);
      return;
    }

    // If the user just finished dragging a node or group, keep the selection intact!
    if (suppressClickAfterDragRef.current) {
      suppressClickAfterDragRef.current = false;
      if (!selectedNodeSet.has(nodeId)) {
        setSelectedNodeIds([nodeId]);
      }
      return;
    }

    setSelectedEdgeId(null);
    setPlusMenu(null);

    if (e.ctrlKey || e.metaKey || isMultiSelectMode) {
      // Toggle this node in multi-selection
      setSelectedNodeIds((prev) =>
        prev.includes(nodeId) ? prev.filter((id) => id !== nodeId) : [...prev, nodeId]
      );
    } else {
      setSelectedNodeIds([nodeId]);
    }
  }

  // Authentication Gate: prevent unauthorized access before rendering the flowchart
  if (authState !== "authenticated") {
    return (
      <div className="auth-gate-screen">
        <div className="auth-gate-card">
          <div className="auth-gate-logo">◇</div>
          <h1 className="auth-gate-title">Novel Flowchart Builder</h1>

          {authState === "checking" && (
            <p className="auth-gate-subtitle">認証状態を確認しています...</p>
          )}

          {authState === "forbidden" && (
            <>
              <div className="auth-error-box">
                <strong>アクセス権限がありません (403 Forbidden)</strong>
                <p>{authUser?.reason || "このGoogleアカウントにはアクセス権限が付与されていません。"}</p>
                {authUser?.email && (
                  <p className="auth-current-email">ログイン中: {authUser.email}</p>
                )}
              </div>
              <div className="auth-gate-actions">
                <button type="button" className="btn btn-secondary" onClick={handleLogout}>
                  別のアカウントでログイン
                </button>
              </div>
            </>
          )}

          {authState === "unauthenticated" && (
            <>
              <p className="auth-gate-subtitle">
                このアプリケーションを閲覧・編集するには Google アカウントによる認証が必要です。
              </p>

              {authUser?.reason && (
                <div className="auth-error-box">
                  <p>{authUser.reason}</p>
                </div>
              )}

              {authUser?.googleClientId && (
                <div className="auth-google-btn-wrap">
                  <div ref={googleBtnRef} />
                </div>
              )}

              <div className="auth-gate-actions">
                <a href="/cdn-cgi/access/login" className="btn btn-primary auth-cf-btn">
                  🔒 Cloudflare Access (Google) でログイン
                </a>
              </div>

              <div className="auth-setup-note">
                <strong>管理者向けセットアップ案内：</strong>
                <ol>
                  <li>
                    <strong>Cloudflare Zero Trust (Access) を使う場合：</strong>
                    Cloudflare ダッシュボードの <em>Zero Trust &gt; Access &gt; Applications</em> でこの Worker ドメインを登録し、Google 認証と許可メールアドレスのポリシーを設定してください。
                  </li>
                  <li>
                    <strong>アプリ単体で Google 認証を使う場合（リポジトリにメアドを残さない方法）：</strong>
                    <code>bun x wrangler secret put ALLOWED_EMAILS</code> で許可するGoogleメールアドレスをシークレット登録してください。
                  </li>
                </ol>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {/* Top Header Toolbar */}
      <header className="top-header">
        <div className="brand-group">
          <div className="brand-logo">◇</div>
          <input
            type="text"
            className="project-title-input"
            value={chart.name}
            onChange={(e) => setChart((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="プロジェクト名を入力"
            title="プロジェクト名"
          />
          {projects.length > 1 && (
            <select
              className="project-select"
              value={chart.id}
              onChange={(e) => handleSelectProject(e.target.value)}
              title="保存済みプロジェクトを切り替え"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <span className={`save-badge save-${saveStatus}`}>
            {saveStatus === "saved" && "✓ SQLite & Local 自動保存済"}
            {saveStatus === "saving" && "⟳ 保存中..."}
            {saveStatus === "offline" && "● LocalStorage保存済"}
          </span>
        </div>

        <div className="toolbar-actions">
          <div className="legend-items">
            <span className="legend-pill">
              <span className="legend-box rect-swatch" /> 四角＝節
            </span>
            <span className="legend-pill">
              <span className="legend-box diamond-swatch" /> ひし形＝分岐
            </span>
            <span className="legend-pill">
              <span className="legend-box diamond-red-swatch" /> 赤ひし形＝未接続の分岐あり
            </span>
          </div>

          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleUndo}
            disabled={undoStack.length === 0}
            title="直前の削除・移動・変更を元に戻す (Ctrl + Z)"
          >
            ↩ 元に戻す
          </button>
          {redoStack.length > 0 && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleRedo}
              title="やり直す (Ctrl + Y)"
            >
              ↪ やり直す
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleAutoSort}
            title="ツリー構造に合わせて図形の位置を上から下へ自動整列します"
          >
            ⇄ 自動ソート（整列）
          </button>
          <button
            type="button"
            className={`btn ${routeTraceMode ? "btn-route-active" : "btn-secondary"}`}
            onClick={handleToggleRouteTraceMode}
            title="辿ってきたルートをハイライトし、分岐を選択しながら変数・フラグの変化を確認します"
          >
            {routeTraceMode ? "🧭 ルート確認中 (ON)" : "🧭 ルート確認モード"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShowVariableModal(true)}
            title="プロジェクト全体のフラグ・変数（string / number / boolean と初期値）を管理します"
          >
            🚩 変数・フラグ ({(chart.variables ?? []).length})
          </button>
          <button
            type="button"
            className={`btn ${isMultiSelectMode ? "btn-primary" : "btn-secondary"}`}
            onClick={() => {
              setRouteTraceMode(false);
              setIsMultiSelectMode((prev) => !prev);
            }}
            title="複数選択モードのON/OFF（スマホ・タブレットでもタップやドラッグで複数選択できます）"
          >
            {isMultiSelectMode ? "☑ 複数選択ON" : "☐ 複数選択"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => handleAddChapter()}
          >
            ＋ 章エリアを追加
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleNewProject}
          >
            新規チャート
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleExportJson}
          >
            JSON出力
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => fileInputRef.current?.click()}
          >
            JSON読込
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={handleImportJson}
          />
          {authUser?.email && authUser.email !== "local@dev" && (
            <div className="auth-user-pill" title={`ログイン中: ${authUser.email}`}>
              <span className="auth-user-email">{authUser.email}</span>
              <button
                type="button"
                className="btn btn-small auth-logout-btn"
                onClick={handleLogout}
              >
                ログアウト
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Multi-Selection Action Banner (shown when 2 or more shapes are selected, or when Multi-Select Mode is ON) */}
      {(selectedNodeIds.length >= 2 || isMultiSelectMode) && (
        <div className="multi-select-banner">
          <div className="multi-select-info">
            <span className="multi-count-badge">
              {selectedNodeIds.length > 0
                ? `${selectedNodeIds.length} 個の図形を選択中`
                : "複数選択モード ON"}
            </span>
            <span className="multi-select-hint">
              （図形をタップで追加・解除 ／ 選択図形をドラッグしてまとめて移動 ／ 一括削除）
            </span>
          </div>
          <div className="multi-select-actions">
            {selectedNodeIds.length > 0 && (
              <button
                type="button"
                className="btn btn-danger-solid"
                onClick={() => handleDeleteNodes(selectedNodeIds)}
              >
                🗑 {selectedNodeIds.length} 個を削除
              </button>
            )}
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                setSelectedNodeIds([]);
                setIsMultiSelectMode(false);
              }}
            >
              選択解除
            </button>
          </div>
        </div>
      )}

      {/* Route Trace / Simulation Mode Banner */}
      {routeTraceMode && (
        <div className="route-trace-banner">
          <div className="route-trace-banner-info">
            <span className="route-trace-badge">
              🧭 ルート確認モード（{routeNodeIds.length} ステップ通過中）
            </span>
            <span className="route-trace-hint">
              オレンジ色の分岐先またはパネルの選択肢をタップして進行 ／ 通過済みの緑色図形をタップでその時点へ巻き戻し
            </span>
          </div>
          <div className="route-trace-banner-actions">
            <button
              type="button"
              className="btn btn-small"
              onClick={handleResetRouteTrace}
              title="最初の開始ノードからルート確認をやり直します"
            >
              ↺ 最初から
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setRouteDrawerMinimized((prev) => !prev)}
            >
              {routeDrawerMinimized ? "📊 変数・分岐パネルを開く" : "パネルを隠す"}
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setRouteTraceMode(false)}
            >
              通常編集に戻る
            </button>
          </div>
        </div>
      )}

      {/* Merge Mode Banner */}
      {mergeMode && (
        <div className="merge-mode-banner">
          <span>
            🔗 <strong>合流モード：</strong>
            接続したい既存の図形（四角またはひし形）をキャンバス上でクリックしてください。
          </span>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => setMergeMode(null)}
          >
            キャンセル (Esc)
          </button>
        </div>
      )}

      {/* Main Workspace: Scrollable Canvas + Right Drawer */}
      <div className="workspace-body">
        <div className="canvas-viewport-wrapper">
          <div
            ref={canvasScrollRef}
            className="canvas-scroll-container"
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              setPlusMenu(null);
              setSelectedEdgeId(null);
              const coords = clientToCanvasCoords(e.clientX, e.clientY);
              const additive = e.ctrlKey || e.metaKey || isMultiSelectMode;
              setMarquee({
                startX: coords.x,
                startY: coords.y,
                currX: coords.x,
                currY: coords.y,
                additive,
                initialSelectedIds: additive ? [...selectedNodeIds] : [],
                hasDragged: false,
              });
            }}
            onTouchStart={(e) => {
              if (e.touches.length !== 1) return;
              setPlusMenu(null);
              setSelectedEdgeId(null);
              if (isMultiSelectMode) {
                const touch = e.touches[0]!;
                const coords = clientToCanvasCoords(touch.clientX, touch.clientY);
                setMarquee({
                  startX: coords.x,
                  startY: coords.y,
                  currX: coords.x,
                  currY: coords.y,
                  additive: true,
                  initialSelectedIds: [...selectedNodeIds],
                  hasDragged: false,
                });
              }
            }}
          >
            {/* Outer wrapper scaled to match zoom dimensions for accurate scrollbars */}
            <div
              className="canvas-zoom-sizer"
              style={{
                width: `${Math.round(totalCanvasWidth * zoom)}px`,
                height: `${Math.round(totalCanvasHeight * zoom)}px`,
              }}
            >
              <div
                ref={flowchartCanvasRef}
                className="flowchart-canvas"
                style={{
                  width: `${totalCanvasWidth}px`,
                  height: `${totalCanvasHeight}px`,
                  transform: `scale(${zoom})`,
                  transformOrigin: "0 0",
                }}
              >
                {/* 1. Horizontal Chapter Lanes Layer */}
                {chapterRanges.map((ch) => (
                  <div
                    key={ch.id}
                    className={`chapter-lane ${
                      ch.index % 2 === 1 ? "chapter-lane-alt" : ""
                    }`}
                    style={{
                      top: `${ch.top}px`,
                      height: `${ch.height}px`,
                    }}
                  >
                    {/* Left Sticky Header inside each Chapter Lane */}
                    <div
                      className="chapter-lane-sidebar"
                      style={{ width: `${CHAPTER_HEADER_WIDTH}px` }}
                      onMouseDown={(e) => e.stopPropagation()}
                      onTouchStart={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="chapter-badge-row">
                        <span className="chapter-number-badge">
                          CHAPTER {ch.index + 1}
                        </span>
                        <div className="chapter-mini-actions">
                          <button
                            type="button"
                            className="icon-btn"
                            title="この章の下に新しい章を追加"
                            onClick={() => handleAddChapter(ch.index)}
                          >
                            ＋
                          </button>
                          {chart.chapters.length > 1 && (
                            <button
                              type="button"
                              className="icon-btn icon-btn-danger"
                              title="この章エリアを削除"
                              onClick={() => handleDeleteChapter(ch.id)}
                            >
                              ×
                            </button>
                          )}
                        </div>
                      </div>
                      <input
                        type="text"
                        className="chapter-title-input"
                        value={ch.title}
                        onChange={(e) =>
                          handleUpdateChapterTitle(ch.id, e.target.value)
                        }
                        placeholder="章タイトルを入力..."
                      />
                      <div className="chapter-height-info">
                        高さ: {Math.round(ch.height)}px
                      </div>
                    </div>

                    {/* Horizontal Divider Line + Drag Resize Handle at bottom of chapter */}
                    <div
                      className="chapter-divider-line"
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        setResizingChapter({
                          chapterId: ch.id,
                          startY: e.clientY,
                          origHeight: ch.height,
                          chapterBottomYAtStart: ch.bottom,
                          shiftNodesBelow: !e.altKey,
                          snapshotBeforeResize: cloneFlowchart(chart),
                          hasResized: false,
                        });
                      }}
                      onTouchStart={(e) => {
                        if (e.touches.length !== 1) return;
                        e.stopPropagation();
                        setResizingChapter({
                          chapterId: ch.id,
                          startY: e.touches[0]!.clientY,
                          origHeight: ch.height,
                          chapterBottomYAtStart: ch.bottom,
                          shiftNodesBelow: true,
                          snapshotBeforeResize: cloneFlowchart(chart),
                          hasResized: false,
                        });
                      }}
                      title="上下にドラッグして章エリアの高さを変更（Altキーを押しながらで下部ノード位置を固定）"
                    >
                      <span className="chapter-resize-pill">
                        ⇕ 章の境界線（ドラッグで高さ調整）
                      </span>
                    </div>
                  </div>
                ))}

                {/* Button at the bottom of the last chapter lane to add another chapter */}
                <div
                  className="add-chapter-bottom-bar"
                  style={{
                    top: `${
                      chapterRanges.length > 0
                        ? chapterRanges[chapterRanges.length - 1]!.bottom
                        : 0
                    }px`,
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="add-chapter-bottom-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAddChapter();
                    }}
                  >
                    ＋ 新しい章エリア（水平レーン）を下に追加
                  </button>
                </div>

                {/* Empty state button if all nodes were deleted */}
                {chart.nodes.length === 0 && (
                  <div
                    className="empty-canvas-cta"
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <p>キャンバス上に図形がありません。</p>
                    <div style={{ display: "flex", gap: "8px", justifyContent: "center" }}>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={handleAddRootNode}
                      >
                        ＋ 最初の四角（節）を作成する
                      </button>
                      {undoStack.length > 0 && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={handleUndo}
                        >
                          ↩ 直前の削除を元に戻す
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* 2. SVG Connections & Stems Layer */}
                <svg
                  className="connections-svg"
                  width={totalCanvasWidth}
                  height={totalCanvasHeight}
                >
                  <defs>
                    <marker
                      id="arrow-normal"
                      viewBox="0 0 10 10"
                      refX="8"
                      refY="5"
                      markerWidth="7"
                      markerHeight="7"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1 L 10 5 L 0 9 z" fill="#475569" />
                    </marker>
                    <marker
                      id="arrow-selected"
                      viewBox="0 0 10 10"
                      refX="8"
                      refY="5"
                      markerWidth="7"
                      markerHeight="7"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1 L 10 5 L 0 9 z" fill="#2563eb" />
                    </marker>
                    <marker
                      id="arrow-route"
                      viewBox="0 0 10 10"
                      refX="8"
                      refY="5"
                      markerWidth="7"
                      markerHeight="7"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1 L 10 5 L 0 9 z" fill="#059669" />
                    </marker>
                    <marker
                      id="arrow-route-choice"
                      viewBox="0 0 10 10"
                      refX="8"
                      refY="5"
                      markerWidth="7"
                      markerHeight="7"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1 L 10 5 L 0 9 z" fill="#d97706" />
                    </marker>
                    <marker
                      id="arrow-route-switch"
                      viewBox="0 0 10 10"
                      refX="8"
                      refY="5"
                      markerWidth="7"
                      markerHeight="7"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1 L 10 5 L 0 9 z" fill="#4f46e5" />
                    </marker>
                  </defs>

                  {/* 2a. Stems from each node to its circular (+) buttons */}
                  {chart.nodes.map((node) => {
                    if (node.type === "rect" && node.isEnd) {
                      return null;
                    }
                    const bottom = getNodeBottomPoint(node);
                    const slotCount = getNodeSlotCount(node);
                    const branchState = getNodeBranchState(node);

                    return Array.from({ length: slotCount }, (_, slotIdx) => {
                      const plusPos = getSlotPlusPosition(node, slotIdx);
                      const isUnconnected = !branchState.connectedSlots.has(slotIdx);

                      return (
                        <line
                          key={`stem-${node.id}-${slotIdx}`}
                          x1={bottom.x}
                          y1={bottom.y}
                          x2={plusPos.x}
                          y2={plusPos.y - PLUS_RADIUS}
                          stroke={
                            node.type === "diamond" && isUnconnected
                              ? "#ef4444"
                              : "#64748b"
                          }
                          strokeWidth={2}
                          strokeDasharray={isUnconnected ? "4 3" : undefined}
                        />
                      );
                    });
                  })}

                  {/* 2b. Full Connecting Lines from slot (+) button to target node top */}
                  {chart.edges.map((edge) => {
                    const sourceNode = nodeMap.get(edge.sourceId);
                    const targetNode = nodeMap.get(edge.targetId);
                    if (!sourceNode || !targetNode) return null;
                    if (sourceNode.type === "rect" && sourceNode.isEnd) return null;

                    const { pathD } = computeEdgeGeometry(
                      edge,
                      sourceNode,
                      targetNode,
                      chart.nodes
                    );

                    const isSelected = selectedEdgeId === edge.id;
                    const isRouteTraversed = routeTraceMode && routeEdgeSet.has(edge.id);
                    const isRouteChoice = routeTraceMode && nextBranchEdgeSet.has(edge.id);
                    const switchableItem = routeTraceMode
                      ? switchableBranchByEdgeId.get(edge.id)
                      : undefined;
                    const isRouteSwitchable = Boolean(switchableItem);
                    const isRouteDimmed =
                      routeTraceMode &&
                      !isRouteTraversed &&
                      !isRouteChoice &&
                      !isRouteSwitchable;

                    return (
                      <g
                        key={edge.id}
                        className={`edge-group ${
                          isRouteTraversed
                            ? "edge-route-traversed"
                            : isRouteChoice
                              ? "edge-route-choice"
                              : isRouteSwitchable
                                ? "edge-route-switchable"
                                : isRouteDimmed
                                  ? "edge-route-dimmed"
                                  : ""
                        }`}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (routeTraceMode) {
                            if (isRouteChoice) {
                              handleChooseRouteBranch(edge);
                            } else if (switchableItem) {
                              handleSwitchBranchAtStep(
                                switchableItem.stepIdx,
                                switchableItem.edge
                              );
                            }
                            return;
                          }
                          setSelectedEdgeId(edge.id);
                          setPlusMenu(null);
                        }}
                      >
                        <path
                          d={pathD}
                          fill="none"
                          stroke="transparent"
                          strokeWidth={18}
                          style={{ cursor: "pointer" }}
                        />
                        <path
                          d={pathD}
                          fill="none"
                          className={
                            isRouteTraversed
                              ? "edge-path-route-active"
                              : isRouteChoice
                                ? "edge-path-route-choice"
                                : isRouteSwitchable
                                  ? "edge-path-route-switchable"
                                  : ""
                          }
                          stroke={
                            isRouteTraversed
                              ? "#059669"
                              : isRouteChoice
                                ? "#d97706"
                                : isRouteSwitchable
                                  ? "#4f46e5"
                                  : isSelected
                                    ? "#2563eb"
                                    : "#475569"
                          }
                          strokeWidth={
                            isRouteTraversed
                              ? 4.5
                              : isRouteChoice
                                ? 3.5
                                : isRouteSwitchable
                                  ? 3.2
                                  : isSelected
                                    ? 3.2
                                    : 2.2
                          }
                          strokeDasharray={
                            isRouteChoice
                              ? "7 5"
                              : isRouteSwitchable
                                ? "5 4"
                                : undefined
                          }
                          markerEnd={
                            isRouteTraversed
                              ? "url(#arrow-route)"
                              : isRouteChoice
                                ? "url(#arrow-route-choice)"
                                : isRouteSwitchable
                                  ? "url(#arrow-route-switch)"
                                  : isSelected
                                    ? "url(#arrow-selected)"
                                    : "url(#arrow-normal)"
                          }
                          style={{ cursor: "pointer" }}
                        />
                      </g>
                    );
                  })}
                </svg>

                {/* 2c. Edge Comment Badges & Interactive Popover on Lines */}
                {chart.edges.map((edge) => {
                  const sourceNode = nodeMap.get(edge.sourceId);
                  const targetNode = nodeMap.get(edge.targetId);
                  if (!sourceNode || !targetNode) return null;
                  if (sourceNode.type === "rect" && sourceNode.isEnd) return null;

                  const { midX, midY } = computeEdgeGeometry(
                    edge,
                    sourceNode,
                    targetNode,
                    chart.nodes
                  );
                  const hasLabel = Boolean(edge.label && edge.label.trim().length > 0);
                  const branchEffects = (sourceNode.effects ?? []).filter(
                    (eff) => eff.branchSlot === edge.sourceSlot
                  );
                  const hasBranchEffects = branchEffects.length > 0;
                  const isSelected = !routeTraceMode && selectedEdgeId === edge.id;
                  const isRouteChoice = routeTraceMode && nextBranchEdgeSet.has(edge.id);
                  const isRouteTraversed = routeTraceMode && routeEdgeSet.has(edge.id);
                  const switchableItem = routeTraceMode
                    ? switchableBranchByEdgeId.get(edge.id)
                    : undefined;
                  const isRouteSwitchable = Boolean(switchableItem);

                  if (
                    !hasLabel &&
                    !hasBranchEffects &&
                    !isSelected &&
                    !isRouteChoice &&
                    !isRouteSwitchable
                  ) {
                    return null;
                  }

                  return (
                    <div
                      key={`edge-label-${edge.id}`}
                      className={`edge-label-anchor ${
                        isSelected ? "edge-label-selected" : ""
                      }`}
                      style={{
                        left: `${midX}px`,
                        top: `${midY}px`,
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (routeTraceMode) {
                          if (isRouteChoice) {
                            handleChooseRouteBranch(edge);
                          } else if (switchableItem) {
                            handleSwitchBranchAtStep(
                              switchableItem.stepIdx,
                              switchableItem.edge
                            );
                          }
                          return;
                        }
                        setSelectedEdgeId(edge.id);
                        setPlusMenu(null);
                      }}
                    >
                      {isSelected ? (
                        <div className="edge-comment-editor">
                          <input
                            type="text"
                            className="edge-comment-input"
                            value={edge.label ?? ""}
                            autoFocus
                            onChange={(e) =>
                              handleUpdateEdgeLabel(edge.id, e.target.value)
                            }
                            placeholder="例：SAN値が80以下の場合"
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                setSelectedEdgeId(null);
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="edge-comment-done-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedEdgeId(null);
                            }}
                            title="閉じる"
                          >
                            ✓
                          </button>
                          <button
                            type="button"
                            className="edge-comment-delete-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              pushUndoSnapshot(chart);
                              setChart((prev) => ({
                                ...prev,
                                edges: prev.edges.filter((item) => item.id !== edge.id),
                              }));
                              setSelectedEdgeId(null);
                            }}
                            title="この接続線を削除"
                          >
                            🗑
                          </button>
                        </div>
                      ) : (
                        <div className="edge-badge-stack">
                          {(hasLabel || isRouteChoice || isRouteSwitchable) && (
                            <div
                              className={`edge-comment-pill ${
                                isRouteTraversed
                                  ? "edge-pill-route-traversed"
                                  : isRouteChoice
                                    ? "edge-pill-route-choice"
                                    : isRouteSwitchable
                                      ? "edge-pill-route-switchable"
                                      : ""
                              }`}
                              title={
                                isRouteChoice
                                  ? "タップしてこの分岐ルートを選択"
                                  : isRouteSwitchable
                                    ? "タップして途中の分岐をこのルートへ切り替え"
                                    : "クリックして線のコメントを編集"
                              }
                            >
                              {isRouteChoice
                                ? `👉 分岐${edge.sourceSlot + 1}${
                                    edge.label ? `: ${edge.label}` : " を選択"
                                  }`
                                : isRouteSwitchable
                                  ? `⇄ 分岐${edge.sourceSlot + 1}へ切替${
                                      edge.label ? `: ${edge.label}` : ""
                                    }`
                                  : edge.label}
                            </div>
                          )}
                          {hasBranchEffects && (
                            <div className="edge-effects-pill-row">
                              {branchEffects.map((eff) => (
                                <span key={eff.id} className="node-effect-mini-chip">
                                  ⚡{" "}
                                  {formatEffectSummary(
                                    { ...eff, branchSlot: null },
                                    variableMap.get(eff.variableId)
                                  )}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* 3. Nodes & Circular (+) Buttons Layer */}
                {chart.nodes.map((node) => {
                  const isSelected = selectedNodeSet.has(node.id);
                  const isMultiSelected = isSelected && selectedNodeIds.length >= 2;
                  const isMergeCandidate =
                    mergeMode !== null && mergeMode.sourceId !== node.id;
                  const branchState = getNodeBranchState(node);
                  const slotCount = branchState.branchCount;

                  const visitedStepIdx = routeTraceMode
                    ? routeStepIndexMap.get(node.id)
                    : undefined;
                  const isRouteVisited = visitedStepIdx !== undefined;
                  const isRouteCurrent = routeTraceMode && currentRouteNodeId === node.id;
                  const nextChoiceEdge = routeTraceMode
                    ? nextBranchEdgeByTargetId.get(node.id)
                    : undefined;
                  const isRouteNextChoice = Boolean(nextChoiceEdge);
                  const switchableTargetItem = routeTraceMode
                    ? switchableBranchByTargetId.get(node.id)
                    : undefined;
                  const isRouteSwitchable = Boolean(switchableTargetItem);
                  const isRouteDimmed =
                    routeTraceMode &&
                    !isRouteVisited &&
                    !isRouteNextChoice &&
                    !isRouteSwitchable;

                  // 四角（節）自体に設定された変数変更のみノード上に表示（ひし形の選択肢別変更は各分岐線に表示）
                  const rectNodeEffects =
                    node.type === "rect"
                      ? (node.effects ?? []).filter(
                          (eff) => eff.branchSlot === null || eff.branchSlot === undefined
                        )
                      : [];

                  return (
                    <React.Fragment key={node.id}>
                      {/* Shape Body (Rectangle or Diamond) */}
                      {node.type === "rect" ? (
                        <div
                          className={`flow-node rect-node ${
                            isSelected ? "node-selected" : ""
                          } ${isMultiSelected ? "node-multi-selected" : ""} ${
                            node.isEnd ? "rect-node-end" : ""
                          } ${isMergeCandidate ? "node-merge-target" : ""} ${
                            isRouteVisited ? "node-route-visited" : ""
                          } ${isRouteCurrent ? "node-route-current" : ""} ${
                            isRouteNextChoice ? "node-route-next-choice" : ""
                          } ${isRouteSwitchable ? "node-route-switchable" : ""} ${
                            isRouteDimmed ? "node-route-dimmed" : ""
                          }`}
                          style={{
                            left: `${node.x - RECT_WIDTH / 2}px`,
                            top: `${node.y - RECT_HEIGHT / 2}px`,
                            width: `${RECT_WIDTH}px`,
                            height: `${RECT_HEIGHT}px`,
                          }}
                          onMouseDown={(e) => handleNodeMouseDown(e, node)}
                          onTouchStart={(e) => handleNodeTouchStart(e, node)}
                          onClick={(e) => handleNodeClick(e, node.id)}
                        >
                          {isRouteVisited && (
                            <div
                              className={`route-step-floating-badge ${
                                isRouteCurrent ? "route-step-current" : ""
                              }`}
                            >
                              STEP {visitedStepIdx + 1}
                              {isRouteCurrent ? "（現在地）" : ""}
                            </div>
                          )}
                          {isRouteNextChoice && nextChoiceEdge && (
                            <div className="route-choice-floating-badge">
                              👉 分岐 {nextChoiceEdge.sourceSlot + 1} を選択
                            </div>
                          )}
                          {!isRouteNextChoice &&
                            isRouteSwitchable &&
                            switchableTargetItem && (
                              <div className="route-switch-floating-badge">
                                ⇄ 分岐 {switchableTargetItem.edge.sourceSlot + 1} へ切替
                              </div>
                            )}
                          {rectNodeEffects.length > 0 && (
                            <div className="node-effects-floating-strip">
                              {rectNodeEffects.slice(0, 2).map((eff) => (
                                <span key={eff.id} className="node-effect-mini-chip">
                                  ⚡ {formatEffectSummary(eff, variableMap.get(eff.variableId))}
                                </span>
                              ))}
                              {rectNodeEffects.length > 2 && (
                                <span className="node-effect-mini-chip">
                                  +{rectNodeEffects.length - 2}
                                </span>
                              )}
                            </div>
                          )}
                          <div className="rect-node-header">
                            <span className="node-kind-tag">
                              {!node.isEnd && slotCount > 1
                                ? `節 (${slotCount}分岐)`
                                : "節"}
                            </span>
                            {node.isEnd && <span className="end-flag-badge">END</span>}
                          </div>
                          <div className="node-title-text">
                            {node.title.trim() || "（タイトル未入力）"}
                          </div>
                          <div className="node-content-preview">
                            {node.content.trim() || "クリックしてテキストを入力..."}
                          </div>
                        </div>
                      ) : (
                        /* Diamond Node (分岐) */
                        <div
                          className={`flow-node diamond-node ${
                            branchState.isIncomplete
                              ? "diamond-incomplete-red"
                              : "diamond-complete"
                          } ${isSelected ? "node-selected" : ""} ${
                            isMultiSelected ? "node-multi-selected" : ""
                          } ${isMergeCandidate ? "node-merge-target" : ""} ${
                            isRouteVisited ? "node-route-visited" : ""
                          } ${isRouteCurrent ? "node-route-current" : ""} ${
                            isRouteNextChoice ? "node-route-next-choice" : ""
                          } ${isRouteSwitchable ? "node-route-switchable" : ""} ${
                            isRouteDimmed ? "node-route-dimmed" : ""
                          }`}
                          style={{
                            left: `${node.x - DIAMOND_WIDTH / 2}px`,
                            top: `${node.y - DIAMOND_HEIGHT / 2}px`,
                            width: `${DIAMOND_WIDTH}px`,
                            height: `${DIAMOND_HEIGHT}px`,
                          }}
                          onMouseDown={(e) => handleNodeMouseDown(e, node)}
                          onTouchStart={(e) => handleNodeTouchStart(e, node)}
                          onClick={(e) => handleNodeClick(e, node.id)}
                        >
                          {isRouteVisited && (
                            <div
                              className={`route-step-floating-badge ${
                                isRouteCurrent ? "route-step-current" : ""
                              }`}
                            >
                              STEP {visitedStepIdx + 1}
                              {isRouteCurrent ? "（現在地・分岐選択）" : ""}
                            </div>
                          )}
                          {isRouteNextChoice && nextChoiceEdge && (
                            <div className="route-choice-floating-badge">
                              👉 分岐 {nextChoiceEdge.sourceSlot + 1} を選択
                            </div>
                          )}
                          {!isRouteNextChoice &&
                            isRouteSwitchable &&
                            switchableTargetItem && (
                              <div className="route-switch-floating-badge">
                                ⇄ 分岐 {switchableTargetItem.edge.sourceSlot + 1} へ切替
                              </div>
                            )}
                          <svg
                            className="diamond-shape-svg"
                            viewBox={`0 0 ${DIAMOND_WIDTH} ${DIAMOND_HEIGHT}`}
                            width={DIAMOND_WIDTH}
                            height={DIAMOND_HEIGHT}
                          >
                            <polygon
                              points={`${DIAMOND_WIDTH / 2},3 ${DIAMOND_WIDTH - 3},${
                                DIAMOND_HEIGHT / 2
                              } ${DIAMOND_WIDTH / 2},${DIAMOND_HEIGHT - 3} 3,${
                                DIAMOND_HEIGHT / 2
                              }`}
                              className="diamond-polygon"
                            />
                          </svg>
                          <div className="diamond-inner-content">
                            <span className="diamond-status-tag">
                              {branchState.isIncomplete
                                ? `分岐未接続 (${branchState.connectedCount}/${branchState.branchCount})`
                                : `分岐 (${branchState.branchCount})`}
                            </span>
                            <div className="diamond-title-text">
                              {node.title.trim() || "（分岐タイトル）"}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Circular (+) Buttons below the shape */}
                      {Array.from({ length: slotCount }, (_, slotIdx) => {
                        const plusPos = getSlotPlusPosition(node, slotIdx);
                        const connectedEdge = chart.edges.find(
                          (e) =>
                            e.sourceId === node.id &&
                            e.sourceSlot === slotIdx &&
                            nodeMap.has(e.targetId)
                        );
                        const isMenuOpen =
                          plusMenu?.nodeId === node.id && plusMenu?.slot === slotIdx;

                        return (
                          <button
                            key={`plus-${node.id}-${slotIdx}`}
                            type="button"
                            className={`circle-plus-btn ${
                              connectedEdge
                                ? "circle-plus-connected"
                                : "circle-plus-unconnected"
                            } ${
                              node.type === "diamond" && !connectedEdge
                                ? "circle-plus-danger"
                                : ""
                            } ${isMenuOpen ? "circle-plus-active" : ""}`}
                            style={{
                              left: `${plusPos.x - PLUS_RADIUS}px`,
                              top: `${plusPos.y - PLUS_RADIUS}px`,
                              width: `${PLUS_RADIUS * 2}px`,
                              height: `${PLUS_RADIUS * 2}px`,
                            }}
                            title={
                              slotCount > 1
                                ? `分岐 ${slotIdx + 1} の接続先を追加・変更`
                                : "次の図形（四角またはひし形）を追加"
                            }
                            onMouseDown={(e) => e.stopPropagation()}
                            onTouchStart={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              setMergeMode(null);
                              setPlusMenu((prev) =>
                                prev &&
                                prev.nodeId === node.id &&
                                prev.slot === slotIdx
                                  ? null
                                  : {
                                      nodeId: node.id,
                                      slot: slotIdx,
                                      x: plusPos.x,
                                      y: plusPos.y + PLUS_RADIUS + 8,
                                    }
                              );
                            }}
                          >
                            ＋
                          </button>
                        );
                      })}
                    </React.Fragment>
                  );
                })}

                {/* 4. Marquee Rubber-band Selection Box */}
                {marquee && marquee.hasDragged && (
                  <div
                    className="marquee-selection-box"
                    style={{
                      left: `${Math.min(marquee.startX, marquee.currX)}px`,
                      top: `${Math.min(marquee.startY, marquee.currY)}px`,
                      width: `${Math.abs(marquee.currX - marquee.startX)}px`,
                      height: `${Math.abs(marquee.currY - marquee.startY)}px`,
                    }}
                  />
                )}

                {/* 5. Popover Menu when a Circular (+) Button is clicked */}
                {plusMenu && (
                  <div
                    className="plus-popover-menu"
                    style={{
                      left: `${Math.min(
                        totalCanvasWidth - 260,
                        Math.max(20, plusMenu.x - 115)
                      )}px`,
                      top: `${plusMenu.y}px`,
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    onTouchStart={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="plus-popover-header">
                      <span>接続する図形を選択</span>
                      <button
                        type="button"
                        className="popover-close-btn"
                        onClick={() => setPlusMenu(null)}
                      >
                        ×
                      </button>
                    </div>

                    <div className="plus-popover-choices">
                      <button
                        type="button"
                        className="choice-card-btn choice-rect"
                        onClick={() =>
                          handleCreateChildNode(plusMenu.nodeId, plusMenu.slot, "rect")
                        }
                      >
                        <span className="choice-shape-icon rect-icon">□</span>
                        <div className="choice-label-col">
                          <strong>四角（節）</strong>
                          <span>通常のシナリオ節を追加</span>
                        </div>
                      </button>

                      <button
                        type="button"
                        className="choice-card-btn choice-diamond"
                        onClick={() =>
                          handleCreateChildNode(
                            plusMenu.nodeId,
                            plusMenu.slot,
                            "diamond"
                          )
                        }
                      >
                        <span className="choice-shape-icon diamond-icon">◇</span>
                        <div className="choice-label-col">
                          <strong>ひし形（分岐）</strong>
                          <span>条件・選択肢の分岐を追加</span>
                        </div>
                      </button>
                    </div>

                    <div className="plus-popover-divider" />

                    <button
                      type="button"
                      className="merge-action-btn"
                      onClick={() => {
                        setMergeMode({
                          sourceId: plusMenu.nodeId,
                          sourceSlot: plusMenu.slot,
                        });
                        setPlusMenu(null);
                      }}
                    >
                      🔗 既存の図形へ合流（キャンバスで選択）
                    </button>

                    {chart.edges.some(
                      (e) =>
                        e.sourceId === plusMenu.nodeId && e.sourceSlot === plusMenu.slot
                    ) && (
                      <button
                        type="button"
                        className="disconnect-action-btn"
                        onClick={() =>
                          handleDisconnectSlot(plusMenu.nodeId, plusMenu.slot)
                        }
                      >
                        ✕ 現在の接続線を解除する
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Undo Toast Notification after Deletion */}
          {undoToast && undoStack.length > 0 && (
            <div
              className="undo-toast-bar"
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <span className="undo-toast-message">🗑 {undoToast.message}</span>
              <button
                type="button"
                className="undo-toast-btn"
                onClick={handleUndo}
              >
                ↩ 元に戻す
              </button>
              <button
                type="button"
                className="undo-toast-close"
                onClick={() => setUndoToast(null)}
                title="閉じる"
              >
                ×
              </button>
            </div>
          )}

          {/* Bottom-Right Floating Zoom Controls (＋ / － / リセット) */}
          <div
            className="floating-zoom-controls"
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            title="Ctrl + マウスホイール、またはピンチ操作でも拡大・縮小できます"
          >
            <button
              type="button"
              className="zoom-ctrl-btn"
              onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))}
              disabled={zoom <= MIN_ZOOM}
              title="縮小 (Zoom Out)"
            >
              －
            </button>
            <button
              type="button"
              className="zoom-percent-btn"
              onClick={() => setZoom(1.0)}
              title="クリックで100%にリセット（Ctrl+スクロール対応）"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className="zoom-ctrl-btn"
              onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))}
              disabled={zoom >= MAX_ZOOM}
              title="拡大 (Zoom In)"
            >
              ＋
            </button>
          </div>
        </div>

        {/* Mobile Backdrop for Bottom Sheet Drawer */}
        {(selectedNode || (routeTraceMode && !routeDrawerMinimized)) && (
          <div
            className="drawer-mobile-backdrop"
            onClick={() => {
              if (routeTraceMode) {
                setRouteDrawerMinimized(true);
              } else {
                setSelectedNodeIds([]);
              }
            }}
          />
        )}

        {/* Right Side Drawer (単一図形選択時 または ルート確認モード時に表示) */}
        <aside
          className={`right-drawer ${
            selectedNode || (routeTraceMode && !routeDrawerMinimized) ? "drawer-open" : ""
          }`}
        >
          {routeTraceMode && !routeDrawerMinimized ? (
            <div className="drawer-content">
              <div className="drawer-mobile-pill" />
              <div className="drawer-header route-drawer-header">
                <div className="drawer-type-indicator">
                  <span className="drawer-badge badge-route">
                    🧭 ルート確認 &amp; 変数ステータス
                  </span>
                  <span className="drawer-chapter-tag">
                    現在 {routeNodeIds.length} ステップ通過中
                  </span>
                </div>
                <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={handleResetRouteTrace}
                    title="最初の開始ノードからやり直す"
                  >
                    ↺ リセット
                  </button>
                  <button
                    type="button"
                    className="drawer-close-btn"
                    onClick={() => setRouteDrawerMinimized(true)}
                    title="パネルを隠す"
                  >
                    ×
                  </button>
                </div>
              </div>

              <div className="drawer-body">
                {/* 1. 辿ってきたルートによる変数の現在値 */}
                <div className="route-section-box">
                  <div className="route-section-header">
                    <span className="form-label">📊 現在の変数・フラグ値</span>
                    <button
                      type="button"
                      className="btn-link-inline"
                      onClick={() => setShowVariableModal(true)}
                    >
                      変数定義を編集
                    </button>
                  </div>

                  {routeEvaluation.variableStates.length === 0 ? (
                    <div className="connection-empty-note">
                      変数がまだ定義されていません。上部の「🚩 変数・フラグ」から追加できます。
                    </div>
                  ) : (
                    <div className="route-var-list">
                      {routeEvaluation.variableStates.map((vs) => (
                        <div
                          key={vs.variable.id}
                          className={`route-var-card ${
                            vs.isChanged ? "route-var-changed" : ""
                          }`}
                        >
                          <div className="route-var-top-row">
                            <div className="route-var-name-group">
                              <span className="route-var-name">{vs.variable.name}</span>
                              <span className="route-var-type-tag">
                                {vs.variable.type}
                              </span>
                            </div>
                            <div className="route-var-val-group">
                              {vs.isChanged && (
                                <span className="route-var-default">
                                  初期: {String(vs.variable.defaultValue)} →
                                </span>
                              )}
                              <span
                                className={`route-var-current ${
                                  vs.isChanged ? "route-var-current-highlight" : ""
                                }`}
                              >
                                {String(vs.currentValue)}
                              </span>
                            </div>
                          </div>
                          {vs.history.length > 0 && (
                            <div className="route-var-history">
                              {vs.history.map((h, i) => (
                                <span key={i} className="route-var-history-chip">
                                  STEP {h.stepIndex + 1} ({h.nodeTitle}):{" "}
                                  {String(h.prevValue)} →{" "}
                                  <strong>{String(h.nextValue)}</strong>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 2. 現在の地点からの分岐選択 */}
                <div className="route-section-box route-branch-choice-box">
                  <div className="form-label">
                    🔀 次のルート（分岐）を選択
                  </div>
                  {currentRouteNode ? (
                    <>
                      <div className="route-current-node-summary">
                        <span className="route-current-step-tag">
                          現在地: STEP {routeNodeIds.length}
                        </span>
                        <strong>{currentRouteNode.title || "（無題）"}</strong>
                        {currentRouteNode.content && (
                          <p className="route-current-node-text">
                            {currentRouteNode.content}
                          </p>
                        )}
                      </div>

                      {currentRouteNode.type === "rect" && currentRouteNode.isEnd ? (
                        <div className="route-end-reached-box">
                          🏁 <strong>END（物語の終端）に到達しました！</strong>
                          <span>
                            下の通過ルート履歴やキャンバス上の図形をタップすると、途中の分岐まで巻き戻して別ルートを試せます。
                          </span>
                        </div>
                      ) : nextRouteBranchEdges.length === 0 ? (
                        <div className="connection-empty-note">
                          この図形から先に接続されている図形がありません。
                        </div>
                      ) : (
                        <div className="route-branch-buttons-list">
                          {nextRouteBranchEdges.map((edge) => {
                            const target = nodeMap.get(edge.targetId);
                            const branchEffects = (
                              currentRouteNode.effects ?? []
                            ).filter((eff) => eff.branchSlot === edge.sourceSlot);
                            const targetNodeEffects = (target?.effects ?? []).filter(
                              (eff) =>
                                eff.branchSlot === null || eff.branchSlot === undefined
                            );
                            const previewEffects = [
                              ...branchEffects,
                              ...targetNodeEffects,
                            ];

                            return (
                              <button
                                key={edge.id}
                                type="button"
                                className="route-branch-choice-btn"
                                onClick={() => handleChooseRouteBranch(edge)}
                              >
                                <div className="route-branch-choice-top">
                                  <span className="route-branch-slot-pill">
                                    分岐 {edge.sourceSlot + 1}
                                  </span>
                                  {edge.label && (
                                    <span className="route-branch-edge-label">
                                      {edge.label}
                                    </span>
                                  )}
                                </div>
                                <div className="route-branch-target-title">
                                  → {target?.title || "（無題）"} へ進む
                                </div>
                                {previewEffects.length > 0 && (
                                  <div className="route-branch-effects-preview">
                                    {previewEffects.map((eff) => (
                                      <span
                                        key={eff.id}
                                        className="node-effect-mini-chip"
                                      >
                                        ⚡{" "}
                                        {formatEffectSummary(
                                          eff,
                                          variableMap.get(eff.variableId)
                                        )}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="connection-empty-note">
                      キャンバス上の図形をタップして開始地点を選択してください。
                    </div>
                  )}
                </div>

                {/* 3. 辿ってきたルート履歴 ＆ 途中の分岐A/B切り替え */}
                <div className="route-section-box">
                  <div className="form-label">
                    👣 辿ってきたルート履歴（途中の分岐もワンタップで切替可能）
                  </div>
                  <div className="route-steps-timeline">
                    {routeNodeIds.map((nodeId, idx) => {
                      const n = nodeMap.get(nodeId);
                      if (!n) return null;
                      const changes = routeEvaluation.stepChanges.get(idx) ?? [];
                      const isCurrent = idx === routeNodeIds.length - 1;
                      const incomingEdge =
                        idx > 0
                          ? chart.edges.find((e) => e.id === routeEdgeIds[idx - 1])
                          : null;

                      // このステップが複数分岐ノードで、すでに次のステップへ進んでいる場合、
                      // その場で他の選択肢（A/Bなど）へワンタップで切り替えられるボタン群を表示
                      const nSlotCount = getNodeSlotCount(n);
                      const branchEdgesAtStep =
                        idx < routeNodeIds.length - 1 && nSlotCount > 1
                          ? chart.edges
                              .filter(
                                (e) =>
                                  e.sourceId === n.id &&
                                  e.sourceSlot >= 0 &&
                                  e.sourceSlot < nSlotCount &&
                                  nodeMap.has(e.targetId)
                              )
                              .sort((a, b) => a.sourceSlot - b.sourceSlot)
                          : [];
                      const takenEdgeIdAtStep = routeEdgeIds[idx];

                      return (
                        <div
                          key={`${nodeId}-${idx}`}
                          className={`route-timeline-item ${
                            isCurrent ? "route-timeline-current" : ""
                          }`}
                          onClick={() => handleRewindRouteToStep(idx)}
                          title="クリックするとこのステップの時点までルートを巻き戻します"
                        >
                          <div className="route-timeline-header">
                            <span className="route-timeline-step-num">
                              STEP {idx + 1}
                            </span>
                            <span className="route-timeline-node-kind">
                              {n.type === "rect" ? "□ 節" : "◇ 分岐"}
                            </span>
                            <strong className="route-timeline-node-title">
                              {n.title || "（無題）"}
                            </strong>
                          </div>
                          {incomingEdge?.label && (
                            <div className="route-timeline-via-edge">
                              ↳ 選択条件: 「{incomingEdge.label}」
                            </div>
                          )}

                          {/* 途中の分岐（A/B等）をその場で切り替えられるスイッチャー */}
                          {branchEdgesAtStep.length > 0 && (
                            <div
                              className="route-inline-branch-switcher"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <span className="route-inline-switcher-label">
                                🔀 分岐切替:
                              </span>
                              <div className="route-inline-switcher-btns">
                                {branchEdgesAtStep.map((bEdge) => {
                                  const isTaken = bEdge.id === takenEdgeIdAtStep;
                                  const bTarget = nodeMap.get(bEdge.targetId);
                                  return (
                                    <button
                                      key={bEdge.id}
                                      type="button"
                                      className={`route-switch-pill ${
                                        isTaken ? "active" : ""
                                      }`}
                                      onClick={() =>
                                        handleSwitchBranchAtStep(idx, bEdge)
                                      }
                                      title={
                                        isTaken
                                          ? "現在選択中の分岐です"
                                          : "クリックすると最初からやり直さずにこの分岐へルートを切り替えます"
                                      }
                                    >
                                      {isTaken ? "✓ " : "⇄ "}
                                      分岐{bEdge.sourceSlot + 1}
                                      {bEdge.label
                                        ? `: ${bEdge.label}`
                                        : bTarget
                                          ? ` (${bTarget.title || "無題"})`
                                          : ""}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {changes.length > 0 && (
                            <div className="route-timeline-changes">
                              {changes.map((c, cIdx) => (
                                <span
                                  key={cIdx}
                                  className="route-timeline-change-pill"
                                >
                                  ⚡ {c.variableName}: {String(c.prevValue)} →{" "}
                                  <strong>{String(c.nextValue)}</strong>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="drawer-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ width: "100%" }}
                  onClick={() => setRouteTraceMode(false)}
                >
                  ルート確認モードを終了して編集に戻る
                </button>
              </div>
            </div>
          ) : selectedNode ? (
            <div className="drawer-content">
              <div className="drawer-mobile-pill" />
              <div className="drawer-header">
                <div className="drawer-type-indicator">
                  {selectedNode.type === "rect" ? (
                    <span className="drawer-badge badge-rect">□ 四角（節）の設定</span>
                  ) : (
                    <span
                      className={`drawer-badge ${
                        getNodeBranchState(selectedNode).isIncomplete
                          ? "badge-diamond-red"
                          : "badge-diamond"
                      }`}
                    >
                      ◇ ひし形（分岐）の設定
                    </span>
                  )}
                  <span className="drawer-chapter-tag">
                    所属: {getChapterForY(selectedNode.y)?.title ?? "未分類"}
                  </span>
                </div>
                <button
                  type="button"
                  className="drawer-close-btn"
                  onClick={() => setSelectedNodeIds([])}
                  title="ドロワーを閉じる"
                >
                  ×
                </button>
              </div>

              <div className="drawer-body">
                {/* 1. タイトル入力欄 */}
                <div className="form-group">
                  <label className="form-label" htmlFor="node-title-input">
                    {selectedNode.type === "rect" ? "節のタイトル" : "分岐のタイトル"}
                  </label>
                  <input
                    id="node-title-input"
                    type="text"
                    className="form-input"
                    value={selectedNode.title}
                    onChange={(e) =>
                      updateNode(selectedNode.id, { title: e.target.value })
                    }
                    placeholder={
                      selectedNode.type === "rect"
                        ? "例：第1節 洋館の入り口"
                        : "例：どちらの扉を開けるか？"
                    }
                  />
                </div>

                {/* 2. テキストエリア（タイトルの下に配置、全文入力可能） */}
                <div className="form-group">
                  <label className="form-label" htmlFor="node-content-textarea">
                    {selectedNode.type === "rect"
                      ? "本文・シナリオテキスト"
                      : "分岐内容・選択肢テキスト"}
                  </label>
                  <textarea
                    id="node-content-textarea"
                    className="form-textarea"
                    rows={8}
                    value={selectedNode.content}
                    onChange={(e) =>
                      updateNode(selectedNode.id, { content: e.target.value })
                    }
                    placeholder={
                      selectedNode.type === "rect"
                        ? "この節のシナリオ本文や演出メモをすべて入力できます..."
                        : "選択肢の文言や分岐条件の詳細を入力できます..."
                    }
                  />
                </div>

                {/* 3A. 四角（節）のドロワーでのみ表示：ENDフラグ */}
                {selectedNode.type === "rect" && (
                  <div className="form-group special-box rect-special-box">
                    <label className="checkbox-row" htmlFor="node-end-checkbox">
                      <input
                        id="node-end-checkbox"
                        type="checkbox"
                        checked={Boolean(selectedNode.isEnd)}
                        onChange={(e) =>
                          updateNode(selectedNode.id, { isEnd: e.target.checked })
                        }
                      />
                      <span className="checkbox-title">ENDフラグ（物語の終端にする）</span>
                    </label>
                    <p className="form-help-text">
                      ONにするとこの節でルートが完結し、四角の下に「＋」ボタンが表示されなくなります。
                    </p>
                  </div>
                )}

                {/* 3B. 分岐先の個数（ひし形、およびENDではない四角で選択可能） */}
                {(selectedNode.type === "diamond" ||
                  (selectedNode.type === "rect" && !selectedNode.isEnd)) && (
                  <div className="form-group special-box diamond-special-box">
                    <label className="form-label" htmlFor="node-branch-count">
                      {selectedNode.type === "diamond"
                        ? "分岐先の個数"
                        : "この節からの分岐数（複数ルートへの分岐）"}
                    </label>
                    <div className="branch-count-controls">
                      {(selectedNode.type === "rect"
                        ? [1, 2, 3, 4, 5]
                        : [2, 3, 4, 5, 6]
                      ).map((num) => (
                        <button
                          key={num}
                          type="button"
                          className={`branch-num-btn ${
                            getNodeSlotCount(selectedNode) === num ? "active" : ""
                          }`}
                          onClick={() =>
                            updateNode(selectedNode.id, { branchCount: num })
                          }
                        >
                          {num === 1 ? "1（通常）" : `${num}分岐`}
                        </button>
                      ))}
                      <input
                        id="node-branch-count"
                        type="number"
                        min={1}
                        max={10}
                        className="branch-number-input"
                        value={getNodeSlotCount(selectedNode)}
                        onChange={(e) => {
                          const val = Math.max(
                            1,
                            Math.min(10, Number.parseInt(e.target.value, 10) || 1)
                          );
                          updateNode(selectedNode.id, { branchCount: val });
                        }}
                      />
                    </div>
                    {selectedNode.type === "diamond" &&
                      (getNodeBranchState(selectedNode).isIncomplete ? (
                        <p className="branch-warning-text">
                          ⚠ 未作成の分岐先があるため、ひし形が赤色で表示されています（
                          {getNodeBranchState(selectedNode).connectedCount} /{" "}
                          {getNodeBranchState(selectedNode).branchCount} 接続済）。
                        </p>
                      ) : (
                        <p className="branch-ok-text">
                          ✓ すべての分岐先（{getNodeSlotCount(selectedNode)}
                          個）が接続されています。
                        </p>
                      ))}
                  </div>
                )}

                {/* 3C. 四角（節）専用：この節自体を通過した時のフラグ・変数の変更設定 */}
                {selectedNode.type === "rect" && (
                  <div className="form-group special-box effects-special-box">
                    <div className="route-section-header">
                      <label className="form-label">
                        ⚡ フラグ・変数の変更（この節での値の変化）
                      </label>
                      <button
                        type="button"
                        className="btn-link-inline"
                        onClick={() => setShowVariableModal(true)}
                      >
                        ＋変数定義を管理
                      </button>
                    </div>

                    {(chart.variables ?? []).length === 0 ? (
                      <div className="connection-empty-note">
                        まず「＋変数定義を管理」からフラグ・変数（string / number / boolean）を登録してください。
                      </div>
                    ) : (
                      <>
                        {(() => {
                          const rectOwnEffects = (selectedNode.effects ?? []).filter(
                            (eff) => eff.branchSlot === null || eff.branchSlot === undefined
                          );
                          return rectOwnEffects.length === 0 ? (
                            <div className="connection-empty-note">
                              この節での変数変更は設定されていません。
                            </div>
                          ) : (
                            <div className="node-effects-editor-list">
                              {rectOwnEffects.map((eff) => {
                                const targetVar = variableMap.get(eff.variableId);
                                const varType: VariableType = targetVar?.type ?? "string";

                                return (
                                  <div key={eff.id} className="node-effect-editor-card">
                                    <div className="node-effect-editor-row">
                                      <select
                                        className="effect-var-select"
                                        value={eff.variableId}
                                        onChange={(e) =>
                                          handleUpdateNodeEffect(selectedNode.id, eff.id, {
                                            variableId: e.target.value,
                                          })
                                        }
                                      >
                                        {(chart.variables ?? []).map((v) => (
                                          <option key={v.id} value={v.id}>
                                            {v.name} ({v.type})
                                          </option>
                                        ))}
                                      </select>

                                      <button
                                        type="button"
                                        className="slot-unlink-btn"
                                        onClick={() =>
                                          handleDeleteNodeEffect(selectedNode.id, eff.id)
                                        }
                                        title="この変更設定を削除"
                                      >
                                        削除
                                      </button>
                                    </div>

                                    <div className="node-effect-editor-row">
                                      <select
                                        className="effect-op-select"
                                        value={eff.op}
                                        onChange={(e) =>
                                          handleUpdateNodeEffect(selectedNode.id, eff.id, {
                                            op: e.target.value as VariableEffectOp,
                                          })
                                        }
                                      >
                                        <option value="set">= （代入する）</option>
                                        {varType === "number" && (
                                          <>
                                            <option value="add">+= （加算する）</option>
                                            <option value="subtract">-= （減算する）</option>
                                          </>
                                        )}
                                        {varType === "boolean" && (
                                          <option value="toggle">! （ON/OFF反転）</option>
                                        )}
                                      </select>

                                      {eff.op !== "toggle" &&
                                        (varType === "boolean" ? (
                                          <select
                                            className="effect-val-input"
                                            value={String(Boolean(eff.value))}
                                            onChange={(e) =>
                                              handleUpdateNodeEffect(
                                                selectedNode.id,
                                                eff.id,
                                                {
                                                  value: e.target.value === "true",
                                                }
                                              )
                                            }
                                          >
                                            <option value="true">true (ON)</option>
                                            <option value="false">false (OFF)</option>
                                          </select>
                                        ) : varType === "number" ? (
                                          <input
                                            type="number"
                                            className="effect-val-input"
                                            value={Number(eff.value) || 0}
                                            onChange={(e) =>
                                              handleUpdateNodeEffect(
                                                selectedNode.id,
                                                eff.id,
                                                {
                                                  value: Number(e.target.value) || 0,
                                                }
                                              )
                                            }
                                          />
                                        ) : (
                                          <input
                                            type="text"
                                            className="effect-val-input"
                                            value={String(eff.value ?? "")}
                                            placeholder="変更後の文字列..."
                                            onChange={(e) =>
                                              handleUpdateNodeEffect(
                                                selectedNode.id,
                                                eff.id,
                                                {
                                                  value: e.target.value,
                                                }
                                              )
                                            }
                                          />
                                        ))}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}

                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ width: "100%", marginTop: "4px" }}
                          onClick={() => handleAddNodeEffect(selectedNode.id, null)}
                        >
                          ＋ この節で変数の変更を追加
                        </button>
                      </>
                    )}
                  </div>
                )}

                {/* 4. 下流への接続状況 ＆ 分岐線のコメント入力 ＆ 選択肢ごとのフラグ・変数変更 */}
                <div className="drawer-connections-section">
                  <div className="route-section-header">
                    <div className="form-label">
                      下流への接続と線のコメント
                      {(selectedNode.type === "diamond" ||
                        getNodeSlotCount(selectedNode) > 1) &&
                        "・フラグ/変数の変更"}
                    </div>
                    {(selectedNode.type === "diamond" ||
                      getNodeSlotCount(selectedNode) > 1) && (
                      <button
                        type="button"
                        className="btn-link-inline"
                        onClick={() => setShowVariableModal(true)}
                      >
                        ＋変数定義を管理
                      </button>
                    )}
                  </div>
                  {selectedNode.type === "rect" && selectedNode.isEnd ? (
                    <div className="connection-empty-note">
                      END設定中のため下流への接続はありません。
                    </div>
                  ) : (
                    <div className="slot-status-list">
                      {Array.from(
                        { length: getNodeSlotCount(selectedNode) },
                        (_, slotIdx) => {
                          const edge = chart.edges.find(
                            (e) =>
                              e.sourceId === selectedNode.id &&
                              e.sourceSlot === slotIdx &&
                              nodeMap.has(e.targetId)
                          );
                          const target = edge ? nodeMap.get(edge.targetId) : null;
                          const showSlotEffects =
                            selectedNode.type === "diamond" ||
                            getNodeSlotCount(selectedNode) > 1;
                          const slotEffects = (selectedNode.effects ?? []).filter(
                            (eff) => eff.branchSlot === slotIdx
                          );

                          return (
                            <div key={slotIdx} className="slot-status-card">
                              <div className="slot-status-item">
                                <span className="slot-index-label">
                                  {getNodeSlotCount(selectedNode) > 1
                                    ? `選択肢 / 分岐 ${slotIdx + 1}`
                                    : "接続先"}
                                </span>
                                {target ? (
                                  <div className="slot-target-info">
                                    <span
                                      className="slot-target-link"
                                      onClick={() => setSelectedNodeIds([target.id])}
                                    >
                                      → {target.title || "（無題）"}
                                    </span>
                                    <button
                                      type="button"
                                      className="slot-unlink-btn"
                                      onClick={() =>
                                        handleDisconnectSlot(selectedNode.id, slotIdx)
                                      }
                                    >
                                      解除
                                    </button>
                                  </div>
                                ) : (
                                  <span className="slot-unconnected-badge">
                                    未作成（下の＋ボタンから追加）
                                  </span>
                                )}
                              </div>
                              {edge && (
                                <div className="slot-edge-comment-row">
                                  <input
                                    type="text"
                                    className="slot-edge-comment-input"
                                    value={edge.label ?? ""}
                                    onChange={(e) =>
                                      handleUpdateEdgeLabel(edge.id, e.target.value)
                                    }
                                    placeholder="線のコメント（例：SAN値が80以下の場合）"
                                  />
                                </div>
                              )}

                              {/* 選択肢（分岐）ごとのフラグ・変数変更 */}
                              {showSlotEffects && (
                                <div className="slot-branch-effects-area">
                                  <div className="slot-branch-effects-header">
                                    <span>
                                      ⚡ この選択肢（分岐 {slotIdx + 1}）でのフラグ・変数変更
                                    </span>
                                  </div>
                                  {slotEffects.length > 0 && (
                                    <div className="node-effects-editor-list">
                                      {slotEffects.map((eff) => {
                                        const targetVar = variableMap.get(eff.variableId);
                                        const varType: VariableType =
                                          targetVar?.type ?? "string";

                                        return (
                                          <div
                                            key={eff.id}
                                            className="node-effect-editor-card"
                                          >
                                            <div className="node-effect-editor-row">
                                              <select
                                                className="effect-var-select"
                                                value={eff.variableId}
                                                onChange={(e) =>
                                                  handleUpdateNodeEffect(
                                                    selectedNode.id,
                                                    eff.id,
                                                    {
                                                      variableId: e.target.value,
                                                    }
                                                  )
                                                }
                                              >
                                                {(chart.variables ?? []).map((v) => (
                                                  <option key={v.id} value={v.id}>
                                                    {v.name} ({v.type})
                                                  </option>
                                                ))}
                                              </select>

                                              <button
                                                type="button"
                                                className="slot-unlink-btn"
                                                onClick={() =>
                                                  handleDeleteNodeEffect(
                                                    selectedNode.id,
                                                    eff.id
                                                  )
                                                }
                                                title="この変更設定を削除"
                                              >
                                                削除
                                              </button>
                                            </div>

                                            <div className="node-effect-editor-row">
                                              <select
                                                className="effect-op-select"
                                                value={eff.op}
                                                onChange={(e) =>
                                                  handleUpdateNodeEffect(
                                                    selectedNode.id,
                                                    eff.id,
                                                    {
                                                      op: e.target
                                                        .value as VariableEffectOp,
                                                    }
                                                  )
                                                }
                                              >
                                                <option value="set">= （代入する）</option>
                                                {varType === "number" && (
                                                  <>
                                                    <option value="add">
                                                      += （加算する）
                                                    </option>
                                                    <option value="subtract">
                                                      -= （減算する）
                                                    </option>
                                                  </>
                                                )}
                                                {varType === "boolean" && (
                                                  <option value="toggle">
                                                    ! （ON/OFF反転）
                                                  </option>
                                                )}
                                              </select>

                                              {eff.op !== "toggle" &&
                                                (varType === "boolean" ? (
                                                  <select
                                                    className="effect-val-input"
                                                    value={String(Boolean(eff.value))}
                                                    onChange={(e) =>
                                                      handleUpdateNodeEffect(
                                                        selectedNode.id,
                                                        eff.id,
                                                        {
                                                          value:
                                                            e.target.value === "true",
                                                        }
                                                      )
                                                    }
                                                  >
                                                    <option value="true">
                                                      true (ON)
                                                    </option>
                                                    <option value="false">
                                                      false (OFF)
                                                    </option>
                                                  </select>
                                                ) : varType === "number" ? (
                                                  <input
                                                    type="number"
                                                    className="effect-val-input"
                                                    value={Number(eff.value) || 0}
                                                    onChange={(e) =>
                                                      handleUpdateNodeEffect(
                                                        selectedNode.id,
                                                        eff.id,
                                                        {
                                                          value:
                                                            Number(e.target.value) || 0,
                                                        }
                                                      )
                                                    }
                                                  />
                                                ) : (
                                                  <input
                                                    type="text"
                                                    className="effect-val-input"
                                                    value={String(eff.value ?? "")}
                                                    placeholder="変更後の文字列..."
                                                    onChange={(e) =>
                                                      handleUpdateNodeEffect(
                                                        selectedNode.id,
                                                        eff.id,
                                                        {
                                                          value: e.target.value,
                                                        }
                                                      )
                                                    }
                                                  />
                                                ))}
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}

                                  <button
                                    type="button"
                                    className="btn btn-small slot-add-effect-btn"
                                    onClick={() =>
                                      handleAddNodeEffect(selectedNode.id, slotIdx)
                                    }
                                  >
                                    ＋ 分岐 {slotIdx + 1} にフラグ・変数の変更を追加
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        }
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="drawer-footer">
                <button
                  type="button"
                  className="btn btn-danger-outline"
                  onClick={() => handleDeleteNode(selectedNode.id)}
                >
                  この図形を削除
                </button>
              </div>
            </div>
          ) : null}
        </aside>
      </div>

      {/* Variable & Flag Manager Modal (変数・フラグ定義モーダル) */}
      {showVariableModal && (
        <div
          className="var-modal-backdrop"
          onClick={() => setShowVariableModal(false)}
        >
          <div
            className="var-modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="var-modal-header">
              <div>
                <h2 className="var-modal-title">🚩 フラグ・変数の定義管理</h2>
                <p className="var-modal-subtitle">
                  変数名・型（string / number / boolean）・初期値（defaultValue）を定義します。
                </p>
              </div>
              <button
                type="button"
                className="drawer-close-btn"
                onClick={() => setShowVariableModal(false)}
              >
                ×
              </button>
            </div>

            <div className="var-modal-body">
              {(chart.variables ?? []).length === 0 ? (
                <div className="connection-empty-note">
                  まだ変数が登録されていません。「＋ 新しい変数を追加」ボタンを押して作成してください。
                </div>
              ) : (
                <div className="var-def-list">
                  {(chart.variables ?? []).map((v) => (
                    <div key={v.id} className="var-def-row">
                      <div className="var-def-field">
                        <label>変数名</label>
                        <input
                          type="text"
                          className="form-input"
                          value={v.name}
                          placeholder="例: SAN, hasKey"
                          onChange={(e) =>
                            handleUpdateVariable(v.id, { name: e.target.value })
                          }
                        />
                      </div>

                      <div className="var-def-field var-def-type-field">
                        <label>型 (Type)</label>
                        <select
                          className="form-input"
                          value={v.type}
                          onChange={(e) => {
                            const nextType = e.target.value as VariableType;
                            const defaultVal =
                              nextType === "number"
                                ? 0
                                : nextType === "boolean"
                                  ? false
                                  : "";
                            handleUpdateVariable(v.id, {
                              type: nextType,
                              defaultValue: defaultVal,
                            });
                          }}
                        >
                          <option value="boolean">boolean (真偽値)</option>
                          <option value="number">number (数値)</option>
                          <option value="string">string (文字列)</option>
                        </select>
                      </div>

                      <div className="var-def-field">
                        <label>初期値 (defaultValue)</label>
                        {v.type === "boolean" ? (
                          <select
                            className="form-input"
                            value={String(Boolean(v.defaultValue))}
                            onChange={(e) =>
                              handleUpdateVariable(v.id, {
                                defaultValue: e.target.value === "true",
                              })
                            }
                          >
                            <option value="false">false (OFF)</option>
                            <option value="true">true (ON)</option>
                          </select>
                        ) : v.type === "number" ? (
                          <input
                            type="number"
                            className="form-input"
                            value={Number(v.defaultValue) || 0}
                            onChange={(e) =>
                              handleUpdateVariable(v.id, {
                                defaultValue: Number(e.target.value) || 0,
                              })
                            }
                          />
                        ) : (
                          <input
                            type="text"
                            className="form-input"
                            value={String(v.defaultValue ?? "")}
                            placeholder="初期文字列..."
                            onChange={(e) =>
                              handleUpdateVariable(v.id, {
                                defaultValue: e.target.value,
                              })
                            }
                          />
                        )}
                      </div>

                      <button
                        type="button"
                        className="slot-unlink-btn var-def-delete-btn"
                        onClick={() => handleDeleteVariable(v.id)}
                        title="この変数を削除"
                      >
                        削除
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="var-modal-footer">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleAddVariable}
              >
                ＋ 新しい変数を追加
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowVariableModal(false)}
              >
                完了
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
