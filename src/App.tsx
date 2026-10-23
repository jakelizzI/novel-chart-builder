import React, { useEffect, useMemo, useRef, useState } from "react";
import { createInitialFlowchart, createMinimalFlowchart } from "./defaultData";
import type {
  ChapterLane,
  FlowchartData,
  FlowEdge,
  FlowNode,
  NodeType,
  ProjectSummary,
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

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
}

export function cloneFlowchart(chart: FlowchartData): FlowchartData {
  return {
    ...chart,
    chapters: chart.chapters.map((c) => ({ ...c })),
    nodes: chart.nodes.map((n) => ({ ...n })),
    edges: chart.edges.map((e) => ({ ...e })),
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
  const [zoom, setZoom] = useState<number>(1.0);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "offline">("saved");

  // Undo / Redo history stacks & Toast notification
  const [undoStack, setUndoStack] = useState<FlowchartData[]>([]);
  const [redoStack, setRedoStack] = useState<FlowchartData[]>([]);
  const [undoToast, setUndoToast] = useState<{ message: string; id: number } | null>(null);

  // Dragging node state
  const [draggingNode, setDraggingNode] = useState<{
    nodeId: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    hasMoved: boolean;
  } | null>(null);

  // Resizing chapter lane state
  const [resizingChapter, setResizingChapter] = useState<{
    chapterId: string;
    startY: number;
    origHeight: number;
    chapterBottomYAtStart: number;
    shiftNodesBelow: boolean;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canvasScrollRef = useRef<HTMLDivElement | null>(null);
  const flowchartCanvasRef = useRef<HTMLDivElement | null>(null);
  const initialLoadDone = useRef(false);

  // Helper to push a snapshot onto undoStack before destructive/structural changes
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

  // Load initial project from SQLite server on startup
  useEffect(() => {
    async function loadFromServer() {
      try {
        const projRes = await fetch("/api/projects");
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
    loadFromServer();
  }, []);

  // Auto-save to localStorage & SQLite backend
  useEffect(() => {
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
  }, [chart]);

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

  // Right Drawer opens only when a single node is selected
  const selectedNode = useMemo(
    () => (selectedNodeIds.length === 1 ? nodeMap.get(selectedNodeIds[0]!) ?? null : null),
    [selectedNodeIds, nodeMap]
  );

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

  // Ctrl + Scroll Wheel to zoom in/out on the canvas
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

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, []);

  // Convert viewport mouse coordinates (clientX, clientY) to logical canvas coordinates
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

  // Handle mouse move / up for node dragging, chapter resizing, and marquee selection
  useEffect(() => {
    if (!draggingNode && !resizingChapter && !marquee) return;

    function onMouseMove(e: MouseEvent) {
      if (draggingNode) {
        const dx = (e.clientX - draggingNode.startX) / zoom;
        const dy = (e.clientY - draggingNode.startY) / zoom;
        const moved = draggingNode.hasMoved || Math.abs(dx) > 3 || Math.abs(dy) > 3;
        if (moved && !draggingNode.hasMoved) {
          setDraggingNode((prev) => (prev ? { ...prev, hasMoved: true } : null));
        }
        const nextX = Math.max(CHAPTER_HEADER_WIDTH + 120, Math.round(draggingNode.origX + dx));
        const nextY = Math.max(55, Math.round(draggingNode.origY + dy));

        setChart((prev) => {
          const totalH = prev.chapters.reduce((sum, c) => sum + c.height, 0);
          let updatedChapters = prev.chapters;
          if (nextY + 120 > totalH && prev.chapters.length > 0) {
            const extra = nextY + 120 - totalH;
            updatedChapters = prev.chapters.map((c, idx) =>
              idx === prev.chapters.length - 1 ? { ...c, height: c.height + extra } : c
            );
          }
          return {
            ...prev,
            chapters: updatedChapters,
            nodes: prev.nodes.map((n) =>
              n.id === draggingNode.nodeId ? { ...n, x: nextX, y: nextY } : n
            ),
          };
        });
      }

      if (resizingChapter) {
        const dy = (e.clientY - resizingChapter.startY) / zoom;
        const newHeight = Math.max(160, Math.round(resizingChapter.origHeight + dy));
        const actualDiff = newHeight - resizingChapter.origHeight;

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
        const coords = clientToCanvasCoords(e.clientX, e.clientY);
        const hasDragged =
          marquee.hasDragged ||
          Math.abs(coords.x - marquee.startX) > 4 ||
          Math.abs(coords.y - marquee.startY) > 4;

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

    function onMouseUp() {
      if (marquee && !marquee.hasDragged && !marquee.additive) {
        setSelectedNodeIds([]);
      }
      setDraggingNode(null);
      setResizingChapter(null);
      setMarquee(null);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [draggingNode, resizingChapter, marquee, zoom, chart.nodes]);

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

  // Handle clicking or Ctrl+clicking a node
  function handleNodeClick(e: React.MouseEvent, nodeId: string) {
    e.stopPropagation();
    if (mergeMode) return;
    setSelectedEdgeId(null);
    setPlusMenu(null);

    if (e.ctrlKey || e.metaKey) {
      // Toggle this node in multi-selection
      setSelectedNodeIds((prev) =>
        prev.includes(nodeId) ? prev.filter((id) => id !== nodeId) : [...prev, nodeId]
      );
    } else {
      setSelectedNodeIds([nodeId]);
    }
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
            title="直前の削除や変更を元に戻す (Ctrl + Z)"
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
        </div>
      </header>

      {/* Multi-Selection Action Banner (shown when 2 or more shapes are selected) */}
      {selectedNodeIds.length >= 2 && (
        <div className="multi-select-banner">
          <div className="multi-select-info">
            <span className="multi-count-badge">{selectedNodeIds.length} 個の図形を選択中</span>
            <span className="multi-select-hint">
              （Ctrl + クリックで1つずつ選択解除 ／ Deleteキーでも一括削除可能）
            </span>
          </div>
          <div className="multi-select-actions">
            <button
              type="button"
              className="btn btn-danger-solid"
              onClick={() => handleDeleteNodes(selectedNodeIds)}
            >
              🗑 選択した {selectedNodeIds.length} 個をまとめて削除
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setSelectedNodeIds([])}
            >
              選択解除 (Esc)
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
              const additive = e.ctrlKey || e.metaKey;
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

                    return (
                      <g
                        key={edge.id}
                        className="edge-group"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedEdgeId(edge.id);
                          setPlusMenu(null);
                        }}
                      >
                        <path
                          d={pathD}
                          fill="none"
                          stroke="transparent"
                          strokeWidth={16}
                          style={{ cursor: "pointer" }}
                        />
                        <path
                          d={pathD}
                          fill="none"
                          stroke={isSelected ? "#2563eb" : "#475569"}
                          strokeWidth={isSelected ? 3.2 : 2.2}
                          markerEnd={
                            isSelected ? "url(#arrow-selected)" : "url(#arrow-normal)"
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
                  const isSelected = selectedEdgeId === edge.id;

                  if (!hasLabel && !isSelected) return null;

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
                        <div
                          className="edge-comment-pill"
                          title="クリックして線のコメントを編集"
                        >
                          {edge.label}
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

                  return (
                    <React.Fragment key={node.id}>
                      {/* Shape Body (Rectangle or Diamond) */}
                      {node.type === "rect" ? (
                        <div
                          className={`flow-node rect-node ${
                            isSelected ? "node-selected" : ""
                          } ${isMultiSelected ? "node-multi-selected" : ""} ${
                            node.isEnd ? "rect-node-end" : ""
                          } ${isMergeCandidate ? "node-merge-target" : ""}`}
                          style={{
                            left: `${node.x - RECT_WIDTH / 2}px`,
                            top: `${node.y - RECT_HEIGHT / 2}px`,
                            width: `${RECT_WIDTH}px`,
                            height: `${RECT_HEIGHT}px`,
                          }}
                          onMouseDown={(e) => {
                            if (e.button !== 0) return;
                            e.stopPropagation();
                            if (mergeMode) {
                              if (mergeMode.sourceId !== node.id) {
                                handleConnectToExistingNode(
                                  mergeMode.sourceId,
                                  mergeMode.sourceSlot,
                                  node.id
                                );
                              }
                              return;
                            }
                            if (e.ctrlKey || e.metaKey) {
                              return;
                            }
                            setDraggingNode({
                              nodeId: node.id,
                              startX: e.clientX,
                              startY: e.clientY,
                              origX: node.x,
                              origY: node.y,
                              hasMoved: false,
                            });
                          }}
                          onClick={(e) => handleNodeClick(e, node.id)}
                        >
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
                          } ${isMergeCandidate ? "node-merge-target" : ""}`}
                          style={{
                            left: `${node.x - DIAMOND_WIDTH / 2}px`,
                            top: `${node.y - DIAMOND_HEIGHT / 2}px`,
                            width: `${DIAMOND_WIDTH}px`,
                            height: `${DIAMOND_HEIGHT}px`,
                          }}
                          onMouseDown={(e) => {
                            if (e.button !== 0) return;
                            e.stopPropagation();
                            if (mergeMode) {
                              if (mergeMode.sourceId !== node.id) {
                                handleConnectToExistingNode(
                                  mergeMode.sourceId,
                                  mergeMode.sourceSlot,
                                  node.id
                                );
                              }
                              return;
                            }
                            if (e.ctrlKey || e.metaKey) {
                              return;
                            }
                            setDraggingNode({
                              nodeId: node.id,
                              startX: e.clientX,
                              startY: e.clientY,
                              origX: node.x,
                              origY: node.y,
                              hasMoved: false,
                            });
                          }}
                          onClick={(e) => handleNodeClick(e, node.id)}
                        >
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
                      left: `${Math.max(20, plusMenu.x - 115)}px`,
                      top: `${plusMenu.y}px`,
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
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
              onClick={(e) => e.stopPropagation()}
            >
              <span className="undo-toast-message">🗑 {undoToast.message}</span>
              <button
                type="button"
                className="undo-toast-btn"
                onClick={handleUndo}
              >
                ↩ 元に戻す (Ctrl+Z)
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
            onClick={(e) => e.stopPropagation()}
            title="Ctrl + マウスホイールでも拡大・縮小できます"
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

        {/* Right Side Drawer (四角 / ひし形 単一選択時に表示) */}
        <aside className={`right-drawer ${selectedNode ? "drawer-open" : ""}`}>
          {selectedNode ? (
            <div className="drawer-content">
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

                {/* 4. 下流への接続状況 ＆ 分岐線のコメント入力 */}
                <div className="drawer-connections-section">
                  <div className="form-label">
                    下流への接続と線のコメント（条件メモ）
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
                          return (
                            <div key={slotIdx} className="slot-status-card">
                              <div className="slot-status-item">
                                <span className="slot-index-label">
                                  {getNodeSlotCount(selectedNode) > 1
                                    ? `分岐 ${slotIdx + 1}`
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
    </div>
  );
}
