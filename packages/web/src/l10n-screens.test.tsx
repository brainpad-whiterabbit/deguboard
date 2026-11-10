// @vitest-environment jsdom
// 画面の決まった文言を、表示言語ごとに主な画面を描いて書き出し、ファイルのスナップショットと突き合わせる（t383）。
// 日本語のスナップショットは英語にする前の画面で書き出したもので、日本語の表示が前と字で同じであることを確かめる。
// 英語では、fixture のデータ（チケットのタイトル・本文など。訳さない）を除いて日本語が残らないことも確かめる
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFields } from "@deguboard/core";
import { App } from "./app.js";
import { ClientError } from "./client/http.js";
import { HostProvider, type Host } from "./host.js";
import { StoreProvider } from "./store.js";
import {
  boardFixture,
  iteration,
  iterationDetail,
  mockClient,
  plan,
  ticket,
  type MockClient,
} from "./test-helpers.js";
import type { RunView } from "./types.js";
import { createUiState, memoryBackend } from "./ui-state.js";
import { language, setLanguage, type Language } from "./l10n.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-04T12:00:00Z") });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setLanguage("ja");
  window.location.hash = "";
  window.localStorage.clear();
});

function hostOf(surface: Host["surface"]): Host {
  return {
    surface,
    open: () => {},
    show: () => {},
    copy: async () => {},
    state: createUiState(memoryBackend()),
  };
}

function run(partial: Partial<RunView> & { id: string }): RunView {
  return {
    ticket: "t2",
    step: "implement",
    agent: "claude-code",
    model: "opus",
    started_at: "2026-11-01T00:00:00Z",
    finished_at: "2026-11-01T00:30:00Z",
    result: "success",
    error: null,
    retries: 1,
    retry_reasons: ["test"],
    usage: { input: 1200, output: 300, cache_read: null, cache_write: null },
    tools: null,
    running: false,
    duration_seconds: 1800,
    ...partial,
  } as RunView;
}

