// 導入のチェックリスト（UI-12）。一覧を読めない間（dg init 前・Git リポジトリの外・git がない）は一覧の代わりに出し、
// 必須（フォルダ・OS・git・Git リポジトリ・ボード）を満たすといつもの画面に変わる。推奨（Skill と hooks・dg コマンド・.claude/.gitignore）が
// 欠けている間は、いつもの画面の上に帯（SetupBand）を出し、開くと項目をその場で直せる。
// 項目は入口が確かめた結果（store.setup。core の dg setup check に、VS Code 拡張がフォルダ・OS・dg コマンドを足す）で、文言はここで id と state から組む
// （core の message は dg の出力で英語なので出さない）。満たさない項目の中身は、どの項目も次の順に並べる（guideOf と ItemGuide）：
//   1. 状態（事実の 1 文） 2. すること（文・場所・ボタン 1 つ） 3. ターミナルで行うなら（同じことをするコマンド） 4. 条件を書いた別の道
// ボタンは VS Code の中でだけ出る（拡張ホストに頼み、deguboard のターミナルで実行する）。dg serve のブラウザにはなく、コマンドをコピーするだけ（ADR-027）。
// 確かめ直しは、拡張ホストの見張りと手のボタン（store.recheckSetup）が行う

import type { SetupAction, SetupView, SetupViewItem } from "@deguboard/core";
import { failureOf } from "../client/http.js";
import { useHost, useUiState } from "../host.js";
import { msg, tr } from "../l10n.js";
import { useStore } from "../store.js";
import { CopyableCode } from "./copyable-code.js";

/** ボタン 1 つ。recheck は確かめ直す（どの入口でも動く）。ほかは拡張ホストに頼む操作で、頼めない入口（dg serve）では出さない */
interface GuideAction {
  label: string;
  act: SetupAction | "recheck";
}

/** 満たさない項目の中身。描く順は ItemGuide が決める */
export interface Guide {
  /** 項目の行に添える短い状態（「なし」「届かない」） */
  short: string;
  /** 1. 状態：何が足りないかを事実で 1 文 */
  status: string;
  /** 状態の根拠になった出力（git のエラーなど）。そのまま出す */
  detail?: string | undefined;
  /** 2. すること：ボタンで足りないときの文 */
  todo?: string | undefined;
  /** 2. すること：操作が働く場所（git init するフォルダ） */
  place?: { label: string; path: string } | undefined;
  /** 2. すること：ボタン 1 つ */
  action?: GuideAction | undefined;
  /** 3. ターミナルで行うなら：ボタンと同じことをするコマンド（上から順に打つ） */
  commands?: readonly string[] | undefined;
  /** 4. 別の道：when の条件（「〜なら」）に当たるときだけ選ぶ */
  alt?:
    | { when: string; action?: GuideAction | undefined; commands?: readonly string[] | undefined }
    | undefined;
  /** 判定の断り書き */
  note?: string | undefined;
}

const RECHECK = msg("もう一度確かめる");

/** remote に届かないときに、人が選んだときだけ使う「手元だけで新しいボードを作る」のコマンド（拡張のボタン newBoard と同じ） */
const NEW_BOARD_COMMAND = "dg init --new-board";

