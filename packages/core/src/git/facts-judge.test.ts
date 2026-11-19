// 照合が読む事実の判定（branch_merged と前の作業の PR）の組み合わせを、git・gh なしで確かめる。
// 値を読む経路（ref と SHA の読み方、merge-base を聞くか、gh の呼び方、警告と記録）は facts.test.ts と
// commands-flow-reconcile.test.ts の代表の件が見る
import { describe, expect, it } from "vitest";
import type { Status } from "../model/common.js";
import {
  baseMergeParents,
  branchAncestryNeeded,
  isEarlierWorkPr,
  judgeBranchMerged,
  mergedBaseOnto,
  type BranchMergeFacts,
  type TipMerge,
} from "./facts-judge.js";

const BASE = "b".repeat(40);
const TIP = "c".repeat(40);
const START = "d".repeat(40);

/** branch_merged の材料。既定は、起点から作業を積んで push した in_progress のブランチで、base の祖先ではない */
const branch = (over: Partial<BranchMergeFacts> = {}): BranchMergeFacts => ({
  tip: TIP,
  base: BASE,
  pushed: true,
  start: START,
  status: "in_progress",
  ancestor: false,
  ...over,
});

/** 祖先を聞いた後の値（聞かない形なら ancestor を渡さずに決める） */
const judge = (facts: BranchMergeFacts): boolean | undefined =>
  judgeBranchMerged(branchAncestryNeeded(facts) ? facts : { ...facts, ancestor: undefined });

describe("branch_merged の判定", () => {
  it("base がなければ不明（事実を置かない）で、祖先を聞かない", () => {
    for (const tip of [TIP, undefined]) {
      const facts = branch({ tip, base: undefined, ancestor: true });
      expect(branchAncestryNeeded(facts)).toBe(false);
      expect(judgeBranchMerged(facts)).toBeUndefined();
    }
  });

  it("ブランチの ref がどこにもなければ、マージ済みとは言えないので偽で、祖先を聞かない", () => {
    const facts = branch({ tip: undefined, ancestor: true });
    expect(branchAncestryNeeded(facts)).toBe(false);
    expect(judgeBranchMerged(facts)).toBe(false);
  });

  it("先端が base と同じ（切ったばかり・ff マージの直後）は、Status と push に関わらず偽で、祖先を聞かない", () => {
    const statuses: Array<Status | undefined> = ["in_progress", "review", undefined];
    for (const status of statuses)
      for (const pushed of [true, false, undefined]) {
        const facts = branch({ tip: BASE, status, pushed, start: undefined, ancestor: true });
        expect(branchAncestryNeeded(facts)).toBe(false);
        expect(judgeBranchMerged(facts)).toBe(false);
      }
  });

  it("in_progress で push していないブランチは、祖先でも作業がないとみなして偽（t38）", () => {
    const facts = branch({ pushed: false, start: undefined, ancestor: true });
    expect(branchAncestryNeeded(facts)).toBe(false);
    expect(judgeBranchMerged(facts)).toBe(false);
  });

  it("push していなくても in_progress のほか（review・Status を渡さない）は祖先かで決める（ローカルで ff マージした形）", () => {
    for (const status of ["review", undefined] as const) {
      expect(branchAncestryNeeded(branch({ status, pushed: false }))).toBe(true);
      expect(judge(branch({ status, pushed: false, ancestor: true }))).toBe(true);
      expect(judge(branch({ status, pushed: false, ancestor: false }))).toBe(false);
    }
  });

  it("リモートを持たないリポジトリ（pushed が undefined）の in_progress は祖先かで決める", () => {
    expect(judge(branch({ pushed: undefined, ancestor: true }))).toBe(true);
  });

  it("先端が記録した起点と同じなら、push して main が進み祖先になっても作業がないとみなして偽（t764）", () => {
    const facts = branch({ tip: START, ancestor: true });
    expect(branchAncestryNeeded(facts)).toBe(false);
    expect(judgeBranchMerged(facts)).toBe(false);
  });

  it("起点を記録していない前からのチケットは、コミットのないブランチでも祖先かだけで決める（t764）", () => {
    expect(judge(branch({ tip: START, start: undefined, ancestor: true }))).toBe(true);
  });

  it("作業を積んで push し ff マージしたブランチは、起点を記録していても main が進めば真（t764）", () => {
    expect(judge(branch({ ancestor: true }))).toBe(true);
  });

  it("作業がある形は祖先かで決め、git が答えなかった（undefined）ときは不明", () => {
    expect(branchAncestryNeeded(branch())).toBe(true);
    expect(judgeBranchMerged(branch({ ancestor: true }))).toBe(true);
    expect(judgeBranchMerged(branch({ ancestor: false }))).toBe(false);
    expect(judgeBranchMerged(branch({ ancestor: undefined }))).toBeUndefined();
  });
});

