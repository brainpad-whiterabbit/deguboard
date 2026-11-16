// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../l10n.js";
import { DEFAULT_VALUES } from "../l10n-core.js";
import { App } from "../app.js";
import { ClientError } from "../client/http.js";
import { createHost, HostProvider } from "../host.js";
import { toggleRoute } from "../router.js";
import { StoreProvider } from "../store.js";
import { mockClient } from "../test-helpers.js";
import { createUiState, memoryBackend } from "../ui-state.js";
import type { ConfigField, ConfigShowView, RetroPerspective } from "../types.js";
import { ASK_PERSPECTIVE_KEY, configFields, defaultConfig, GUIDE_TOPICS } from "@deguboard/core";
import {
  CONFIRM_KEYS,
  RETRO_ITEM_PREFIX,
  clearsToDefault,
  formatValue,
  groupOf,
  isModified,
  fieldMatch,
  metricSummary,
  retroChanges,
  nameOf,
  shownRetroPerspectives,
  valueAt,
} from "./config.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  window.localStorage.clear();
});

/**
 * core の configFields と同じ形の項目（説明は短くしたもの）。scope は core と同じ：local は個人で上書きできる項目。
 * models.sample だけは core にない作りものの項目：保存の前に確かめない・既定が空でない文字列で、個人で上書きできる項目を、
 * 自分のタブで空にしたときの動きを試すため（core の local の項目にはこの組み合わせがない）。
 * clears_to_default（空にすると既定に戻る）も core と同じで、既定が空でない文字列の項目だけ true。
 * 要約（summary）は書いていない項目では説明と同じ文にする（画面は「詳しく」を出さない）。
 * 要約と詳しい説明を分ける項目・例・空のときの動き・選択肢ごとの説明は、core と同じ形で一部の項目にだけ持たせる
 */
const FIELDS: ConfigField[] = (
  [
    {
      key: "git.remote",
      type: "string",
      description:
        "Git remote of the code (work branches and pull requests). The kanban data also syncs with it unless git.data_remote is set",
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
      summary: "チケットの書き込みをいつコミットするか",
      description: "each: 書き込みのたびにコミット / batch: まとめてコミット / manual: 手で決める",
      option_descriptions: {
        each: "書き込みのたびにコミットする",
        batch: "作業ツリーに残してまとめてコミットする",
        manual: "dg commit のときだけコミットする",
      },
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
      summary: "品質ゲートの検査が回すコマンド",
      description: "テストのコマンドの引数配列",
      example: ["mise", "run", "check"],
      empty: "検査を判定しない",
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
      key: "auto.decisions",
      type: "list",
      description: "聞かずに選ぶ判断",
      option_descriptions: {
        assign: "割り当て",
        check: "直し方が 1 つの点検",
        plan: "Plan の承認",
        audit: "見直しの表",
        accept: "受け入れ条件の確認",
      },
      default: ["assign", "check", "plan", "audit", "accept"],
      scope: "team",
      clears_to_default: false,
    },
    {
      key: "models.light",
      type: "string",
      summary: "段階 light に使うモデル",
      description: "Plan の段階 light と調べものに使うモデル。空なら親のモデル",
      example: "haiku",
      empty: "親のモデル",
      default: "",
      scope: "local",
      clears_to_default: false,
    },
    {
      key: "models.sample",
      type: "string",
      description: "作りものの項目",
      default: "inherit",
      scope: "local",
      clears_to_default: true,
    },
    {
      key: "worktree.setup",
      type: "list",
      description: "準備のコマンド",
      default: [],
      scope: "team",
      clears_to_default: false,
    },
    // guide.notes.* は core と同じく、どの topic も同じ文を持つ
    ...["work", "plan"].map((topic) => ({
      key: `guide.notes.${topic}`,
      type: "string" as const,
      summary: "ガイドの見出しの直後に差し込む文書",
      description: "差し込む文書のパス。リポジトリの外は読まない",
      example: "docs/notes.md",
      empty: "何も差し込まない",
      default: "",
      scope: "team" as const,
      clears_to_default: false,
    })),
  ] satisfies (Omit<ConfigField, "summary"> & { summary?: string })[]
).map((f) => ({ summary: f.description, ...f }));

function configClient(initialLocal: Record<string, unknown> = {}) {
  const client = mockClient();
  const config = {
    git: { remote: "origin", base_branch: "main" },
    worktree: { root: "../<repo>.worktrees", setup: [] as string[] },
    commit: { mode: "each" },
    push: { mode: "auto" },
    metrics: { read_transcripts: false },
    actions: { shell: false, test: ["mise", "run", "check"] },
    auto: { merge: false, decisions: ["assign", "check", "plan", "audit", "accept"] },
    models: { light: "", sample: "inherit" },
    guide: { notes: { work: "docs/work-notes.md", plan: "" } },
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
      ? {
          config: merged(),
          team: config,
          local: { ...local },
          defaults: defaultConfig(),
          fields: FIELDS,
        }
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

/**
 * 描き直しと、その後に続く非同期の処理（読み直し・応答の反映・書き込みの要求）が終わるまで act で流す。
 * 1 tick の待ち（setTimeout 0）では、描き直しや後から始まる要求を取りこぼすので、流しきってから確かめる
 */
async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => {});
}

function mount(client: ReturnType<typeof mockClient>) {
  window.location.hash = "#/config";
  render(
    <StoreProvider client={client}>
      <App />
    </StoreProvider>,
  );
}