/** ボードの項目の中身。state は core の BoardState（dg init がすることを先に確かめた結果） */
function boardGuide(item: SetupViewItem): Guide {
  const init: Pick<Guide, "commands"> = { commands: item.fix };
  switch (item.state) {
    case "remote_board":
      return {
        short: tr("未取り込み"),
        status: tr("リモートにチームのボードがあり、このクローンにはまだ取り込んでいません。"),
        action: { label: tr("チームのボードを取り込む"), act: "init" },
        ...init,
      };
    case "remote_no_board":
      return {
        short: tr("まだない"),
        status: tr("リモートにボードはありません。"),
        todo: tr("新しいボードを作り、リモートへ push します。"),
        action: { label: tr("新しいボードを作る"), act: "init" },
        ...init,
      };
    case "remote_unreachable":
      return {
        short: tr("リモートに届かない"),
        status: tr(
          "リモートに届かないため、チームのボードがあるか分からず、ボードはまだ作っていません。",
        ),
        detail: item.detail,
        todo: tr(
          "ネットワーク・認証（ssh 鍵や gh auth）・リモートの URL を直してから、確かめ直します。",
        ),
        action: { label: tr(RECHECK), act: "recheck" },
        alt: {
          when: tr("チームのボードがないと分かっているなら"),
          action: { label: tr("手元だけで新しいボードを作る"), act: "newBoard" },
          commands: [NEW_BOARD_COMMAND],
        },
      };
    case "no_remote":
      return {
        short: tr("まだない"),
        status: tr(
          "このリポジトリにはコードのリモートがなく、取り込むチームのボードがありません。",
        ),
        todo: tr("このマシンだけのボードを作ります。"),
        action: { label: tr("新しいボードを作る"), act: "init" },
        ...init,
      };
    case "local_branch":
      return {
        short: tr("worktree がない"),
        status: tr("このクローンにはボードのブランチがあり、その worktree がありません。"),
        action: { label: tr("ボードの worktree を作り直す"), act: "init" },
        ...init,
      };
    case "data_remote_missing":
      return {
        short: tr("リモートがない"),
        status: tr("データのリモートに渡した名前のリモートが、このクローンにありません。"),
        todo: tr("git remote add で足すか、URL を渡してから、確かめ直します。"),
        action: { label: tr(RECHECK), act: "recheck" },
      };
    case "data_branch_invalid":
      return {
        short: tr("名前が正しくない"),
        status: tr("データのブランチに渡した名前を、dg init が受け付けません。"),
        todo: tr("名前を直してから、確かめ直します。"),
        action: { label: tr(RECHECK), act: "recheck" },
      };
    default:
      return {
        short: tr("まだない"),
        status: tr("このクローンにはまだボードがありません。"),
        action: { label: tr("ボードを用意する"), act: "init" },
        ...init,
      };
  }
}

/** dg コマンドの項目の中身。state は拡張が決める（packages/vscode/src/setup.ts の DgCommandState）。判定は拡張から見た PATH による */
function dgCommandGuide(item: SetupViewItem): Guide {
  const p = item.params ?? {};
  const note = tr(
    "この判定は拡張から見た PATH によります。シェルの設定を変えた後は、VS Code を開き直すと反映されます。",
  );
  switch (item.state) {
    case "not_on_path":
      return {
        short: tr("PATH にない"),
        status: tr(
          "{0} は張ってありますが、{1} が PATH にないため、ターミナルとエージェントから dg を呼べません。",
          p["link"] ?? "",
          p["dir"] ?? "",
        ),
        todo: tr(
          "次の 1 行をシェルの設定に足し、VS Code と、開いているターミナルとエージェントを開き直します。",
        ),
        commands: item.fix,
        note,
      };
    case "occupied":
      return {
        short: tr("PATH にない"),
        status: p["target"]
          ? tr(
              "{0} はすでにあり、deguboard の起動ファイルではなく {1} を指しているため、dg コマンドを入れられません。",
              p["link"] ?? "",
              p["target"],
            )
          : tr(
              "{0} はすでにあり、シンボリックリンクではないため、dg コマンドを入れられません。",
              p["link"] ?? "",
            ),
        todo: tr("中身を確かめ、要らなければ自分で消してから、dg コマンドを入れます。"),
        action: { label: tr("dg コマンドを入れる"), act: "installDg" },
        note,
      };
    case "major_mismatch":
      return {
        short: tr("版が違う"),
        status: tr(
          "PATH の dg（{0}）のメジャー版が、拡張の dg（{1}）と違います。",
          p["version"] ?? "",
          p["core"] ?? "",
        ),
        todo: tr("どちらかを更新してメジャー版をそろえてから、確かめ直します。"),
        action: { label: tr(RECHECK), act: "recheck" },
        note,
      };
    case "error":
      return {
        short: tr("動かない"),
        status: tr("PATH の dg が動きません（dg --version が失敗しました）。"),
        detail: item.detail,
        todo: tr("PATH の dg を直してから、確かめ直します。"),
        action: { label: tr(RECHECK), act: "recheck" },
        note,
      };
    default:
      return {
        short: tr("PATH にない"),
        status: tr("PATH に dg がなく、ターミナルとエージェントから dg を呼べません。"),
        todo: tr("拡張に同梱した dg を {0} に張ります。", p["link"] ?? "~/.local/bin/dg"),
        action: { label: tr("dg コマンドを入れる"), act: "installDg" },
        note,
      };
  }
}

