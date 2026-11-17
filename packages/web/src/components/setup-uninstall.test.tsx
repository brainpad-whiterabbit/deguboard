// @vitest-environment jsdom
import type { SetupAction, SetupView, UninstallPreview } from "@deguboard/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostProvider, type Host } from "../host.js";
import { StoreProvider } from "../store.js";
import { mockClient, setupView } from "../test-helpers.js";
import { createUiState, memoryBackend, SETUP_UNINSTALL_KEY } from "../ui-state.js";
import { SetupBand, SetupChecklist } from "./setup-checklist.js";
import { UNINSTALL_SETTLE_MS } from "./setup-uninstall.js";

afterEach(cleanup);

/** dg uninstall --dry-run の結果。止める理由のない、このリポジトリだけの範囲 */
const CLEAN: UninstallPreview = {
  personal: false,
  removes: [
    { kind: "hooks", scope: "repository", target: "/work/repo/.claude/settings.local.json" },
    {
      kind: "skills",
      scope: "repository",
      target: "/work/repo/.claude/skills",
      names: ["dgwork", "dgplan"],
    },
    { kind: "data_worktree", scope: "repository", target: "/work/repo/.git/deguboard" },
  ],
  keeps: [
    {
      kind: "remote_data_branch",
      target: "origin/deguboard",
      reason: "The board data stays on the remote",
      commands: ["git push origin --delete deguboard"],
    },
  ],
  blockers: [],
};

const BLOCKED: UninstallPreview = {
  ...CLEAN,
  blockers: [
    {
      kind: "unpushed",
      message: "2 commit(s) of the board data are not pushed",
      next: ["dg sync"],
    },
    {
      kind: "active_worktrees",
      message:
        "Tickets not finished yet have worktrees in this clone: t12 (/work/repo.worktrees/t12)",
      next: ["dg ticket list", "git worktree list"],
    },
  ],
};

/** VS Code の中の Host。acts に頼んだ操作、asked に確かめた範囲（personal）が入り、previews の先頭から順に結果を返す（最後は繰り返す） */
function vscodeHost(previews: UninstallPreview[] = [CLEAN]) {
  const acts: SetupAction[] = [];
  const asked: boolean[] = [];
  const queue = [...previews];
  const host: Host = {
    surface: "sidebar",
    extension: true,
    open: () => {},
    show: () => {},
    copy: async () => {},
    state: createUiState(memoryBackend()),
    setupAct: async (act) => void acts.push(act),
    uninstallPreview: async (personal) => {
      asked.push(personal);
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return { ...next, personal };
    },
  };
  return { host, acts, asked };
}

function tree(view: SetupView, host: Host, uninstall?: string) {
  const client = mockClient();
  client.setup = async () => view;
  return (
    <StoreProvider client={client}>
      <HostProvider host={host}>
        <SetupChecklist view={view} uninstall={uninstall} />
      </HostProvider>
    </StoreProvider>
  );
}

const toggle = () => screen.getByRole("button", { name: /アンインストール/ });
const body = () => document.querySelector<HTMLElement>(".setup-uninstall-body")!;

