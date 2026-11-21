// データのリモートをなしにする（git.data_remote: none・dg init --no-data-remote）ときの判定と、利用者に出す文。
// ここの関数は git・ファイルを読まない：事実（データのブランチがデータのリモートにあるか、など）は呼び出し側（setup.ts）が集めて渡す。
// 判定の組み合わせは data-remote-none.test.ts で網羅し、git を通す結合テスト（commands-no-data-remote.test.ts）は経路の代表だけにする

import { NO_DATA_REMOTE } from "../model/config.js";

/** データを共有に戻す操作（文に入れる）。個人の設定でなしにしたなら上書きを消し、チームの値でなしにしたなら空かリモートの名前にする */
function shareAgain(scope: "team" | "local"): string {
  return scope === "local"
    ? "dg config unset git.data_remote --local"
    : `dg config set git.data_remote "" (the code's remote; or a remote's name)`;
}

/**
 * データを手元だけに置くと決めたときの知らせ：dg は送らないが、人の git push --all・--mirror では手元の deguboard ブランチが出ることと、
 * 共有に戻す方法（戻すと、それまでの履歴が丸ごと push される）
 */
export function localOnlyNote(scope: "team" | "local"): string {
  return `The board's data stays on this machine: dg does not fetch or push it (git.data_remote is ${NO_DATA_REMOTE}), and work branches and pull requests still use the code's remote. git push --all and git push --mirror still send the local deguboard branch to a remote, so do not use them in this repository. To share the board later, run ${shareAgain(scope)}, then dg sync: the whole history of the data, including the Run records, is pushed`;
}

/**
 * チームと共有しているボード（データのブランチが target にある）で、このクローンだけデータのリモートをなしにしたときの警告：
 * claim がほかの人を排他しなくなること（push の成功で取得とする仕組みが働かない。SY-3）と、戻し方
 */
export function sharedBoardLeftWarning(target: string): string {
  return `This clone no longer fetches or pushes the board's data, but the team's board is still on ${target} (the data branch there is not deleted): a claim made here does not keep the others from claiming the same ticket, and what is written here does not reach them. To share again, run ${shareAgain("local")}, then dg sync: it takes in the team's changes and pushes what was committed here meanwhile`;
}

/**
 * データのリモートにボードがある（target）のに、--no-data-remote で新しいボードを作ったときの警告：
 * 作ったのは別のボードで、後で共有に戻すと DATA_HISTORY_UNRELATED で止まる（init はリモートを確かめないので、手元の追跡 ref で分かるときだけ出す）
 */
export function separateBoardWarning(target: string): string {
  return `${target} already holds a board, and the board created here is a separate one that shares no history with it: sharing it on that branch later stops dg sync with DATA_HISTORY_UNRELATED. dg init without --no-data-remote, in a clone that has no board yet, is what takes in the board on the remote`;
}

/** dg init の入力の組み合わせの誤り（何も作る前に止める）。なければ undefined */
export function initDataRemoteProblem(input: {
  dataRemote?: string | undefined;
  noDataRemote?: boolean | undefined;
}): string | undefined {
  if (input.noDataRemote && input.dataRemote !== undefined)
    return "--no-data-remote and --data-remote cannot be given together: --no-data-remote keeps the data on this machine only, and --data-remote names where it is shared";
  // none という名前のリモートを渡されると、config に none と書かれて黙ってデータのリモートなしになる
  if (input.dataRemote === NO_DATA_REMOTE)
    return `${NO_DATA_REMOTE} cannot be a data remote's name (config's git.data_remote reads it as no data remote). To keep the data on this machine only, pass --no-data-remote; to use a remote with that name, add it under another name`;
  return undefined;
}

/**
 * dg init --no-data-remote が none を書く先。新しいボード（この init が config.yaml を作る）ならチームの config、
 * 既にあるボードで config がなしでなければこのクローンの個人の設定（チームの値は書き換えない。--data-remote と同じ扱い）、
 * 既になしなら書かない（null）。--no-data-remote を付けない init は何も書かない
 */
export function initNoneRecord(facts: {
  noDataRemote: boolean;
  /** この init が config.yaml を作る（新しいボード） */
  newConfig: boolean;
  /** 今の config（個人 > チーム）が既にデータのリモートなし */
  configuredNone: boolean;
}): "team" | "local" | null {
  if (!facts.noDataRemote) return null;
  if (facts.newConfig) return "team";
  return facts.configuredNone ? null : "local";
}

