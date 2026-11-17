// 左パネルの導入のチェックリスト（UI-12）のうち、VS Code の API に触れない純粋な処理。extension.ts から呼ぶ。
// 項目の大半は core の dg setup check（checkSetup）が確かめる。ここは拡張でしか確かめられない 3 つ（作業フォルダ・OS・PATH の dg）を足して、
// 画面に渡す 1 つの一覧（SetupView）にする。文言は画面（web の components/setup-checklist.tsx）が id と state から表示言語で組むので、
// ここの message は core と同じく英語で持ち、画面には出ない

import path from "node:path";
import {
  initCommandLine,
  type SetupAction,
  type SetupBoardSource,
  type SetupCheckResult,
  type SetupView,
  type SetupViewItem,
} from "@deguboard/core";
import { majorOf, type DgLookup } from "./dg.js";
import type { DgLink } from "./launcher.js";

/**
 * dg コマンドの項目の細かい状態。missing は PATH に dg がなく ~/.local/bin/dg もない、not_on_path は ~/.local/bin/dg を張ってあるが
 * ~/.local/bin が PATH にない、occupied は ~/.local/bin/dg がほかの dg か通常のファイルで張れない、
 * major_mismatch は PATH の dg のメジャー版が拡張に同梱した core と違う、error は dg --version が失敗した
 */
export type DgCommandState = "missing" | "not_on_path" | "occupied" | "major_mismatch" | "error";

/** dg コマンドの項目を決める事実。PATH は拡張から見たもの（GUI から起動した VS Code の PATH は、ターミナルの PATH と違うことがある） */
export interface DgCommandFacts {
  /** PATH の dg を dg --version で引いた結果 */
  lookup: DgLookup;
  /** 拡張に同梱した core の版 */
  coreVersion: string;
  /** ~/.local/bin/dg の今の状態 */
  link: DgLink;
  /** ~/.local/bin/dg のパス */
  linkPath: string;
  /** ~/.local/bin が PATH にあるか */
  binOnPath: boolean;
}

/** ~/.local/bin を PATH に足す 1 行（シェルの設定に書く） */
export const PATH_EXPORT_LINE = "export PATH=$HOME/.local/bin:$PATH";

type Checked = Pick<
  SetupViewItem,
  "status" | "message" | "fix" | "state" | "value" | "detail" | "params"
>;

const PENDING: Checked = {
  status: "pending",
  message: "Checked after the required items above are met",
  fix: [],
};

/**
 * PATH の dg の項目（推奨）。dg があって版のメジャーが拡張と合えば満たす（読めない版は比べられないので満たすとする）。
 * ないときは、~/.local/bin/dg の状態と PATH から、次にすること（入れる・PATH に足す・塞いでいるものを片付ける）が分かる state にする
 */
export function dgCommandItem(facts: DgCommandFacts): Checked {
  const { lookup, coreVersion, link, linkPath } = facts;
  const unmet = (
    state: DgCommandState,
    message: string,
    extra: Partial<Checked> = {},
  ): Checked => ({
    status: "unmet",
    message,
    fix: [],
    state,
    ...extra,
  });
  if (lookup.kind === "found") {
    const dg = majorOf(lookup.version);
    const core = majorOf(coreVersion);
    if (dg === undefined || core === undefined || dg === core)
      return { status: "ok", message: `dg ${lookup.version}`, fix: [], value: lookup.version };
    return unmet(
      "major_mismatch",
      `The major version of the dg on PATH (${lookup.version}) differs from the extension's dg (${coreVersion})`,
      { params: { version: lookup.version, core: coreVersion } },
    );
  }
  if (lookup.kind === "error")
    return unmet("error", "dg --version failed", { detail: lookup.detail });
  const dir = path.dirname(linkPath);
  if (link.kind === "ours" && !facts.binOnPath)
    return unmet("not_on_path", `${linkPath} is linked, but ${dir} is not on PATH`, {
      fix: [PATH_EXPORT_LINE],
      params: { link: linkPath, dir },
    });
  if (link.kind === "other")
    return unmet("occupied", `${linkPath} already exists and is not the deguboard launcher`, {
      params: { link: linkPath, ...(link.target === undefined ? {} : { target: link.target }) },
    });
  return unmet("missing", "dg is not on PATH", { params: { link: linkPath } });
}

