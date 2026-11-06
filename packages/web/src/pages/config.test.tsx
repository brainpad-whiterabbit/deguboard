// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../l10n.js";
import { PRIORITY_CRITERIA_EN } from "../l10n-en.js";
import { App } from "../app.js";
import { ClientError } from "../client/http.js";
import { StoreProvider } from "../store.js";
import { mockClient } from "../test-helpers.js";
import type { ConfigField } from "../types.js";
import { configFields } from "@deguboard/core";
import {
  CONFIRM_KEYS,
  clearsToDefault,
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

/**
 * core の configFields と同じ形の項目（説明は短くしたもの）。scope は core と同じ：local は個人で上書きできる項目。
 * clears_to_default（空にすると既定に戻る）も core と同じで、既定が空でない文字列の項目だけ true
 */
const FIELDS: ConfigField[] = [
  {
    key: "default_project",
    type: "string",
    description: "省略時の Project",
    default: "default",
    scope: "local",
    clears_to_default: true,
  },
  {
    key: "git.remote",
    type: "string",
    description: "同期先のリモート",
    default: "origin",
    scope: "local",
    clears_to_default: true,
  },
  {
    key: "git.base_branch",
    type: "string",
    description: "基準",
    default: "main",
    scope: "team",
    clears_to_default: true,
  },
  {
    key: "worktree.root",
    type: "string",
    description: "置き場所",
    default: "../<repo>.worktrees",
    scope: "local",
    clears_to_default: true,
  },
  {
    key: "commit.mode",
    type: "enum",
    options: ["each", "batch", "manual"],
    description: "each: 書き込みのたびにコミット",
    default: "batch",
    scope: "local",
    clears_to_default: false,
  },
  {
    key: "push.mode",
    type: "enum",
    options: ["auto", "manual"],
    description: "auto: コミットのたびに push",
    default: "auto",
    scope: "local",
    clears_to_default: false,
  },
  {
    key: "metrics.read_transcripts",
    type: "boolean",
    description: "会話記録を読む",
    default: false,
    scope: "team",
    clears_to_default: false,
  },
  {
    key: "actions.shell",
    type: "boolean",
    description: "シェルを許す",
    default: false,
    scope: "local",
    clears_to_default: false,
  },
  {
    key: "actions.test",
    type: "list",
    description: "テストのコマンド",
    default: [],
    scope: "team",
    clears_to_default: false,
  },
  {
    key: "auto.merge",
    type: "boolean",
    description: "自動でマージ",
    default: false,
    scope: "team",
    clears_to_default: false,
  },
  {
    key: "models.light",
    type: "string",
    description: "light のモデル",
    default: "",
    scope: "local",
    clears_to_default: false,
  },
  {
    key: "actor.human_only",
    type: "list",
    description: "人だけ",
    default: [],
    scope: "team",
    clears_to_default: false,
  },
];

function configClient(initialLocal: Record<string, unknown> = {}) {
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
    models: { light: "" },
    actor: { human_only: [] as string[] },
  };
  /** 個人の上書き（ドット区切りの項目名 → 値）。core と同じく config.show は local で返し、重ねた値は config で返す */
  const local: Record<string, unknown> = { ...initialLocal };
  const merged = () => {
    const out = structuredClone(config) as Record<string, unknown>;
    for (const [key, value] of Object.entries(local)) {
      const [top, leaf] = key.split(".") as [string, string | undefined];
      if (leaf) (out[top] as Record<string, unknown>)[leaf] = value;
      else out[top] = value;
    }
    return out;
  };
  client.handlers["config.show"] = (input) =>
    (input as { fields?: boolean }).fields
      ? { config: merged(), team: config, local: { ...local }, fields: FIELDS }
      : merged();
  client.handlers["config.set"] = (input) => {
    const { key, local: toLocal } = input as { key: string; value: unknown; local?: boolean };
    let { value } = input as { value: unknown };
    if (value === "bad")
      throw new ClientError({
        code: "VALIDATION_FAILED",
        message: `${key} の値が正しくない`,
        detail: "選択肢にない",
      });
    // --local は個人の設定に書き、重ねた値を返す。なしはチームの値に書き、チームの値を返す
    if (toLocal) {
      // core と同じく、空にすると既定に戻る項目（clears_to_default）に空文字を渡すと上書きを消す（resolveLeaf）
      const field = FIELDS.find((f) => f.key === key);
      const clears = field?.clears_to_default === true && value === "";
      if (clears) delete local[key];
      else local[key] = value;
      return merged();
    }
    const [top, leaf] = key.split(".") as [keyof typeof config, string | undefined];
    // core と同じく、空にすると既定に戻る項目に空文字を渡すと値を消し、返す値では既定で補われる
    const field = FIELDS.find((f) => f.key === key);
    if (field?.clears_to_default === true && value === "") value = field.default;
    if (leaf) (config[top] as Record<string, unknown>)[leaf] = value;
    else (config as Record<string, unknown>)[top] = value;
    return config;
  };
  client.handlers["config.unset"] = (input) => {
    const { key } = input as { key: string; local?: boolean };
    delete local[key];
    return merged();
  };
  return { client, config, local };
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
const unsetCalls = (client: ReturnType<typeof mockClient>) =>
  client.calls.filter((c) => c.name === "config.unset").map((c) => c.input);
const tabOf = (name: "チーム" | "自分") =>
  screen.getByRole("tab", { name: new RegExp(`^${name}`) });
const ownOf = (key: string) =>
  within(fieldOf(key)).getByRole<HTMLInputElement>("checkbox", { name: "自分の値を使う" });

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

  it("個人の上書きがあってもチームのタブの欄にはチームの値を出し、保存の後もチームの値（config.set の戻り）を出す", async () => {
    // 個人は commit.mode を manual で上書きしている。config.show は重ねた値と、チームの値・個人の上書きを別に返す
    const { client } = configClient({ "commit.mode": "manual" });
    mount(client);
    await screen.findByText("コミットの仕方");
    expect(tabOf("チーム").getAttribute("aria-selected")).toBe("true");
    const select = within(fieldOf("commit.mode")).getByRole<HTMLSelectElement>("combobox");
    expect(select.value).toBe("each");
    expect(screen.getByRole("note").textContent).toContain("「自分」のタブ");
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

  it("自分のタブで保存が通って読み直しだけが失敗したら、保存できたことと読み直せないことを分けて出す", async () => {
    const { client, local } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    fireEvent.click(tabOf("自分"));
    const show = client.handlers["config.show"]!;
    client.handlers["config.show"] = () => {
      throw new ClientError({ code: "IO_ERROR", message: "読めない" });
    };
    fireEvent.click(ownOf("push.mode"));
    expect(await screen.findByText("保存した: push.mode を自分だけ auto にした")).toBeTruthy();
    const alert = await within(fieldOf("push.mode")).findByRole("alert");
    expect(alert.textContent).toBe("保存したが、読み直せない: 読めない");
    expect(alert.textContent).not.toContain("保存できない");
    expect(local["push.mode"]).toBe("auto");
    // 欄は保存前の値に戻さず、保存した値（自分の値を使う）で出す
    expect(ownOf("push.mode").checked).toBe(true);
    expect(within(fieldOf("push.mode")).getByRole<HTMLSelectElement>("combobox").disabled).toBe(
      false,
    );

    // 外すほうも、読み直せなくても上書きなしで出す
    fireEvent.click(ownOf("push.mode"));
    expect(
      await screen.findByText("保存した: push.mode の自分の値を外した（チームの auto を使う）"),
    ).toBeTruthy();
    expect(local["push.mode"]).toBeUndefined();
    expect(ownOf("push.mode").checked).toBe(false);

    // 後で読み直せたら「読み直せない」を消す
    client.handlers["config.show"] = show;
    fireEvent.click(ownOf("commit.mode"));
    expect(await screen.findByText("保存した: commit.mode を自分だけ each にした")).toBeTruthy();
    await waitFor(() => expect(within(fieldOf("push.mode")).queryByRole("alert")).toBeNull());
  });

  it("自分のタブで保存そのものが失敗したら、今までどおり保存できない旨を出し、読み直さない", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    fireEvent.click(tabOf("自分"));
    client.handlers["config.set"] = () => {
      throw new ClientError({ code: "VALIDATION_FAILED", message: "push.mode の値が正しくない" });
    };
    const before = client.calls.filter((c) => c.name === "config.show").length;
    fireEvent.click(ownOf("push.mode"));
    expect((await within(fieldOf("push.mode")).findByRole("alert")).textContent).toBe(
      "保存できない: push.mode の値が正しくない",
    );
    expect(screen.queryByText(/^保存した:/)).toBeNull();
    expect(client.calls.filter((c) => c.name === "config.show")).toHaveLength(before);
  });

  it("2 つの保存の読み直しが逆の順に返っても、後に始めた保存の結果を画面に残す", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    fireEvent.click(tabOf("自分"));
    // 保存の後の読み直しを止め、返す順を決める
    const show = client.handlers["config.show"]!;
    const held: (() => void)[] = [];
    client.handlers["config.show"] = (input) => {
      const data = show(input);
      return new Promise((resolve) => held.push(() => resolve(data)));
    };
    fireEvent.click(ownOf("push.mode"));
    await waitFor(() => expect(held).toHaveLength(1));
    fireEvent.click(ownOf("commit.mode"));
    await waitFor(() => expect(held).toHaveLength(2));
    // 後に始めた保存（commit.mode）の読み直しが先に返り、先に始めた保存（push.mode）の古い応答が後で返る
    held[1]!();
    expect(await screen.findByText("保存した: commit.mode を自分だけ each にした")).toBeTruthy();
    held[0]!();
    client.handlers["config.show"] = show;
    // 古い応答（commit.mode の上書きがない）で置き換えない
    await waitFor(() => expect(ownOf("push.mode").checked).toBe(true));
    expect(ownOf("commit.mode").checked).toBe(true);
    expect(screen.getByText("保存した: commit.mode を自分だけ each にした")).toBeTruthy();
    expect(screen.queryByText("保存した: push.mode を自分だけ auto にした")).toBeNull();
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

  it("チームのタブで既定が空でない文字列の項目を空にすると、確かめの文は既定の値に戻すことを示し、空でない値に変えるときの文は今のまま", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    const remote = within(fieldOf("git.remote")).getByRole<HTMLInputElement>("textbox");
    // 空でない値に変える：今までどおり「を … にする」
    fireEvent.change(remote, { target: { value: "upstream" } });
    fireEvent.blur(remote);
    expect(
      within(fieldOf("git.remote")).getByRole("alertdialog").querySelector("p")?.textContent,
    ).toBe("git.remote を upstream にする。同期先が変わる。チーム全員に効く。保存する？");
    fireEvent.click(within(fieldOf("git.remote")).getByText("やめる"));

    // 空にする：空の値（「`` にする」）でなく、戻る既定の値を出す
    fireEvent.change(remote, { target: { value: "" } });
    fireEvent.blur(remote);
    const confirm = within(fieldOf("git.remote")).getByRole("alertdialog");
    expect(confirm.querySelector("p")?.textContent).toBe(
      "git.remote を空にし、既定の origin に戻す。同期先が変わる。チーム全員に効く。保存する？",
    );
    fireEvent.click(within(confirm).getByText("保存する"));
    expect(await screen.findByText("保存した: git.remote を origin にした")).toBeTruthy();
    expect(setCalls(client)).toEqual([{ key: "git.remote", value: "" }]);
  });

  it("英語の表示でも、チームのタブで既定に戻る項目を空にしたときの確かめの文が崩れない", async () => {
    setLanguage("en");
    try {
      const { client } = configClient();
      mount(client);
      await screen.findByText("Commit mode");
      const remote = within(fieldOf("worktree.root")).getByRole<HTMLInputElement>("textbox");
      fireEvent.change(remote, { target: { value: "" } });
      fireEvent.blur(remote);
      expect(
        within(fieldOf("worktree.root")).getByRole("alertdialog").querySelector("p")?.textContent,
      ).toBe(
        "Clear worktree.root and go back to the default ../<repo>.worktrees. This changes where work happens. It applies to the whole team. Save?",
      );
      fireEvent.click(within(fieldOf("worktree.root")).getByText("Cancel"));
      fireEvent.change(remote, { target: { value: "../wt" } });
      fireEvent.blur(remote);
      expect(
        within(fieldOf("worktree.root")).getByRole("alertdialog").querySelector("p")?.textContent,
      ).toBe(
        "Set worktree.root to ../wt. This changes where work happens. It applies to the whole team. Save?",
      );
    } finally {
      setLanguage("ja");
    }
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

  it("チームのタブは自分で上書きしている項目に「自分：値」の印を出し、押すと自分のタブのその項目に移る", async () => {
    const { client } = configClient({ "commit.mode": "manual", "actions.shell": true });
    mount(client);
    await screen.findByText("コミットの仕方");
    // チームのタブは全項目を出し、上書きしている 2 項目にだけ印を出す
    expect(document.querySelectorAll(".config-field")).toHaveLength(FIELDS.length);
    expect([...document.querySelectorAll(".config-override")].map((e) => e.textContent)).toEqual([
      "自分：manual",
      "自分：true",
    ]);
    expect(within(fieldOf("push.mode")).queryByText(/^自分：/)).toBeNull();
    // 自分のタブには上書きしている件数を添える
    expect(tabOf("自分").textContent).toBe("自分2");

    fireEvent.click(within(fieldOf("commit.mode")).getByRole("button", { name: "自分：manual" }));
    expect(tabOf("自分").getAttribute("aria-selected")).toBe("true");
    expect(tabOf("チーム").getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("note").textContent).toContain("deguboard-local/config.yaml");
    // 移った項目の「自分の値を使う」に焦点が移る
    await waitFor(() => expect(document.activeElement).toBe(ownOf("commit.mode")));
    expect(ownOf("commit.mode").checked).toBe(true);
    expect(within(fieldOf("commit.mode")).getByRole<HTMLSelectElement>("combobox").value).toBe(
      "manual",
    );

    // タブで戻れる
    fireEvent.click(tabOf("チーム"));
    expect(within(fieldOf("commit.mode")).getByRole<HTMLSelectElement>("combobox").value).toBe(
      "each",
    );
  });

  it("自分のタブは上書きできる項目（scope が local）だけを出し、使わない項目はチームの値を触れない欄で出す", async () => {
    const { client } = configClient({ "commit.mode": "manual" });
    mount(client);
    await screen.findByText("コミットの仕方");
    fireEvent.click(tabOf("自分"));
    expect(
      [...document.querySelectorAll(".config-field")].map((e) => e.getAttribute("data-key")),
    ).toEqual([
      // まとまりの順（コミットと push・エージェント・Git）
      "commit.mode",
      "push.mode",
      "actions.shell",
      "models.light",
      "default_project",
      "git.remote",
      "worktree.root",
    ]);
    expect(document.querySelectorAll(".config-field")).toHaveLength(
      FIELDS.filter((f) => f.scope === "local").length,
    );
    // チーム専用の項目は出さない
    expect(document.querySelector('[data-key="auto.merge"]')).toBeNull();
    // 上書きしている項目は自分の値で触れ、チームの値を添える
    const commit = fieldOf("commit.mode");
    expect(commit.classList.contains("modified")).toBe(true);
    expect(within(commit).getByText("チーム：each")).toBeTruthy();
    expect(within(commit).getByRole<HTMLSelectElement>("combobox").disabled).toBe(false);
    // 使わない項目はチームの値を出し、欄は触れない
    const push = fieldOf("push.mode");
    expect(ownOf("push.mode").checked).toBe(false);
    expect(within(push).getByRole<HTMLSelectElement>("combobox").value).toBe("auto");
    expect(within(push).getByRole<HTMLSelectElement>("combobox").disabled).toBe(true);
    expect(within(push).getByText("チームの値を使っている")).toBeTruthy();
  });

  it("「自分の値を使う」を入れるとチームの値を config.set --local で写し、外すと config.unset --local でチームの値に戻す", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    fireEvent.click(tabOf("自分"));
    // 入れる：チームの値（auto）を自分の値として写し、欄を触れるようにする
    fireEvent.click(ownOf("push.mode"));
    await waitFor(() =>
      expect(setCalls(client)).toEqual([{ key: "push.mode", value: "auto", local: true }]),
    );
    expect(await screen.findByText("保存した: push.mode を自分だけ auto にした")).toBeTruthy();
    await waitFor(() => expect(ownOf("push.mode").checked).toBe(true));
    const select = within(fieldOf("push.mode")).getByRole<HTMLSelectElement>("combobox");
    expect(select.disabled).toBe(false);

    // 自分の値を変える：--local で保存し、チームの値は変えない
    fireEvent.change(select, { target: { value: "manual" } });
    await waitFor(() =>
      expect(setCalls(client)).toContainEqual({ key: "push.mode", value: "manual", local: true }),
    );
    expect(await within(fieldOf("push.mode")).findByText("チーム：auto")).toBeTruthy();
    fireEvent.click(tabOf("チーム"));
    expect(within(fieldOf("push.mode")).getByRole<HTMLSelectElement>("combobox").value).toBe(
      "auto",
    );
    expect(within(fieldOf("push.mode")).getByRole("button", { name: "自分：manual" })).toBeTruthy();

    // 外す：上書きを外し、チームの値を出す
    fireEvent.click(tabOf("自分"));
    fireEvent.click(ownOf("push.mode"));
    await waitFor(() => expect(unsetCalls(client)).toEqual([{ key: "push.mode", local: true }]));
    expect(
      await screen.findByText("保存した: push.mode の自分の値を外した（チームの auto を使う）"),
    ).toBeTruthy();
    await waitFor(() => expect(ownOf("push.mode").checked).toBe(false));
    expect(within(fieldOf("push.mode")).getByRole<HTMLSelectElement>("combobox").value).toBe(
      "auto",
    );
    fireEvent.click(tabOf("チーム"));
    expect(within(fieldOf("push.mode")).queryByText(/^自分：/)).toBeNull();
  });

  it("自分のタブでも確かめる項目（CONFIRM_KEYS）は保存の前に確かめ、効く値が変わる外し方も確かめる", async () => {
    const { client } = configClient({ "git.remote": "upstream" });
    mount(client);
    await screen.findByText("コミットの仕方");
    fireEvent.click(tabOf("自分"));
    // 自分の値を変える：確かめるまで書かず、文は自分だけに効くと伝える
    const remote = within(fieldOf("git.remote")).getByRole<HTMLInputElement>("textbox");
    expect(remote.value).toBe("upstream");
    fireEvent.change(remote, { target: { value: "fork" } });
    fireEvent.blur(remote);
    const confirm = within(fieldOf("git.remote")).getByRole("alertdialog");
    expect(confirm.textContent).toContain("同期先が変わる");
    expect(confirm.textContent).toContain("自分だけに効く");
    expect(confirm.textContent).not.toContain("チーム全員");
    await new Promise((r) => setTimeout(r, 0));
    expect(setCalls(client)).toEqual([]);
    fireEvent.click(within(confirm).getByText("保存する"));
    expect(await screen.findByText("保存した: git.remote を自分だけ fork にした")).toBeTruthy();
    expect(setCalls(client)).toEqual([{ key: "git.remote", value: "fork", local: true }]);

    // 外す：チームの origin に戻ると同期先が変わるので確かめ、やめると上書きを残す
    fireEvent.click(ownOf("git.remote"));
    const unset = within(fieldOf("git.remote")).getByRole("alertdialog");
    expect(unset.textContent).toContain("チームの origin に戻す");
    fireEvent.click(within(unset).getByText("やめる"));
    expect(ownOf("git.remote").checked).toBe(true);
    expect(unsetCalls(client)).toEqual([]);
    fireEvent.click(ownOf("git.remote"));
    fireEvent.click(within(fieldOf("git.remote")).getByText("保存する"));
    await waitFor(() => expect(unsetCalls(client)).toEqual([{ key: "git.remote", local: true }]));

    // 入れるのは効く値が変わらないので確かめない
    fireEvent.click(ownOf("worktree.root"));
    await waitFor(() =>
      expect(setCalls(client)).toContainEqual({
        key: "worktree.root",
        value: "../<repo>.worktrees",
        local: true,
      }),
    );
  });

  it("自分のタブで既定が空でない文字列の項目を空にすると、外すのと同じに扱い、印と件数を core の値で読み直す", async () => {
    const { client } = configClient({ "git.remote": "upstream", default_project: "mine" });
    mount(client);
    await screen.findByText("コミットの仕方");
    expect(tabOf("自分").textContent).toBe("自分2");
    fireEvent.click(tabOf("自分"));

    // 確かめない項目：空にすると上書きが外れ、チームの値を出す
    const project = within(fieldOf("default_project")).getByRole<HTMLInputElement>("textbox");
    fireEvent.change(project, { target: { value: "" } });
    fireEvent.blur(project);
    expect(
      await screen.findByText(
        "保存した: default_project の自分の値を外した（チームの default を使う）",
      ),
    ).toBeTruthy();
    expect(unsetCalls(client)).toEqual([{ key: "default_project", local: true }]);
    await waitFor(() => expect(ownOf("default_project").checked).toBe(false));
    expect(project.value).toBe("default");
    expect(tabOf("自分").textContent).toBe("自分1");

    // 確かめる項目：確かめの文は外すときのもの（空の値を出さない）
    const remote = within(fieldOf("git.remote")).getByRole<HTMLInputElement>("textbox");
    fireEvent.change(remote, { target: { value: "" } });
    fireEvent.blur(remote);
    const confirm = within(fieldOf("git.remote")).getByRole("alertdialog");
    expect(confirm.textContent).toContain("自分の値を外し、チームの origin に戻す");
    fireEvent.click(within(confirm).getByText("保存する"));
    await waitFor(() => expect(ownOf("git.remote").checked).toBe(false));
    expect(tabOf("自分").textContent).toBe("自分");
    fireEvent.click(tabOf("チーム"));
    expect(document.querySelectorAll(".config-override")).toHaveLength(0);
  });

  it("自分のタブで空にしても既定に戻らない項目（clears_to_default が false）を空にすると、外さずに空の値を保存する", async () => {
    const { client } = configClient({ "models.light": "sonnet" });
    mount(client);
    await screen.findByText("コミットの仕方");
    fireEvent.click(tabOf("自分"));
    const light = within(fieldOf("models.light")).getByRole<HTMLInputElement>("textbox");
    fireEvent.change(light, { target: { value: "" } });
    fireEvent.blur(light);
    // 空の値は空のまま出す（文の中の空白は 2 つ並ぶ）
    expect(await screen.findByText(/^保存した: models\.light を自分だけ\s+にした$/)).toBeTruthy();
    expect(setCalls(client)).toEqual([{ key: "models.light", value: "", local: true }]);
    expect(unsetCalls(client)).toEqual([]);
    // 自分の値（空）は残る
    expect(ownOf("models.light").checked).toBe(true);
    expect(tabOf("自分").textContent).toBe("自分1");
  });

  it("set --local で空文字を渡しても、core が上書きを消したなら画面も上書きなしで出す（config.show で読み直す）", async () => {
    const { client } = configClient({ "worktree.root": "/w" });
    mount(client);
    await screen.findByText("コミットの仕方");
    fireEvent.click(tabOf("自分"));
    // 画面の判断を通らない経路（core が上書きを消す）でも、読み直した値に従う
    client.handlers["config.set"]!({ key: "worktree.root", value: "", local: true });
    fireEvent.click(ownOf("push.mode"));
    await waitFor(() => expect(ownOf("push.mode").checked).toBe(true));
    expect(ownOf("worktree.root").checked).toBe(false);
  });

  it("タブを切り替えると、確かめの待ちと入力中の値を捨てる", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    fireEvent.click(within(fieldOf("actions.shell")).getByRole("checkbox"));
    expect(within(fieldOf("actions.shell")).getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(tabOf("自分"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(tabOf("チーム"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // 「保存した」も前のタブのものなので消す
    fireEvent.click(within(fieldOf("metrics.read_transcripts")).getByRole("checkbox"));
    expect(await screen.findByText(/^保存した: /)).toBeTruthy();
    fireEvent.click(tabOf("自分"));
    expect(screen.queryByText(/^保存した: /)).toBeNull();
    fireEvent.click(tabOf("チーム"));
    expect(within(fieldOf("actions.shell")).getByRole<HTMLInputElement>("checkbox").checked).toBe(
      false,
    );
    expect(setCalls(client)).toEqual([{ key: "metrics.read_transcripts", value: true }]);
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

  it("空にすると既定に戻るかは core の項目の定義（clears_to_default）で決め、型や既定値から判断しない", () => {
    const base = { type: "string", description: "", scope: "local" } as const;
    // 既定が空でない文字列の項目：core は true を出し、空の値（空文字・undefined・null）が外すのと同じになる
    const clears: ConfigField = { ...base, key: "a", default: "x", clears_to_default: true };
    expect(clearsToDefault(clears, "")).toBe(true);
    expect(clearsToDefault(clears, undefined)).toBe(true);
    expect(clearsToDefault(clears, null)).toBe(true);
    expect(clearsToDefault(clears, "y")).toBe(false);
    // 既定が空の文字列の項目：core は false を出し、空文字は値として保存する
    const keeps: ConfigField = { ...base, key: "b", default: "", clears_to_default: false };
    expect(clearsToDefault(keeps, "")).toBe(false);
    // 画面は型や既定値を見ない。core が条件を変えても値に従う
    expect(clearsToDefault({ ...clears, clears_to_default: false }, "")).toBe(false);
    expect(clearsToDefault({ ...keeps, clears_to_default: true }, "")).toBe(true);
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

  it("英語の表示では、検索が英語の説明にも当たる", () => {
    setLanguage("en");
    try {
      // 表示名（Remote to sync with）には含まれず、英語の説明にだけある語
      expect(fieldMatchesQuery(FIELDS[1]!, "FETCHES FROM")).toBe(true);
      expect(fieldMatchesQuery(FIELDS[1]!, "pushes to")).toBe(true);
      expect(fieldMatchesQuery(FIELDS[1]!, "worktree")).toBe(false);
    } finally {
      setLanguage("ja");
    }
  });
});

describe("優先度の判断基準の英語の表示と保存（UI-11）", () => {
  const defaultOf = (key: string) => configFields().find((f) => f.key === key)!.default as string;
  const DEFAULT_HIGH = defaultOf("priority.high");
  /** 判断基準の 3 つの値。medium・low は既定のまま */
  const priority = (high: string) => ({
    high,
    medium: defaultOf("priority.medium"),
    low: defaultOf("priority.low"),
  });
  /** 優先度の 3 項目を config.show の fields に足す（FIELDS は全体の数を数える別のテストが使う） */
  const withPriorityFields = (client: ReturnType<typeof mockClient>) => {
    const show = client.handlers["config.show"]!;
    const priorityFields = configFields().filter((f) => f.key.startsWith("priority."));
    client.handlers["config.show"] = (input) => {
      const view = show(input) as Record<string, unknown>;
      return (input as { fields?: boolean } | undefined)?.fields
        ? { ...view, fields: [...FIELDS, ...priorityFields] }
        : view;
    };
    return client;
  };
  const highInput = () => within(fieldOf("priority.high")).getByRole<HTMLInputElement>("textbox");

  it("英語の表示で、config.yaml に訳と同じ文が書いてあるときは、何もしないで離れても保存しない", async () => {
    setLanguage("en");
    try {
      const { client, config } = configClient();
      withPriorityFields(client);
      Object.assign(config, { priority: priority(PRIORITY_CRITERIA_EN.high) });
      mount(client);
      await screen.findByText("Commit mode");
      expect(highInput().value).toBe(PRIORITY_CRITERIA_EN.high);
      fireEvent.blur(highInput());
      expect(setCalls(client)).toEqual([]);
    } finally {
      setLanguage("ja");
    }
  });

  it("英語の表示で既定のままなら英語の訳を出し、何もしないで離れても保存しない。訳を打って離れても既定のままなら保存しない", async () => {
    setLanguage("en");
    try {
      const { client, config } = configClient();
      withPriorityFields(client);
      Object.assign(config, { priority: priority(DEFAULT_HIGH) });
      mount(client);
      await screen.findByText("Commit mode");
      expect(highInput().value).toBe(PRIORITY_CRITERIA_EN.high);
      fireEvent.blur(highInput());
      fireEvent.change(highInput(), { target: { value: PRIORITY_CRITERIA_EN.high } });
      fireEvent.blur(highInput());
      expect(setCalls(client)).toEqual([]);
      // 書き換えた文は、そのまま保存する
      fireEvent.change(highInput(), { target: { value: "独自の基準" } });
      fireEvent.blur(highInput());
      await waitFor(() =>
        expect(setCalls(client)).toEqual([{ key: "priority.high", value: "独自の基準" }]),
      );
    } finally {
      setLanguage("ja");
    }
  });

  it("英語の表示で訳の文を打って離れたら、既定の値（日本語）で保存する", async () => {
    setLanguage("en");
    try {
      const { client, config } = configClient();
      withPriorityFields(client);
      Object.assign(config, { priority: priority("独自の基準") });
      mount(client);
      await screen.findByText("Commit mode");
      fireEvent.change(highInput(), { target: { value: PRIORITY_CRITERIA_EN.high } });
      fireEvent.blur(highInput());
      await waitFor(() =>
        expect(setCalls(client)).toEqual([{ key: "priority.high", value: DEFAULT_HIGH }]),
      );
    } finally {
      setLanguage("ja");
    }
  });

  it("英語の表示で既定に戻したときの「保存した」の文も英語の訳で出す（日本語の既定を出さない）", async () => {
    setLanguage("en");
    try {
      const { client, config } = configClient();
      withPriorityFields(client);
      Object.assign(config, { priority: priority("独自の基準") });
      mount(client);
      await screen.findByText("Commit mode");
      fireEvent.click(
        within(fieldOf("priority.high")).getByRole("button", { name: "Reset to Default" }),
      );
      await waitFor(() =>
        expect(setCalls(client)).toEqual([{ key: "priority.high", value: DEFAULT_HIGH }]),
      );
      const saved = await waitFor(() => {
        const el = document.querySelector(".config-saved");
        expect(el?.textContent).toContain(PRIORITY_CRITERIA_EN.high);
        return el!;
      });
      expect(saved.textContent).not.toContain(DEFAULT_HIGH);
    } finally {
      setLanguage("ja");
    }
  });
});
