// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASK_WORKFLOW_KEY,
  DEFAULT_WORKFLOW,
  resolveWorkflow,
  workflowSections,
  type WorkflowDefinition,
} from "@deguboard/core";
import { App } from "../app.js";
import { createHost, HostProvider } from "../host.js";
import { setLanguage } from "../l10n.js";
import { DEFAULT_VALUES } from "../l10n-core.js";
import { StoreProvider } from "../store.js";
import { fixture, mockClient } from "../test-helpers.js";
import type { WorkflowView } from "../types.js";
import { createUiState, memoryBackend } from "../ui-state.js";
import {
  WORKFLOW_ITEM_PREFIX,
  workflowMatches,
  workflowRowName,
  workflowSectionName,
} from "./config-workflow.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  window.localStorage.clear();
});

/**
 * 一部だけを書いた workflow.yaml：表示名を 1 つ、完了の境目の decide、リリースの段階、独自の段階、skip。ほかは省く。
 * sections は core の workflowSections がこの定義から作る（dg workflow show と同じ。画面は写すだけ）
 */
const WRITTEN: WorkflowDefinition = {
  states: { review: { label: "Client Review" } },
  boundaries: [{ from: "review", to: "done", requires: ["pr_merged"], decide: "human_only" }],
  wip: { in_progress: 5 },
  flow: {
    release: "always_ask",
    "deploy-staging": { decide: "always_ask", after: "audit", guide: "docs/flow/deploy.md" },
    skip: ["retro"],
  },
};

function workflowView(def: WorkflowDefinition, over: Partial<WorkflowView> = {}): WorkflowView {
  const resolved = resolveWorkflow(def);
  return {
    labels: resolved.labels,
    default_labels: DEFAULT_WORKFLOW.labels,
    moves: [],
    exists: true,
    sections: workflowSections(resolved),
    ...over,
  };
}

function client(workflow: WorkflowView = workflowView(WRITTEN)) {
  return mockClient(fixture({ workflow }));
}

/** 設定画面を開き、Workflow のタブに移る。エージェントに頼む入力欄まで開けるよう Host で包む */
async function mount(c: ReturnType<typeof mockClient>) {
  window.location.hash = "#/config";
  render(
    <StoreProvider client={c}>
      <HostProvider
        host={{ ...createHost("sidebar", null), state: createUiState(memoryBackend()) }}
      >
        <App />
      </HostProvider>
    </StoreProvider>,
  );
  fireEvent.click(await screen.findByRole("tab", { name: "Workflow" }));
}

const panel = () => screen.getByRole("tabpanel");
const sectionOf = (key: string) =>
  document.querySelector<HTMLElement>(`section[data-section="${key}"]`)!;
const rowOf = (key: string) =>
  document.querySelector<HTMLElement>(`tr[data-key="workflow.${key}"]`)!;
/** 行の左（名前とキー）と右（値と札）の文 */
const cells = (key: string) => [
  rowOf(key).querySelector("th .config-name")!.textContent,
  rowOf(key).querySelector("th .config-key")!.textContent,
  rowOf(key).querySelector("td .config-workflow-value")!.textContent,
];
const jaOf = (text: string) => DEFAULT_VALUES[text]?.ja ?? text;

