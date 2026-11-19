// 照合が読む事実の導出のうち、読んだ値から決めるだけの判定（ST-4・ST-6、ADR-028）。git・gh を読まない（import は型だけ）。
// 作業ブランチの先端が base を取り込んだだけのマージコミット（の連なり）かの判定（RN-10）もここに置く（値を読むのは tip-merge.ts）。
// 値を読むのは facts.ts で、読んだ値をここへ渡す。判定の組み合わせは facts-judge.test.ts が git・gh なしで確かめ、
// git を通すテスト（facts.test.ts・commands-flow-reconcile.test.ts）は経路の代表だけを見る

import type { Status } from "../model/common.js";

/** branch_merged を決める材料（祖先かどうかのほか） */
export interface BranchMergeInput {
  /** 作業ブランチの先端の SHA（リモートの追跡ブランチがあればその先端、なければローカルの先端）。ref がどちらにもなければ undefined */
  tip: string | undefined;
  /** 照合の base の先端の SHA。base の ref がなければ undefined */
  base: string | undefined;
  /** リモートの追跡ブランチがあるか（branch_pushed）。リモートを持たないリポジトリでは undefined */
  pushed: boolean | undefined;
  /** claim が記録した作業ブランチの起点の SHA（`branch_base`）。なければ見ない */
  start: string | undefined;
  /** チケットの今の Status。渡さないとき（遷移の検査など）は祖先かだけで決める */
  status: Status | undefined;
}

/** branch_merged を決める材料のすべて */
export interface BranchMergeFacts extends BranchMergeInput {
  /**
   * 先端が base の祖先か（`git merge-base --is-ancestor`）。branchAncestryNeeded が偽のときは読まずに undefined、
   * 読んだが git が答えなかったときも undefined
   */
  ancestor: boolean | undefined;
}

/**
 * 先端を見るまでもなく作業がないとみなすか。
 * 先端が base と同じなら、切ったばかりで作業のないブランチとみなす。ff マージの直後も同じ形になるが、
 * base が進めば真の祖先になり、PR があれば pr_merged で先に拾える。
 * 先端が base の真の祖先でも、commit のないブランチは base が進めば同じ形になる（グラフだけでは ff マージと区別できない）。
 * in_progress で push していないブランチはまだ作業がないとみなす。push した後は、claim が記録した起点（start）と
 * 先端が同じなら作業がないとみなす（t764）。claim はブランチをその起点から切るので、claim の後に人が別の起点から
 * 切り直した形だけが拾えない（受け入れる）。起点のない前からのチケットは祖先かだけで判定する。先端のコミット日時と
 * branch_at を比べると PC ごとの時計のずれで判定が変わるので採らない。push せずローカルで ff マージした形は拾えない
 */
function unworked(input: BranchMergeInput & { tip: string; base: string }): boolean {
  return (
    input.tip === input.base ||
    (input.status === "in_progress" && input.pushed === false) ||
    (input.start !== undefined && input.tip === input.start)
  );
}

/** branch_merged を決めるのに、先端が base の祖先かを git に聞く要があるか（要らなければ facts.ts は聞かない） */
export function branchAncestryNeeded(input: BranchMergeInput): boolean {
  return (
    input.tip !== undefined &&
    input.base !== undefined &&
    !unworked({ ...input, tip: input.tip, base: input.base })
  );
}

/**
 * branch_merged の値。決められなければ undefined（事実を置かない＝不明。ST-5）。
 * base がなければ不明、ブランチがなければマージ済みとは言えないので偽（消えたブランチは照合が警告する）。
 * 作業がないとみなす形は偽、ほかは祖先かどうかで決める
 */
export function judgeBranchMerged(facts: BranchMergeFacts): boolean | undefined {
  if (facts.base === undefined) return undefined;
  if (facts.tip === undefined) return false;
  if (unworked({ ...facts, tip: facts.tip, base: facts.base })) return false;
  return facts.ancestor;
}

/** マージコミットの親と、そのうち base のコミットであるもの */
export interface MergeParents {
  /** 親の SHA（順に） */
  parents: readonly string[];
  /** 親のうち base のコミット（base の先端かその祖先）であるもの */
  onBase: readonly string[];
}

/**
 * 作業ブランチのリモートの先端がマージコミットのときの事実（先端が親を 2 つ以上持つときだけ読む。tip-merge.ts）。
 * base を取り込んだだけの更新かを決める材料（RN-10）。parents と onBase は先端のもの
 */
export interface TipMerge extends MergeParents {
  /**
   * 先端の base でない親から、base でない親を順に辿って読んだマージコミット（先端に近い順。先端は含まない）。
   * base を 2 回以上取り込んだ先端で、取り込みの連なりの先の見直した SHA に着くために読む。
   * 辿るのをやめる場所は nextInBaseMergeChain が決める
   */
  earlier: ReadonlyArray<MergeParents & { sha: string }>;
  /** 先端の tree */
  tree: string;
  /**
   * 連なりの先（baseMergeChain の work）に、先端の base の親を 1 回だけ自動でマージした結果の tree。
   * 競合した・作れなかったとき、作らなかったとき（連なりが baseMergeChain の形でない・その先を見直した見直しがない）は null
   */
  autoTree: string | null;
}

