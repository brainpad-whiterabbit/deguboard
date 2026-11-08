// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { HostProvider } from "../host.js";
import { createUiState, memoryBackend } from "../ui-state.js";
import { afterEach, describe, expect, it } from "vitest";
import { StoreProvider } from "../store.js";
import { setLanguage } from "../l10n.js";
import { PRIORITY_CRITERIA_EN } from "../l10n-en.js";
import { configFields } from "@deguboard/core";
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
  it("完了だけを塗り、進行中は斜線にして、数字に何の比かを書く", async () => {
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

  it("Status ごとに件数の割合で積み上げ、0 件の Status は出さない。short なら数字は done/全体 だけ", async () => {
    mount(
      <ProgressBar
        short
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
      { cls: "status-in_progress partial", width: "25%" },
      { cls: "status-todo partial", width: "50%" },
    ]);
  });

  it("チケットがなければ空のバーと「完了 0/0」", async () => {
    mount(
      <ProgressBar
        progress={{
          total: 0,
          done: 0,
          by_status: { todo: 0, in_progress: 0, review: 0, done: 0, abandoned: 0 },
        }}
      />,
    );
    const bar = (await screen.findByText("完了 0/0")).previousElementSibling!;
    expect(bar.children).toHaveLength(0);
  });
});

describe("優先度の印", () => {
  it("記号（SVG）と値の文字を出す。3 つの値を出す（medium も =）", async () => {
    mount(
      <>
        <PriorityMark priority="high" />
        <PriorityMark priority="medium" />
        <PriorityMark priority="low" />
      </>,
    );
    await screen.findByText("high");
    const marks = [...document.querySelectorAll(".priority-mark")];
    expect(marks).toHaveLength(3);
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

  it("英語の表示で既定のままの判断基準は英語の訳で出し、書き換えた値は書いた言葉のまま出す（UI-11）", async () => {
    const defaults = configFields().filter((f) => f.key.startsWith("priority."));
    const client = mockClient();
    const config = {
      default_project: "default",
      priority: { high: "独自の基準", medium: "", low: "" },
    };
    const shown = {
      config: { ...config, priority: { ...config.priority, medium: defaults[1]!.default } },
    };
    client.handlers["config.show"] = (input) =>
      (input as { fields?: boolean } | undefined)?.fields
        ? { ...shown, team: shown.config, local: {}, fields: defaults }
        : shown.config;
    setLanguage("en");
    try {
      render(
        <StoreProvider client={client}>
          <PriorityMark priority="high" />
          <PriorityMark priority="medium" />
        </StoreProvider>,
      );
      await screen.findByText("high");
      await waitFor(() =>
        expect(
          document.querySelector(".priority-mark.priority-medium")!.getAttribute("title"),
        ).toContain(PRIORITY_CRITERIA_EN.medium),
      );
      const titles = [...document.querySelectorAll(".priority-mark")].map((el) =>
        el.getAttribute("title"),
      );
      // 書き換えた high は書いた言葉のまま、既定のままの medium は英語の訳
      expect(titles[0]).toContain("独自の基準");
      expect(titles[1]).toContain(PRIORITY_CRITERIA_EN.medium);
    } finally {
      setLanguage("ja");
    }
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

  it("空の一覧は「該当するチケットはない」を出す", async () => {
    mount(<TicketTable tickets={[]} />);
    expect(await screen.findByText("該当するチケットはない")).toBeTruthy();
  });
});

describe("カンバンの行の頭の印", () => {
  it("running と idle の印は、それぞれ読み上げ用の名前を持つ", async () => {
    mount(
      <>
        <ActivityMark activity="running" />
        <ActivityMark activity="idle" />
      </>,
    );
    await screen.findByRole("img", { name: "Run が実行中" });
    screen.getByRole("img", { name: "着手済み（実行中の Run なし）" });
  });

  it("kanban の行は head の印を出し、list の行は head を使わず状態の丸印を出す", async () => {
    const t = ticket({ id: "t1", status: "in_progress" });
    mount(
      <>
        <TicketRow ticket={t} variant="kanban" head={<ActivityMark activity="idle" />} />
        <TicketRow ticket={t} head={<ActivityMark activity="idle" />} />
        <TicketRow ticket={t} variant="kanban" />
      </>,
    );
    await screen.findAllByText("t1");
    const [withHead, list, plain] = [...document.querySelectorAll<HTMLElement>(".ticket-row")];
    const idle = { name: "着手済み（実行中の Run なし）" };
    expect(within(withHead!).getByRole("img", idle)).toBeTruthy();
    expect(within(list!).queryByRole("img", idle)).toBeNull();
    expect(within(list!).getByRole("img", { name: "In Progress" })).toBeTruthy();
    expect(within(plain!).queryByRole("img", idle)).toBeNull();
    expect(within(plain!).getByText("t1")).toBeTruthy();
  });
});
