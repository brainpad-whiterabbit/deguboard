// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../app.js";
import { ClientError } from "../client/http.js";
import { StoreProvider } from "../store.js";
import { mockClient } from "../test-helpers.js";
import type { ConfigField } from "../types.js";
import { configFields } from "@deguboard/core";
import {
  CONFIRM_KEYS,
  formatValue,
  groupOf,
  isModified,
  fieldMatchesQuery,
  nameOf,
  valueAt,
} from "./config.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  window.localStorage.clear();
});

/** core の configFields と同じ形の項目（説明は短くしたもの）。scope は core と同じ：local は個人で上書きできる項目 */
const FIELDS: ConfigField[] = [
  {
    key: "default_project",
    type: "string",
    description: "省略時の Project",
    default: "default",
    scope: "local",
  },
  {
    key: "git.remote",
    type: "string",
    description: "同期先のリモート",
    default: "origin",
    scope: "local",
  },
  { key: "git.base_branch", type: "string", description: "基準", default: "main", scope: "team" },
  {
    key: "worktree.root",
    type: "string",
    description: "置き場所",
    default: "../<repo>.worktrees",
    scope: "local",
  },
  {
    key: "commit.mode",
    type: "enum",
    options: ["each", "batch", "manual"],
    description: "each: 書き込みのたびにコミット",
    default: "batch",
    scope: "local",
  },
  {
    key: "push.mode",
    type: "enum",
    options: ["auto", "manual"],
    description: "auto: コミットのたびに push",
    default: "auto",
    scope: "local",
  },
  {
    key: "metrics.read_transcripts",
    type: "boolean",
    description: "会話記録を読む",
    default: false,
    scope: "team",
  },
  {
    key: "actions.shell",
    type: "boolean",
    description: "シェルを許す",
    default: false,
    scope: "local",
  },
  {
    key: "actions.test",
    type: "list",
    description: "テストのコマンド",
    default: [],
    scope: "team",
  },
  {
    key: "auto.merge",
    type: "boolean",
    description: "自動でマージ",
    default: false,
    scope: "team",
  },
  { key: "actor.human_only", type: "list", description: "人だけ", default: [], scope: "team" },
];

function configClient() {
  const client = mockClient();
  const config = {
    default_project: "default",
    git: { remote: "origin", base_branch: "main" },
    worktree: { root: "../<repo>.worktrees" },
    commit: { mode: "each" },
    push: { mode: "auto" },
    metrics: { read_transcripts: false },
    actions: { shell: false, test: ["mise", "run", "check"] },
    auto: { merge: false },
    actor: { human_only: [] as string[] },
  };
  client.handlers["config.show"] = (input) =>
    (input as { fields?: boolean }).fields
      ? { config, team: config, local: {}, fields: FIELDS }
      : config;
  client.handlers["config.set"] = (input) => {
    const { key, value } = input as { key: string; value: unknown };
    if (value === "bad")
      throw new ClientError({
        code: "VALIDATION_FAILED",
        message: `${key} の値が正しくない`,
        detail: "選択肢にない",
      });
    const [top, leaf] = key.split(".") as [keyof typeof config, string | undefined];
    if (leaf) (config[top] as Record<string, unknown>)[leaf] = value;
    else (config as Record<string, unknown>)[top] = value;
    return config;
  };
  return { client, config };
}

function mount(client: ReturnType<typeof mockClient>) {
  window.location.hash = "#/config";
  render(
    <StoreProvider client={client}>
      <App />
    </StoreProvider>,
  );
}

const fieldOf = (key: string) => document.querySelector<HTMLElement>(`[data-key="${key}"]`)!;
const setCalls = (client: ReturnType<typeof mockClient>) =>
  client.calls.filter((c) => c.name === "config.set").map((c) => c.input);

