import type { SetupCheckItem, SetupCheckResult } from "@deguboard/core";
import { describe, expect, it } from "vitest";
import {
  autoRecheck,
  buildSetupView,
  dgCommandItem,
  PATH_EXPORT_LINE,
  setupCommands,
  skillsHooksCommands,
  supportedPlatform,
  type DgCommandFacts,
} from "./setup.js";

const LINK = "/home/u/.local/bin/dg";

/** dg コマンドの項目の事実。省けば、PATH に dg がなく ~/.local/bin/dg もない */
function dgFacts(partial: Partial<DgCommandFacts> = {}): DgCommandFacts {
  return {
    lookup: { kind: "missing" },
    coreVersion: "1.4.0",
    link: { kind: "none" },
    linkPath: LINK,
    binOnPath: false,
    ...partial,
  };
}

/** core の dg setup check の 1 項目。省けば満たしている */
function coreItem(
  id: SetupCheckItem["id"],
  level: SetupCheckItem["level"],
  partial: Partial<SetupCheckItem> = {},
): SetupCheckItem {
  return {
    id,
    label: id === "gitignore" ? ".claude/.gitignore" : id,
    level,
    status: "ok",
    message: "",
    fix: [],
    ...partial,
  };
}

/** core の dg setup check の結果。changes で項目を書き換える。ready は必須の項目から求める */
function coreResult(
  changes: Partial<Record<SetupCheckItem["id"], Partial<SetupCheckItem>>> = {},
): SetupCheckResult {
  const items = [
    coreItem("git", "required", changes.git),
    coreItem("repository", "required", changes.repository),
    coreItem("board", "required", changes.board),
    coreItem("skills_hooks", "recommended", changes.skills_hooks),
    coreItem("gitignore", "recommended", changes.gitignore),
  ];
  return {
    ready: items.every((i) => i.level !== "required" || i.status === "ok"),
    items,
  };
}

const statuses = (view: { items: { id: string; status: string }[] }) =>
  view.items.map((i) => [i.id, i.status]);

describe("dg コマンドの項目（PATH の dg。UI-11）", () => {
  it("PATH に dg があり、メジャー版が拡張と同じなら満たす。読めない版は比べられないので満たすとする", () => {
    expect(dgCommandItem(dgFacts({ lookup: { kind: "found", version: "1.9.0" } }))).toMatchObject({
      status: "ok",
      value: "1.9.0",
    });
    expect(dgCommandItem(dgFacts({ lookup: { kind: "found", version: "dev" } })).status).toBe("ok");
  });

  it("メジャー版が拡張と違えば満たさず、両方の版を返す（通知の代わりに項目で示す）", () => {
    expect(dgCommandItem(dgFacts({ lookup: { kind: "found", version: "2.0.1" } }))).toMatchObject({
      status: "unmet",
      state: "major_mismatch",
      params: { version: "2.0.1", core: "1.4.0" },
    });
  });

  it("dg --version が失敗したら、その出力を返す", () => {
    expect(
      dgCommandItem(dgFacts({ lookup: { kind: "error", detail: "needs Node.js 24" } })),
    ).toMatchObject({ status: "unmet", state: "error", detail: "needs Node.js 24" });
  });

  it("PATH に dg がなく ~/.local/bin/dg もなければ missing（入れるボタンを出す）", () => {
    expect(dgCommandItem(dgFacts())).toMatchObject({
      status: "unmet",
      state: "missing",
      fix: [],
      params: { link: LINK },
    });
  });

  it("~/.local/bin/dg を張ってあるのに ~/.local/bin が PATH になければ not_on_path で、PATH に足す 1 行を返す", () => {
    expect(dgCommandItem(dgFacts({ link: { kind: "ours" } }))).toMatchObject({
      status: "unmet",
      state: "not_on_path",
      fix: [PATH_EXPORT_LINE],
      params: { link: LINK, dir: "/home/u/.local/bin" },
    });
    // PATH にあるのに動かない（起動ファイルがないなど）ときは、入れ直せるよう missing にする
    expect(dgCommandItem(dgFacts({ link: { kind: "ours" }, binOnPath: true })).state).toBe(
      "missing",
    );
  });

  it("~/.local/bin/dg がほかの dg か通常のファイルなら occupied で、張り先があれば返す", () => {
    expect(dgCommandItem(dgFacts({ link: { kind: "other", target: "/src/dg.js" } }))).toMatchObject(
      { state: "occupied", params: { link: LINK, target: "/src/dg.js" } },
    );
    expect(dgCommandItem(dgFacts({ link: { kind: "other" } })).params).toEqual({ link: LINK });
  });
});

