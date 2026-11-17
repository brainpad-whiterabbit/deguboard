// 導入のチェックリスト（setup-checklist.tsx）の末尾の「アンインストール」の節と、外した後の知らせ（UI-12）。
// 節は必須を満たした後のチェックリストにだけ、閉じた形で出す（項目ではないので印を付けず、推奨の帯にも出さない）。
// 開くと範囲を選ばせ、拡張ホストが返す dg uninstall --dry-run の結果（host.uninstallPreview）から消すもの・残すもの・止める理由を出す。
// 文言はここで kind から表示言語で組む（core の message・reason は dg の出力で英語。中身が要る止める理由だけ、根拠としてそのまま添える）。
// 消すのは dg で、画面は確かめるだけ：「外す…」→「外す」の 2 段階の後、選んだ範囲の dg uninstall を deguboard のターミナルで実行する
// （host.setupAct。ターミナルで打つのは人なので、dg uninstall を人だけに限る Core の固定と矛盾しない）。dg が実行のときに止める理由を
// もう一度確かめるので、画面の結果が古くても消し過ぎない。--force は画面に出さない（越えるのは、ターミナルで自分で打つ人だけ）。
// 拡張ホストのない入口（dg serve）には節を出さない（ADR-027）

import type {
  UninstallBlocker,
  UninstallItem,
  UninstallKept,
  UninstallPreview,
} from "@deguboard/core";
import { useEffect, useState } from "react";
import { failureOf } from "../client/http.js";
import { useHost } from "../host.js";
import { msg, tr } from "../l10n.js";
import { useStore } from "../store.js";
import { SETUP_UNINSTALL_KEY } from "../ui-state.js";
import { CopyableCode } from "./copyable-code.js";

const REMOVES: Record<UninstallItem["kind"], string> = {
  hooks: msg("dg のフック"),
  skills: msg("dg の Skill（{0} 個）"),
  data_worktree: msg("ボードの worktree"),
  data_branch: msg("手元のボードのブランチ"),
  merge_driver: msg("git config のマージドライバの登録"),
  local_dir: msg("個人の設定・会話記録・キャッシュ"),
};

const KEEPS: Record<UninstallKept["kind"], string> = {
  remote_data_branch: msg("リモートのボード"),
  data_remote: msg("データのリモートの登録"),
  ignore_file: msg("チームでコミットした .gitignore"),
  shared_hooks: msg("チームで共有する設定のフック"),
  edited_skills: msg("手を加えた dg の Skill"),
  personal_hooks: msg("個人の設定のフック"),
  personal_skills: msg("個人の Skill"),
};

const BLOCKERS: Record<UninstallBlocker["kind"], string> = {
  unpushed: msg("リモートへ送っていないボードのデータがあります。"),
  uncommitted: msg("dg がまだコミットしていないボードの変更があります。"),
  outside_changes: msg("ボードのデータに、dg の外で行った変更があります。"),
  rebase: msg("ボードの worktree で rebase が途中のため、失うものを判定できません。"),
  active_worktrees: msg("終わっていないチケットの worktree が、このクローンにあります。"),
  unreadable: msg("ボードのデータを読めないため、終わっていないチケットを確かめられません。"),
};

/** core の文（英語）を根拠として添える止める理由。どのチケット・どのファイルかは core の文にしかない */
const DETAILED: ReadonlySet<UninstallBlocker["kind"]> = new Set([
  "outside_changes",
  "active_worktrees",
  "unreadable",
]);

/** 画面が流す dg uninstall の 1 行（拡張の setupCommands が流すものと同じ。packages/vscode/src/setup.ts） */
export function uninstallCommandLine(personal: boolean): string {
  return personal ? "dg uninstall --personal" : "dg uninstall";
}

/** 確かめた結果。personal は確かめた範囲で、選んでいる範囲と違う間は確かめている途中として扱う */
type Checked = { personal: boolean } & ({ data: UninstallPreview } | { error: string });

/**
 * 「アンインストール」の節。initiallyOpen はコマンドパレットの「このリポジトリからアンインストール」から開いたとき。
 * revision は確かめ直しのたびに変わる値（チェックリストの view）で、変わると消すものを取り直す
 */
