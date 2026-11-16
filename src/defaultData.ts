import type { FlowchartData } from "./types";

export function createInitialFlowchart(id = "default", name = "サンプルノベル企画"): FlowchartData {
  return {
    id,
    name,
    variables: [
      {
        id: "var-san",
        name: "SAN",
        type: "number",
        defaultValue: 100,
      },
      {
        id: "var-key",
        name: "銀の鍵所持",
        type: "boolean",
        defaultValue: false,
      },
      {
        id: "var-route",
        name: "現在ルート",
        type: "string",
        defaultValue: "エントランス",
      },
    ],
    chapters: [
      {
        id: "chap-1",
        title: "第1章：序幕",
        height: 340,
        order: 0,
      },
      {
        id: "chap-2",
        title: "第2章：探索と選択",
        height: 380,
        order: 1,
      },
      {
        id: "chap-3",
        title: "第3章：結末",
        height: 320,
        order: 2,
      },
    ],
    nodes: [
      {
        id: "node-1",
        type: "rect",
        title: "第1節：見知らぬ洋館",
        content: "主人公が目を覚ますと、そこは古びた洋館のエントランスだった。\n正面には2つの扉が並んでいる。",
        x: 520,
        y: 85,
        isEnd: false,
        branchCount: 1,
        effects: [],
      },
      {
        id: "node-2",
        type: "diamond",
        title: "どちらの扉を開ける？",
        content: "選択肢1：左の重厚な木製の扉へ進む\n選択肢2：右の鉄格子の扉へ進む",
        x: 520,
        y: 235,
        branchCount: 2,
        effects: [
          {
            id: "eff-branch-left",
            variableId: "var-route",
            op: "set",
            value: "書斎ルート",
            branchSlot: 0,
          },
          {
            id: "eff-branch-right",
            variableId: "var-route",
            op: "set",
            value: "地下室ルート",
            branchSlot: 1,
          },
          {
            id: "eff-branch-right-san",
            variableId: "var-san",
            op: "subtract",
            value: 20,
            branchSlot: 1,
          },
        ],
      },
      {
        id: "node-3",
        type: "rect",
        title: "第2節：書斎での発見",
        content: "左の扉の先は静かな書斎だった。\n机の上から古い日記と銀の鍵を見つける。",
        x: 330,
        y: 440,
        isEnd: false,
        branchCount: 1,
        effects: [
          {
            id: "eff-get-key",
            variableId: "var-key",
            op: "set",
            value: true,
            branchSlot: null,
          },
        ],
      },
      {
        id: "node-4",
        type: "rect",
        title: "第3節：地下への階段",
        content: "右の扉を開けると、冷たい風が吹き上がる地下階段が続いていた。",
        x: 710,
        y: 440,
        isEnd: false,
        branchCount: 1,
        effects: [
          {
            id: "eff-basement-san",
            variableId: "var-san",
            op: "subtract",
            value: 15,
            branchSlot: null,
          },
        ],
      },
      {
        id: "node-5",
        type: "diamond",
        title: "銀の鍵を使うか？",
        content: "選択肢1：奥の隠し扉に鍵を使う\n選択肢2：鍵を使わずに引き返す（未作成の分岐）",
        x: 330,
        y: 605,
        branchCount: 2,
        effects: [],
      },
      {
        id: "node-6",
        type: "rect",
        title: "最終節：夜明けの脱出",
        content: "隠し通路を抜けると、朝靄の森へと出ることができた。\nこうして長い夜は幕を閉じた。【TRUE END】",
        x: 330,
        y: 820,
        isEnd: true,
        branchCount: 1,
        effects: [
          {
            id: "eff-true-end",
            variableId: "var-route",
            op: "set",
            value: "TRUE END（生還）",
            branchSlot: null,
          },
        ],
      },
    ],
    edges: [
      {
        id: "edge-1",
        sourceId: "node-1",
        sourceSlot: 0,
        targetId: "node-2",
        label: "",
      },
      {
        id: "edge-2",
        sourceId: "node-2",
        sourceSlot: 0,
        targetId: "node-3",
        label: "左の扉へ",
      },
      {
        id: "edge-3",
        sourceId: "node-2",
        sourceSlot: 1,
        targetId: "node-4",
        label: "SAN値が80以下の場合",
      },
      {
        id: "edge-4",
        sourceId: "node-3",
        sourceSlot: 0,
        targetId: "node-5",
        label: "",
      },
      {
        id: "edge-5",
        sourceId: "node-5",
        sourceSlot: 0,
        targetId: "node-6",
        label: "銀の鍵を使う",
      },
    ],
  };
}

export function createMinimalFlowchart(id: string, name: string): FlowchartData {
  return {
    id,
    name,
    variables: [],
    chapters: [
      {
        id: "chap-1",
        title: "第1章：プロローグ",
        height: 420,
        order: 0,
      },
      {
        id: "chap-2",
        title: "第2章：本編",
        height: 420,
        order: 1,
      },
    ],
    nodes: [
      {
        id: "node-start",
        type: "rect",
        title: "第1節：物語の始まり",
        content: "ここからシナリオを入力してください。",
        x: 520,
        y: 110,
        isEnd: false,
        branchCount: 1,
      },
    ],
    edges: [],
  };
}