/** 満たさない項目の中身を、項目の id と state から組む */
export function guideOf(item: SetupViewItem, view: SetupView): Guide {
  switch (item.id) {
    case "folder":
      return {
        short: tr("開いていない"),
        status: tr("フォルダを開いていません。"),
        todo: tr("deguboard を使うリポジトリのフォルダを開きます。"),
        action: { label: tr("フォルダを開く"), act: "openFolder" },
      };
    case "os":
      return {
        short: tr("非対応"),
        status: tr("この OS（{0}）では deguboard は動きません。", item.params?.["platform"] ?? ""),
        todo: tr(
          "WSL か Remote（SSH・Dev Containers）で、Linux か macOS のフォルダを開き直します。",
        ),
      };
    case "git":
      return {
        short: tr("見つからない"),
        status: tr("使える git（2.30 以上）が PATH にありません。"),
        detail: item.detail,
        todo: tr("git 2.30 以上を入れてから、確かめ直します。"),
        action: { label: tr(RECHECK), act: "recheck" },
      };
    case "repository":
      return {
        short: tr("リポジトリではない"),
        status: tr("このフォルダは Git リポジトリではありません。"),
        place: view.cwd ? { label: tr("次のフォルダに作る"), path: view.cwd } : undefined,
        action: { label: tr("このフォルダに git init する"), act: "gitInit" },
        commands: item.fix,
        alt: {
          when: tr("別のフォルダで使うつもりなら"),
          action: { label: tr("フォルダを開き直す"), act: "openFolder" },
        },
      };
    case "board":
      return boardGuide(item);
    case "skills_hooks": {
      // core は直すコマンドだけを返す。どちらも入っていないとき（入れるコマンドが 2 つとも並ぶ）だけ言い切り、ほかは古いものを含めて言う
      const none =
        item.fix.length === 2 &&
        item.fix.includes("dg hooks install") &&
        item.fix.includes("dg skill install");
      // 手を加えた Skill を上書きする --force は、ボタンでは実行しない（コマンドを見せ、人が選んで打つ）
      const byButton = item.fix.some((c) => !c.includes("--force"));
      return {
        short: tr("そろっていない"),
        status: none
          ? tr("このマシンに dg の Skill と hooks が入っていません。")
          : tr("このマシンの dg の Skill と hooks に、入っていないものか古いものがあります。"),
        todo: tr("入れると、Claude Code が手順を読んでチケットを進め、Run が記録されます。"),
        action: byButton
          ? { label: tr("Skill と hooks を入れる"), act: "installSkillsHooks" }
          : undefined,
        commands: item.fix,
      };
    }
    case "dg_command":
      return dgCommandGuide(item);
    case "gitignore":
      return {
        short: tr("未コミット"),
        status: tr("{0} にコミットしていない変更があります。", item.label),
        todo: tr(
          "コミットすると、各自の設定と dg の Skill が、ほかの人のクローンで追跡の候補に出なくなります。リポジトリの最上位で、次のコマンドを実行します。",
        ),
        commands: item.fix,
      };
  }
}