/** 画面の多くの部品が出るよう、チケット・Iteration・Epic・Plan・Run・履歴を揃えた client */
function richClient(): MockClient {
  const s1 = iteration({
    id: "s1",
    name: "最初の Iteration",
    status: "active",
    goal: "目標データの文",
    start: "2026-11-01",
    end: "2026-11-14",
  });
  const s2 = iteration({ id: "s2", name: "次の Iteration", status: "planned" });
  const s0 = iteration({ id: "s0", name: "前の Iteration", status: "closed" });
  const data = boardFixture({ iterations: [s1, s2, s0] });
  data.tickets = [
    ticket({ id: "t1", title: "ログイン", status: "done", iteration: "s1", pr: 12 }),
    ticket({
      id: "t2",
      title: "API",
      status: "in_progress",
      priority: "high",
      epic: "e1",
      iteration: "s1",
      branch: "feat/api",
      assignee: "eiki/agent",
      labels: ["api"],
    }),
    ticket({
      id: "t3",
      title: "題データの三",
      status: "review",
      iteration: "s1",
      depends_on: ["t2"],
    }),
    ticket({ id: "t4", title: "やめた", status: "abandoned", iteration: "s0", epic: "e1" }),
    ticket({ id: "t5", title: "未割り当て", status: "todo", priority: "low" }),
    ticket({ id: "t6", title: "次に回す", status: "todo", iteration: "s2" }),
  ];
  data.plans = [
    plan({ id: "p1", tickets: ["t2", "t3"], after: { t3: ["t2"] }, iteration: "s1" } as never),
    plan({ id: "p2", tickets: ["t6"], pending_approval: true }),
  ];
  const client = mockClient(data);
  client.handlers["iteration.show"] = (input) => {
    const id = (input as { iteration: string }).iteration;
    const it = data.iterations.find((i) => i.id === id)!;
    const items = data.tickets.filter((t) => t.iteration === id) as never[];
    return {
      ...iterationDetail(it, items),
      plans: [{ id: "p1", status: "approved", progress: { total: 2, done: 0, by_status: {} } }],
    };
  };
  // 本文は fixture の既定（test-helpers の「本文」）でなく、画面の文言とぶつからない語にする
  const showTicket = client.handlers["ticket.show"]!;
  client.handlers["ticket.show"] = (input) => ({
    ...(showTicket(input) as object),
    body: "## 見出しデータの一\n\n本文データの文\n\n## 受け入れ条件\n\n- [ ] 条件データの一\n",
  });
  client.handlers["epic.show"] = () => ({
    ...data.epics[0],
    body: "## 見出しデータの一\n\nEpic のデータの文\n",
    tickets: data.tickets.filter((t) => t.epic === "e1"),
  });
  client.handlers["history"] = () => ({
    events: [
      {
        kind: "ticket",
        id: "t2",
        at: "2026-11-04T10:00:00Z",
        changes: [{ field: "status", from: "todo", to: "in_progress" }],
      },
      {
        kind: "ticket",
        id: "t6",
        at: "2026-11-03T10:00:00Z",
        changes: [{ field: "iteration", from: "s0", to: "s2" }],
      },
    ],
    shallow: false,
    incomplete: [],
  });
  const runs = [
    run({ id: "r20261101-000000-aaaa" }),
    run({
      id: "r20261101-010000-bbbb",
      result: "failure",
      error: "テストが落ちた",
      retries: 0,
      retry_reasons: [],
    }),
    run({
      id: "r20261101-020000-cccc",
      result: null,
      finished_at: null,
      running: true,
      duration_seconds: null,
    }),
  ];
  client.handlers["run.list"] = () => runs;
  const config = {
    default_project: "default",
    git: { remote: "origin", base_branch: "main" },
    commit: { mode: "each" },
  };
  // 項目の説明は、core の説明を鍵に表示言語の訳を引き、訳がなければ core の説明のまま出す（UI-11・t649）。
  // 日本語のスナップショットが core の説明の書き換えで動かないよう、日本語では説明をキーに差し替える（表にない文なのでそのまま出る）。
  // 英語では core の説明のまま渡して訳を引く（説明と訳の鍵の揃いは l10n.test.ts が確かめる）
  const fields = configFields().map((f) =>
    language() === "ja" ? { ...f, description: f.key } : f,
  );
  client.handlers["config.show"] = (input) =>
    (input as { fields?: boolean }).fields ? { config, team: config, local: {}, fields } : config;
  return client;
}

/**
 * 英語の画面で日本語が残っていないかを見るときに除く文：fixture のデータ（訳さない）と、
 * core の config の既定値（優先度の判断基準。利用者が書き換える config.yaml の値で、core の言語のまま）。
 * データは画面の文言（tr の鍵）とぶつからない固有の語にする（鍵と同じ語を除くと、訳し漏れが隠れる）
 */
const DATA_TEXTS = [
  ...configFields().flatMap((f) => (typeof f.default === "string" ? [f.default] : [])),
  "最初の Iteration",
  "次の Iteration",
  "前の Iteration",
  "目標データの文",
  "ログイン",
  "題データの三",
  "やめた",
  "未割り当て",
  "次に回す",
  "最初の版",
  "Epic のデータの文",
  "見出しデータの一",
  "本文データの文",
  "条件データの一",
  "テストが落ちた",
];

/** 行全体がこれと同じときだけ除くデータ。本文の受け入れ条件の節の見出しは、本文の書式の決まった語（チケットの中身） */
const DATA_LINES = ["受け入れ条件"];

/** 画面の文言を、テキストと読み上げ・ツールチップ・入力の案内の属性ごとに 1 行ずつ並べる */
function screenText(root: Element = document.body): string {
  const lines: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) lines.push(text);
      return;
    }
    if (!(node instanceof Element)) return;
    for (const attr of ["title", "aria-label", "placeholder", "alt"]) {
      const v = node.getAttribute(attr);
      if (v) lines.push(`[${attr}] ${v}`);
    }
    if (node instanceof HTMLInputElement && node.type !== "checkbox" && node.value)
      lines.push(`[value] ${node.value}`);
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return lines.join("\n");
}

/** 読み込みと詳細の取り寄せが落ち着くまで待つ */
async function settle() {
  await waitFor(() => expect(document.querySelector(".skeleton")).toBeNull());
  for (let i = 0; i < 10; i++) await act(async () => {});
}

