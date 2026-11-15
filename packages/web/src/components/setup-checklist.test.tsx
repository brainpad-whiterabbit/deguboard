// @vitest-environment jsdom
import {
  DEFAULT_DATA_BRANCH as CORE_DEFAULT_DATA_BRANCH,
  initCommandLine as coreInitCommandLine,
  type SetupAction,
  type SetupView,
  type SetupViewItem,
} from "@deguboard/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostProvider, type Host } from "../host.js";
import { StoreProvider, useStore } from "../store.js";
import { mockClient, setupView } from "../test-helpers.js";
import { createUiState, memoryBackend } from "../ui-state.js";
import {
  DEFAULT_DATA_BRANCH,
  guideOf,
  initCommandLine,
  SetupChecklist,
} from "./setup-checklist.js";

afterEach(cleanup);

describe("core の写し（web は core の実行時のコードを取り込めない）", () => {
  it("データのブランチの既定と dg init の 1 行が core と同じ", () => {
    expect(DEFAULT_DATA_BRANCH).toBe(CORE_DEFAULT_DATA_BRANCH);
    for (const options of [
      {},
      { dataRemote: "git@github.com:team/kanban.git", dataBranch: "kanban" },
      { dataRemote: "kanban", newBoard: true },
      { dataRemote: "/srv/my repo; rm -rf ~", dataBranch: "a'b", newBoard: true },
      { dataRemote: "kanban", dataBranch: "=foo" },
      { dataRemote: "kanban", dataBranch: "a=b" },
    ])
      expect(initCommandLine(options)).toBe(coreInitCommandLine(options));
  });
});

/** VS Code の中（ボタンの操作を拡張ホストに頼める）の Host。acts に頼んだ操作が入る */
function vscodeHost(acts: SetupAction[] = []): Host {
  return {
    surface: "sidebar",
    open: () => {},
    show: () => {},
    copy: async () => {},
    state: createUiState(memoryBackend()),
    setupAct: async (act) => void acts.push(act),
  };
}

/** dg serve のブラウザ（拡張ホストがなく、ボタンの操作を頼めない）の Host */
function browserHost(copy: Host["copy"] = async () => {}): Host {
  return {
    surface: "sidebar",
    open: () => {},
    show: () => {},
    copy,
    state: createUiState(memoryBackend()),
  };
}

function mount(view: SetupView, host: Host = vscodeHost(), onClose?: () => void) {
  const client = mockClient();
  const setup = vi.fn(async () => view);
  client.setup = setup;
  render(
    <StoreProvider client={client}>
      <HostProvider host={host}>
        <SetupChecklist view={view} {...(onClose ? { onClose } : {})} />
      </HostProvider>
    </StoreProvider>,
  );
  return { client, setup };
}

/** 項目の行（<li>）を名前で引く */
function row(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>(".setup-item")].find((li) =>
    li.querySelector(".setup-name")!.textContent!.startsWith(name),
  );
  if (!found) throw new Error(`項目がない: ${name}`);
  return found;
}

/** 項目の中身の要素の並びを、文言の決まりの 4 つの段（状態・すること・ターミナルで行うなら・別の道）と断り書きの番号にする */
function guideOrder(guide: Element): number[] {
  let stage = 0;
  return [...guide.children].map((el) => {
    if (el.classList.contains("setup-status")) stage = 1;
    else if (el.classList.contains("setup-alt")) stage = 4;
    else if (el.classList.contains("setup-note")) stage = 5;
    else if (
      el.classList.contains("setup-slot") &&
      /^ターミナルで(行うなら|実行する)$/.test(el.textContent ?? "")
    )
      stage = 3;
    else if (stage < 2) stage = 2;
    return stage;
  });
}