/** エージェントに頼む入力欄まで開けるよう、Host（見た目の状態はメモリ）で包んで載せる */
function mountWithHost(client: ReturnType<typeof mockClient>) {
  window.location.hash = "#/config";
  render(
    <StoreProvider client={client}>
      {/* 拡張ホストのない Host は見た目の状態を使い回すので、テストごとの置き場に差し替える（前のテストの小窓を戻さない） */}
      <HostProvider
        host={{ ...createHost("sidebar", null), state: createUiState(memoryBackend()) }}
      >
        <App />
      </HostProvider>
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
  it("まとまりごとに全項目を名前・キー・要約・型に合う入力欄と一緒に出し、チーム全員に効く帯を出す", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "コミットと push",
      "エージェント",
      "計測",
      "Git",
      "ガイドの差し込み",
    ]);
    // 「既定の Workflow」の項目はない
    expect(screen.queryByText("既定の Workflow")).toBeNull();
    expect(document.querySelectorAll(".config-field")).toHaveLength(FIELDS.length);
    const commit = fieldOf("commit.mode");
    expect(within(commit).getByText("commit.mode")).toBeTruthy();
    expect(within(commit).getByText("チケットの書き込みをいつコミットするか")).toBeTruthy();
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
    const add = within(fieldOf("worktree.setup")).getByPlaceholderText("項目を足す");
    fireEvent.change(add, { target: { value: "pnpm" } });
    fireEvent.keyDown(add, { key: "Enter" });
    expect(within(fieldOf("worktree.setup")).getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(within(fieldOf("worktree.setup")).getByLabelText("pnpm を外す"));
    expect(within(fieldOf("worktree.setup")).queryByRole("alertdialog")).toBeNull();

    // 待ちが解けたので、ほかの項目も触れる
    expect(within(fieldOf("git.remote")).getByRole<HTMLInputElement>("textbox").disabled).toBe(
      false,
    );
    await settle();
    expect(setCalls(client)).toEqual([]);
  });

  it("確かめを待つ間は、待っている項目のほかの「既定に戻す」を押せず、待ちと下書きが残る", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    const reset = (key: string) =>
      within(fieldOf(key)).getByRole<HTMLButtonElement>("button", { name: "既定に戻す" });
    // actions.test（既定から変えてある）に足して、確かめを待たせる
    const add = within(fieldOf("actions.test")).getByRole("textbox");
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
    await settle();
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

  it("actions.test・actions.shell・worktree.setup・auto.merge も保存の前に確かめ、変わることを出し、やめると戻す", async () => {
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

    // 聞かずに選ぶ判断：外した結果を確かめ、やめると元のリストに戻る
    fireEvent.click(within(fieldOf("auto.decisions")).getByLabelText("accept を外す"));
    const decisions = within(fieldOf("auto.decisions")).getByRole("alertdialog");
    expect(decisions.textContent).toContain("エージェントが聞かずに選ぶ判断が変わる");
    fireEvent.click(within(decisions).getByText("やめる"));
    expect(within(fieldOf("auto.decisions")).getByLabelText("accept を外す")).toBeTruthy();
    expect(setCalls(client)).toEqual([]);

    // claim の準備のコマンド：足してから保存する
    const add = within(fieldOf("worktree.setup")).getByPlaceholderText("項目を足す");
    fireEvent.change(add, { target: { value: "pnpm" } });
    fireEvent.keyDown(add, { key: "Enter" });
    const setup = within(fieldOf("worktree.setup")).getByRole("alertdialog");
    expect(setup.textContent).toContain("claim のたびに確認なしで回すコマンドが変わる");
    fireEvent.click(within(setup).getByText("保存する"));
    expect(await screen.findByText("保存した: worktree.setup を [pnpm] にした")).toBeTruthy();
    expect(setCalls(client)).toEqual([{ key: "worktree.setup", value: ["pnpm"] }]);
  });

  it("拒否されたら理由を項目の下にだけ出し、値を保存されている値に戻す", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    const input = within(fieldOf("models.light")).getByRole<HTMLInputElement>("textbox");
    fireEvent.change(input, { target: { value: "bad" } });
    fireEvent.blur(input);
    expect((await within(fieldOf("models.light")).findByRole("alert")).textContent).toContain(
      "models.light の値が正しくない（選択肢にない）",
    );
    expect(input.value).toBe("");
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

  it("チームのタブで保存した後に、保存の前に始まった読み込みの古い応答が返っても、画面は保存した値のまま", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    const box = () =>
      within(fieldOf("metrics.read_transcripts")).getByRole<HTMLInputElement>("checkbox");
    // 読み込み（config.show）を止め、返すのを決める。止めた時点の値で応答を作る（呼ばれた順に held に並ぶ）
    const show = client.handlers["config.show"]!;
    const held: (() => void)[] = [];
    client.handlers["config.show"] = (input) => {
      // 呼ばれた時点の値を写す（モックの応答は config を参照するので、後の保存で変わらないように）
      const data = structuredClone(show(input));
      return new Promise((resolve) => held.push(() => resolve(data)));
    };
    // 1 回目の保存（true）。その後の読み直しの応答を返すと、画面の読み込み（held[1]）が始まる
    fireEvent.click(box());
    await waitFor(() => expect(held).toHaveLength(1));
    held[0]!();
    await waitFor(() => expect(held).toHaveLength(2));
    // held[1] は 1 回目の保存の後・2 回目の保存の前に始まった読み込み（true を読んだ）。返す前に 2 回目の保存（false）をする
    fireEvent.click(box());
    await waitFor(() => expect(box().checked).toBe(false));
    await waitFor(() => expect(held).toHaveLength(3));
    // 古い応答（true）が後から返っても、保存した値（false）のまま
    held[1]!();
    await settle();
    expect(box().checked).toBe(false);
    expect(screen.getByText("保存した: metrics.read_transcripts を false にした")).toBeTruthy();
    held[2]!();
    await waitFor(() => expect(held).toHaveLength(4));
    held[3]!();
    client.handlers["config.show"] = show;
  });

  it("保存の後に始まった読み込みの応答は、今までどおり画面に反映される", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    const box = () =>
      within(fieldOf("metrics.read_transcripts")).getByRole<HTMLInputElement>("checkbox");
    // 読み込みの応答は、チームの値が外から false に変わった形で返す
    const show = client.handlers["config.show"]!;
    const held: (() => void)[] = [];
    client.handlers["config.show"] = (input) => {
      const data = structuredClone(show(input) as ConfigShowView);
      data.team.metrics = { read_transcripts: false };
      return new Promise((resolve) => held.push(() => resolve(data)));
    };
    fireEvent.click(box());
    await waitFor(() => expect(held).toHaveLength(1));
    held[0]!();
    // 1 回目の保存の後に始まった画面の読み込み（held[1]）は、保存の後なので反映される
    await waitFor(() => expect(held).toHaveLength(2));
    held[1]!();
    await waitFor(() => expect(box().checked).toBe(false));
    client.handlers["config.show"] = show;
  });

  it("2 つの項目の保存が重なり、後の保存が先に終わっても、先の保存が終わったときは後の項目の「保存中」の印と錠を消さず、自分の保存が終わったときだけ外す", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    // 先に始めた保存（commit.mode）を止めておき、後に始めた保存（metrics.read_transcripts）が先に終わるようにする
    const set = client.handlers["config.set"]!;
    const held: (() => void)[] = [];
    client.handlers["config.set"] = (input) => {
      if ((input as { key: string }).key !== "commit.mode") return set(input);
      const data = set(input);
      return new Promise((resolve) => held.push(() => resolve(data)));
    };
    fireEvent.change(within(fieldOf("commit.mode")).getByRole("combobox"), {
      target: { value: "manual" },
    });
    await waitFor(() => expect(held).toHaveLength(1));
    fireEvent.click(within(fieldOf("metrics.read_transcripts")).getByRole("checkbox"));
    expect(
      await screen.findByText("保存した: metrics.read_transcripts を true にした"),
    ).toBeTruthy();

    // 後の保存が終わっても、止めたままの commit.mode の「保存中」の印と錠は残る
    expect(within(fieldOf("commit.mode")).getByText("保存中…")).toBeTruthy();
    expect(within(fieldOf("commit.mode")).getByRole<HTMLSelectElement>("combobox").disabled).toBe(
      true,
    );
    expect(within(fieldOf("metrics.read_transcripts")).queryByText("保存中…")).toBeNull();

    // 自分の保存が終わると、その項目の印と錠だけが消える
    held[0]!();
    await waitFor(() => expect(within(fieldOf("commit.mode")).queryByText("保存中…")).toBeNull());
    expect(within(fieldOf("commit.mode")).getByRole<HTMLSelectElement>("combobox").disabled).toBe(
      false,
    );
    client.handlers["config.set"] = set;
  });

  it("git.remote・git.base_branch・worktree.root は保存の前に確かめ、やめると戻す。worktree.root は「保存する」を押すまで config.set を呼ばず、確かめの間はほかの項目を触れない", async () => {
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

    const root = within(fieldOf("worktree.root")).getByRole<HTMLInputElement>("textbox");
    fireEvent.change(root, { target: { value: "/tmp/worktrees" } });
    fireEvent.blur(root);
    const rootConfirm = within(fieldOf("worktree.root")).getByRole("alertdialog");
    expect(rootConfirm.textContent).toContain("/tmp/worktrees");
    // 確かめを待つ間はほかの項目を触れず、config.set もまだ呼ばない
    expect(within(fieldOf("git.remote")).getByRole<HTMLInputElement>("textbox").disabled).toBe(
      true,
    );
    await settle();
    expect(setCalls(client)).toEqual([{ key: "git.remote", value: "upstream" }]);
    fireEvent.click(within(rootConfirm).getByText("保存する"));
    expect(
      await screen.findByText("保存した: worktree.root を /tmp/worktrees にした"),
    ).toBeTruthy();
    expect(setCalls(client)).toEqual([
      { key: "git.remote", value: "upstream" },
      { key: "worktree.root", value: "/tmp/worktrees" },
    ]);
    expect(within(fieldOf("worktree.root")).queryByRole("alertdialog")).toBeNull();
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
    ).toBe(
      "git.remote を upstream にする。作業ブランチと PR の先が変わる（git.data_remote が空ならデータの同期先も）。チーム全員に効く。保存する？",
    );
    fireEvent.click(within(fieldOf("git.remote")).getByText("やめる"));

    // 空にする：空の値（「`` にする」）でなく、戻る既定の値を出す
    fireEvent.change(remote, { target: { value: "" } });
    fireEvent.blur(remote);
    const confirm = within(fieldOf("git.remote")).getByRole("alertdialog");
    expect(confirm.querySelector("p")?.textContent).toBe(
      "git.remote を空にし、既定の origin に戻す。作業ブランチと PR の先が変わる（git.data_remote が空ならデータの同期先も）。チーム全員に効く。保存する？",
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
      "models.sample",
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
    expect(confirm.textContent).toContain("作業ブランチと PR の先が変わる");
    expect(confirm.textContent).toContain("自分だけに効く");
    expect(confirm.textContent).not.toContain("チーム全員");
    await settle();
    expect(setCalls(client)).toEqual([]);
    fireEvent.click(within(confirm).getByText("保存する"));
    expect(await screen.findByText("保存した: git.remote を自分だけ fork にした")).toBeTruthy();
    expect(setCalls(client)).toEqual([{ key: "git.remote", value: "fork", local: true }]);

    // 外す：チームの origin に戻るとリモートが変わるので確かめ、やめると上書きを残す
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
    const { client } = configClient({ "git.remote": "upstream", "models.sample": "mine" });
    mount(client);
    await screen.findByText("コミットの仕方");
    expect(tabOf("自分").textContent).toBe("自分2");
    fireEvent.click(tabOf("自分"));

    // 確かめない項目：空にすると上書きが外れ、チームの値を出す
    const sample = within(fieldOf("models.sample")).getByRole<HTMLInputElement>("textbox");
    fireEvent.change(sample, { target: { value: "" } });
    fireEvent.blur(sample);
    expect(
      await screen.findByText(
        "保存した: models.sample の自分の値を外した（チームの inherit を使う）",
      ),
    ).toBeTruthy();
    expect(unsetCalls(client)).toEqual([{ key: "models.sample", local: true }]);
    await waitFor(() => expect(ownOf("models.sample").checked).toBe(false));
    expect(sample.value).toBe("inherit");
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

  it("要約 1 行をいつも出し、詳しい説明の全文は畳んだ「詳しく」で開ける。要約と同じ文の項目は「詳しく」を出さない", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    const commit = fieldOf("commit.mode");
    expect(commit.querySelector(".config-summary")?.textContent).toBe(
      "チケットの書き込みをいつコミットするか",
    );
    const more = commit.querySelector<HTMLDetailsElement>("details.config-more")!;
    expect(more.open).toBe(false);
    expect(within(more).getByText("詳しく")).toBeTruthy();
    expect(more.querySelector(".config-detail")?.textContent).toBe(
      "each: 書き込みのたびにコミット / batch: まとめてコミット / manual: 手で決める",
    );
    fireEvent.click(within(more).getByText("詳しく"));
    expect(more.open).toBe(true);
    // 要約を書いていない項目（要約が説明と同じ）は、説明を要約の行に出し、「詳しく」を出さない
    const remote = fieldOf("git.remote");
    expect(remote.querySelector(".config-summary")?.textContent).toBe(
      "コードのリモート（作業ブランチと PR）。git.data_remote を設定しなければ、カンバンのデータもここと同期する",
    );
    expect(remote.querySelector("details")).toBeNull();
  });

  it("例は入力欄のプレースホルダに、空のときの動きは欄の下の 1 行に出す", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    const light = fieldOf("models.light");
    expect(within(light).getByRole<HTMLInputElement>("textbox").placeholder).toBe("例 haiku");
    expect(light.querySelector(".config-empty")?.textContent).toBe("空のとき: 親のモデル");
    // リストは足す欄のプレースホルダに、例のリストを出す
    const test = fieldOf("actions.test");
    expect(within(test).getByRole<HTMLInputElement>("textbox").placeholder).toBe(
      "例 [mise, run, check]",
    );
    expect(test.querySelector(".config-empty")?.textContent).toBe("空のとき: 検査を判定しない");
    // 例のない項目は今までのプレースホルダのまま、空にできない項目は空のときの行を出さない
    expect(
      within(fieldOf("worktree.setup")).getByRole<HTMLInputElement>("textbox").placeholder,
    ).toBe("項目を足す");
    expect(fieldOf("commit.mode").querySelector(".config-empty")).toBeNull();
  });

  it("選択肢のある項目は選んでいる値の説明だけを出し、値を変えると説明も替わる", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    const hints = () =>
      [...fieldOf("commit.mode").querySelectorAll(".config-option-hints li")].map(
        (e) => e.textContent,
      );
    expect(hints()).toEqual(["each 書き込みのたびにコミットする"]);
    fireEvent.change(within(fieldOf("commit.mode")).getByRole("combobox"), {
      target: { value: "manual" },
    });
    expect(hints()).toEqual(["manual dg commit のときだけコミットする"]);
    await settle();
    expect(hints()).toEqual(["manual dg commit のときだけコミットする"]);
    // 選択肢のリストは入っている値ごとに説明を出し、外した値の説明は消える。入っていない選択肢は足す欄の候補に出す
    const decisions = fieldOf("auto.decisions");
    expect(
      [...decisions.querySelectorAll(".config-option-hints code")].map((e) => e.textContent),
    ).toEqual(["assign", "check", "plan", "audit", "accept"]);
    fireEvent.click(within(decisions).getByLabelText("accept を外す"));
    expect(within(decisions).queryByText("受け入れ条件の確認")).toBeNull();
    expect(
      [...decisions.querySelectorAll("datalist option")].map((e) => e.getAttribute("value")),
    ).toEqual(["accept"]);
  });

  it("guide.notes.* は説明を 1 つだけ出し、差し込む先ごとの行の表で出す", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    const section = screen.getByRole("region", { name: "ガイドの差し込み" });
    expect(within(section).getAllByText("ガイドの見出しの直後に差し込む文書")).toHaveLength(1);
    expect(within(section).getAllByText("空のとき: 何も差し込まない")).toHaveLength(1);
    expect(section.querySelectorAll("details.config-more")).toHaveLength(1);
    const rows = within(section).getAllByRole("row");
    expect(
      rows.map((r) => within(r).getByRole("rowheader").querySelector("label")?.textContent),
    ).toEqual(["作業", "計画"]);
    // 行の名前は入力欄の名前になり、欄はチームの値と例のプレースホルダを出す
    const work = within(section).getByRole<HTMLInputElement>("textbox", { name: "作業" });
    expect(work.value).toBe("docs/work-notes.md");
    expect(
      within(section).getByRole<HTMLInputElement>("textbox", { name: "計画" }).placeholder,
    ).toBe("例 docs/notes.md");
  });

  it("guide.notes.* の表は、core のどのガイドの topic の行にも短い名前（NOTE_LABELS）を出す（topic を足したときの漏れを防ぐ）", async () => {
    const { client } = configClient();
    // 項目は core の configFields の guide.notes.*（GUIDE_TOPICS の全 topic）に差し替える
    const notes = configFields().filter((f) => f.key.startsWith("guide.notes."));
    const show = client.handlers["config.show"]!;
    client.handlers["config.show"] = (input) => {
      const out = show(input) as ConfigShowView | Record<string, unknown>;
      return "fields" in out
        ? { ...out, fields: [...FIELDS.filter((f) => !f.key.startsWith("guide.notes.")), ...notes] }
        : out;
    };
    mount(client);
    await screen.findByText("コミットの仕方");
    const section = screen.getByRole("region", { name: "ガイドの差し込み" });
    const labels = within(section)
      .getAllByRole("row")
      .map((r) => within(r).getByRole("rowheader").querySelector("label")?.textContent);
    expect(labels).toHaveLength(GUIDE_TOPICS.length);
    // 名前がない topic は topic のまま出る
    expect(labels.filter((l) => (GUIDE_TOPICS as readonly unknown[]).includes(l))).toEqual([]);
  });

  it("検索は要約と詳しい説明にも当たり、詳しい説明にだけ当たった項目は「詳しく」を開いて出す", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    const search = screen.getByLabelText("設定を検索");
    const shown = () =>
      [...document.querySelectorAll(".config-field")].map((e) => e.getAttribute("data-key"));
    const open = (el: Element) => el.querySelector<HTMLDetailsElement>("details")!.open;
    // 要約に当たる：「詳しく」は畳んだまま
    fireEvent.change(search, { target: { value: "いつコミット" } });
    expect(shown()).toEqual(["commit.mode"]);
    expect(open(fieldOf("commit.mode"))).toBe(false);
    // 詳しい説明にだけ当たる：「詳しく」を開く
    fireEvent.change(search, { target: { value: "手で決める" } });
    expect(shown()).toEqual(["commit.mode"]);
    expect(open(fieldOf("commit.mode"))).toBe(true);
    // guide.notes.* は表の上の 1 つの「詳しく」を開く
    fireEvent.change(search, { target: { value: "リポジトリの外" } });
    expect(shown()).toEqual(["guide.notes.work", "guide.notes.plan"]);
    expect(open(document.querySelector(".config-notes")!)).toBe(true);
    // 検索を消すと畳む
    fireEvent.change(search, { target: { value: "" } });
    expect(open(fieldOf("commit.mode"))).toBe(false);
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

  // 歯車はビューのタイトル行にあり、拡張ホストの toggle の event が toggleRoute を呼ぶ（host.tsx の HostBridge）。
  // 設定画面から戻る手は歯車（とタブ）だけで、画面の中に戻るリンクは置かない
  it("項目の行ごとに頼む吹き出しを出し、押すと core が決めた候補（設定の説明と変更の 1 つ）から、その項目のキーを入れた /dgconfig の依頼文を開く", async () => {
    const { client } = configClient();
    mountWithHost(client);
    await screen.findByText("コミットの仕方");
    // 説明つきの行は名前の行に、guide.notes.* の表の行は見出しのセルに、どの項目も 1 つずつ
    for (const f of FIELDS)
      expect(
        within(fieldOf(f.key)).getAllByRole("button", {
          name: `エージェントに頼む（設定の項目 ${f.key}）`,
        }),
        f.key,
      ).toHaveLength(1);
    expect(
      fieldOf("guide.notes.work").querySelector("th[data-ask-spot] > .ask-bubble"),
    ).toBeTruthy();
    // 候補は画面で組まず、項目ごとの組（= を付けたキー）を ask-menu に渡して引く
    await waitFor(() =>
      expect(
        client.calls
          .filter((c) => c.name === "ask-menu")
          .flatMap((c) => (c.input as { sets: string[] }).sets),
      ).toEqual(expect.arrayContaining(FIELDS.map((f) => `=${f.key}`))),
    );
    fireEvent.click(
      within(fieldOf("commit.mode")).getByRole("button", { name: /エージェントに頼む/ }),
    );
    await waitFor(() => expect(screen.getAllByRole("menuitem")).toHaveLength(1));
    fireEvent.click(screen.getByRole("menuitem", { name: /設定を説明・変更する/ }));
    const composer = await screen.findByRole("region", { name: "エージェントに頼む" });
    // 項目のキーを札に出し、依頼文は core の ask が返したまま
    await waitFor(() =>
      expect([...composer.querySelectorAll(".ask-pill")].map((p) => p.textContent)).toEqual([
        "/dgconfig",
        "commit.mode",
      ]),
    );
    fireEvent.click(within(composer).getByRole("button", { name: "全文" }));
    await waitFor(() =>
      expect(within(composer).getByLabelText("全文", { selector: "pre" }).textContent).toBe(
        "/dgconfig commit.mode",
      ),
    );
    const asks = client.calls.filter((c) => c.name === "ask").map((c) => c.input);
    expect(asks.length).toBeGreaterThan(0);
    expect(
      asks.every(
        (i) =>
          (i as { key?: string }).key === "commit.mode" &&
          (i as { targets: string[] }).targets.length === 0,
      ),
    ).toBe(true);
    // 頼むだけでは設定を書かない
    expect(setCalls(client)).toEqual([]);
  });

  it("自分のタブの行にも頼む吹き出しを出す", async () => {
    const { client } = configClient();
    mountWithHost(client);
    await screen.findByText("コミットの仕方");
    fireEvent.click(tabOf("自分"));
    await settle();
    expect(
      within(fieldOf("commit.mode")).getByRole("button", {
        name: "エージェントに頼む（設定の項目 commit.mode）",
      }),
    ).toBeTruthy();
  });

  it("歯車で設定画面を開き、もう一度押すと来る前の画面に戻る", async () => {
    const { client } = configClient();
    window.location.hash = "#/backlog";
    render(
      <StoreProvider client={client}>
        <App />
      </StoreProvider>,
    );
    await screen.findByRole("heading", { level: 1, name: "バックログ" });
    act(() => toggleRoute("#/config"));
    expect(window.location.hash).toBe("#/config");
    expect(await screen.findByText("コミットの仕方")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "前の画面に戻る" })).toBeNull();
    act(() => toggleRoute("#/config"));
    expect(window.location.hash).toBe("#/backlog");
  });

  it("来る前の画面がない（#/config を直接開いた）ときは、歯車でカンバンに戻る", async () => {
    const { client } = configClient();
    mount(client);
    await screen.findByText("コミットの仕方");
    act(() => toggleRoute("#/config"));
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
      "actions.light_test",
      "actions.shell",
      "actions.test",
      "auto.decisions",
      "auto.merge",
      "git.base_branch",
      "git.data_branch",
      "git.data_remote",
      "git.remote",
      "worktree.root",
      "worktree.setup",
    ]);
  });

  it("入れ子の値を引き、既定との差を中身で比べ、値を短く書く", () => {
    expect(valueAt({ commit: { mode: "each" } }, "commit.mode")).toBe("each");
    expect(valueAt({ top: "x" }, "top")).toBe("x");
    expect(valueAt({}, "commit.mode")).toBeUndefined();
    expect(isModified([], [])).toBe(false);
    expect(isModified(["a"], [])).toBe(true);
    expect(formatValue([])).toBe("空");
    expect(formatValue(["a", "b"])).toBe("[a, b]");
    expect(formatValue(false)).toBe("false");
  });

  it("空にすると既定に戻るかは core の項目の定義（clears_to_default）で決め、型や既定値から判断しない", () => {
    const base = { type: "string", summary: "", description: "", scope: "local" } as const;
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
    expect(groupOf("auto.merge")).toBe("agent");
    expect(groupOf("priority.high")).toBe("ticket");
    // やめた項目（default_workflow・actor.human_only）はどのまとまりにも入らない
    expect(groupOf("default_workflow")).toBe("other");
    expect(groupOf("actor.human_only")).toBe("other");
    expect(groupOf("new.item")).toBe("other");
    expect(fieldMatch(FIELDS[0]!, "リモート")).toBe("shown");
    expect(fieldMatch(FIELDS[0]!, "GIT.REMOTE")).toBe("shown");
    expect(fieldMatch(FIELDS[0]!, "push")).toBeNull();
  });

  it("英語の表示では、検索が英語の説明にも当たる", () => {
    setLanguage("en");
    try {
      // 表示名（Code remote）には含まれず、英語の説明にだけある語
      expect(fieldMatch(FIELDS[0]!, "WORK BRANCHES")).toBe("shown");
      expect(fieldMatch(FIELDS[0]!, "pull requests")).toBe("shown");
      expect(fieldMatch(FIELDS[0]!, "worktree")).toBeNull();
    } finally {
      setLanguage("ja");
    }
  });
});