/**
 * マージコミットの親が「作業の先端と base のコミット」の形なら、その組（work は base でない親、base は base の親）。
 * 親がちょうど 2 つで、片方だけが base のコミットのときだけ。親の順は問わない。
 * 両方が base のコミット（作業が base に入った後）・どちらも違う（別のブランチのマージ）・親が 3 つ以上は undefined
 */
export function baseMergeParents(merge: MergeParents): { work: string; base: string } | undefined {
  if (merge.parents.length !== 2) return undefined;
  const [a, b] = merge.parents as [string, string];
  const aOnBase = merge.onBase.includes(a);
  const bOnBase = merge.onBase.includes(b);
  if (aOnBase === bOnBase) return undefined;
  return aOnBase ? { work: b, base: a } : { work: a, base: b };
}

/**
 * 先端から base だけを取り込んだマージコミットが続くなら、その連なりの先（work：最後のマージコミットの base でない親）と、
 * 先端が取り込んだ base のコミット（base：先端の base の親）。先端と earlier のどれもが baseMergeParents の形で、
 * それぞれが前のマージコミットの base でない親であるときだけ。途中に別のブランチのマージがある・つながっていないなら undefined。
 * 途中のマージコミットが取り込んだ base のコミットは返さない：見直した SHA に今の base を 1 回マージした結果と先端の tree を
 * 比べれば、途中の取り込みで競合を手で解いた・変更を混ぜたものも tree の違いに出る（段ごとのマージと一括のマージで
 * tree が違う場合も数えない側に倒れる）
 */
export function baseMergeChain(
  merge: Pick<TipMerge, "parents" | "onBase" | "earlier">,
): { work: string; base: string } | undefined {
  const tip = baseMergeParents(merge);
  if (!tip) return undefined;
  let work = tip.work;
  for (const commit of merge.earlier) {
    const pair = commit.sha === work ? baseMergeParents(commit) : undefined;
    if (!pair) return undefined;
    work = pair.work;
  }
  return { work, base: tip.base };
}

/**
 * 取り込みの連なりをさらに辿るために次に読むコミットの SHA（tip-merge.ts が読んで earlier に足す）。辿らないなら undefined：
 * 連なりの先が見直した SHA（reviewed）に着いた・連なりが baseMergeChain の形でなくなった。
 * 返した SHA がマージコミットでなければ、読む側はそこで止める（取り込みの後の別のコミット・rebase は見直しに着かない）
 */
export function nextInBaseMergeChain(
  merge: Pick<TipMerge, "parents" | "onBase" | "earlier">,
  reviewed: readonly string[],
): string | undefined {
  const end = baseMergeChain(merge);
  return end && !reviewed.includes(end.work) ? end.work : undefined;
}

/**
 * 先端が base を取り込んだだけのマージコミット（の連なり）なら、取り込む前の作業の先端の SHA（その SHA の見直しを先端の見直しとして数える）。
 * 連なりが baseMergeChain の形で、先端の tree が自動マージの結果と同じときだけ。競合を手で解いた・マージに変更を混ぜた
 * （tree が違う）・自動マージの結果がない（null）は undefined。rebase と、取り込みの後に積んだコミットは、
 * 連なりがこの形でないので数えない
 */
export function mergedBaseOnto(merge: TipMerge | undefined): string | undefined {
  if (!merge || merge.autoTree === null || merge.autoTree !== merge.tree) return undefined;
  return baseMergeChain(merge)?.work;
}

/** 前の作業の PR かを決める PR の値（gh pr view の結果のうち） */
interface PrOrigin {
  /** gh の state（OPEN・MERGED・CLOSED） */
  state: string;
  /** PR の作成時刻（ISO）。読めなければ undefined */
  createdAt: string | undefined;
}

/**
 * ブランチ名で引いた PR を、同じブランチ名で出した前の作業の PR とみなして外すか（ST-6、t206・t747）。
 * ブランチを記録する前（`branchAt` より前）に作られ、開いていない PR（マージ済みも閉じたものも）は前の作業のもの。
 * 開いたままの PR は、記録より前に作られても今の作業の PR として使う（手放して claim し直した後も続けられるように）。
 * 記録した番号で引いた PR（`recorded`）・ブランチの記録の時刻がない・作成の時刻が読めないときは外さない
 */
export function isEarlierWorkPr(
  pr: PrOrigin,
  ticket: { recorded: boolean; branchAt: string | undefined },
): boolean {
  return (
    !ticket.recorded &&
    ticket.branchAt !== undefined &&
    pr.state !== "OPEN" &&
    pr.createdAt !== undefined &&
    Date.parse(pr.createdAt) < Date.parse(ticket.branchAt)
  );
}