describe("設定画面", () => {
  it("4 つのまとまりで全項目を名前・キー・説明・型に合う入力欄と一緒に出し、チーム全員に効く帯を出す", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "コミットと push",
      "エージェント",
      "計測",
      "Git",
    ]);
    expect(document.querySelectorAll(".config-field")).toHaveLength(FIELDS.length);
    const commit = fieldOf("commit.mode");
    expect(within(commit).getByText("commit.mode")).toBeTruthy();
    expect(within(commit).getByText("each: 書き込みのたびにコミット")).toBeTruthy();
    expect(within(commit).getByRole("combobox")).toBeTruthy();
    expect(within(fieldOf("auto.merge")).getByRole("checkbox")).toBeTruthy();
    expect(within(fieldOf("git.remote")).getByRole("textbox")).toBeTruthy();
    expect(within(fieldOf("actions.test")).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("note").textContent).toContain("全員に効く");
    expect(client.calls).toContainEqual({ name: "config.show", input: { fields: true } });
  });

  it("個人の上書きがあっても欄にはチームの値を出し、保存の後もチームの値（config.set の戻り）を出す", async () => {
    const { client, config: team } = configClient();
    // 個人は commit.mode を manual で上書きしている。config.show は重ねた値と、チームの値・個人の上書きを別に返す
    const merged = { ...team, commit: { mode: "manual" } };
    client.handlers["config.show"] = (input) =>
      (input as { fields?: boolean }).fields
        ? { config: merged, team, local: { "commit.mode": "manual" }, fields: FIELDS }
        : merged;
    mount(client);
    await screen.findByText("コミットの仕方");
    const select = within(fieldOf("commit.mode")).getByRole<HTMLSelectElement>("combobox");
    expect(select.value).toBe("each");
    expect(screen.getByRole("note").textContent).toContain("dg config set --local");
    // チームの値（each）を選び直しても変わっていないので保存しない
    fireEvent.change(select, { target: { value: "each" } });
    expect(setCalls(client)).toEqual([]);
    // batch に変えるとチームに保存し、欄と「保存した」はチームの値になる（個人の manual は出ない）
    fireEvent.change(select, { target: { value: "batch" } });
    await waitFor(() => expect(setCalls(client)).toEqual([{ key: "commit.mode", value: "batch" }]));
    expect(await screen.findByText("保存した: commit.mode を batch にした")).toBeTruthy();
    await waitFor(() =>
      expect(within(fieldOf("commit.mode")).getByRole<HTMLSelectElement>("combobox").value).toBe(
        "batch",
      ),
    );
  });

  it("既定から変えた項目に印と「既定に戻す」を出し、押すと既定値を config.set で保存する", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    const commit = fieldOf("commit.mode");
    expect(commit.classList.contains("modified")).toBe(true);
    expect(within(commit).getByText("変更あり")).toBeTruthy();
    expect(within(fieldOf("push.mode")).queryByText("変更あり")).toBeNull();
    expect(within(fieldOf("push.mode")).queryByText("既定に戻す")).toBeNull();
    fireEvent.click(within(commit).getByText("既定に戻す"));
    await waitFor(() => expect(setCalls(client)).toEqual([{ key: "commit.mode", value: "batch" }]));
    expect(await screen.findByText("保存した: commit.mode を batch にした")).toBeTruthy();
    await waitFor(() => expect(within(fieldOf("commit.mode")).queryByText("変更あり")).toBeNull());
  });

  it("確かめを待つ間に保存されている値へ戻すと、確かめを消して config.set を呼ばない", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    // チェック：入れて、枠を閉じずに外す
    const shell = within(fieldOf("actions.shell")).getByRole<HTMLInputElement>("checkbox");
    fireEvent.click(shell);
    expect(within(fieldOf("actions.shell")).getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(shell);
    expect(within(fieldOf("actions.shell")).queryByRole("alertdialog")).toBeNull();
    expect(shell.checked).toBe(false);

    // リスト：足して、枠を閉じずに外す
    const add = within(fieldOf("actor.human_only")).getByPlaceholderText("項目を足す");
    fireEvent.change(add, { target: { value: "epic.close" } });
    fireEvent.keyDown(add, { key: "Enter" });
    expect(within(fieldOf("actor.human_only")).getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(within(fieldOf("actor.human_only")).getByLabelText("epic.close を外す"));
    expect(within(fieldOf("actor.human_only")).queryByRole("alertdialog")).toBeNull();

    // 待ちが解けたので、ほかの項目も触れる
    expect(within(fieldOf("git.remote")).getByRole<HTMLInputElement>("textbox").disabled).toBe(
      false,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(setCalls(client)).toEqual([]);
  });

  it("確かめを待つ間は、待っている項目のほかの「既定に戻す」を押せず、待ちと下書きが残る", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    const reset = (key: string) =>
      within(fieldOf(key)).getByRole<HTMLButtonElement>("button", { name: "既定に戻す" });
    // actions.test（既定から変えてある）に足して、確かめを待たせる
    const add = within(fieldOf("actions.test")).getByPlaceholderText("項目を足す");
    fireEvent.change(add, { target: { value: "--fast" } });
    fireEvent.keyDown(add, { key: "Enter" });
    expect(within(fieldOf("actions.test")).getByRole("alertdialog")).toBeTruthy();

    // ほかの項目の「既定に戻す」は押せず、押しても待ちは移らない
    expect(reset("commit.mode").disabled).toBe(true);
    fireEvent.click(reset("commit.mode"));
    expect(within(fieldOf("actions.test")).getByRole("alertdialog")).toBeTruthy();
    expect(within(fieldOf("actions.test")).getAllByRole("listitem")).toHaveLength(4);
    // 待っている項目の「既定に戻す」は押せる
    expect(reset("actions.test").disabled).toBe(false);

    // やめると、ほかの項目の「既定に戻す」も押せるようになる
    fireEvent.click(within(fieldOf("actions.test")).getByRole("button", { name: "やめる" }));
    expect(within(fieldOf("actions.test")).queryByRole("alertdialog")).toBeNull();
    expect(reset("commit.mode").disabled).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(setCalls(client)).toEqual([]);
  });

  it("確かめない項目は変えたらすぐ保存し、保存した項目と値を出す", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    fireEvent.click(within(fieldOf("metrics.read_transcripts")).getByRole("checkbox"));
    expect(
      await screen.findByText("保存した: metrics.read_transcripts を true にした"),
    ).toBeTruthy();
    fireEvent.change(within(fieldOf("commit.mode")).getByRole("combobox"), {
      target: { value: "manual" },
    });
    expect(await screen.findByText("保存した: commit.mode を manual にした")).toBeTruthy();
    expect(setCalls(client)).toEqual([
      { key: "metrics.read_transcripts", value: true },
      { key: "commit.mode", value: "manual" },
    ]);
  });

  it("actions.test・actions.shell・actor.human_only・auto.merge も保存の前に確かめ、変わることを出し、やめると戻す", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    // テストのコマンド：外した結果を確かめ、やめると元のリストに戻る
    fireEvent.click(within(fieldOf("actions.test")).getByLabelText("check を外す"));
    const test = within(fieldOf("actions.test")).getByRole("alertdialog");
    expect(test.textContent).toContain("[mise, run]");
    expect(test.textContent).toContain("確認なしで実行するコマンドが変わる");
    fireEvent.click(within(test).getByText("やめる"));
    expect(within(fieldOf("actions.test")).getByLabelText("check を外す")).toBeTruthy();

    // シェルの許可：チェックを入れても、保存するまで config.set を呼ばない
    fireEvent.click(within(fieldOf("actions.shell")).getByRole("checkbox"));
    const shell = within(fieldOf("actions.shell")).getByRole("alertdialog");
    expect(shell.textContent).toContain("任意のシェルを実行できるかが変わる");
    fireEvent.click(within(shell).getByText("やめる"));
    expect(within(fieldOf("actions.shell")).getByRole<HTMLInputElement>("checkbox").checked).toBe(
      false,
    );
    expect(setCalls(client)).toEqual([]);

    // 自動マージ：エージェントに PR のマージを許すので、保存するまで config.set を呼ばない
    fireEvent.click(within(fieldOf("auto.merge")).getByRole("checkbox"));
    const merge = within(fieldOf("auto.merge")).getByRole("alertdialog");
    expect(merge.textContent).toContain("エージェントが PR を自動でマージするかが変わる");
    fireEvent.click(within(merge).getByText("やめる"));
    expect(within(fieldOf("auto.merge")).getByRole<HTMLInputElement>("checkbox").checked).toBe(
      false,
    );
    expect(setCalls(client)).toEqual([]);

    // 人だけに許すコマンド：足してから保存する
    const add = within(fieldOf("actor.human_only")).getByPlaceholderText("項目を足す");
    fireEvent.change(add, { target: { value: "epic.close" } });
    fireEvent.keyDown(add, { key: "Enter" });
    const human = within(fieldOf("actor.human_only")).getByRole("alertdialog");
    expect(human.textContent).toContain("エージェントに許す操作が変わる");
    fireEvent.click(within(human).getByText("保存する"));
    expect(
      await screen.findByText("保存した: actor.human_only を [epic.close] にした"),
    ).toBeTruthy();
    expect(setCalls(client)).toEqual([{ key: "actor.human_only", value: ["epic.close"] }]);
  });

  it("拒否されたら理由を項目の下にだけ出し、値を保存されている値に戻す", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    const input = within(fieldOf("default_project")).getByRole<HTMLInputElement>("textbox");
    fireEvent.change(input, { target: { value: "bad" } });
    fireEvent.blur(input);
    expect((await within(fieldOf("default_project")).findByRole("alert")).textContent).toContain(
      "default_project の値が正しくない（選択肢にない）",
    );
    expect(input.value).toBe("default");
    // 上の通知の帯には出さない（項目の下の 1 か所だけ）
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("git.remote・git.base_branch・worktree.root は保存の前に確かめ、やめると戻す", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    const input = within(fieldOf("git.base_branch")).getByRole<HTMLInputElement>("textbox");
    fireEvent.change(input, { target: { value: "develop" } });
    fireEvent.blur(input);
    const confirm = within(fieldOf("git.base_branch")).getByRole("alertdialog");
    expect(setCalls(client)).toEqual([]);
    fireEvent.click(within(confirm).getByText("やめる"));
    expect(input.value).toBe("main");
    expect(setCalls(client)).toEqual([]);

    const remote = within(fieldOf("git.remote")).getByRole<HTMLInputElement>("textbox");
    fireEvent.change(remote, { target: { value: "upstream" } });
    fireEvent.keyDown(remote, { key: "Enter" });
    fireEvent.blur(remote);
    fireEvent.click(within(fieldOf("git.remote")).getByText("保存する"));
    expect(await screen.findByText("保存した: git.remote を upstream にした")).toBeTruthy();
    expect(setCalls(client)).toEqual([{ key: "git.remote", value: "upstream" }]);
  });

  it("worktree.root も保存の前に確かめ、「保存する」を押すまで config.set を呼ばない", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    const root = within(fieldOf("worktree.root")).getByRole<HTMLInputElement>("textbox");
    fireEvent.change(root, { target: { value: "/tmp/worktrees" } });
    fireEvent.blur(root);
    const confirm = within(fieldOf("worktree.root")).getByRole("alertdialog");
    expect(confirm.textContent).toContain("/tmp/worktrees");
    // 確かめを待つ間はほかの項目を触れず、config.set もまだ呼ばない
    expect(within(fieldOf("git.remote")).getByRole<HTMLInputElement>("textbox").disabled).toBe(
      true,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(setCalls(client)).toEqual([]);
    fireEvent.click(within(confirm).getByText("保存する"));
    expect(
      await screen.findByText("保存した: worktree.root を /tmp/worktrees にした"),
    ).toBeTruthy();
    expect(setCalls(client)).toEqual([{ key: "worktree.root", value: "/tmp/worktrees" }]);
    expect(within(fieldOf("worktree.root")).queryByRole("alertdialog")).toBeNull();
  });

  it("検索欄で名前・キー・説明から項目を絞り、空のまとまりは出さない", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    fireEvent.change(screen.getByLabelText("設定を検索"), { target: { value: "push" } });
    expect(
      [...document.querySelectorAll(".config-field")].map((e) => e.getAttribute("data-key")),
    ).toEqual(["push.mode"]);
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "コミットと push",
    ]);
    fireEvent.change(screen.getByLabelText("設定を検索"), { target: { value: "見つからない" } });
    expect(screen.getByText("該当する設定がない")).toBeTruthy();
  });

  it("ブラウザでは上のバーの歯車で設定画面とその前の画面を切り替える", async () => {
    const { client } = configClient();
    window.location.hash = "#/backlog";
    render(
      <StoreProvider client={client}>
        <App />
      </StoreProvider>,
    );
    const gear = await screen.findByRole("button", { name: "設定" });
    fireEvent.click(gear);
    expect(window.location.hash).toBe("#/config");
    expect(await screen.findByText("コミットの仕方")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    expect(window.location.hash).toBe("#/backlog");
  });

  it("画面の中の「前の画面に戻る」は歯車と同じく、来る前の画面に戻る", async () => {
    const { client } = configClient();
    window.location.hash = "#/backlog";
    render(
      <StoreProvider client={client}>
        <App />
      </StoreProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "設定" }));
    expect(window.location.hash).toBe("#/config");
    fireEvent.click(await screen.findByRole("button", { name: "前の画面に戻る" }));
    expect(window.location.hash).toBe("#/backlog");
  });

  it("来る前の画面がない（#/config を直接開いた）ときは、「前の画面に戻る」でカンバンに戻る", async () => {
    const { client } = configClient();
    mount(client);
    fireEvent.click(await screen.findByRole("button", { name: "前の画面に戻る" }));
    expect(window.location.hash).toBe("#/board");
  });

  it("来る前の画面がないときは、歯車でもカンバンに戻る", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    expect(window.location.hash).toBe("#/board");
  });
});