describe("優先度の判断基準の日本語の表示と保存（UI-11）", () => {
  const defaultOf = (key: string) => configFields().find((f) => f.key === key)!.default as string;
  /** core の既定（英語） */
  const DEFAULT_HIGH = defaultOf("priority.high");
  /** 既定の値の日本語の訳（DEFAULT_VALUES）。既定のままのときだけ日本語の表示で出る */
  const JA_HIGH = DEFAULT_VALUES[DEFAULT_HIGH]!.ja!;
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

  it("日本語の既定（訳と同じ文）を config.yaml に書いたリポジトリでは、どちらの表示言語でも書いたまま出し、何もしないで離れても保存しない", async () => {
    for (const [language, name] of [
      ["ja", "コミットの仕方"],
      ["en", "Commit mode"],
    ] as const) {
      setLanguage(language);
      try {
        const { client, config } = configClient();
        withPriorityFields(client);
        Object.assign(config, { priority: priority(JA_HIGH) });
        mount(client);
        await screen.findByText(name);
        expect(highInput().value, language).toBe(JA_HIGH);
        fireEvent.blur(highInput());
        expect(setCalls(client), language).toEqual([]);
      } finally {
        setLanguage("ja");
        cleanup();
      }
    }
  });

  it("既定を書き換えた値は、どちらの表示言語でも書いたまま欄に出し、何もしないで離れても保存しない", async () => {
    for (const [language, name] of [
      ["ja", "コミットの仕方"],
      ["en", "Commit mode"],
    ] as const) {
      setLanguage(language);
      try {
        const { client, config } = configClient();
        withPriorityFields(client);
        Object.assign(config, { priority: priority("独自の基準") });
        mount(client);
        await screen.findByText(name);
        expect(highInput().value, language).toBe("独自の基準");
        fireEvent.blur(highInput());
        expect(setCalls(client), language).toEqual([]);
      } finally {
        setLanguage("ja");
        cleanup();
      }
    }
  });

  it("日本語の表示で既定のままなら日本語の訳を出し、何もしないで離れても保存しない。訳を打って離れても既定のままなら保存しない", async () => {
    const { client, config } = configClient();
    withPriorityFields(client);
    Object.assign(config, { priority: priority(DEFAULT_HIGH) });
    mount(client);
    await screen.findByText("コミットの仕方");
    expect(highInput().value).toBe(JA_HIGH);
    fireEvent.blur(highInput());
    fireEvent.change(highInput(), { target: { value: JA_HIGH } });
    fireEvent.blur(highInput());
    expect(setCalls(client)).toEqual([]);
    // 書き換えた文は、そのまま保存する
    fireEvent.change(highInput(), { target: { value: "独自の基準" } });
    fireEvent.blur(highInput());
    await waitFor(() =>
      expect(setCalls(client)).toEqual([{ key: "priority.high", value: "独自の基準" }]),
    );
  });

  it("英語の表示で既定のままなら既定の英語の文のまま出す", async () => {
    setLanguage("en");
    try {
      const { client, config } = configClient();
      withPriorityFields(client);
      Object.assign(config, { priority: priority(DEFAULT_HIGH) });
      mount(client);
      await screen.findByText("Commit mode");
      expect(highInput().value).toBe(DEFAULT_HIGH);
      fireEvent.blur(highInput());
      expect(setCalls(client)).toEqual([]);
    } finally {
      setLanguage("ja");
    }
  });

  it("日本語の表示で訳の文を打って離れたら、既定の値（英語）で保存する", async () => {
    const { client, config } = configClient();
    withPriorityFields(client);
    Object.assign(config, { priority: priority("独自の基準") });
    mount(client);
    await screen.findByText("コミットの仕方");
    fireEvent.change(highInput(), { target: { value: JA_HIGH } });
    fireEvent.blur(highInput());
    await waitFor(() =>
      expect(setCalls(client)).toEqual([{ key: "priority.high", value: DEFAULT_HIGH }]),
    );
  });

  it("日本語の表示で既定に戻したときの「保存した」の文も日本語の訳で出す（英語の既定を出さない）", async () => {
    const { client, config } = configClient();
    withPriorityFields(client);
    Object.assign(config, { priority: priority("独自の基準") });
    mount(client);
    await screen.findByText("コミットの仕方");
    fireEvent.click(within(fieldOf("priority.high")).getByRole("button", { name: "既定に戻す" }));
    await waitFor(() =>
      expect(setCalls(client)).toEqual([{ key: "priority.high", value: DEFAULT_HIGH }]),
    );
    const saved = await waitFor(() => {
      const el = document.querySelector(".config-saved");
      expect(el?.textContent).toContain(JA_HIGH);
      return el!;
    });
    expect(saved.textContent).not.toContain(DEFAULT_HIGH);
  });
});