describe("導入のチェックリスト（必須を満たさない間）", () => {
  it("フォルダ・OS・git・Git リポジトリ・ボードと推奨の項目を上から並べ、満たさない最初の項目にだけ状態・ボタン・コマンドを出す", () => {
    mount(setupView({ repository: { status: "unmet", fix: ["git init"] } }));
    expect(screen.getByRole("heading", { name: "deguboard を始める" })).toBeTruthy();
    expect(
      [...document.querySelectorAll(".setup-item")].map((li) => [
        li.querySelector(".setup-name")!.firstChild!.textContent,
        li.className.replace("setup-item ", ""),
      ]),
    ).toEqual([
      ["フォルダ", "ok"],
      ["OS", "ok"],
      ["git", "ok"],
      ["Git リポジトリ", "unmet"],
      ["ボード", "pending"],
      ["Skill と hooks", "pending"],
      ["dg コマンド", "pending"],
      [".claude/.gitignore", "pending"],
    ]);
    // 開くのは満たさない最初の項目だけ
    expect(document.querySelectorAll(".setup-guide")).toHaveLength(1);
    const repo = within(row("Git リポジトリ"));
    expect(repo.getByText("このフォルダは Git リポジトリではありません。")).toBeTruthy();
    // 作る場所を見せる
    expect(repo.getByText("/work/repo")).toBeTruthy();
    expect(repo.getByRole("button", { name: "このフォルダに git init する" })).toBeTruthy();
    expect(repo.getByText("git init")).toBeTruthy();
    expect(repo.getByRole("button", { name: "git init をコピー" })).toBeTruthy();
    // 印は読み上げでも分かる
    expect(repo.getByRole("img", { name: "満たしていない" })).toBeTruthy();
    expect(within(row("ボード")).getByRole("img", { name: "まだ確かめていない" })).toBeTruthy();
  });

  it("ボタンを押すと拡張ホストに操作を頼む。別の道のボタンも同じ", () => {
    const acts: SetupAction[] = [];
    mount(setupView({ repository: { status: "unmet", fix: ["git init"] } }), vscodeHost(acts));
    fireEvent.click(screen.getByRole("button", { name: "このフォルダに git init する" }));
    fireEvent.click(screen.getByRole("button", { name: "フォルダを開き直す" }));
    expect(acts).toEqual(["gitInit", "openFolder"]);
  });

  it("手で確かめ直すボタンは、見出しの横と、直すのが人の手だけの項目の中にあり、押すと確かめ直す", async () => {
    const { setup } = mount(setupView({ git: { status: "unmet" } }));
    const before = setup.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "確かめ直す" }));
    await waitFor(() => expect(setup.mock.calls.length).toBeGreaterThan(before));
    const again = setup.mock.calls.length;
    fireEvent.click(within(row("git")).getByRole("button", { name: "もう一度確かめる" }));
    await waitFor(() => expect(setup.mock.calls.length).toBeGreaterThan(again));
  });

  it("dg serve のブラウザには拡張に頼むボタンがなく、コマンドをコピーするだけ。ボタンしかない別の道は出さない", async () => {
    const copy = vi.fn(async () => {});
    mount(setupView({ repository: { status: "unmet", fix: ["git init"] } }), browserHost(copy));
    expect(screen.queryByRole("button", { name: "このフォルダに git init する" })).toBeNull();
    expect(screen.queryByText("別のフォルダで使うつもりなら")).toBeNull();
    // コマンドが唯一の道なので「なら」を付けない
    expect(screen.getByText("ターミナルで実行する")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "git init をコピー" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith("git init"));
  });

  it("フォルダを開いていないときは、フォルダの項目に「フォルダを開く」を出す", () => {
    const acts: SetupAction[] = [];
    mount({ ...setupView({ folder: { status: "unmet" } }), cwd: null }, vscodeHost(acts));
    expect(within(row("フォルダ")).getByText("フォルダを開いていません。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "フォルダを開く" }));
    expect(acts).toEqual(["openFolder"]);
  });
});

