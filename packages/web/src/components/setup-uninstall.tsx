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
import { useEffect, useRef, useState } from "react";
import { failureOf } from "../client/http.js";
import { useHost, type Host } from "../host.js";
import { msg, tr } from "../l10n.js";
import { useStore } from "../store.js";
import { SETUP_UNINSTALL_KEY, type UninstallMarker } from "../ui-state.js";
import { CopyableCode } from "./copyable-code.js";

/**
 * 実行してから、ボードがまだ残っているかを確かめ直すまでの時間。dg uninstall はふつう数秒で終わるので、これだけ待ってもボードが
 * 残っていれば、外れなかった（dg が断った、ターミナルが実行中で送らなかった）とみなす。すぐに確かめないのは、消している途中の結果を
 * 外れなかったと取り違えないため
 */
export const UNINSTALL_SETTLE_MS = 15_000;

/** 画面から dg uninstall を実行したことの印（ui-state.ts の SETUP_UNINSTALL_KEY）。形の違う値（前の版の文字列）は読まない */
function markerOf(host: Host): UninstallMarker | undefined {
  const value = host.state.get<unknown>(SETUP_UNINSTALL_KEY);
  return typeof value === "object" && value !== null && "cwd" in value
    ? (value as UninstallMarker)
    : undefined;
}

/** 消すものにボード（worktree か手元のブランチ）が残っているか */
function hasBoard(data: UninstallPreview): boolean {
  return data.removes.some((i) => i.kind === "data_worktree" || i.kind === "data_branch");
}

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
 * revision は確かめ直しのたびに変わる値（チェックリストの view）で、変わると消すものを取り直す。cwd は確かめたフォルダ（view.cwd）
 */
export function UninstallSection({
  initiallyOpen,
  revision,
  cwd,
}: {
  initiallyOpen: boolean;
  revision: unknown;
  cwd: string | null;
}) {
  const host = useHost();
  const store = useStore();
  const { setupAct, uninstallPreview } = host;
  const [open, setOpen] = useState(initiallyOpen);
  const [personal, setPersonal] = useState(false);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** running は実行した後、stalled は待ってもボードが残っていた（外れなかった）後 */
  const [started, setStarted] = useState<"running" | "stalled" | null>(null);
  /** 実行した時刻。消すものを取り直した結果から、外れなかったことを見分けるのに使う */
  const startedAt = useRef<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  /** 同期の後と、実行して待った後に取り直すための数（どちらも確かめ直しを起こさないので） */
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // 節が出るのは、このフォルダにボードがある間だけ。出し直したときにこのフォルダの印が残っていれば、前の実行では外れなかったか、
    // 外した後に入れ直している。どちらも印を残さない（次に必須を満たさなくなったときに、外したと言わないように）
    if (markerOf(host)?.cwd === cwd) host.state.remove(SETUP_UNINSTALL_KEY);
  }, [host, cwd]);

  useEffect(() => {
    if (started !== "running") return;
    const timer = setTimeout(() => setTick((n) => n + 1), UNINSTALL_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [started]);

  useEffect(() => {
    if (!open || !uninstallPreview) return;
    let stale = false;
    uninstallPreview(personal).then(
      (data) => {
        if (stale) return;
        setChecked({ personal, data });
        // 実行の後も節が出ていて、取り直した結果にボードが残っている：外れなかった。印を消し、外した後の知らせを出させない。
        // 止める理由があれば dg は必ず断るので、すぐに外れなかったと分かる。なければ、消している途中かもしれないので待ってから見る
        const at = startedAt.current;
        if (at === null) return;
        const refused = data.blockers.length > 0;
        if (refused || (hasBoard(data) && Date.now() - at >= UNINSTALL_SETTLE_MS)) {
          startedAt.current = null;
          if (markerOf(host)?.cwd === cwd) host.state.remove(SETUP_UNINSTALL_KEY);
          setStarted(refused ? null : "stalled");
        }
      },
      (error: unknown) => {
        if (!stale) setChecked({ personal, error: failureOf(error).message });
      },
    );
    return () => {
      stale = true;
    };
  }, [open, personal, revision, tick, uninstallPreview, host, cwd]);

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
    if (markerOf(host)?.cwd === cwd) host.state.remove(SETUP_UNINSTALL_KEY);
    startedAt.current = null;
    setStarted(null);
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
    // 外した後の画面（必須を満たさないチェックリスト）が知らせを出せるように、実行したことを先に残す。Webview の状態はフォルダごとでは
    // ないので、実行したフォルダを持たせる（ほかのフォルダのチェックリストに、外したと言わせない）
    const marker: UninstallMarker = { cwd };
    host.state.set(SETUP_UNINSTALL_KEY, marker);
    startedAt.current = Date.now();
    setStarted("running");
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
              {started === "running"
                ? tr(
                    "deguboard のターミナルで実行しました。外し終わると、この画面は始めるときのチェックリストに戻ります。",
                  )
                : tr("まだ外れていません。deguboard のターミナルの出力を確かめてください。")}
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
 * 知らせ、拡張の画面を開くボタンだけを置く。出すのは、実行したフォルダ（印の cwd）のチェックリストにだけ（cwd は view.cwd）。
 * 印は、ボードが戻ったとき（app.tsx）と節を出し直したときに消える。
 * requested は、コマンドパレットの「このリポジトリからアンインストール」で開いたとき。画面から外した後でなければ、黙って
 * チェックリストだけを出さずに、外すものがないことを 1 行で知らせる
 */
export function UninstalledNotice({ cwd, requested }: { cwd: string | null; requested: boolean }) {
  const host = useHost();
  const store = useStore();
  const { setupAct } = host;
  const [closed, setClosed] = useState(false);
  if (!setupAct || !host.uninstallPreview || closed) return null;
  if (markerOf(host)?.cwd !== cwd)
    return requested ? (
      <p className="muted" role="status">
        {tr("ボードがないので、この画面から外すものはありません。")}
      </p>
    ) : null;
  const close = (): void => {
    host.state.remove(SETUP_UNINSTALL_KEY);
    setClosed(true);
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
