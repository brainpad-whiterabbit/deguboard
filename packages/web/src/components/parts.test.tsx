// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { HostProvider } from "../host.js";
import { createUiState, memoryBackend } from "../ui-state.js";
import { afterEach, describe, expect, it } from "vitest";
import { StoreProvider } from "../store.js";
import {
  ActivityMark,
  PriorityMark,
  ProgressBar,
  RowPriority,
  StatusDot,
  TicketRow,
  TicketTable,
  priorityTitle,
  sameAssignee,
} from "./parts.js";
import { mockClient, ticket } from "../test-helpers.js";

afterEach(cleanup);

function mount(node: React.ReactNode) {
  render(<StoreProvider client={mockClient()}>{node}</StoreProvider>);
}

describe("行の担当", () => {
  it("すべて同じ 1 人のときだけ true。担当のないチケットが混ざる・行がないときは false", () => {
    expect(sameAssignee([{ assignee: "eiki/agent" }, { assignee: "eiki/agent" }])).toBe(true);
    expect(sameAssignee([{ assignee: "eiki/agent" }, { assignee: "eiki" }])).toBe(false);
    expect(sameAssignee([{ assignee: "eiki/agent" }, {}])).toBe(false);
    expect(sameAssignee([{}, {}])).toBe(false);
    expect(sameAssignee([])).toBe(false);
  });
});

describe("進捗バー", () => {
  it("Webview では完了だけを塗り、進行中は斜線にして、数字に何の比かを書く", async () => {
    render(
      <StoreProvider client={mockClient()}>
        <HostProvider
          host={{
            surface: "sidebar",
            open: () => {},
            show: () => {},
            copy: async () => {},
            state: createUiState(memoryBackend()),
          }}
        >
          <ProgressBar
            progress={{
              total: 5,
              done: 0,
              by_status: { todo: 1, in_progress: 3, review: 1, done: 0, abandoned: 0 },
            }}
          />
        </HostProvider>
      </StoreProvider>,
    );
    const label = await screen.findByText("完了 0/5 ・ 進行中 4");
    const segments = [...label.previousElementSibling!.children].map((el) => el.className);
    expect(segments).toEqual([
      "status-review partial",
      "status-in_progress partial",
      "status-todo partial",
    ]);
  });

  it("Status ごとに件数の割合で積み上げ、0 件の Status は出さない", async () => {
    mount(
      <ProgressBar
        progress={{
          total: 4,
          done: 1,
          by_status: { todo: 2, in_progress: 1, review: 0, done: 1, abandoned: 3 },
        }}
      />,
    );
    const bar = (await screen.findByText("1/4")).previousElementSibling!;
    const segments = [...bar.children].map((el) => ({
      cls: el.className,
      width: (el as HTMLElement).style.width,
    }));
    expect(segments).toEqual([
      { cls: "status-done", width: "25%" },
      { cls: "status-in_progress", width: "25%" },
      { cls: "status-todo", width: "50%" },
    ]);
  });

  it("チケットがなければ空のバーと 0/0", async () => {
    mount(
      <ProgressBar
        progress={{
          total: 0,
          done: 0,
          by_status: { todo: 0, in_progress: 0, review: 0, done: 0, abandoned: 0 },
        }}
      />,
    );
    const bar = (await screen.findByText("0/0")).previousElementSibling!;
    expect(bar.children).toHaveLength(0);
  });
});