describe("設定画面の部品", () => {
  it("core の configFields の全キーに表示名があり、どれも「その他」に落ちない（スキーマに足した項目の漏れを防ぐ）", () => {
    for (const { key } of configFields()) {
      expect(nameOf(key), key).not.toBe(key);
      expect(groupOf(key), key).not.toBe("other");
    }
  });

  it("保存の前に確かめるのは、同期と照合・worktree・実行するコマンド・エージェントに許す操作を変える項目だけ", () => {
    expect([...CONFIRM_KEYS.keys()].sort()).toEqual([
      "actions.shell",
      "actions.test",
      "actor.human_only",
      "auto.merge",
      "git.base_branch",
      "git.remote",
      "worktree.root",
    ]);
  });

  it("入れ子の値を引き、既定との差を中身で比べ、値を短く書く", () => {
    expect(valueAt({ commit: { mode: "each" } }, "commit.mode")).toBe("each");
    expect(valueAt({ default_project: "x" }, "default_project")).toBe("x");
    expect(valueAt({}, "commit.mode")).toBeUndefined();
    expect(isModified([], [])).toBe(false);
    expect(isModified(["a"], [])).toBe(true);
    expect(formatValue([])).toBe("空");
    expect(formatValue(["a", "b"])).toBe("[a, b]");
    expect(formatValue(false)).toBe("false");
  });

  it("キーの最上位でまとまりを決め、知らない項目は「その他」", () => {
    expect(groupOf("push.mode")).toBe("commit");
    expect(groupOf("actor.human_only")).toBe("agent");
    expect(groupOf("default_project")).toBe("git");
    expect(groupOf("new.item")).toBe("other");
    expect(fieldMatchesQuery(FIELDS[1]!, "リモート")).toBe(true);
    expect(fieldMatchesQuery(FIELDS[1]!, "GIT.REMOTE")).toBe(true);
    expect(fieldMatchesQuery(FIELDS[1]!, "push")).toBe(false);
  });
});