describe("画面に渡す導入のチェックリスト（UI-12）", () => {
  it("フォルダ・OS・git・Git リポジトリ・ボード・Skill と hooks・dg コマンド・.gitignore の順に並べ、すべて満たせば ready", () => {
    const view = buildSetupView({
      folder: "/work/repo",
      platform: "linux",
      core: coreResult(),
      dg: dgFacts({ lookup: { kind: "found", version: "1.4.0" } }),
    });
    expect(statuses(view)).toEqual([
      ["folder", "ok"],
      ["os", "ok"],
      ["git", "ok"],
      ["repository", "ok"],
      ["board", "ok"],
      ["skills_hooks", "ok"],
      ["dg_command", "ok"],
      ["gitignore", "ok"],
    ]);
    expect(view).toMatchObject({ ready: true, cwd: "/work/repo" });
    expect(view.items[0]).toMatchObject({ level: "required", value: "/work/repo" });
    expect(view.items[6]).toMatchObject({ level: "recommended", value: "1.4.0" });
  });

  it("フォルダを開いていなければフォルダが満たさず、その後は確かめずに待たせる", () => {
    const view = buildSetupView({
      folder: undefined,
      platform: "linux",
      core: undefined,
      dg: undefined,
    });
    expect(view).toMatchObject({ ready: false, cwd: null });
    expect(statuses(view)).toEqual([
      ["folder", "unmet"],
      ["os", "pending"],
      ["git", "pending"],
      ["repository", "pending"],
      ["board", "pending"],
      ["skills_hooks", "pending"],
      ["dg_command", "pending"],
    ]);
  });

  it("Windows では OS が満たさず、その後は確かめずに待たせる", () => {
    expect(supportedPlatform("linux")).toBe(true);
    expect(supportedPlatform("darwin")).toBe(true);
    expect(supportedPlatform("win32")).toBe(false);
    const view = buildSetupView({
      folder: "C:\\work\\repo",
      platform: "win32",
      core: undefined,
      dg: undefined,
    });
    expect(view.ready).toBe(false);
    expect(view.items[1]).toMatchObject({
      id: "os",
      status: "unmet",
      params: { platform: "win32" },
    });
    expect(view.items.slice(2).every((i) => i.status === "pending")).toBe(true);
  });

  it("core の必須の項目を満たさなければ ready でなく、dg コマンドも確かめずに待たせる。core の項目はそのまま渡す", () => {
    const board = { status: "unmet" as const, state: "remote_board" as const, fix: ["dg init"] };
    const view = buildSetupView({
      folder: "/work/repo",
      platform: "linux",
      core: coreResult({
        board,
        skills_hooks: { status: "pending" },
        gitignore: { status: "pending" },
      }),
      // 必須を満たさない間は拡張が確かめないが、渡されても使わない
      dg: dgFacts(),
    });
    expect(view.ready).toBe(false);
    expect(view.items.find((i) => i.id === "board")).toMatchObject(board);
    expect(view.items.find((i) => i.id === "dg_command")?.status).toBe("pending");
  });

  it("必須を満たせば、推奨の項目が欠けていても ready（いつもの画面に変える）", () => {
    const view = buildSetupView({
      folder: "/work/repo",
      platform: "darwin",
      core: coreResult({ skills_hooks: { status: "unmet", fix: ["dg hooks install"] } }),
      dg: dgFacts(),
    });
    expect(view.ready).toBe(true);
    expect(view.items.filter((i) => i.status === "unmet").map((i) => i.id)).toEqual([
      "skills_hooks",
      "dg_command",
    ]);
  });
});