export function UninstallSection({
  initiallyOpen,
  revision,
}: {
  initiallyOpen: boolean;
  revision: unknown;
}) {
  const host = useHost();
  const store = useStore();
  const { setupAct, uninstallPreview } = host;
  const [open, setOpen] = useState(initiallyOpen);
  const [personal, setPersonal] = useState(false);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [started, setStarted] = useState(false);
  const [syncing, setSyncing] = useState(false);
  /** 同期の後に取り直すための数（同期は確かめ直しを起こさないので） */
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // 外した後に入れ直して、またこの節が出た：前の知らせを残さない（次に必須を満たさなくなったときに、外したと言わないように）
    if (host.state.get<string>(SETUP_UNINSTALL_KEY) === "shown")
      host.state.remove(SETUP_UNINSTALL_KEY);
  }, [host]);

  useEffect(() => {
    if (!open || !uninstallPreview) return;
    let stale = false;
    uninstallPreview(personal).then(
      (data) => {
        if (!stale) setChecked({ personal, data });
      },
      (error: unknown) => {
        if (!stale) setChecked({ personal, error: failureOf(error).message });
      },
    );
    return () => {
      stale = true;
    };
  }, [open, personal, revision, tick, uninstallPreview]);

  if (!setupAct || !uninstallPreview) return null;

  const fail = (error: unknown): void => {
    const f = failureOf(error);
    store.notify({ kind: "error", text: f.message, detail: f.detail });
  };
  const current = checked?.personal === personal ? checked : null;
  const data = current && "data" in current ? current.data : null;
  const blocked = data !== null && data.blockers.length > 0;
  const choose = (next: boolean): void => {
    setPersonal(next);
    setConfirming(false);
  };
  const toggle = (): void => {
    // 開け閉めは新しい流れの始まり：実行したまま外れなかった（dg が止めた）ときの印を残さない
    host.state.remove(SETUP_UNINSTALL_KEY);
    setStarted(false);
    setConfirming(false);
    setOpen(!open);
  };
  const sync = (): void => {
    setSyncing(true);
    void setupAct("sync")
      .catch(fail)
      .finally(() => {
        setSyncing(false);
        setTick((n) => n + 1);
      });
  };
  const run = (): void => {
    // 外した後の画面（必須を満たさないチェックリスト）が知らせを出せるように、実行したことを先に残す
    host.state.set(SETUP_UNINSTALL_KEY, "started");
    setStarted(true);
    setConfirming(false);
    void setupAct(personal ? "uninstallPersonal" : "uninstall").catch(fail);
  };

  return (
    <section className="setup-uninstall" aria-labelledby="setup-uninstall-title">
      <h3 id="setup-uninstall-title">
        <button
          type="button"
          className="setup-uninstall-toggle"
          aria-expanded={open}
          onClick={toggle}
        >
          <span aria-hidden="true">{open ? "▾" : "▸"}</span> {tr("アンインストール")}
        </button>
      </h3>
      {open ? (
        <div className="setup-uninstall-body">
          <p className="muted">
            {tr(
              "このクローンから deguboard を外します。リモートとチームで共有するものには触れないので、あとでボードを取り込み直せます。",
            )}
          </p>
          <fieldset className="setup-choice">
            <legend className="setup-slot">{tr("範囲")}</legend>
            <label>
              <input
                type="radio"
                name="setup-uninstall-scope"
                checked={!personal}
                onChange={() => choose(false)}
              />
              {tr("このリポジトリだけ")}
            </label>
            <label>
              <input
                type="radio"
                name="setup-uninstall-scope"
                checked={personal}
                onChange={() => choose(true)}
              />
              {tr("個人の Skill とフックも")}
            </label>
            {personal ? (
              <p className="muted setup-note">
                {tr("個人の Skill とフックは、ほかのリポジトリでも使えなくなります。")}
              </p>
            ) : null}
          </fieldset>
          {current === null ? (
            <p className="muted" role="status">
              {tr("消すものを確かめています…")}
            </p>
          ) : data === null ? (
            <>
              <p className="setup-status">{tr("消すものを確かめられませんでした。")}</p>
              <pre className="setup-output">{"error" in current ? current.error : ""}</pre>
            </>
          ) : (
            <>
              <p className="setup-slot">{tr("消すもの（dg uninstall --dry-run）")}</p>
              {data.removes.length === 0 ? (
                <p className="muted">{tr("消すものはありません。")}</p>
              ) : (
                <ul className="setup-uninstall-list removes">
                  {data.removes.map((item) => (
                    <li key={`${item.kind}\n${item.target}`}>
                      <span aria-hidden="true">−</span>
                      <span>
                        {tr(REMOVES[item.kind], item.names?.length ?? 0)}
                        <code>{item.target}</code>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="setup-slot">{tr("残すもの")}</p>
              <ul className="setup-uninstall-list">
                {data.keeps.map((kept) => (
                  <li key={`${kept.kind}\n${kept.target}`}>
                    <span aria-hidden="true">·</span>
                    <span>
                      {tr(KEEPS[kept.kind])}
                      <code>{kept.target}</code>
                    </span>
                  </li>
                ))}
                <li>
                  <span aria-hidden="true">·</span>
                  <span>{tr("VS Code 拡張と dg コマンド")}</span>
                </li>
              </ul>
              {blocked ? (
                <div className="setup-uninstall-stop" role="status">
                  <strong>{tr("このままでは外せません")}</strong>
                  {data.blockers.map((blocker) => (
                    <div key={blocker.kind} className="setup-uninstall-blocker">
                      <p>{tr(BLOCKERS[blocker.kind])}</p>
                      {DETAILED.has(blocker.kind) ? (
                        <pre className="setup-output">{blocker.message}</pre>
                      ) : null}
                      {blocker.next.map((command) => (
                        <CopyableCode
                          key={command}
                          text={command}
                          label={tr("{0} をコピー", command)}
                        />
                      ))}
                    </div>
                  ))}
                  <button type="button" disabled={syncing} onClick={sync}>
                    {tr("同期する")}
                  </button>
                </div>
              ) : null}
            </>
          )}
          {started ? (
            <p className="muted" role="status">
              {tr(
                "deguboard のターミナルで実行しました。外し終わると、この画面は始めるときのチェックリストに戻ります。",
              )}
            </p>
          ) : null}
          {confirming && data !== null && !blocked ? (
            <div className="setup-uninstall-confirm">
              <p>
                {personal
                  ? tr("上の「消すもの」を、このクローンとホームディレクトリから消します。")
                  : tr("上の「消すもの」を、このクローンから消します。")}
              </p>
              <p className="setup-slot">
                {tr("次のコマンドを deguboard のターミナルで実行します")}
              </p>
              <CopyableCode
                text={uninstallCommandLine(personal)}
                label={tr("{0} をコピー", uninstallCommandLine(personal))}
              />
              <div className="setup-uninstall-buttons">
                <button type="button" className="setup-danger" onClick={run}>
                  {tr("外す")}
                </button>
                <button type="button" onClick={() => setConfirming(false)}>
                  {tr("やめる")}
                </button>
              </div>
            </div>
          ) : (
            <div className="setup-uninstall-buttons">
              <button
                type="button"
                className="setup-danger"
                disabled={data === null || blocked}
                onClick={() => setConfirming(true)}
              >
                {tr("外す…")}
              </button>
              {blocked ? (
                <span className="muted setup-note">{tr("止める理由がなくなると押せます。")}</span>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * 外した後の知らせ。画面から dg uninstall を実行した後、ボードがなくなって必須を満たさないチェックリストに替わったときに、その上に出す。
 * 拡張は自分では消さない（ほかのリポジトリでも使う）。消すのは最後にすること（先に消すと、ほかのリポジトリに残ったフックが呼ぶ dg がなくなる）を
 * 知らせ、拡張の画面を開くボタンだけを置く
 */
export function UninstalledNotice() {
  const host = useHost();
  const store = useStore();
  const { setupAct } = host;
  const [shown, setShown] = useState(
    () => host.state.get<string>(SETUP_UNINSTALL_KEY) !== undefined,
  );
  useEffect(() => {
    if (host.state.get<string>(SETUP_UNINSTALL_KEY) === "started")
      host.state.set(SETUP_UNINSTALL_KEY, "shown");
  }, [host]);
  if (!shown || !setupAct) return null;
  const close = (): void => {
    host.state.remove(SETUP_UNINSTALL_KEY);
    setShown(false);
  };
  return (
    <div className="setup-uninstalled" role="status">
      <strong>{tr("このリポジトリから deguboard を外しました")}</strong>
      <span>
        {tr(
          "VS Code 拡張と dg コマンドは残っています。拡張を消すのは最後にしてください（先に消すと、ほかのリポジトリに残ったフックが動かなくなります）。ほかのリポジトリでも使わないなら、拡張の画面から消せます。",
        )}
      </span>
      <span className="setup-band-buttons">
        <button
          type="button"
          onClick={() =>
            void setupAct("showExtension").catch((error: unknown) => {
              const f = failureOf(error);
              store.notify({ kind: "error", text: f.message, detail: f.detail });
            })
          }
        >
          {tr("拡張の画面を開く")}
        </button>
        <button type="button" className="link" onClick={close}>
          {tr("閉じる")}
        </button>
      </span>
    </div>
  );
}