describe("ボードの項目（dg init がすることを先に確かめた結果）", () => {
  const board = (state: string, extra: Partial<SetupViewItem> = {}) =>
    setupView({ board: { status: "unmet", state, fix: ["dg init"], ...extra } });

  it("remote にチームのボードがあれば、取り込むボタンと dg init を出す", () => {
    const acts: SetupAction[] = [];
    mount(board("remote_board"), vscodeHost(acts));
    expect(
      screen.getByText("リモートにチームのボードがあり、このクローンにはまだ取り込んでいません。"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "チームのボードを取り込む" }));
    expect(acts).toEqual(["init"]);
    expect(screen.getByText("dg init")).toBeTruthy();
  });

  it("remote に届かないときは、ボードを作るボタンを主にせず、git の出力と確かめ直すボタンを出す。新しく作るのは条件を書いた別の道だけ", () => {
    const acts: SetupAction[] = [];
    mount(
      board("remote_unreachable", {
        fix: [],
        detail: "fatal: Could not read from remote repository.",
      }),
      vscodeHost(acts),
    );
    const item = within(row("ボード"));
    expect(item.getByText("fatal: Could not read from remote repository.")).toBeTruthy();
    expect(item.getByRole("button", { name: "もう一度確かめる" }).className).toBe("primary");
    const alt = within(row("ボード").querySelector<HTMLElement>(".setup-alt")!);
    expect(alt.getByText("チームのボードがないと分かっているなら")).toBeTruthy();
    expect(alt.getByText("dg init --new-board")).toBeTruthy();
    const local = alt.getByRole("button", { name: "手元だけで新しいボードを作る" });
    expect(local.className).toBe("");
    fireEvent.click(local);
    expect(acts).toEqual(["newBoard"]);
  });

  it.each([
    ["remote_no_board", "リモートにボードはありません。", "新しいボードを作る"],
    [
      "no_remote",
      "このリポジトリにはコードのリモートがなく、取り込むチームのボードがありません。",
      "新しいボードを作る",
    ],
    [
      "local_branch",
      "このクローンにはボードのブランチがあり、その worktree がありません。",
      "ボードの worktree を作り直す",
    ],
  ])("%s は状態の文と、dg init を実行するボタンを出す", (state, status, button) => {
    const acts: SetupAction[] = [];
    mount(board(state), vscodeHost(acts));
    expect(screen.getByText(status)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: button }));
    expect(acts).toEqual(["init"]);
  });

  it.each([
    ["data_remote_missing", "データのリモートに渡した名前のリモートが、このクローンにありません。"],
    ["data_branch_invalid", "データのブランチに渡した名前を、dg init が受け付けません。"],
  ])("%s は直すコマンドがないので、状態の文と確かめ直すボタンだけを出す", (state, status) => {
    mount(board(state, { fix: [] }));
    expect(screen.getByText(status)).toBeTruthy();
    expect(within(row("ボード")).getByRole("button", { name: "もう一度確かめる" })).toBeTruthy();
    expect(screen.queryByText("ターミナルで行うなら")).toBeNull();
  });
});