const LABELS: Record<SetupViewItem["id"], string | undefined> = {
  folder: msg("フォルダ"),
  os: "OS",
  git: "git",
  repository: msg("Git リポジトリ"),
  board: msg("ボード"),
  skills_hooks: msg("Skill と hooks"),
  dg_command: msg("dg コマンド"),
  // ファイルの名前（.claude/.gitignore）は core が Adapter から引くので、core の label を出す
  gitignore: undefined,
};

function labelOf(item: SetupViewItem): string {
  const label = LABELS[item.id];
  return label === undefined ? item.label : tr(label);
}

const MARKS = {
  ok: { mark: "✓", label: msg("満たしている") },
  unmet: { mark: "✗", label: msg("満たしていない") },
  recommended: { mark: "!", label: msg("推奨の項目が未完了") },
  pending: { mark: "·", label: msg("まだ確かめていない") },
} as const;

function Commands({ commands }: { commands: readonly string[] }) {
  return (
    <>
      {commands.map((command) => (
        <CopyableCode key={command} text={command} label={tr("{0} をコピー", command)} />
      ))}
    </>
  );
}

/** 満たさない項目の中身を、状態 → すること → ターミナルで行うなら → 別の道 の順に描く */
function ItemGuide({ guide }: { guide: Guide }) {
  const host = useHost();
  const store = useStore();
  const button = (action: GuideAction, primary: boolean) => {
    const className = primary ? "primary" : "";
    if (action.act === "recheck")
      return (
        <button
          type="button"
          className={className}
          disabled={store.checkingSetup}
          onClick={() => void store.recheckSetup()}
        >
          {action.label}
        </button>
      );
    const { setupAct } = host;
    if (!setupAct) return null;
    const act = action.act;
    return (
      <button
        type="button"
        className={className}
        onClick={() =>
          void setupAct(act).catch((error: unknown) => {
            const f = failureOf(error);
            store.notify({ kind: "error", text: f.message, detail: f.detail });
          })
        }
      >
        {action.label}
      </button>
    );
  };
  const main = guide.action ? button(guide.action, true) : null;
  const other = guide.alt?.action ? button(guide.alt.action, false) : null;
  const otherCommands = guide.alt?.commands ?? [];
  return (
    <div className="setup-guide">
      <p className="setup-status">{guide.status}</p>
      {guide.detail ? <pre className="setup-output">{guide.detail}</pre> : null}
      {guide.todo ? <p>{guide.todo}</p> : null}
      {guide.place ? (
        <>
          <p className="setup-slot">{guide.place.label}</p>
          <code className="setup-path">{guide.place.path}</code>
        </>
      ) : null}
      {main}
      {guide.commands && guide.commands.length > 0 ? (
        <>
          {/* ボタンのない入口（dg serve）とボタンのない項目では、コマンドが唯一の道なので「なら」を付けない */}
          <p className="setup-slot">
            {main ? tr("ターミナルで行うなら") : tr("ターミナルで実行する")}
          </p>
          <Commands commands={guide.commands} />
        </>
      ) : null}
      {guide.alt && (other || otherCommands.length > 0) ? (
        <div className="setup-alt">
          <p className="setup-slot">{guide.alt.when}</p>
          {other}
          {other && otherCommands.length > 0 ? (
            <p className="setup-slot">{tr("ターミナルで行うなら")}</p>
          ) : null}
          <Commands commands={otherCommands} />
        </div>
      ) : null}
      {guide.note ? <p className="muted setup-note">{guide.note}</p> : null}
    </div>
  );
}

function Item({ item, view, open }: { item: SetupViewItem; view: SetupView; open: boolean }) {
  const kind =
    item.status === "unmet" && item.level === "recommended" ? "recommended" : item.status;
  const guide = item.status === "unmet" ? guideOf(item, view) : undefined;
  return (
    <li className={`setup-item ${kind}`}>
      <span className="setup-mark" role="img" aria-label={tr(MARKS[kind].label)}>
        {MARKS[kind].mark}
      </span>
      <span className="setup-name">
        {labelOf(item)}
        {item.status === "ok" && item.value ? (
          <span className="setup-value">{item.value}</span>
        ) : null}
        {guide ? <span className="setup-short">{guide.short}</span> : null}
      </span>
      {guide && open ? <ItemGuide guide={guide} /> : null}
    </li>
  );
}