describe("優先度の印", () => {
  it("記号（SVG）と値の文字を出し、色のクラスを付ける。3 つの値を出す（medium も =）", async () => {
    mount(
      <>
        <PriorityMark priority="high" />
        <PriorityMark priority="medium" />
        <PriorityMark priority="low" />
      </>,
    );
    await screen.findByText("high");
    const marks = [...document.querySelectorAll(".priority-mark")];
    expect(marks.map((m) => m.className)).toEqual([
      "priority-mark priority-high",
      "priority-mark priority-medium",
      "priority-mark priority-low",
    ]);
    // どの値にも 10px の SVG の記号と値の文字が付く
    for (const m of marks) {
      const svg = m.querySelector("svg.priority-glyph")!;
      expect(svg.getAttribute("width")).toBe("10");
      expect(m.querySelector(".priority-text")).toBeTruthy();
    }
    expect(marks.map((m) => m.querySelector(".priority-text")!.textContent)).toEqual([
      "high",
      "medium",
      "low",
    ]);
  });

  it("ツールチップは 1 行目に値と並び方、2 行目から判断基準（config、なければ既定）を出す", async () => {
    mount(<PriorityMark priority="high" />);
    await screen.findByText("high");
    const title = document.querySelector(".priority-mark")!.getAttribute("title")!;
    const [head, ...rest] = title.split("\n");
    expect(head).toBe("優先度 high（上に並ぶ）");
    // 2 行目からは mockClient の config.show の priority.high（判断基準）
    expect(rest.join("\n")).toBe("利用者に見える不具合・ほかのチケットを止めている");
  });

  it("priorityTitle は判断基準が空（未ロード）なら 1 行目だけを返し、改行も基準も付けない", () => {
    const empty = { high: "", medium: "", low: "" };
    expect(priorityTitle("high", empty)).toBe("優先度 high（上に並ぶ）");
    expect(priorityTitle("low", empty)).not.toContain("\n");
    // 基準があれば 2 行目に付く
    expect(priorityTitle("high", { ...empty, high: "基準" })).toBe("優先度 high（上に並ぶ）\n基準");
  });

  it("行の印（RowPriority）は high・low を出し、medium は出さない", async () => {
    mount(
      <>
        <RowPriority priority="high" />
        <RowPriority priority="medium" />
        <RowPriority priority="low" />
      </>,
    );
    await screen.findByText("high");
    expect(
      [...document.querySelectorAll(".priority-mark .priority-text")].map((m) => m.textContent),
    ).toEqual(["high", "low"]);
  });
});

describe("状態の印と空の一覧", () => {
  it("丸印は Workflow の表示名を読み上げ用の名前にする", async () => {
    mount(<StatusDot status="review" />);
    expect(await screen.findByRole("img", { name: "Code Review" })).toBeTruthy();
  });

  it("空の一覧は破線の枠（.empty）で出す", async () => {
    mount(<TicketTable tickets={[]} />);
    expect((await screen.findByText("該当するチケットはない")).className).toBe("empty");
  });
});

describe("カンバンの行の頭の印", () => {
  it("running は回るリング、idle は止まった半分塗りの丸で、読み上げ用の名前を持つ", async () => {
    mount(
      <>
        <ActivityMark activity="running" />
        <ActivityMark activity="idle" />
      </>,
    );
    const ring = await screen.findByRole("img", { name: "Run が実行中" });
    expect(ring.className).toBe("activity-mark activity-running");
    const half = screen.getByRole("img", { name: "着手済み（実行中の Run なし）" });
    expect(half.className).toBe("activity-mark activity-idle");
  });

  it("kanban の行は head を番号の前に出して has-head を付け、list の行は head を使わず丸印を出す", async () => {
    const t = ticket({ id: "t1", status: "in_progress" });
    mount(
      <>
        <TicketRow ticket={t} variant="kanban" head={<ActivityMark activity="idle" />} />
        <TicketRow ticket={t} head={<ActivityMark activity="idle" />} />
        <TicketRow ticket={t} variant="kanban" />
      </>,
    );
    await screen.findAllByText("t1");
    const [withHead, list, plain] = [...document.querySelectorAll(".ticket-row")];
    expect(withHead!.classList.contains("has-head")).toBe(true);
    expect(withHead!.firstElementChild!.classList.contains("activity-idle")).toBe(true);
    expect(list!.querySelector(".activity-mark")).toBeNull();
    expect(list!.firstElementChild!.classList.contains("status-dot")).toBe(true);
    expect(plain!.classList.contains("has-head")).toBe(false);
    expect(plain!.firstElementChild!.tagName).toBe("CODE");
  });
});