describe("設定画面の振り返りの節（retro.perspectives を読むだけで出す）", () => {
  /** 指標を 2 つ持つ観点と、定義のない観点。core の retroPerspectiveSchema と同じ形 */
  const RETRO: Record<string, RetroPerspective> = {
    review: {
      name: "見直しの効き目",
      question: "見直しは不具合をマージの前に見つけたか",
      metrics: {
        "first-pass-rate": {
          definition: "最初の見直しで通ったチケットの割合。手直しの Run を数える",
          sources: ["dg metrics show --iteration <S>"],
          unmeasured: "見逃した不具合",
        },
        "fix-rounds": {
          definition: "手直しの回数の平均",
          sources: ["dg run list --ticket <id>", "gh pr view <n>"],
        },
      },
    },
    cost: { name: "コスト", question: "時間とトークンはどこに使われたか", metrics: {} },
  };
  const retroClient = () => {
    const { client, config } = configClient();
    Object.assign(config, { retro: { perspectives: structuredClone(RETRO) } });
    return client;
  };
  const section = () => screen.getByRole("region", { name: "振り返り" });
  const perspectiveOf = (id: string) =>
    document.querySelector<HTMLElement>(`[data-perspective="${id}"]`)!;
  const metricOf = (key: string) => document.querySelector<HTMLElement>(`[data-metric="${key}"]`)!;
  /** 指標の「詳しく」 */
  const moreOf = (key: string) => metricOf(key).querySelector<HTMLDetailsElement>(".config-more")!;
  const summaryOf = (el: Element) => el.querySelector(":scope > summary")!;

  it("観点をほかの項目と同じ行（名前・ID・指標の数、下に問いを切らずに）で出し、入力欄も畳む三角も置かない", async () => {
    mount(retroClient());
    await screen.findByText("コミットの仕方");
    const s = section();
    expect(within(s).getByText("dg retro metric")).toBeTruthy();
    expect(
      [...s.querySelectorAll("[data-perspective]")].map((e) => [
        e.classList.contains("config-field"),
        e.querySelector(":scope > .config-field-head")!.textContent,
        e.querySelector(":scope > .config-summary")!.textContent,
      ]),
    ).toEqual([
      // どちらも既定の同じ ID の観点から名前と問いを書き換えているので「変更あり」が付く
      [true, "見直しの効き目review変更あり指標 2", "見直しは不具合をマージの前に見つけたか"],
      [true, "コストcost変更あり指標なし", "時間とトークンはどこに使われたか"],
    ]);
    expect(perspectiveOf("review").querySelector(".config-key")!.textContent).toBe("review");
    // 観点は <details> で畳まない（畳むのは指標の「詳しく」だけ）
    expect(s.querySelectorAll("details:not(.config-more)")).toHaveLength(0);
    // ボタンは観点ごとの頼む吹き出しだけ
    expect(s.querySelectorAll("input, select, textarea, button:not(.ask-bubble)")).toHaveLength(0);
    expect(s.querySelectorAll("button.ask-bubble")).toHaveLength(2);
  });

  it("観点の行の吹き出しから、その観点の ID を渡して /dgretro を頼む依頼文を開く（ask は key に retro.perspectives.<id> を受ける）", async () => {
    const client = retroClient();
    mountWithHost(client);
    await screen.findByText("コミットの仕方");
    const head = perspectiveOf("review").querySelector<HTMLElement>(":scope > .config-field-head")!;
    fireEvent.click(
      within(head).getByRole("button", { name: "エージェントに頼む（振り返りの観点 review）" }),
    );
    // 候補は core が決めた振り返るの 1 つだけ
    await waitFor(() => expect(screen.getAllByRole("menuitem")).toHaveLength(1));
    fireEvent.click(screen.getByRole("menuitem", { name: /振り返る/ }));
    const composer = await screen.findByRole("region", { name: "エージェントに頼む" });
    fireEvent.click(within(composer).getByRole("button", { name: "全文" }));
    await waitFor(() =>
      expect(within(composer).getByLabelText("全文", { selector: "pre" }).textContent).toBe(
        "/dgretro\n観点 review だけで振り返って",
      ),
    );
    expect(RETRO_ITEM_PREFIX).toBe(ASK_PERSPECTIVE_KEY);
    const asks = client.calls.filter((c) => c.name === "ask").map((c) => c.input);
    expect(asks.map((i) => (i as { key?: string }).key)).toEqual(
      asks.map(() => "retro.perspectives.review"),
    );
    expect(asks.length).toBeGreaterThan(0);
  });

  it("指標は ID と数え方の最初の文の子の行で出し、全文・出どころ・測れないものは「詳しく」に畳む", async () => {
    mount(retroClient());
    await screen.findByText("コミットの仕方");
    expect(
      [...perspectiveOf("review").querySelectorAll("[data-metric] > .config-field-head")].map(
        (e) => e.textContent,
      ),
    ).toEqual([
      "first-pass-rate最初の見直しで通ったチケットの割合。",
      "fix-rounds手直しの回数の平均",
    ]);
    const more = moreOf("review.first-pass-rate");
    expect(more.open).toBe(false);
    expect(summaryOf(more).textContent).toBe("詳しく");
    fireEvent.click(summaryOf(more));
    expect(more.open).toBe(true);
    const dl = within(more.querySelector("dl")!);
    expect(dl.getByText("最初の見直しで通ったチケットの割合。手直しの Run を数える")).toBeTruthy();
    expect(dl.getByText("dg metrics show --iteration <S>")).toBeTruthy();
    expect(dl.getByText("見逃した不具合")).toBeTruthy();
    // 測れないものがない指標はその見出しを出さない
    expect(within(metricOf("review.fix-rounds")).queryByText("この指標で測れないもの")).toBeNull();
  });

  it("指標のない観点に「指標なし」の札と、振り返りで提案して承認すると出ることの 1 行を出す", async () => {
    mount(retroClient());
    await screen.findByText("コミットの仕方");
    const cost = within(perspectiveOf("cost"));
    expect(cost.getByText("指標なし").classList.contains("badge")).toBe(true);
    expect(cost.getByText("指標は振り返りで提案し、人が承認するとここに出る")).toBeTruthy();
    expect(within(perspectiveOf("review")).queryByText(/指標は振り返りで提案し/)).toBeNull();
  });

  it("自分のタブには出さない", async () => {
    mount(retroClient());
    await screen.findByText("コミットの仕方");
    fireEvent.click(tabOf("自分"));
    expect(screen.queryByRole("region", { name: "振り返り" })).toBeNull();
  });

  it("検索は観点の名前・問いと指標の ID・数え方・出どころ・測れないものに当たり、当たった指標の「詳しく」を開いて出す", async () => {
    mount(retroClient());
    await screen.findByText("コミットの仕方");
    const search = screen.getByLabelText("設定を検索");
    const shown = () => ({
      perspectives: [...document.querySelectorAll("[data-perspective]")].map((e) =>
        e.getAttribute("data-perspective"),
      ),
      metrics: [...document.querySelectorAll("[data-metric]")].map((e) =>
        e.getAttribute("data-metric"),
      ),
    });
    // 観点の問いに当たる：指標をすべて出し、指標の「詳しく」は閉じたまま
    fireEvent.change(search, { target: { value: "マージの前" } });
    expect(shown()).toEqual({
      perspectives: ["review"],
      metrics: ["review.first-pass-rate", "review.fix-rounds"],
    });
    expect(moreOf("review.first-pass-rate").open).toBe(false);
    // 観点の名前（指標のない観点）
    fireEvent.change(search, { target: { value: "コスト" } });
    expect(shown()).toEqual({ perspectives: ["cost"], metrics: [] });
    // 指標の出どころ・ID・数え方の 2 文目・測れないものに当たる：当たった指標だけを、「詳しく」を開いて出す
    for (const [query, key] of [
      ["GH PR", "review.fix-rounds"],
      ["first-pass", "review.first-pass-rate"],
      ["Run を数える", "review.first-pass-rate"],
      ["見逃した", "review.first-pass-rate"],
    ] as const) {
      fireEvent.change(search, { target: { value: query } });
      expect(shown()).toEqual({ perspectives: ["review"], metrics: [key] });
      expect(moreOf(key).open).toBe(true);
    }
    // どれにも当たらなければ節を出さない
    fireEvent.change(search, { target: { value: "見つからない" } });
    expect(screen.queryByRole("region", { name: "振り返り" })).toBeNull();
    expect(screen.getByText("該当する設定がない")).toBeTruthy();
    // 設定の項目に当たらず振り返りだけに当たるときは「該当する設定がない」を出さない
    fireEvent.change(search, { target: { value: "見逃した" } });
    expect(screen.queryByText("該当する設定がない")).toBeNull();
    // 検索を消すと畳む
    fireEvent.change(search, { target: { value: "" } });
    expect(moreOf("review.first-pass-rate").open).toBe(false);
  });

  it("要約は数え方の最初の文（「。」か英語の「. 」の先に来る方まで）、文の終わりがなければ全文", () => {
    expect(metricSummary("一文目。二文目。")).toBe("一文目。");
    expect(metricSummary("句点のない文")).toBe("句点のない文");
    expect(metricSummary("Share of tickets. Count the runs. More.")).toBe("Share of tickets.");
    expect(metricSummary("One sentence only.")).toBe("One sentence only.");
    // 文の中の「.」（版や小数）は文の終わりとみなさない
    expect(metricSummary("Runs of v1.2 per ticket")).toBe("Runs of v1.2 per ticket");
    expect(metricSummary("英語の文 like this. と混ざる。")).toBe("英語の文 like this.");
  });

  it("英語の表示では節の文字列を英語の訳で出す（観点の名前と問いは書いたまま）", async () => {
    setLanguage("en");
    try {
      mount(retroClient());
      await screen.findByText("Commit mode");
      const s = screen.getByRole("region", { name: "Retro" });
      expect(within(s).getByText("Metrics: 2")).toBeTruthy();
      expect(within(s).getByText("No metrics")).toBeTruthy();
      expect(within(s).getByText("コスト")).toBeTruthy();
    } finally {
      setLanguage("ja");
    }
  });

  describe("既定の観点の訳（t939）", () => {
    const DEFAULTS = defaultConfig().retro.perspectives;
    const jaOf = (text: string) => DEFAULT_VALUES[text]!.ja!;
    /**
     * outcome・review は既定のまま（review は指標を持つ）。spec は名前だけ、cost は問いだけを書き換えた観点。
     * flow は既定にない ID で、名前と問いが既定の outcome と同じ文の観点
     */
    const perspectives = (): Record<string, RetroPerspective> => ({
      outcome: structuredClone(DEFAULTS["outcome"]!),
      review: { ...structuredClone(DEFAULTS["review"]!), metrics: RETRO["review"]!.metrics },
      spec: { ...structuredClone(DEFAULTS["spec"]!), name: "Ticket quality" },
      cost: { ...structuredClone(DEFAULTS["cost"]!), question: "Where did the tokens go?" },
      flow: structuredClone(DEFAULTS["outcome"]!),
    });
    const client = () => {
      const { client, config } = configClient();
      Object.assign(config, { retro: { perspectives: perspectives() } });
      return client;
    };
    const rows = () =>
      [...document.querySelectorAll("[data-perspective]")].map((e) => [
        e.getAttribute("data-perspective"),
        e.querySelector(".config-name")!.textContent,
        e.querySelector(".config-retro-question")!.textContent,
      ]);

    it("既定の 7 観点は名前と問いのどちらも日本語の訳を持つ", () => {
      expect(Object.keys(DEFAULTS)).toHaveLength(7);
      for (const [id, p] of Object.entries(DEFAULTS)) {
        expect(DEFAULT_VALUES[p.name]?.ja, id).toBeTruthy();
        expect(DEFAULT_VALUES[p.question]?.ja, id).toBeTruthy();
      }
    });

    it("日本語の表示では、名前と問いの両方が既定のままの観点を日本語の訳で出し、片方でも書き換えた観点と既定にない観点は書いたまま出す", async () => {
      mount(client());
      await screen.findByText("コミットの仕方");
      const d = DEFAULTS;
      expect(rows()).toEqual([
        ["outcome", "成果", jaOf(d["outcome"]!.question)],
        ["review", "見直しの効き目", jaOf(d["review"]!.question)],
        // 名前だけ書き換えた：問いも訳さない
        ["spec", "Ticket quality", d["spec"]!.question],
        // 問いだけ書き換えた：名前も訳さない
        ["cost", "Cost", "Where did the tokens go?"],
        // 既定にない ID：同じ文でも既定とみなさない
        ["flow", "Outcome", d["outcome"]!.question],
      ]);
      // 指標を持つ観点も、名前と問いが既定のままなら訳す（指標の定義は訳さない）
      expect(perspectiveOf("review").querySelector(".config-retro-count")!.textContent).toBe(
        "指標 2",
      );
      // 検索は出している文（訳）に当てる
      fireEvent.change(screen.getByLabelText("設定を検索"), { target: { value: "成果" } });
      expect(rows().map((r) => r[0])).toEqual(["outcome"]);
    });

    it("英語の表示では、既定のままの観点を core の英語の文のまま出す", async () => {
      setLanguage("en");
      try {
        mount(client());
        await screen.findByText("Commit mode");
        const d = DEFAULTS;
        expect(rows().slice(0, 2)).toEqual([
          ["outcome", "Outcome", d["outcome"]!.question],
          ["review", "Review effectiveness", d["review"]!.question],
        ]);
      } finally {
        setLanguage("ja");
      }
    });

    it("shownRetroPerspectives は既定を渡さなければ（古い応答）、どの観点も書いたまま返す", () => {
      const written = perspectives();
      expect(shownRetroPerspectives(written, {})).toEqual(written);
    });

    it("名前か問いを書き換えた観点と既定にない観点に、ほかの項目と同じ左の線と「変更あり」の札を付け、既定のままの観点には付けない", async () => {
      mount(client());
      await screen.findByText("コミットの仕方");
      const marks = () =>
        [...document.querySelectorAll<HTMLElement>("[data-perspective]")].map((e) => [
          e.getAttribute("data-perspective"),
          e.classList.contains("modified"),
          e.querySelector(".config-modified")?.textContent ?? null,
        ]);
      expect(marks()).toEqual([
        ["outcome", false, null],
        // 指標を足しても、名前と問いが既定のままなら変更なし（既定の観点は指標を持たない）
        ["review", false, null],
        ["spec", true, "変更あり"],
        ["cost", true, "変更あり"],
        ["flow", true, "変更あり"],
      ]);
      // 札の title に既定（表示言語の訳）を出し、既定にない観点はそう出す
      const title = (id: string) =>
        perspectiveOf(id).querySelector(".config-modified")!.getAttribute("title");
      expect(title("spec")).toBe(
        `既定は ${jaOf(DEFAULTS["spec"]!.name)}: ${jaOf(DEFAULTS["spec"]!.question)}`,
      );
      expect(title("flow")).toBe("既定にない観点");
    });

    it("retroChanges は既定を渡さなければ（古い応答）どの観点にも印を付けない", () => {
      expect(retroChanges(perspectives(), {})).toEqual({});
      expect(Object.keys(retroChanges(perspectives(), DEFAULTS))).toEqual(["spec", "cost", "flow"]);
    });
  });
});