/**
 * チェックリスト。必須を満たさない間（view.ready が偽）は全項目を並べ、満たさない最初の項目だけを開く
 * （その下は、前の項目を満たすまで確かめられないので待たせる）。必須を満たした後（帯から開いたとき。onClose を渡す）は、
 * 必須を 1 行にまとめ、推奨の満たさない項目をすべて開く
 */
export function SetupChecklist({ view, onClose }: { view: SetupView; onClose?: () => void }) {
  const store = useStore();
  const required = view.items.filter((i) => i.level === "required");
  const recommended = view.items.filter((i) => i.level === "recommended");
  const firstUnmet = view.items.find((i) => i.status === "unmet");
  return (
    <section className="setup" aria-labelledby="setup-title">
      <div className="setup-head">
        <h2 id="setup-title">{view.ready ? tr("セットアップ") : tr("deguboard を始める")}</h2>
        <button
          type="button"
          className="link"
          disabled={store.checkingSetup}
          onClick={() => void store.recheckSetup()}
        >
          {tr("確かめ直す")}
        </button>
      </div>
      {view.ready ? (
        <>
          <ul className="setup-items">
            <li className="setup-item ok">
              <span className="setup-mark" role="img" aria-label={tr(MARKS.ok.label)}>
                {MARKS.ok.mark}
              </span>
              <span className="setup-name">{tr("必須の {0} 項目", required.length)}</span>
            </li>
          </ul>
          <h3 className="setup-group">{tr("推奨")}</h3>
          <ul className="setup-items">
            {recommended.map((item) => (
              <Item key={item.id} item={item} view={view} open />
            ))}
          </ul>
        </>
      ) : (
        <>
          <p className="muted">
            {tr(
              "上から順に確かめています。満たしていない項目を直すと、自動で確かめ直し、必須の項目をすべて満たすといつもの画面に変わります。",
            )}
          </p>
          <ul className="setup-items">
            {view.items.map((item) => (
              <Item key={item.id} item={item} view={view} open={item === firstUnmet} />
            ))}
          </ul>
        </>
      )}
      {onClose ? (
        <button type="button" onClick={onClose}>
          {tr("いつもの画面に戻る")}
        </button>
      ) : null}
    </section>
  );
}

/** 帯を出さないと決めたことを残す見た目の状態の鍵。Webview の状態はワークスペース（リポジトリ）ごとなので、このリポジトリでだけ出なくなる */
export const SETUP_BAND_DISMISSED_KEY = "setup.band.dismissed";

/** 推奨の満たさない項目 */
export function unmetRecommended(view: SetupView): SetupViewItem[] {
  return view.items.filter((i) => i.level === "recommended" && i.status === "unmet");
}

/**
 * いつもの画面の上に出す、推奨の項目が欠けていることの帯。開くとチェックリスト（SetupChecklist）で項目をその場で直せ、
 * このリポジトリでは出さないこともできる（Claude Code を使わない人は Skill と hooks を入れないままでよい）
 */
export function SetupBand({ view, onOpen }: { view: SetupView; onOpen: () => void }) {
  const [dismissed, setDismissed] = useUiState(SETUP_BAND_DISMISSED_KEY, false);
  const unmet = unmetRecommended(view);
  if (dismissed || unmet.length === 0) return null;
  return (
    <div className="setup-band" role="status">
      <span>
        {tr(
          "推奨の {0} 項目が未完了です（{1}）。",
          unmet.length,
          unmet.map(labelOf).join(tr("・")),
        )}
      </span>
      <span className="setup-band-buttons">
        <button type="button" onClick={onOpen}>
          {tr("残りの項目を開く")}
        </button>
        <button type="button" className="link" onClick={() => setDismissed(true)}>
          {tr("このリポジトリでは出さない")}
        </button>
      </span>
    </div>
  );
}
