// データのリモートをなしにする判定（data-remote-none.ts）。git を読まない関数なので、組み合わせをここで網羅する（t1206）

import { describe, expect, it } from "vitest";
import {
  dataRemoteNameOf,
  dataTargetOf,
  NO_DATA_REMOTE,
  overlayLocalConfig,
  defaultConfig,
} from "../model/config.js";
import { missingDataRemote } from "../git/repo.js";
import {
  decideDataRemoteNone,
  initDataRemoteProblem,
  initNoneRecord,
  initNotes,
} from "./data-remote-none.js";

describe("データのリモートの決め方（dataRemoteNameOf）", () => {
  it("git.data_remote が none なら null、空ならコードのリモート、名前ならその名前", () => {
    const of = (data_remote: string) =>
      dataRemoteNameOf({ git: { remote: "origin", data_remote } });
    expect(of(NO_DATA_REMOTE)).toBeNull();
    expect(of("")).toBe("origin");
    expect(of("data")).toBe("data");
    expect(
      dataTargetOf({ git: { remote: "origin", data_remote: "none", data_branch: "kanban" } }),
    ).toEqual({ remote: null, branch: "kanban" });
  });

  it("個人の設定の none はチームの名前に勝ち、個人の名前はチームの none に勝つ", () => {
    const team = (data_remote: string) => {
      const config = defaultConfig();
      config.git.data_remote = data_remote;
      return config;
    };
    const overlaid = (teamValue: string, local: Record<string, unknown>) =>
      dataRemoteNameOf(overlayLocalConfig(team(teamValue), local).config);
    expect(overlaid("data", { "git.data_remote": "none" })).toBeNull();
    expect(overlaid("none", { "git.data_remote": "data" })).toBe("data");
    expect(overlaid("none", {})).toBeNull();
  });

  it("none は名指しではないので、リモートがなくても「名指ししたリモートがない」とみなさない", () => {
    const missing = (data_remote: string, dataRemote: string | null) =>
      missingDataRemote({ dataRemote }, { git: { data_remote } });
    expect(missing("none", null)).toBeUndefined();
    expect(missing("", null)).toBeUndefined();
    expect(missing("data", null)).toBe("data");
    expect(missing("data", "data")).toBeUndefined();
  });
});

describe("dg init の判定", () => {
  it("--no-data-remote と --data-remote の併用と、none という名前のデータのリモートは誤り", () => {
    expect(initDataRemoteProblem({})).toBeUndefined();
    expect(initDataRemoteProblem({ dataRemote: "data" })).toBeUndefined();
    expect(initDataRemoteProblem({ noDataRemote: true })).toBeUndefined();
    expect(initDataRemoteProblem({ noDataRemote: false, dataRemote: "data" })).toBeUndefined();
    expect(initDataRemoteProblem({ noDataRemote: true, dataRemote: "data" })).toMatch(
      /cannot be given together/,
    );
    expect(initDataRemoteProblem({ dataRemote: "none" })).toMatch(/--no-data-remote/);
  });

  it("none を書く先は、新しいボードならチームの config、既にあるボードなら個人の設定で、既になしなら書かない", () => {
    const cases: Array<[boolean, boolean, boolean, "team" | "local" | null]> = [
      // noDataRemote, newConfig, configuredNone, 書く先
      [true, true, false, "team"],
      [true, true, true, "team"],
      [true, false, false, "local"],
      [true, false, true, null],
      [false, true, false, null],
      [false, true, true, null],
      [false, false, false, null],
      [false, false, true, null],
    ];
    for (const [noDataRemote, newConfig, configuredNone, want] of cases)
      expect(initNoneRecord({ noDataRemote, newConfig, configuredNone })).toBe(want);
  });

  const base = {
    noDataRemote: false,
    teamNone: false,
    newConfig: false,
    pushedTo: null,
    sharedOn: null,
  };
  const pushedTo = { remote: "origin", branch: "deguboard" };

  it("新しいボードをリモートへ push したときだけ、リモートを読める人なら誰でも読めることと --no-data-remote を伝える", () => {
    const notes = initNotes({ ...base, newConfig: true, pushedTo });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/pushed to origin\/deguboard: anyone who can read origin can read/);
    expect(notes[0]).toMatch(/dg init --no-data-remote/);
    expect(notes[0]).toMatch(/git push origin --delete deguboard/);
    // push しなかった新しいボード（リモートがない・届かない）と、既にあるボード（2 回目の init・取り込んだ clone）には出さない
    expect(initNotes({ ...base, newConfig: true })).toEqual([]);
    expect(initNotes({ ...base, pushedTo })).toEqual([]);
    expect(initNotes(base)).toEqual([]);
  });

  it("--no-data-remote のときは、git push --all・--mirror で出ることと、none のある場所に合う共有への戻し方を伝える", () => {
    const team = initNotes({ ...base, noDataRemote: true, teamNone: true, newConfig: true });
    expect(team).toHaveLength(1);
    expect(team[0]).toMatch(/git push --all and git push --mirror still send/);
    expect(team[0]).toMatch(/dg config set git\.data_remote "".*then dg sync: the whole history/);
    // 既にあるボードで個人の設定に書いたときは、個人の上書きを消す
    const local = initNotes({ ...base, noDataRemote: true });
    expect(local).toHaveLength(1);
    expect(local[0]).toMatch(/dg config unset git\.data_remote --local, then dg sync/);
  });

  it("--no-data-remote でリモートにボードがあるときは、新しいボードなら別のボードになること、既にあるボードなら排他が効かないことも警告する", () => {
    const separate = initNotes({
      ...base,
      noDataRemote: true,
      teamNone: true,
      newConfig: true,
      sharedOn: "origin/deguboard",
    });
    expect(separate).toHaveLength(2);
    expect(separate[1]).toMatch(/origin\/deguboard already holds a board.*DATA_HISTORY_UNRELATED/);
    const left = initNotes({ ...base, noDataRemote: true, sharedOn: "origin/deguboard" });
    expect(left).toHaveLength(2);
    expect(left[1]).toMatch(/does not keep the others from claiming the same ticket/);
  });
});