interface Scene {
  name: string;
  surface: Host["surface"];
  hash: string;
  /** 描いた後に操作する（吹き出しを開くなど） */
  act?: () => void | Promise<void>;
  client?: () => MockClient;
}

const SCENES: Scene[] = [
  { name: "サイドバーのカンバン", surface: "sidebar", hash: "#/board" },
  { name: "サイドバーのバックログ", surface: "sidebar", hash: "#/backlog" },
  { name: "サイドバーの履歴", surface: "sidebar", hash: "#/history" },
  { name: "サイドバーの設定", surface: "sidebar", hash: "#/config" },
  { name: "パネルのチケット詳細", surface: "panel", hash: "#/tickets/t2" },
  { name: "パネルの依存のあるチケット詳細", surface: "panel", hash: "#/tickets/t3" },
  { name: "パネルの Epic 詳細", surface: "panel", hash: "#/epics/e1" },
  { name: "パネルの Iteration 詳細", surface: "panel", hash: "#/iterations/s1" },
  { name: "パネルの閉じた Iteration 詳細", surface: "panel", hash: "#/iterations/s0" },
  { name: "パネルの Plan 詳細", surface: "panel", hash: "#/plans/p1" },
  { name: "パネルの承認待ちの Plan 詳細", surface: "panel", hash: "#/plans/p2" },
  {
    name: "サイドバーのエージェントに頼む入力欄",
    surface: "sidebar",
    hash: "#/board",
    act: async () => {
      // 行の吹き出しを開いて候補を出す。候補の一覧を書き出した後、先頭の候補で入力欄を開く
      fireEvent.click(document.querySelector<HTMLElement>("[aria-haspopup='menu']")!);
      await settle();
      const menu = screenText(document.querySelector(".ask-menu")!);
      fireEvent.click(document.querySelector<HTMLElement>(".ask-menu-item")!);
      await settle();
      document.body.dataset["menu"] = menu;
    },
  },
  {
    name: "dg init 前の始め方",
    surface: "sidebar",
    hash: "#/board",
    client: () => {
      const client = mockClient();
      client.handlers["project.list"] = () => {
        throw new ClientError({ code: "NOT_INITIALIZED", message: "初期化されていない" });
      };
      return client;
    },
  },
];

async function renderScene(scene: Scene, language: Language): Promise<string> {
  setLanguage(language);
  window.location.hash = scene.hash;
  const client = (scene.client ?? richClient)();
  render(
    <StoreProvider client={client} readRunning={scene.surface === "sidebar"}>
      <HostProvider host={hostOf(scene.surface)}>
        <App />
      </HostProvider>
    </StoreProvider>,
  );
  await settle();
  if (scene.act) {
    await scene.act();
    await settle();
  }
  const menu = document.body.dataset["menu"];
  delete document.body.dataset["menu"];
  return menu ? `${menu}\n---\n${screenText()}` : screenText();
}

/** 日本語の文字（かな・漢字・全角の記号） */
const JAPANESE = /[　-ヿ一-鿿＀-￯]/;

describe("画面の文言の表示言語", () => {
  for (const language of ["ja", "en"] as const) {
    it(`${language} の主な画面の文言がスナップショットと同じ`, async () => {
      const out: string[] = [];
      for (const scene of SCENES) {
        out.push(`## ${scene.name}\n${await renderScene(scene, language)}`);
        cleanup();
        window.localStorage.clear();
      }
      await expect(`${out.join("\n\n")}\n`).toMatchFileSnapshot(
        `./__snapshots__/l10n-screens.${language}.txt`,
      );
    });
  }

  it("英語では fixture のデータと core の文を除いて日本語が残らない", async () => {
    const found: string[] = [];
    for (const scene of SCENES) {
      const text = await renderScene(scene, "en");
      for (const line of text.split("\n")) {
        if (DATA_LINES.includes(line)) continue;
        let rest = line;
        for (const d of DATA_TEXTS) rest = rest.split(d).join("");
        if (JAPANESE.test(rest)) found.push(`${scene.name}: ${line}`);
      }
      cleanup();
      window.localStorage.clear();
    }
    expect(found).toEqual([]);
  });
});