export interface SetupFacts {
  /** 開いている作業フォルダ（最初のもの）のパス。開いていなければ undefined */
  folder: string | undefined;
  /** 拡張ホストの OS（process.platform）。リモート（SSH・WSL・Dev Containers）では拡張ホストが動く側の OS */
  platform: NodeJS.Platform;
  /** core の dg setup check の結果。フォルダがない・OS が対応していないときは確かめないので undefined */
  core: SetupCheckResult | undefined;
  /** dg コマンドの項目の事実。必須の項目を満たさないときは確かめないので undefined */
  dg: DgCommandFacts | undefined;
}

/** dg が動く OS か（requirements.md の実行環境：Linux / macOS） */
export function supportedPlatform(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

/** core を確かめなかったとき（フォルダがない・OS が対応していない）に、待っている項目として並べる core の項目 */
const CORE_PENDING: Pick<SetupViewItem, "id" | "label" | "level">[] = [
  { id: "git", label: "git", level: "required" },
  { id: "repository", label: "Git repository", level: "required" },
  { id: "board", label: "Board", level: "required" },
  { id: "skills_hooks", label: "Skills and hooks", level: "recommended" },
];

/**
 * 画面に渡す一覧を組む。順は、フォルダ・OS・git・Git リポジトリ・ボード（必須）、Skill と hooks・dg コマンド・agent の設定の .gitignore（推奨）。
 * 必須の項目を満たさなければ、その後の項目は確かめずに pending にする（core の checkSetup と同じ決まり）
 */
export function buildSetupView(facts: SetupFacts): SetupView {
  const folderOk = facts.folder !== undefined;
  const osOk = supportedPlatform(facts.platform);
  const folder: SetupViewItem = {
    id: "folder",
    label: "Folder",
    level: "required",
    ...(facts.folder !== undefined
      ? {
          status: "ok",
          message: `The folder ${facts.folder} is open`,
          fix: [],
          value: facts.folder,
        }
      : { status: "unmet", message: "No folder is open", fix: [] }),
  };
  const os: SetupViewItem = {
    id: "os",
    label: "OS",
    level: "required",
    ...(!folderOk
      ? PENDING
      : osOk
        ? { status: "ok", message: `OS ${facts.platform}`, fix: [], value: facts.platform }
        : {
            status: "unmet",
            message: `dg does not run on ${facts.platform}. It needs Linux or macOS`,
            fix: [],
            params: { platform: facts.platform },
          }),
  };
  const core: SetupViewItem[] =
    facts.core?.items ?? CORE_PENDING.map((head) => ({ ...head, ...PENDING }));
  const ready = folderOk && osOk && facts.core?.ready === true;
  const dg: SetupViewItem = {
    id: "dg_command",
    label: "dg command",
    level: "recommended",
    ...(ready && facts.dg ? dgCommandItem(facts.dg) : PENDING),
  };
  // dg コマンドは Skill と hooks の後、.gitignore の前に置く（入れる順）
  const at = core.findIndex((item) => item.id === "gitignore");
  const items = [
    folder,
    os,
    ...(at < 0 ? [...core, dg] : [...core.slice(0, at), dg, ...core.slice(at)]),
  ];
  return { ready, items, cwd: facts.folder ?? null };
}

/**
 * 拡張ホストの見張り（ファイルの変化・ターミナルの実行の終わり・ウィンドウに戻った）で、自動で確かめ直すか。
 * - すべて満たしていれば確かめ直さない（欠けたことは次に画面を開いたときに分かる）
 * - 満たさない最初の項目がボードのときも確かめ直さない。ボードの確かめは remote に尋ねる（git ls-remote。最長 30 秒）ので見張りのたびには回さず、
 *   dg init が済んだことはデータ worktree の見張り（extension.ts の watchInit）が拾う。remote を直した後は、人が手で確かめ直す
 * - 推奨だけが欠けていて、人が帯を「このリポジトリでは出さない」にしている（bandDismissed）ときも確かめ直さない。結果を出す場所がないのに、
 *   ターミナルの実行の終わりとウィンドウに戻るたびに git と dg --version を起こさない（Claude Code を使わない人は推奨を入れないままでよい）
 */
export function autoRecheck(view: SetupView | undefined, bandDismissed: boolean): boolean {
  if (!view) return true;
  const first = view.items.find((item) => item.status === "unmet");
  if (first === undefined || first.id === "board") return false;
  return first.level === "required" || !bandDismissed;
}

/**
 * フォルダごとに持つ、人がボードの項目で指定したデータの置き場所を、画面の setup の要求で更新した値（undefined はコードのリモート）。
 * 指定し直した画面だけが board を送り（null はコードのリモートに戻した）、送らない画面は持っている指定のまま確かめる。
 * 左パネルとエディタのパネルは別々の画面で、確かめた結果はフォルダごとに 1 つ（autoRecheck が読む）なので、指定を持たないパネルの
 * 確かめ直し（dg init の前は、パネルも一覧を読めずにチェックリストを出す）が、左パネルの指定で確かめた結果を上書きしないように
 */
export function heldSetupBoard(
  held: SetupBoardSource | undefined,
  sent: SetupBoardSource | null | undefined,
): SetupBoardSource | undefined {
  if (sent === undefined) return held;
  return sent ?? undefined;
}

/**
 * 「Skill と hooks を入れる」ボタンが流すコマンド。最後に確かめた項目の直すコマンド（core が返す）から、--force の付くもの
 * （手を加えた Skill を上書きする）を除く。上書きは人がコマンドを見て自分で打つ。確かめた結果がなければ、どちらも入れる
 */
export function skillsHooksCommands(view: SetupView | undefined): string[] {
  const item = view?.items.find((i) => i.id === "skills_hooks");
  if (!item) return ["dg skill install", "dg hooks install"];
  return item.fix.filter((command) => !command.includes("--force"));
}

/** ボタンのうち、deguboard のターミナルでコマンドを流すもの（フォルダを開く・dg コマンドを入れる・同期する・拡張の画面を開くは拡張が自分で行う） */
export type TerminalSetupAction = Exclude<
  SetupAction,
  "openFolder" | "installDg" | "sync" | "showExtension"
>;

/**
 * ボタンが deguboard のターミナルで流すコマンド。init・newBoard は、人がボードの項目で別のリポジトリを指定していれば（board）、
 * 確かめたときと同じ値を dg init の --data-remote・--data-branch に渡す（core の initCommandLine。値はシェルに渡せる形に囲む）。
 * uninstall・uninstallPersonal は「アンインストール」の節で選んだ範囲の dg uninstall。--force は画面から流さない
 * （止める理由を越えるのは、ターミナルで自分で打つ人だけ）。ターミナルで打つのは人なので --actor は付けない（dg uninstall は人だけが実行できる）
 */
export function setupCommands(
  act: TerminalSetupAction,
  view: SetupView | undefined,
  board?: SetupBoardSource,
): string[] {
  const source = { dataRemote: board?.dataRemote, dataBranch: board?.dataBranch };
  switch (act) {
    case "gitInit":
      return ["git init"];
    case "init":
      return [initCommandLine(source)];
    case "newBoard":
      return [initCommandLine({ ...source, newBoard: true })];
    case "installSkillsHooks":
      return skillsHooksCommands(view);
    case "uninstall":
      return ["dg uninstall"];
    case "uninstallPersonal":
      return ["dg uninstall --personal"];
  }
}