describe("前の作業の PR を外す判定", () => {
  const BRANCH_AT = "2026-11-02T05:00:00Z";
  const BEFORE = "2026-10-31T10:00:00Z";
  const AFTER = "2026-11-02T06:30:00Z";
  const byBranch = { recorded: false, branchAt: BRANCH_AT };

  it("ブランチ名で引いて、記録より前に作られ開いていない PR（マージ済みも閉じたものも）は外す（t206・t747）", () => {
    for (const state of ["MERGED", "CLOSED"])
      expect(isEarlierWorkPr({ state, createdAt: BEFORE }, byBranch)).toBe(true);
  });

  it("開いたままの PR は、記録より前に作られていても今の作業の PR として使う（t747）", () => {
    expect(isEarlierWorkPr({ state: "OPEN", createdAt: BEFORE }, byBranch)).toBe(false);
  });

  it("記録の後に作られた PR は、マージ済みも閉じたものも使う（同じ名前で claim し直して出した新しい PR。t206・t747）", () => {
    for (const state of ["MERGED", "CLOSED", "OPEN"])
      expect(isEarlierWorkPr({ state, createdAt: AFTER }, byBranch)).toBe(false);
  });

  it("記録した時刻と同じ時刻に作られた PR は外さない（より前のものだけ外す）", () => {
    expect(isEarlierWorkPr({ state: "MERGED", createdAt: BRANCH_AT }, byBranch)).toBe(false);
  });

  it("記録した番号で引いた PR・ブランチの記録の時刻がない・作成の時刻が読めないときは外さない", () => {
    const old = { state: "MERGED", createdAt: BEFORE };
    expect(isEarlierWorkPr(old, { recorded: true, branchAt: BRANCH_AT })).toBe(false);
    expect(isEarlierWorkPr(old, { recorded: false, branchAt: undefined })).toBe(false);
    expect(isEarlierWorkPr({ state: "MERGED", createdAt: undefined }, byBranch)).toBe(false);
  });
});

describe("base を取り込んだだけのマージコミットの判定（RN-10）", () => {
  const WORK = "1".repeat(40);
  const MAIN = "2".repeat(40);
  const THIRD = "3".repeat(40);
  const TREE = "e".repeat(40);
  const OTHER_TREE = "f".repeat(40);
  /** 既定は、作業の先端（WORK）に base のコミット（MAIN）を取り込み、tree が自動マージの結果と同じマージコミット */
  const merge = (over: Partial<TipMerge> = {}): TipMerge => ({
    parents: [WORK, MAIN],
    onBase: [MAIN],
    tree: TREE,
    autoTree: TREE,
    ...over,
  });

  it("親が 2 つで片方だけが base のコミットなら、base でない親を作業の先端とする。親の順は問わない", () => {
    expect(baseMergeParents(merge())).toEqual({ work: WORK, base: MAIN });
    expect(baseMergeParents(merge({ parents: [MAIN, WORK] }))).toEqual({ work: WORK, base: MAIN });
  });

  it("どちらの親も base のコミットでない・両方が base のコミット・親が 2 つでないなら、その形でない", () => {
    expect(baseMergeParents(merge({ onBase: [] }))).toBeUndefined();
    expect(baseMergeParents(merge({ onBase: [WORK, MAIN] }))).toBeUndefined();
    expect(baseMergeParents(merge({ parents: [WORK, MAIN, THIRD] }))).toBeUndefined();
    expect(baseMergeParents(merge({ parents: [WORK], onBase: [] }))).toBeUndefined();
    // base のコミットとして挙がった SHA が親にない
    expect(baseMergeParents(merge({ onBase: [THIRD] }))).toBeUndefined();
  });

  it("tree が自動マージの結果と同じなら、取り込む前の作業の先端を返す", () => {
    expect(mergedBaseOnto(merge())).toBe(WORK);
    expect(mergedBaseOnto(merge({ parents: [MAIN, WORK] }))).toBe(WORK);
  });

  it("マージコミットでない・tree が自動マージの結果と違う（競合を手で解いた）・自動マージの結果がない・親の形が違うなら返さない", () => {
    const cases: Array<TipMerge | undefined> = [
      undefined,
      merge({ tree: OTHER_TREE }),
      merge({ autoTree: null }),
      merge({ onBase: [] }),
      merge({ onBase: [WORK, MAIN] }),
      merge({ parents: [WORK, MAIN, THIRD] }),
    ];
    for (const c of cases) expect(mergedBaseOnto(c)).toBeUndefined();
  });
});