describe("見張りで自動で確かめ直すか", () => {
  const view = (
    core: SetupCheckResult,
    dg = dgFacts({ lookup: { kind: "found", version: "1.4.0" } }),
  ) => buildSetupView({ folder: "/work/repo", platform: "linux", core, dg });

  it("まだ確かめていない・満たさない項目があるときは確かめ直し、すべて満たしていれば確かめ直さない", () => {
    expect(autoRecheck(undefined, false)).toBe(true);
    expect(autoRecheck(view(coreResult()), false)).toBe(false);
    expect(autoRecheck(view(coreResult({ repository: { status: "unmet" } })), false)).toBe(true);
    expect(autoRecheck(view(coreResult({ skills_hooks: { status: "unmet" } })), false)).toBe(true);
    expect(autoRecheck(view(coreResult(), dgFacts()), false)).toBe(true);
  });

  it("満たさない最初の項目がボードのときは確かめ直さない（remote に尋ねる確かめを見張りのたびに回さない。dg init はデータ worktree の見張りが拾う）", () => {
    const board = view(coreResult({ board: { status: "unmet", state: "remote_unreachable" } }));
    expect(autoRecheck(board, false)).toBe(false);
    expect(autoRecheck(board, true)).toBe(false);
  });

  it("帯を「このリポジトリでは出さない」にしていて推奨だけが欠けているときは確かめ直さない（ターミナルの実行の終わりとウィンドウに戻るたびに git と dg を起こさない）", () => {
    const recommended = [
      view(coreResult({ skills_hooks: { status: "unmet" } })),
      view(coreResult({ gitignore: { status: "unmet" } })),
      view(coreResult(), dgFacts()),
    ];
    for (const v of recommended) expect(autoRecheck(v, true)).toBe(false);
    // 帯を出さなくても、まだ確かめていない・必須が欠けている間は確かめ直す（チェックリストは出ている）
    expect(autoRecheck(undefined, true)).toBe(true);
    expect(
      autoRecheck(
        view(coreResult({ git: { status: "unmet" }, skills_hooks: { status: "pending" } })),
        true,
      ),
    ).toBe(true);
  });
});

describe("「Skill と hooks を入れる」ボタンが流すコマンド", () => {
  const view = (fix: string[]) =>
    buildSetupView({
      folder: "/work/repo",
      platform: "linux",
      core: coreResult({ skills_hooks: { status: "unmet", fix } }),
      dg: dgFacts(),
    });

  it("最後に確かめた項目の直すコマンドを流し、手を加えた Skill を上書きする --force は除く", () => {
    expect(
      skillsHooksCommands(
        view(["dg hooks install", "dg skill install", "dg skill install --personal --force"]),
      ),
    ).toEqual(["dg hooks install", "dg skill install"]);
    expect(skillsHooksCommands(view(["dg skill install --force"]))).toEqual([]);
  });

  it("確かめた結果がなければ、どちらも入れる", () => {
    expect(skillsHooksCommands(undefined)).toEqual(["dg skill install", "dg hooks install"]);
  });
});

describe("ボタンがターミナルで流すコマンド（setupCommands）", () => {
  const board = { dataRemote: "git@github.com:team/kanban.git", dataBranch: "kanban" };

  it("別のリポジトリのボードを指定していれば、dg init に --data-remote・--data-branch を付ける", () => {
    expect(setupCommands("init", undefined, board)).toEqual([
      "dg init --data-remote git@github.com:team/kanban.git --data-branch kanban",
    ]);
    expect(setupCommands("newBoard", undefined, board)).toEqual([
      "dg init --new-board --data-remote git@github.com:team/kanban.git --data-branch kanban",
    ]);
    // ブランチを省けば --data-branch を付けない（dg init の既定の deguboard）
    expect(setupCommands("init", undefined, { dataRemote: "kanban" })).toEqual([
      "dg init --data-remote kanban",
    ]);
  });

  it("指定していなければ引数を付けない", () => {
    expect(setupCommands("init", undefined)).toEqual(["dg init"]);
    expect(setupCommands("newBoard", undefined)).toEqual(["dg init --new-board"]);
    expect(setupCommands("gitInit", undefined, board)).toEqual(["git init"]);
  });

  it("人が入れた値は、シェルにそのまま渡らないように囲む（ターミナルに 1 行で送るので）", () => {
    expect(
      setupCommands("init", undefined, { dataRemote: "/srv/my repo; rm -rf ~", dataBranch: "a'b" }),
    ).toEqual([`dg init --data-remote '/srv/my repo; rm -rf ~' --data-branch 'a'\\''b'`]);
  });
});