describe("ボードの項目で別のリポジトリのボードを指定する", () => {
  const SOURCE = { dataRemote: "git@github.com:team/kanban.git", dataBranch: "deguboard" };

  /**
   * 確かめ直した結果を描き直すチェックリスト（store.setup を描く）。setup は board を付けて頼まれると next を返し、
   * 拡張ホストに頼んだ操作は acts に [操作, データの置き場所] で入る
   */
  function mountLive(first: SetupView, next: SetupView) {
    const acts: [SetupAction, unknown][] = [];
    const host: Host = {
      ...vscodeHost(),
      setupAct: async (act, board) => void acts.push([act, board]),
    };
    const client = mockClient();
    const setup = vi.fn(async (options?: { board?: unknown }) => (options?.board ? next : first));
    client.setup = setup;
    function Live() {
      const store = useStore();
      return <SetupChecklist view={store.setup ?? first} />;
    }
    render(
      <StoreProvider client={client}>
        <HostProvider host={host}>
          <Live />
        </HostProvider>
      </StoreProvider>,
    );
    return { acts, setup };
  }

  const board = (state: string, extra: Partial<SetupViewItem> = {}) =>
    setupView({ board: { status: "unmet", state, fix: ["dg init"], ...extra } });

  it("remote にボードがないときは、新しく作るか別のリポジトリかを選ばせ、別のリポジトリを選ぶと入れた値で確かめ直し、--data-remote・--data-branch 付きで dg init する", async () => {
    const fix = [`dg init --data-remote ${SOURCE.dataRemote} --data-branch deguboard`];
    const { acts, setup } = mountLive(board("remote_no_board"), board("remote_board", { fix }));
    const item = within(row("ボード"));
    // 既定は新しく作る道で、そのボタンを出す
    expect(item.getByRole("radio", { name: "新しいボードを作る" })).toHaveProperty("checked", true);
    expect(item.getByRole("button", { name: "新しいボードを作る" })).toBeTruthy();
    fireEvent.click(item.getByRole("radio", { name: "チームのボードは別のリポジトリにある" }));
    // 別のリポジトリを選んだ間は、新しく作るボタンを出さない
    expect(item.queryByRole("button", { name: "新しいボードを作る" })).toBeNull();
    const check = item.getByRole("button", { name: "このリポジトリを確かめる" });
    expect(check).toHaveProperty("disabled", true);
    fireEvent.change(
      item.getByRole("textbox", { name: "データのリポジトリ（URL か remote 名）" }),
      {
        target: { value: ` ${SOURCE.dataRemote} ` },
      },
    );
    expect(item.getByRole("textbox", { name: "ブランチ" })).toHaveProperty("value", "deguboard");
    // 確かめる前でも、ターミナルで打つ 1 行を見せる
    expect(item.getByText(fix[0]!)).toBeTruthy();
    fireEvent.click(check);
    await waitFor(() => expect(setup).toHaveBeenCalledWith({ board: SOURCE }));
    const after = within(row("ボード"));
    await waitFor(() =>
      expect(
        after.getByText(
          "データのリポジトリにチームのボードがあり、このクローンにはまだ取り込んでいません。",
        ),
      ).toBeTruthy(),
    );
    fireEvent.click(after.getByRole("button", { name: "チームのボードを取り込む" }));
    expect(acts).toEqual([["init", SOURCE]]);
    expect(after.getByText(fix[0]!)).toBeTruthy();
  });

  it("入れた値を確かめた結果が dg init の受け付けない値なら、その状態を出し、値を直すかコードのリモートに戻れる", async () => {
    const { setup } = mountLive(board("no_remote"), board("data_remote_missing", { fix: [] }));
    const item = within(row("ボード"));
    fireEvent.click(item.getByRole("radio", { name: "チームのボードは別のリポジトリにある" }));
    fireEvent.change(
      item.getByRole("textbox", { name: "データのリポジトリ（URL か remote 名）" }),
      {
        target: { value: "kanban" },
      },
    );
    fireEvent.change(item.getByRole("textbox", { name: "ブランチ" }), { target: { value: "" } });
    fireEvent.click(item.getByRole("button", { name: "このリポジトリを確かめる" }));
    // ブランチを空にすれば --data-branch を付けない（dg init の既定）
    await waitFor(() => expect(setup).toHaveBeenCalledWith({ board: { dataRemote: "kanban" } }));
    const after = within(row("ボード"));
    await waitFor(() =>
      expect(
        after.getByText("データのリモートに渡した名前のリモートが、このクローンにありません。"),
      ).toBeTruthy(),
    );
    expect(
      after.getByRole("textbox", { name: "データのリポジトリ（URL か remote 名）" }),
    ).toHaveProperty("value", "kanban");
    const calls = setup.mock.calls.length;
    fireEvent.click(after.getByRole("button", { name: "コードのリモートのボードを使う" }));
    await waitFor(() => expect(setup.mock.calls.length).toBeGreaterThan(calls));
    expect(setup.mock.calls.at(-1)).toEqual([undefined]);
  });

  it("remote にボードがあるときも、条件を書いた別の道としてデータのリポジトリを指定できる", async () => {
    const { acts, setup } = mountLive(
      board("remote_board"),
      board("remote_board", { fix: [`dg init --data-remote ${SOURCE.dataRemote}`] }),
    );
    const alt = within(row("ボード").querySelector<HTMLElement>(".setup-alt")!);
    expect(alt.getByText("使うボードが別のリポジトリにあるなら")).toBeTruthy();
    // 主の道は取り込むボタンで、別の道は開くまで入力を出さない
    expect(
      within(row("ボード")).getByRole("button", { name: "チームのボードを取り込む" }).className,
    ).toBe("primary");
    expect(alt.queryByRole("textbox")).toBeNull();
    fireEvent.click(alt.getByRole("button", { name: "データのリポジトリを指定する" }));
    fireEvent.change(alt.getByRole("textbox", { name: "データのリポジトリ（URL か remote 名）" }), {
      target: { value: SOURCE.dataRemote },
    });
    fireEvent.click(alt.getByRole("button", { name: "このリポジトリを確かめる" }));
    await waitFor(() => expect(setup).toHaveBeenCalledWith({ board: SOURCE }));
    await waitFor(() => expect(screen.getByText("確かめたデータのリポジトリ")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "チームのボードを取り込む" }));
    expect(acts).toEqual([["init", SOURCE]]);
  });
});