describe("導入のチェックリストの「アンインストール」の節", () => {
  it("必須を満たした後のチェックリストの末尾に閉じた節があり、開くまで消すものを確かめない", () => {
    const { host, asked } = vscodeHost();
    render(tree(setupView(), host));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".setup")!.lastElementChild!.className).toBe("setup-uninstall");
    expect(document.querySelector(".setup-uninstall-body")).toBeNull();
    expect(asked).toEqual([]);
  });

  it("必須を満たさない間と、拡張ホストのない入口（dg serve）には節を出さない。推奨の帯にも出さない", () => {
    const { host } = vscodeHost();
    render(tree(setupView({ board: { status: "unmet", fix: ["dg init"] } }), host));
    expect(screen.queryByRole("button", { name: /アンインストール/ })).toBeNull();
    cleanup();
    const browser: Host = {
      ...host,
      extension: false,
      setupAct: undefined,
      uninstallPreview: undefined,
    };
    render(tree(setupView(), browser));
    expect(screen.queryByRole("button", { name: /アンインストール/ })).toBeNull();
    cleanup();
    const view = setupView({ skills_hooks: { status: "unmet", fix: ["dg hooks install"] } });
    render(
      <StoreProvider client={mockClient()}>
        <HostProvider host={host}>
          <SetupBand view={view} onOpen={() => {}} />
        </HostProvider>
      </StoreProvider>,
    );
    expect(document.querySelector(".setup-band")!.textContent).not.toContain("アンインストール");
  });

  it("開くと範囲を選べ、dg uninstall --dry-run の結果から消すものと残すものを出す。範囲を変えると確かめ直す", async () => {
    const { host, asked } = vscodeHost();
    render(tree(setupView(), host));
    fireEvent.click(toggle());
    expect(screen.getByRole("radio", { name: "このリポジトリだけ" })).toHaveProperty(
      "checked",
      true,
    );
    await waitFor(() => expect(document.querySelector(".setup-uninstall-list")).toBeTruthy());
    const [removes, keeps] = [...document.querySelectorAll(".setup-uninstall-list")];
    expect([...removes!.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "−dg のフック/work/repo/.claude/settings.local.json",
      "−dg の Skill（2 個）/work/repo/.claude/skills",
      "−ボードの worktree/work/repo/.git/deguboard",
    ]);
    expect([...keeps!.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "·リモートのボードorigin/deguboard",
      "·VS Code 拡張と dg コマンド",
    ]);
    // 残すものを消すコマンド（リモートのボードを消す）は出さない
    expect(body().textContent).not.toContain("git push origin --delete");
    fireEvent.click(screen.getByRole("radio", { name: "個人の Skill とフックも" }));
    await waitFor(() => expect(asked).toEqual([false, true]));
  });

  it("止める理由がある間は実行のボタンを押せず、「同期する」を出す。同期すると確かめ直し、理由がなくなれば押せる", async () => {
    const { host, acts, asked } = vscodeHost([BLOCKED, CLEAN]);
    render(tree(setupView(), host));
    fireEvent.click(toggle());
    const stop = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(".setup-uninstall-stop");
      expect(found).toBeTruthy();
      return found!;
    });
    expect(within(stop).getByText("このままでは外せません")).toBeTruthy();
    expect(within(stop).getByText("リモートへ送っていないボードのデータがあります。")).toBeTruthy();
    // どのチケットの worktree かは core の文にしかないので、そのまま添える
    expect(stop.textContent).toContain("t12 (/work/repo.worktrees/t12)");
    expect(within(stop).getByText("git worktree list")).toBeTruthy();
    expect(screen.getByRole("button", { name: "外す…" })).toHaveProperty("disabled", true);
    fireEvent.click(within(stop).getByRole("button", { name: "同期する" }));
    await waitFor(() => expect(document.querySelector(".setup-uninstall-stop")).toBeNull());
    expect(acts).toEqual(["sync"]);
    expect(asked).toEqual([false, false]);
    expect(screen.getByRole("button", { name: "外す…" })).toHaveProperty("disabled", false);
  });

  it("2 段階に確かめた後、選んだ範囲の dg uninstall を拡張ホストに頼む。やめると頼まない", async () => {
    const { host, acts } = vscodeHost();
    render(tree(setupView(), host));
    fireEvent.click(toggle());
    const first = await screen.findByRole("button", { name: "外す…" });
    await waitFor(() => expect(first).toHaveProperty("disabled", false));
    fireEvent.click(first);
    expect(acts).toEqual([]);
    const confirm = document.querySelector<HTMLElement>(".setup-uninstall-confirm")!;
    expect(within(confirm).getByText("dg uninstall")).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "やめる" }));
    expect(document.querySelector(".setup-uninstall-confirm")).toBeNull();
    expect(acts).toEqual([]);
    fireEvent.click(screen.getByRole("radio", { name: "個人の Skill とフックも" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "外す…" })).toHaveProperty("disabled", false),
    );
    fireEvent.click(screen.getByRole("button", { name: "外す…" }));
    expect(
      within(document.querySelector<HTMLElement>(".setup-uninstall-confirm")!).getByText(
        "dg uninstall --personal",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "外す" }));
    expect(acts).toEqual(["uninstallPersonal"]);
  });

  it("コマンドパレットから開いたとき（uninstall）は、節を開いて出す。節を閉じた後にもう一度実行すると、開き直す", async () => {
    const { host, asked } = vscodeHost();
    const view = setupView();
    const { rerender } = render(tree(view, host, "1"));
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(asked).toEqual([false]));
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    // 同じ印のままなら閉じたまま。コマンドの実行のたびに印が変わるので、開き直す
    rerender(tree(view, host, "1"));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    rerender(tree(view, host, "2"));
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("必須を満たさない間にコマンドパレットから開くと、外すものがないことを知らせる。ふつうに開いたときは出さない", () => {
    const { host } = vscodeHost();
    const gone = setupView({ board: { status: "unmet", fix: ["dg init"] } });
    const { rerender } = render(tree(gone, host));
    expect(screen.queryByText("ボードがないので、この画面から外すものはありません。")).toBeNull();
    rerender(tree(gone, host, "1"));
    expect(screen.getByText("ボードがないので、この画面から外すものはありません。")).toBeTruthy();
    expect(document.querySelector(".setup-uninstalled")).toBeNull();
  });

  it("実行後に必須を満たさないチェックリストに戻ると、拡張は最後に消すことを知らせ、拡張の画面を開くボタンを置く。閉じると消える", async () => {
    const { host, acts } = vscodeHost();
    const { rerender } = render(tree(setupView(), host));
    fireEvent.click(toggle());
    const first = await screen.findByRole("button", { name: "外す…" });
    await waitFor(() => expect(first).toHaveProperty("disabled", false));
    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", { name: "外す" }));
    expect(acts).toEqual(["uninstall"]);
    expect(document.querySelector(".setup-uninstalled")).toBeNull();
    // dg uninstall がボードを消し、確かめ直しで必須を満たさなくなった
    const gone = setupView({ board: { status: "unmet", state: "remote_board", fix: ["dg init"] } });
    rerender(tree(gone, host));
    const notice = document.querySelector<HTMLElement>(".setup-uninstalled")!;
    expect(document.querySelector(".setup")!.firstElementChild).toBe(notice);
    expect(notice.textContent).toContain("拡張を消すのは最後にしてください");
    expect(screen.getByRole("heading", { name: "deguboard を始める" })).toBeTruthy();
    fireEvent.click(within(notice).getByRole("button", { name: "拡張の画面を開く" }));
    expect(acts).toEqual(["uninstall", "showExtension"]);
    fireEvent.click(within(notice).getByRole("button", { name: "閉じる" }));
    expect(document.querySelector(".setup-uninstalled")).toBeNull();
  });

  it("画面から実行していなければ、必須を満たさないチェックリストに知らせを出さない。入れ直した後は前の知らせを残さない", async () => {
    const { host } = vscodeHost();
    const gone = setupView({ board: { status: "unmet", fix: ["dg init"] } });
    render(tree(gone, host));
    expect(document.querySelector(".setup-uninstalled")).toBeNull();
    // 外した後の知らせを出したまま入れ直し、その後にまた必須を満たさなくなった
    host.state.set(SETUP_UNINSTALL_KEY, { cwd: gone.cwd });
    cleanup();
    const again = render(tree(gone, host));
    expect(document.querySelector(".setup-uninstalled")).toBeTruthy();
    again.rerender(tree(setupView(), host));
    await waitFor(() => expect(host.state.get(SETUP_UNINSTALL_KEY)).toBeUndefined());
    cleanup();
    render(tree(gone, host));
    expect(document.querySelector(".setup-uninstalled")).toBeNull();
  });

  it("知らせは実行したフォルダのチェックリストにだけ出す（Webview の状態はフォルダごとではない）", () => {
    const { host } = vscodeHost();
    const gone = setupView({ board: { status: "unmet", fix: ["dg init"] } });
    host.state.set(SETUP_UNINSTALL_KEY, { cwd: gone.cwd });
    const { rerender } = render(tree({ ...gone, cwd: "/work/other" }, host));
    expect(document.querySelector(".setup-uninstalled")).toBeNull();
    rerender(tree(gone, host));
    expect(document.querySelector(".setup-uninstalled")).toBeTruthy();
  });

  /** 節を開き、2 段階に確かめて実行するところまで進める */
  async function runFromScreen(): Promise<void> {
    fireEvent.click(toggle());
    const first = await screen.findByRole("button", { name: "外す…" });
    await waitFor(() => expect(first).toHaveProperty("disabled", false));
    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", { name: "外す" }));
  }

  it("実行の後に取り直した結果に止める理由があれば（dg が断った）、印を消し、後で必須を満たさなくなっても外したと言わない", async () => {
    const { host, acts } = vscodeHost([CLEAN, BLOCKED]);
    const { rerender } = render(tree(setupView(), host));
    await runFromScreen();
    expect(acts).toEqual(["uninstall"]);
    expect(host.state.get(SETUP_UNINSTALL_KEY)).toEqual({ cwd: "/work/repo" });
    // 確かめ直しでチェックリストが新しくなり（ボードは残っている）、消すものを取り直す
    rerender(tree(setupView(), host));
    await waitFor(() => expect(document.querySelector(".setup-uninstall-stop")).toBeTruthy());
    expect(host.state.get(SETUP_UNINSTALL_KEY)).toBeUndefined();
    expect(body().textContent).not.toContain("deguboard のターミナルで実行しました");
    rerender(tree(setupView({ board: { status: "unmet", fix: ["dg init"] } }), host));
    expect(document.querySelector(".setup-uninstalled")).toBeNull();
  });

  it("実行して待ってもボードが残っていれば（ターミナルが実行中で送らなかったなど）、印を消し、まだ外れていないことを知らせる", async () => {
    const { host, asked } = vscodeHost();
    render(tree(setupView(), host));
    fireEvent.click(toggle());
    const first = await screen.findByRole("button", { name: "外す…" });
    await waitFor(() => expect(first).toHaveProperty("disabled", false));
    fireEvent.click(first);
    // 実行の時刻と待つタイマーを偽の時計に載せる（実行のボタンを押す前から）
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      fireEvent.click(screen.getByRole("button", { name: "外す" }));
      expect(asked).toEqual([false]);
      // すぐには決めない（消している途中かもしれない）。待った後に取り直し、ボードが残っていれば外れなかった
      await act(() => vi.advanceTimersByTimeAsync(UNINSTALL_SETTLE_MS - 1));
      expect(asked).toEqual([false]);
      await act(() => vi.advanceTimersByTimeAsync(1));
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(host.state.get(SETUP_UNINSTALL_KEY)).toBeUndefined());
    expect(asked).toEqual([false, false]);
    expect(body().textContent).toContain("まだ外れていません。");
  });
});
