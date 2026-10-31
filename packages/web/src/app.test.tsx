// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./app.js";
import { ClientError } from "./client/http.js";
import { HostProvider, type Host } from "./host.js";
import { StoreProvider } from "./store.js";
import { mockClient } from "./test-helpers.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

function mount(client = mockClient(), host?: Host) {
  const app = host ? (
    <HostProvider host={host}>
      <App />
    </HostProvider>
  ) : (
    <App />
  );
  render(<StoreProvider client={client}>{app}</StoreProvider>);
  return client;
}

describe("画面", () => {
  it("カンバンは Workflow の表示名の 4 列で、チケットを Status の列に出す。abandoned は切り替えで出す", async () => {
    mount();
    await screen.findByText("ログイン");
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["Todo1", "In Progress1", "Code Review0", "Done1"]);
    expect(screen.queryByText("Abandoned")).toBeNull();
    fireEvent.click(screen.getByLabelText("abandoned を出す"));
    expect(screen.getByText("Abandoned")).toBeTruthy();
  });

  it("同期の印は未 push と未取り込みを出し、同期ボタンが sync を呼ぶ", async () => {
    const client = mockClient();
    client.data.status = { ...client.data.status, ahead: 2, behind: 1 };
    client.handlers["sync"] = () => ({});
    mount(client);
    expect(await screen.findByText("未 push 2")).toBeTruthy();
    expect(screen.getByText("未取り込み 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "同期" }));
    await waitFor(() => expect(client.calls.some((c) => c.name === "sync")).toBe(true));
  });

  it("バックログは done を除いて出し、検索で絞れる", async () => {
    window.location.hash = "#/backlog";
    mount();
    await screen.findByText("API");
    expect(screen.queryByText("ログイン")).toBeNull();
    fireEvent.change(screen.getByLabelText("検索"), { target: { value: "web" } });
    expect(screen.queryByText("API")).toBeNull();
    expect(screen.getByText("画面")).toBeTruthy();
  });

  it("チケット詳細は本文と属性を出し、Status の変更は ticket.move を通り、拒否されたら理由を出す", async () => {
    window.location.hash = "#/tickets/t3";
    const client = mockClient();
    client.handlers["ticket.move"] = () => {
      throw new ClientError({ code: "REJECTED", message: "依存先が終わっていない" });
    };
    mount(client);
    await screen.findByRole("heading", { level: 1, name: "画面" });
    expect(screen.getByText("本文")).toBeTruthy();
    expect(screen.getByText("a")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "in_progress" } });
    expect((await screen.findByRole("alert")).textContent).toContain("依存先が終わっていない");
    expect(client.calls.at(-1)).toMatchObject({
      name: "ticket.move",
      input: { ticket: "t3", status: "in_progress" },
    });
  });

  it("編集して保存すると ticket.update に属性と本文を渡す", async () => {
    window.location.hash = "#/tickets/t3";
    const client = mockClient();
    client.handlers["ticket.update"] = (input) => input;
    mount(client);
    await screen.findByRole("heading", { level: 1, name: "画面" });
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "新しい題" } });
    fireEvent.change(screen.getByLabelText("ラベル"), { target: { value: "web, ui" } });
    fireEvent.change(screen.getByLabelText("Epic"), { target: { value: "e1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.calls.some((c) => c.name === "ticket.update")).toBe(true));
    expect(client.calls.find((c) => c.name === "ticket.update")!.input).toMatchObject({
      ticket: "t3",
      title: "新しい題",
      labels: ["web", "ui"],
      epic: "e1",
      iteration: null,
    });
  });

  it("サイドバーではチケットのリンクがハッシュ遷移せず、ホストに開いてもらう", async () => {
    window.location.hash = "#/backlog";
    const opened: string[] = [];
    mount(mockClient(), { surface: "sidebar", openTicket: (id) => opened.push(id) });
    fireEvent.click(await screen.findByText("API"));
    expect(opened).toEqual(["t2"]);
    expect(window.location.hash).toBe("#/backlog");
  });

  it("サイドバーではカンバンの列が折りたためる節になり、チケットは 1 行で出る。空の節は「なし」", async () => {
    mount(mockClient(), { surface: "sidebar", openTicket: () => {} });
    await screen.findByText("ログイン");
    const app = document.querySelector(".app")!;
    expect(app.getAttribute("data-surface")).toBe("sidebar");
    const columns = [...document.querySelectorAll("details.column")];
    expect(columns).toHaveLength(4);
    expect(columns.every((c) => c.hasAttribute("open"))).toBe(true);
    expect(document.querySelectorAll(".card")).toHaveLength(0);
    expect(document.querySelectorAll(".row-drag .row")).toHaveLength(3);
    expect(screen.getAllByText("なし")).toHaveLength(1);
    expect(screen.queryByText("deguboard")).toBeNull();
  });

  it("サイドバーではチケット詳細のルートでもバックログを出す（詳細はエディタのパネル）", async () => {
    window.location.hash = "#/tickets/t3";
    mount(mockClient(), { surface: "sidebar", openTicket: () => {} });
    await screen.findByText("API");
    expect(screen.queryByRole("heading", { level: 1, name: "画面" })).toBeNull();
    expect(document.querySelector("table.list")).toBeNull();
    expect(document.querySelectorAll("ul.rows > li")).toHaveLength(2);
  });

  it("Webview がリンクのクリックを横取りしても（document で preventDefault）、タブを押すとハッシュが変わり aria-current が移る", async () => {
    const intercept = (e: Event) => e.preventDefault();
    document.addEventListener("click", intercept);
    try {
      mount(mockClient(), { surface: "sidebar", openTicket: () => {} });
      await screen.findByText("ログイン");
      const board = screen.getByRole("link", { name: "カンバン" });
      expect(board.getAttribute("aria-current")).toBe("page");
      fireEvent.click(screen.getByRole("link", { name: "バックログ" }));
      expect(window.location.hash).toBe("#/backlog");
      await screen.findByRole("heading", { level: 1, name: "バックログ" });
      expect(screen.getByRole("link", { name: "バックログ" }).getAttribute("aria-current")).toBe(
        "page",
      );
      expect(board.getAttribute("aria-current")).toBeNull();
    } finally {
      document.removeEventListener("click", intercept);
    }
  });

  it("エディタのパネルのチケットリンクはホストに頼み（同じパネルで遷移して題が変わる）、それ以外のリンクはハッシュ遷移", async () => {
    window.location.hash = "#/backlog";
    const opened: string[] = [];
    mount(mockClient(), { surface: "panel", openTicket: (id) => opened.push(id) });
    fireEvent.click(await screen.findByText("API"));
    expect(opened).toEqual(["t2"]);
    expect(window.location.hash).toBe("#/backlog");
    fireEvent.click(screen.getByRole("link", { name: "Epic" }));
    expect(window.location.hash).toBe("#/epics");
  });

  it("エディタのパネルでチケット詳細を出すときはヘッダー（タブ・Project・同期）を出さない。カンバンでは出す", async () => {
    window.location.hash = "#/tickets/t3";
    mount(mockClient(), { surface: "panel", openTicket: () => {} });
    await screen.findByRole("heading", { level: 1, name: "画面" });
    expect(screen.queryByRole("navigation", { name: "画面" })).toBeNull();
    expect(screen.queryByRole("button", { name: "同期" })).toBeNull();
    expect(screen.queryByText("deguboard")).toBeNull();
    window.location.hash = "#/board";
    await screen.findByRole("navigation", { name: "画面" });
    expect(screen.getByRole("button", { name: "同期" })).toBeTruthy();
  });

  it("ブラウザではチケットのリンクが詳細へのハッシュ遷移のまま", async () => {
    window.location.hash = "#/backlog";
    mount();
    const link = (await screen.findByText("API")).closest("a")!;
    expect(link.getAttribute("href")).toBe("#/tickets/t2");
  });

  it("Epic の一覧は進捗を出す", async () => {
    window.location.hash = "#/epics";
    mount();
    expect(await screen.findByText("最初の版")).toBeTruthy();
    expect(screen.getByText("0/1")).toBeTruthy();
  });
});
