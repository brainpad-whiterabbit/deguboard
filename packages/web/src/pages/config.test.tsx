// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../app.js";
import { ClientError } from "../client/http.js";
import { StoreProvider } from "../store.js";
import { mockClient } from "../test-helpers.js";
import type { ConfigField } from "../types.js";
import { formatValue, groupOf, isModified, matchesQuery, valueAt } from "./config.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  window.localStorage.clear();
});

/** core の configFields と同じ形の項目（説明は短くしたもの） */
const FIELDS: ConfigField[] = [
  { key: "default_project", type: "string", description: "省略時の Project", default: "default" },
  { key: "git.remote", type: "string", description: "同期先のリモート", default: "origin" },
  { key: "git.base_branch", type: "string", description: "基準", default: "main" },
  { key: "worktree.root", type: "string", description: "置き場所", default: "../<repo>.worktrees" },
  {
    key: "commit.mode",
    type: "enum",
    options: ["each", "batch", "manual"],
    description: "each: 書き込みのたびにコミット",
    default: "batch",
  },
  {
    key: "push.mode",
    type: "enum",
    options: ["auto", "manual"],
    description: "auto: コミットのたびに push",
    default: "auto",
  },
  {
    key: "metrics.read_transcripts",
    type: "boolean",
    description: "会話記録を読む",
    default: false,
  },
  { key: "actions.shell", type: "boolean", description: "シェルを許す", default: false },
  { key: "actions.test", type: "list", description: "テストのコマンド", default: [] },
  { key: "auto.merge", type: "boolean", description: "自動でマージ", default: false },
  { key: "actor.human_only", type: "list", description: "人だけ", default: [] },
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
    (input as { fields?: boolean }).fields ? { config, fields: FIELDS } : config;
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

  it("チェックとリストは変えたらすぐ保存し、保存した項目と値を出す", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    fireEvent.click(within(fieldOf("auto.merge")).getByRole("checkbox"));
    expect(await screen.findByText("保存した: auto.merge を true にした")).toBeTruthy();
    fireEvent.click(within(fieldOf("actions.test")).getByLabelText("check を外す"));
    expect(await screen.findByText("保存した: actions.test を [mise, run] にした")).toBeTruthy();
    const add = within(fieldOf("actor.human_only")).getByPlaceholderText("項目を足す");
    fireEvent.change(add, { target: { value: "epic.close" } });
    fireEvent.keyDown(add, { key: "Enter" });
    expect(
      await screen.findByText("保存した: actor.human_only を [epic.close] にした"),
    ).toBeTruthy();
    expect(setCalls(client)).toEqual([
      { key: "auto.merge", value: true },
      { key: "actions.test", value: ["mise", "run"] },
      { key: "actor.human_only", value: ["epic.close"] },
    ]);
  });

  it("拒否されたら理由を項目の下に出し、値を保存されている値に戻す", async () => {
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
});

describe("設定画面の部品", () => {
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
    expect(matchesQuery(FIELDS[1]!, "リモート")).toBe(true);
    expect(matchesQuery(FIELDS[1]!, "GIT.REMOTE")).toBe(true);
    expect(matchesQuery(FIELDS[1]!, "push")).toBe(false);
  });
});