describe("推奨の項目（帯から開いたとき）", () => {
  it("必須を 1 行にまとめ、推奨の満たさない項目をすべて開く。戻るボタンで閉じる", () => {
    const onClose = vi.fn();
    mount(
      setupView({
        skills_hooks: { status: "unmet", fix: ["dg hooks install", "dg skill install"] },
        dg_command: {
          status: "unmet",
          state: "missing",
          params: { link: "/home/u/.local/bin/dg" },
        },
      }),
      vscodeHost(),
      onClose,
    );
    expect(screen.getByRole("heading", { name: "セットアップ" })).toBeTruthy();
    expect(screen.getByText("必須の 5 項目")).toBeTruthy();
    expect(screen.getByText("推奨")).toBeTruthy();
    expect(document.querySelectorAll(".setup-guide")).toHaveLength(2);
    expect(
      within(row("Skill と hooks")).getByRole("img", { name: "推奨の項目が未完了" }),
    ).toBeTruthy();
    expect(
      within(row(".claude/.gitignore")).getByRole("img", { name: "満たしている" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "いつもの画面に戻る" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Skill と hooks は、入れるボタンと core が返したコマンドを出す。上書き（--force）しかないときはボタンを出さず、コマンドだけにする", () => {
    const acts: SetupAction[] = [];
    mount(
      setupView({
        skills_hooks: { status: "unmet", fix: ["dg hooks install", "dg skill install"] },
      }),
      vscodeHost(acts),
    );
    expect(screen.getByText("このマシンに dg の Skill と hooks が入っていません。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skill と hooks を入れる" }));
    expect(acts).toEqual(["installSkillsHooks"]);
    expect(screen.getByText("dg hooks install")).toBeTruthy();
    expect(screen.getByText("dg skill install")).toBeTruthy();

    cleanup();
    mount(
      setupView({
        skills_hooks: { status: "unmet", fix: ["dg skill install --personal --force"] },
      }),
    );
    expect(
      screen.getByText(
        "このマシンの dg の Skill と hooks に、入っていないものか古いものがあります。",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skill と hooks を入れる" })).toBeNull();
    expect(screen.getByText("dg skill install --personal --force")).toBeTruthy();
  });

  it("dg コマンドは、PATH にないときは入れるボタンを、張ったが PATH にないときは足す 1 行を、メジャー版が違うときは両方の版を出す", () => {
    const acts: SetupAction[] = [];
    const dg = (item: Partial<SetupViewItem>) =>
      setupView({ dg_command: { status: "unmet", ...item } });
    mount(dg({ state: "missing", params: { link: "/home/u/.local/bin/dg" } }), vscodeHost(acts));
    expect(
      screen.getByText("PATH に dg がなく、ターミナルとエージェントから dg を呼べません。"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "dg コマンドを入れる" }));
    expect(acts).toEqual(["installDg"]);

    cleanup();
    mount(
      dg({
        state: "not_on_path",
        fix: ["export PATH=$HOME/.local/bin:$PATH"],
        params: { link: "/home/u/.local/bin/dg", dir: "/home/u/.local/bin" },
      }),
    );
    expect(
      screen.getByText(
        "/home/u/.local/bin/dg は張ってありますが、/home/u/.local/bin が PATH にないため、ターミナルとエージェントから dg を呼べません。",
      ),
    ).toBeTruthy();
    expect(screen.getByText("export PATH=$HOME/.local/bin:$PATH")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "dg コマンドを入れる" })).toBeNull();

    cleanup();
    mount(dg({ state: "major_mismatch", params: { version: "2.0.1", core: "1.4.0" } }));
    expect(
      screen.getByText("PATH の dg（2.0.1）のメジャー版が、拡張の dg（1.4.0）と違います。"),
    ).toBeTruthy();

    cleanup();
    mount(
      dg({
        state: "occupied",
        params: { link: "/home/u/.local/bin/dg", target: "/src/deguboard/packages/cli/bin/dg.js" },
      }),
    );
    expect(
      screen.getByText(
        "/home/u/.local/bin/dg はすでにあり、deguboard の起動ファイルではなく /src/deguboard/packages/cli/bin/dg.js を指しているため、dg コマンドを入れられません。",
      ),
    ).toBeTruthy();
  });

  it(".claude/.gitignore は、コミットするコマンドを出すだけで、ボタンを出さない（作業ブランチに勝手にコミットしない）", () => {
    const fix = [
      "git add .claude/.gitignore",
      'git commit -m "Ignore the files dg installs on each machine" .claude/.gitignore',
    ];
    mount(setupView({ gitignore: { status: "unmet", fix } }));
    const item = within(row(".claude/.gitignore"));
    expect(item.getByText(".claude/.gitignore にコミットしていない変更があります。")).toBeTruthy();
    for (const command of fix) expect(item.getByText(command)).toBeTruthy();
    expect(
      item.queryAllByRole("button").filter((b) => !b.classList.contains("copy-button")),
    ).toEqual([]);
  });
});

describe("満たさない項目の文言の決まり", () => {
  /** 満たさない項目のすべての形（項目と state の組） */
  const UNMET: Partial<Record<SetupViewItem["id"], Partial<SetupViewItem>>>[] = [
    { folder: { status: "unmet" } },
    { os: { status: "unmet", params: { platform: "win32" } } },
    { git: { status: "unmet", detail: "git --version failed" } },
    { repository: { status: "unmet", fix: ["git init"] } },
    ...[
      "remote_board",
      "remote_no_board",
      "no_remote",
      "local_branch",
      "data_remote_missing",
      "data_branch_invalid",
      "",
    ].map((state) => ({ board: { status: "unmet" as const, state, fix: ["dg init"] } })),
    { board: { status: "unmet", state: "remote_unreachable", detail: "fatal: unreachable" } },
    { skills_hooks: { status: "unmet", fix: ["dg hooks install", "dg skill install"] } },
    { skills_hooks: { status: "unmet", fix: ["dg skill install --force"] } },
    ...["missing", "occupied", "major_mismatch", "error"].map((state) => ({
      dg_command: { status: "unmet" as const, state, detail: "x" },
    })),
    {
      dg_command: {
        status: "unmet",
        state: "not_on_path",
        fix: ["export PATH=$HOME/.local/bin:$PATH"],
      },
    },
    { gitignore: { status: "unmet", fix: ["git add .claude/.gitignore"] } },
  ];

  it("どの項目も、状態 → すること → ターミナルで行うなら → 条件を書いた別の道、の順に並べる（VS Code と dg serve の両方）", () => {
    for (const host of [vscodeHost, browserHost]) {
      for (const changes of UNMET) {
        mount(setupView(changes), host());
        const guides = [...document.querySelectorAll(".setup-guide")];
        expect(guides.length).toBeGreaterThan(0);
        for (const guide of guides) {
          const order = guideOrder(guide);
          // 先頭は状態で、段は後ろへしか進まない
          expect(order[0]).toBe(1);
          expect(order).toEqual([...order].sort((a, b) => a - b));
          expect(order.filter((stage) => stage === 1)).toHaveLength(1);
        }
        cleanup();
      }
    }
  });

  it("状態は事実の 1 文で、質問にしない。別の道は「〜なら」の条件を書く", () => {
    for (const changes of UNMET) {
      const view = setupView(changes);
      for (const item of view.items.filter((i) => i.status === "unmet")) {
        const guide = guideOf(item, view);
        // 文の終わり（。）は末尾の 1 つだけで、問いかけ（？・か。）で終わらない
        expect(guide.status.match(/。/g)).toHaveLength(1);
        expect(guide.status).toMatch(/[^か？?]。$/);
        if (guide.alt) expect(guide.alt.when).toMatch(/なら$/);
      }
    }
  });
});