describe("dg config set で git.data_remote を none にする判定（decideDataRemoteNone）", () => {
  const facts = { key: "git.data_remote", value: "none", sharedOn: "origin/deguboard" };

  it("データのブランチがリモートにあるボードでは、チームの値を拒んで --local を案内する", () => {
    const decision = decideDataRemoteNone({ ...facts, scope: "team" });
    expect(decision).toMatchObject({
      kind: "reject",
      message: expect.stringContaining("origin/deguboard"),
      hint: expect.stringContaining("dg config set git.data_remote none --local"),
    });
    // リモートにあるデータのブランチは消えないことも伝える
    expect(decision).toMatchObject({ hint: expect.stringContaining("stays there") });
  });

  it("データのブランチがリモートにあるボードでも --local は通し、claim がほかの人を排他しなくなることと戻し方を警告する", () => {
    const decision = decideDataRemoteNone({ ...facts, scope: "local" });
    expect(decision.kind).toBe("allow");
    const warnings = decision.kind === "allow" ? decision.warnings.join("\n") : "";
    expect(warnings).toMatch(/does not keep the others from claiming the same ticket/);
    expect(warnings).toMatch(/dg config unset git\.data_remote --local, then dg sync/);
    expect(warnings).toMatch(/git push --all and git push --mirror/);
  });

  it("データのブランチがリモートにないボードでは、チームの値も個人の設定も通し、範囲に合う戻し方を伝える", () => {
    const team = decideDataRemoteNone({ ...facts, scope: "team", sharedOn: null });
    expect(team).toMatchObject({
      kind: "allow",
      warnings: [expect.stringContaining('dg config set git.data_remote ""')],
    });
    const local = decideDataRemoteNone({ ...facts, scope: "local", sharedOn: null });
    expect(local).toMatchObject({
      kind: "allow",
      warnings: [expect.stringContaining("dg config unset git.data_remote --local")],
    });
  });

  it("ほかの項目・none でない値は、範囲とボードの状態によらず何も決めない", () => {
    for (const scope of ["team", "local"] as const)
      for (const sharedOn of ["origin/deguboard", null]) {
        for (const value of ["", "data", "NONE", undefined, null])
          expect(decideDataRemoteNone({ key: "git.data_remote", value, scope, sharedOn })).toEqual({
            kind: "other",
          });
        // git.remote と git.data_branch は none という名前を禁じない（データのリモートの値ではない）
        for (const key of ["git.remote", "git.data_branch", "commit.mode"])
          expect(decideDataRemoteNone({ key, value: "none", scope, sharedOn })).toEqual({
            kind: "other",
          });
      }
  });
});