describe("設定画面の Workflow のタブ（workflow.yaml を読むだけで出す。UI-14）", () => {
  it("3 つ目のタブ「Workflow」に、6 つの項目を節、その下の値を行（名前とキーが左、値が右）で出し、入力欄と保存の操作を置かない", async () => {
    const c = client();
    await mount(c);
    await waitFor(() => expect(sectionOf("states")).toBeTruthy());
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "チーム",
      "自分",
      "Workflow",
    ]);
    expect(screen.getByRole("tab", { name: "Workflow" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    // 読むだけの帯：どのファイルの値かと、変えるには頼むこと
    const note = within(panel()).getByRole("note");
    expect(note.textContent).toContain("カンバンの流れと権限（読むだけ）");
    expect(within(note).getByText("workflow.yaml")).toBeTruthy();
    expect(note.textContent).toContain("吹き出しからエージェントに頼む");
    // 節は workflow.yaml の最上位の項目の順で、見出しに名前とキーを出す
    expect(
      [...document.querySelectorAll("section[data-section]")].map((s) => [
        s.querySelector("h3")!.textContent,
        s.querySelector(".config-section-head .config-key")!.textContent,
      ]),
    ).toEqual([
      ["状態", "states"],
      ["境目", "boundaries"],
      ["例外", "exceptions"],
      ["WIP の上限", "wip"],
      ["流れの段階", "flow"],
      ["カンバンの管理", "governance"],
    ]);
    expect(screen.getByRole("region", { name: "流れの段階" })).toBe(sectionOf("flow"));
    // 行は core の sections の行をそのままの順で出す
    const sections = c.data.workflow.sections!;
    for (const s of sections)
      expect(
        [...sectionOf(s.key).querySelectorAll("tr[data-key]")].map((r) =>
          r.getAttribute("data-key"),
        ),
        s.key,
      ).toEqual(s.rows.map((r) => `workflow.${r.key}`));
    expect(cells("exceptions.abandon")).toEqual([
      "やめる（abandoned へ動かす）",
      "exceptions.abandon",
      "always_ask",
    ]);
    expect(cells("governance.delete")).toEqual([
      "チケットの削除",
      "governance.delete",
      "human_only",
    ]);
    // リストは値を並べ、空のリストは「空」
    expect(cells("boundaries.todo.in_progress.requires")[2]).toBe("deps_done");
    expect(cells("boundaries.in_progress.review.requires")[2]).toBe("空");
    // 入力欄は検索だけで、ボタンは頼む吹き出しだけ（保存・既定に戻すはない）
    expect([...panel().querySelectorAll("input, select, textarea")]).toEqual([
      screen.getByLabelText("設定を検索"),
    ]);
    expect(panel().querySelectorAll("button:not(.ask-bubble)")).toHaveLength(0);
    expect(panel().querySelector(".config-saved")).toBeNull();
    // チームと自分のタブの中身は出さない
    expect(screen.queryByText("チーム全員に効く設定")).toBeNull();
  });

  it("省いた値も既定で出し、既定と違う行にだけ左の線と「変更あり」（title に既定の値）を付ける。既定と違うかは core の modified を写す", async () => {
    const c = client();
    await mount(c);
    await waitFor(() => expect(sectionOf("states")).toBeTruthy());
    const marks = (key: string) => [
      rowOf(key).classList.contains("modified"),
      rowOf(key).querySelector(".config-modified")?.getAttribute("title") ?? null,
    ];
    // 省いた値：既定のまま出て、印はない。既定のままの表示名は表示言語の訳で出す（UI-11）
    expect(cells("states.todo.label")).toEqual([
      "todo の表示名",
      "states.todo.label",
      jaOf("Todo"),
    ]);
    expect(marks("states.todo.label")).toEqual([false, null]);
    expect(cells("flow.assign")[2]).toBe("ask_unless_auto");
    expect(marks("flow.assign")).toEqual([false, null]);
    expect(cells("governance.create")[2]).toBe("anyone");
    expect(cells("wip.in_progress")[2]).toBe("5");
    expect(marks("wip.in_progress")).toEqual([false, null]);
    // 書いた値：書いたまま出し、「変更あり」の title に既定を出す（表示名の既定は訳）
    expect(cells("states.review.label")[2]).toBe("Client Review変更あり");
    expect(marks("states.review.label")).toEqual([true, `既定は ${jaOf("Review")}`]);
    expect(cells("boundaries.review.done.decide")[2]).toBe("human_only変更あり");
    expect(marks("boundaries.review.done.decide")).toEqual([true, "既定は ask_unless_auto"]);
    expect(marks("boundaries.review.done.requires")).toEqual([false, null]);
    expect(marks("flow.release")).toEqual([true, "既定は human_only"]);
    expect(cells("flow.skip")[2]).toBe("retro変更あり");
    expect(marks("flow.skip")).toEqual([true, "既定は 空"]);
    // wip は書いた列だけに上限が付く：既定で上限のある review は「上限なし」になる
    expect(cells("wip.review")[2]).toBe("上限なし変更あり");
    expect(marks("wip.review")).toEqual([true, "既定は 3"]);
    // 印は core の modified と同じ行にだけ付く（画面で比べない）
    const rows = c.data.workflow.sections!.flatMap((s) => s.rows);
    expect(
      rows.filter((r) => rowOf(r.key).classList.contains("modified")).map((r) => r.key),
    ).toEqual(rows.filter((r) => r.modified).map((r) => r.key));
    expect(
      rows.filter((r) => rowOf(r.key).querySelector(".config-modified")).map((r) => r.key),
    ).toEqual(rows.filter((r) => r.modified && !r.custom).map((r) => r.key));
  });

  it("独自の段階には「独自の段階」の札と after・guide を出す（既定がないので「変更あり」は付けず、左の線は付ける）", async () => {
    await mount(client());
    await waitFor(() => expect(sectionOf("flow")).toBeTruthy());
    const row = rowOf("flow.deploy-staging");
    expect(cells("flow.deploy-staging")).toEqual([
      "deploy-staging",
      "flow.deploy-staging",
      "always_ask独自の段階",
    ]);
    expect(row.classList.contains("modified")).toBe(true);
    expect(row.querySelector(".config-custom-stage")!.textContent).toBe("独自の段階");
    expect(row.querySelector(".config-modified")).toBeNull();
    expect(row.querySelector(".config-workflow-custom")!.textContent).toBe(
      "after audit guide docs/flow/deploy.md",
    );
    // 同梱の段階には札も after・guide もない
    expect(rowOf("flow.audit").querySelector(".config-custom-stage")).toBeNull();
    expect(rowOf("flow.audit").querySelector(".config-workflow-custom")).toBeNull();
  });

  it("workflow.yaml がなければ、どの値も既定で出してそう知らせる。行のない応答（前の版の cache）では読み込み中を出す", async () => {
    await mount(client(workflowView({}, { exists: false })));
    await waitFor(() => expect(sectionOf("states")).toBeTruthy());
    expect(screen.getByText("workflow.yaml がないので、どの値も既定の値")).toBeTruthy();
    expect(document.querySelectorAll("tr.modified")).toHaveLength(0);
    expect(document.querySelectorAll("tr[data-key]")).toHaveLength(
      workflowSections(DEFAULT_WORKFLOW).flatMap((s) => s.rows).length,
    );
    cleanup();
    await mount(client({ labels: DEFAULT_WORKFLOW.labels, moves: [] }));
    expect(within(panel()).getByText("読み込み中…")).toBeTruthy();
    expect(document.querySelector("section[data-section]")).toBeNull();
  });

  it("行と節の見出しの吹き出しから、workflow.<key> を core の ask に渡して /dgconfig の依頼文を開く。画面は workflow.yaml を書かない", async () => {
    expect(WORKFLOW_ITEM_PREFIX).toBe(ASK_WORKFLOW_KEY);
    const c = client();
    await mount(c);
    await waitFor(() => expect(sectionOf("flow")).toBeTruthy());
    const sections = c.data.workflow.sections!;
    // どの行にも節の見出しにも吹き出しが 1 つずつ
    for (const s of sections) {
      expect(
        within(sectionOf(s.key).querySelector<HTMLElement>(".config-section-head")!).getAllByRole(
          "button",
          { name: `エージェントに頼む（Workflow の節 ${s.key}）` },
        ),
      ).toHaveLength(1);
      for (const r of s.rows)
        expect(
          within(rowOf(r.key)).getAllByRole("button", {
            name: `エージェントに頼む（Workflow の項目 ${r.key}）`,
          }),
          r.key,
        ).toHaveLength(1);
    }
    // 候補は画面で組まず、節と行の組（= を付けた workflow.<key>）を ask-menu に渡して引く
    await waitFor(() =>
      expect(
        c.calls
          .filter((x) => x.name === "ask-menu")
          .flatMap((x) => (x.input as { sets: string[] }).sets),
      ).toEqual(
        expect.arrayContaining(
          sections.flatMap((s) => [
            `=workflow.${s.key}`,
            ...s.rows.map((r) => `=workflow.${r.key}`),
          ]),
        ),
      ),
    );
    const askText = async (button: HTMLElement) => {
      fireEvent.click(button);
      await waitFor(() => expect(screen.getAllByRole("menuitem")).toHaveLength(1));
      fireEvent.click(screen.getByRole("menuitem", { name: /設定を説明・変更する/ }));
      const composer = await screen.findByRole("region", { name: "エージェントに頼む" });
      fireEvent.click(within(composer).getByRole("button", { name: "全文" }));
      return () => within(composer).getByLabelText("全文", { selector: "pre" }).textContent;
    };
    // 行から：その値のキー
    const rowText = await askText(
      within(rowOf("flow.release")).getByRole("button", { name: /エージェントに頼む/ }),
    );
    await waitFor(() => expect(rowText()).toBe("/dgconfig workflow.flow.release"));
    const asks = () => c.calls.filter((x) => x.name === "ask").map((x) => x.input);
    expect(asks().length).toBeGreaterThan(0);
    expect(
      asks().every(
        (i) =>
          (i as { key?: string }).key === "workflow.flow.release" &&
          (i as { targets: string[] }).targets.length === 0,
      ),
    ).toBe(true);
    // 画面からは workflow.yaml も設定も書かない
    expect(c.calls.filter((x) => /^(workflow|config)\.(set|unset)$/.test(x.name))).toEqual([]);
  });

  it("節の見出しの吹き出しは、その項目の全体（workflow.<項目>）を /dgconfig に頼む", async () => {
    const c = client();
    await mount(c);
    await waitFor(() => expect(sectionOf("governance")).toBeTruthy());
    fireEvent.click(
      within(sectionOf("governance")).getByRole("button", {
        name: "エージェントに頼む（Workflow の節 governance）",
      }),
    );
    await waitFor(() => expect(screen.getAllByRole("menuitem")).toHaveLength(1));
    fireEvent.click(screen.getByRole("menuitem", { name: /設定を説明・変更する/ }));
    const composer = await screen.findByRole("region", { name: "エージェントに頼む" });
    fireEvent.click(within(composer).getByRole("button", { name: "全文" }));
    await waitFor(() =>
      expect(within(composer).getByLabelText("全文", { selector: "pre" }).textContent).toBe(
        "/dgconfig workflow.governance",
      ),
    );
  });

  it("検索で名前・キーから行を絞り、当たらない節は出さない。節の名前かキーに当たれば、その節の行をすべて出す", async () => {
    await mount(client());
    await waitFor(() => expect(sectionOf("states")).toBeTruthy());
    const search = screen.getByLabelText("設定を検索");
    expect(search.getAttribute("placeholder")).toBe("Workflow を検索（名前・キー・値）");
    const shown = () =>
      [...document.querySelectorAll("tr[data-key]")].map((r) =>
        r.getAttribute("data-key")!.slice("workflow.".length),
      );
    // 名前
    fireEvent.change(search, { target: { value: "リリース" } });
    expect(shown()).toEqual(["flow.release"]);
    expect(
      [...document.querySelectorAll("section[data-section]")].map((s) =>
        s.getAttribute("data-section"),
      ),
    ).toEqual(["flow"]);
    // キー（大文字小文字は区別しない。workflow. を付けた形でも当たる）
    fireEvent.change(search, { target: { value: "REVIEW.DONE" } });
    expect(shown()).toEqual(["boundaries.review.done.requires", "boundaries.review.done.decide"]);
    fireEvent.change(search, { target: { value: "workflow.exceptions.back" } });
    expect(shown()).toEqual(["exceptions.back"]);
    // 節の名前とキー：その節の行をすべて
    fireEvent.change(search, { target: { value: "カンバンの管理" } });
    expect(shown()).toEqual(
      ["delete", "config", "reassign", "epic", "create"].map((o) => `governance.${o}`),
    );
    fireEvent.change(search, { target: { value: "exceptions" } });
    expect(shown()).toEqual(["exceptions.abandon", "exceptions.back", "exceptions.reopen"]);
    // 独自の段階は名前（ID）と guide でも当たる
    fireEvent.change(search, { target: { value: "docs/flow" } });
    expect(shown()).toEqual(["flow.deploy-staging"]);
    // どれにも当たらない
    fireEvent.change(search, { target: { value: "当たらない語" } });
    expect(shown()).toEqual([]);
    expect(screen.getByText("該当する設定がない")).toBeTruthy();
  });

  it("英語の表示では、節と行の名前・帯・札を英語の訳で出し、既定のままの表示名は core の英語の文のまま出す", async () => {
    setLanguage("en");
    try {
      await mount(client());
      await waitFor(() => expect(sectionOf("states")).toBeTruthy());
      expect(sectionOf("flow").querySelector("h3")!.textContent).toBe("Flow stages");
      expect(cells("states.todo.label")).toEqual([
        "Display name of todo",
        "states.todo.label",
        "Todo",
      ]);
      expect(cells("wip.review")[2]).toBe("No limitModified");
      expect(rowOf("flow.deploy-staging").querySelector(".config-custom-stage")!.textContent).toBe(
        "Your own stage",
      );
      expect(within(panel()).getByRole("note").textContent).toContain("read-only");
    } finally {
      setLanguage("ja");
    }
  });
});

describe("Workflow のタブの部品", () => {
  it("core が返すどの節と行にも名前がある（項目を足したときの漏れを防ぐ）。独自の段階は ID を名前にする", () => {
    // wip はどの列にも上限を書いた形で、5 つの列の行を出させる
    const all = workflowSections(
      resolveWorkflow({ wip: { todo: 1, in_progress: 1, review: 1, done: 1, abandoned: 1 } }),
    );
    for (const s of all) {
      expect(workflowSectionName(s.key), s.key).not.toBe(s.key);
      for (const r of s.rows) expect(workflowRowName(r.key), r.key).not.toBe(r.key);
    }
    expect(workflowSectionName("unknown")).toBe("unknown");
    expect(workflowRowName("flow.deploy-staging")).toBe("deploy-staging");
  });

  it("workflowMatches は検索語が空ならすべてを返し、行に当たった節は当たった行だけにする", () => {
    const sections = workflowSections(resolveWorkflow(WRITTEN));
    expect(workflowMatches(sections, "  ")).toEqual(sections);
    expect(
      workflowMatches(sections, "human_only").map((s) => [s.key, s.rows.map((r) => r.key)]),
    ).toEqual([
      ["boundaries", ["boundaries.review.done.decide"]],
      ["governance", ["governance.delete", "governance.epic"]],
    ]);
  });
});