/**
 * dg init の出力に足す知らせ。
 *   - 新しいボードをデータのリモートへ push した：リモートを読める人なら誰でも読めることと、手元だけに置く --no-data-remote
 *   - --no-data-remote：手元だけに置くことの知らせ（localOnlyNote）。共有しているボードで個人の設定に書いたときは、その警告も
 */
export function initNotes(facts: {
  noDataRemote: boolean;
  /** init の後、チームの config の git.data_remote が none（そうでなければ、none はこのクローンの個人の設定にある） */
  teamNone: boolean;
  /** この init が config.yaml を作った（新しいボード） */
  newConfig: boolean;
  /** この init のコミットを push した先（データのリモートとデータのブランチ）。push しなかったら null */
  pushedTo: { remote: string; branch: string } | null;
  /** データのブランチがデータのリモートにある（追跡 ref がある）ときの、その場所（<リモート>/<ブランチ>）。なければ null */
  sharedOn: string | null;
}): string[] {
  if (facts.noDataRemote) {
    // 戻し方は none のある場所で変わる：チームの値なら空かリモートの名前にし、個人の設定なら上書きを消す
    const note = localOnlyNote(facts.teamNone ? "team" : "local");
    if (facts.sharedOn === null) return [note];
    // リモートにボードがあるのに新しく作ったボードは、それと履歴を共有しない別のボード。既にあるボードなら、チームのボードから離れた
    return [
      note,
      facts.newConfig
        ? separateBoardWarning(facts.sharedOn)
        : sharedBoardLeftWarning(facts.sharedOn),
    ];
  }
  if (!facts.newConfig || facts.pushedTo === null) return [];
  const { remote, branch } = facts.pushedTo;
  return [
    `The new board was pushed to ${remote}/${branch}: anyone who can read ${remote} can read its tickets and Run records. To keep a board on this machine only, start it with dg init --no-data-remote (for this board: delete the pushed branch with git push ${remote} --delete ${branch}, then run dg config set git.data_remote ${NO_DATA_REMOTE})`,
  ];
}

export type DataRemoteNoneDecision =
  /** git.data_remote を none にする書き込みではない（ここでは何も決めない） */
  | { kind: "other" }
  /** 拒む（VALIDATION_FAILED）。hint は次の手 */
  | { kind: "reject"; message: string; hint: string }
  /** 通す。warnings を結果に足す */
  | { kind: "allow"; warnings: string[] };

/**
 * dg config set が git.data_remote を none にしてよいか。
 *   - チームの値：データのブランチがデータのリモートにある（sharedOn）ボードでは拒み、--local を案内する。チームの値を none にすると、
 *     ほかのクローンは取り込んだ後に黙って同期をやめ、排他（SY-3）がチームごと効かなくなる。リモートにないボードでは通す
 *   - 個人の設定（--local）：通す。共有しているボードなら、claim がほかの人を排他しなくなることと戻し方を警告する
 */
export function decideDataRemoteNone(facts: {
  key: string;
  /** スキーマに合わせて直した後の値 */
  value: unknown;
  scope: "team" | "local";
  /** データのブランチがデータのリモートにある（追跡 ref がある）ときの、その場所（<リモート>/<ブランチ>）。なければ null */
  sharedOn: string | null;
}): DataRemoteNoneDecision {
  if (facts.key !== "git.data_remote" || facts.value !== NO_DATA_REMOTE) return { kind: "other" };
  if (facts.sharedOn === null) return { kind: "allow", warnings: [localOnlyNote(facts.scope)] };
  if (facts.scope === "team")
    return {
      kind: "reject",
      message: `The team's git.data_remote cannot be ${NO_DATA_REMOTE}: the board's data branch is on ${facts.sharedOn}, and the clones that sync with it would stop syncing without a word`,
      hint: `To keep the data on this machine only from now on, set it for this clone alone: dg config set git.data_remote ${NO_DATA_REMOTE} --local. The data branch already on the remote stays there; deleting it is a person's decision (git push <remote> --delete <branch>)`,
    };
  return {
    kind: "allow",
    warnings: [localOnlyNote("local"), sharedBoardLeftWarning(facts.sharedOn)],
  };
}
