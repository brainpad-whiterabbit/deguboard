// 設定画面（#/config）。config.show の fields で config.yaml の全項目を既定値・説明（スキーマの describe）つきで読み、
// 値を変えるたびに config.set で 1 項目ずつ保存する。読み書きするのはチームで共有する config.yaml の値（view.team）で、
// 個人の上書き（deguboard-local/config.yaml。CLI の config set --local）は欄に出さない（重ねた値を出すと保存が効かなかったように見える）。
// VS Code の settings.json は使わない（requirements.md 5.10）。左パネルではビューのタイトル行の歯車、ブラウザでは上のバーの歯車で開け閉めし、画面の中の「前の画面に戻る」も歯車と同じく来る前の画面に戻る。
// 選択欄とチェックは変えたらすぐ、テキストは Enter か欄を離れたとき、リストは足す・外すたびに保存する。
// 同期先とブランチの判定・worktree の置き場所・実行するコマンドとエージェントに許す操作を変える項目（CONFIRM_KEYS）は、保存の前に欄の下で確かめる。
// 拒否されたら理由を項目の下にだけ出し（上の通知の帯には出さない）、値を保存されている値に戻す

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { failureOf } from "../client/http.js";
import { hrefOf, toggleRoute } from "../router.js";
import { useStore } from "../store.js";
import type { ConfigField, ConfigShowView } from "../types.js";
import { tr, msg } from "../l10n.js";
import { trNode } from "../l10n-node.js";

/** 画面のまとまり。キーの最上位（commit.mode なら commit）で振り分ける */
const GROUPS: { id: string; label: string; tops: string[] }[] = [
  { id: "commit", label: msg("コミットと push"), tops: ["commit", "push"] },
  { id: "agent", label: msg("エージェント"), tops: ["actions", "auto", "lint", "models", "actor"] },
  { id: "metrics", label: msg("計測"), tops: ["metrics"] },
  { id: "notify", label: msg("通知"), tops: ["notify"] },
  { id: "git", label: "Git", tops: ["git", "worktree", "default_project"] },
  { id: "ticket", label: msg("チケット"), tops: ["priority"] },
];
/** GROUPS に入っていない項目（スキーマに足したばかりのもの）の受け皿 */
const OTHER_GROUP = { id: "other", label: msg("その他") };

/** 項目の表示名。ないものはキーをそのまま出す */
const NAMES: Record<string, string> = {
  "commit.mode": msg("コミットの仕方"),
  "push.mode": msg("push の仕方"),
  "actions.shell": msg("シェルの Action を許す"),
  "actions.test": msg("テストのコマンド"),
  "auto.merge": msg("PR を自動でマージする"),
  "lint.require_iteration": msg("Iteration に入れてから進める"),
  "models.light": msg("段階 light のモデル"),
  "models.standard": msg("段階 standard のモデル"),
  "models.heavy": msg("段階 heavy のモデル"),
  "actor.human_only": msg("人だけに許すコマンド"),
  "metrics.read_transcripts": msg("会話記録から使用量を読む"),
  "notify.approvals": msg("承認待ちが増えたら通知する"),
  "git.remote": msg("同期先のリモート"),
  "git.base_branch": msg("基準のブランチ"),
  "worktree.root": msg("worktree の置き場所"),
  default_project: msg("既定の Project"),
  "priority.high": msg("優先度 high の判断基準"),
  "priority.medium": msg("優先度 medium の判断基準"),
  "priority.low": msg("優先度 low の判断基準"),
};

/**
 * 保存の前に確かめる項目と、確かめの文に出す変わること。誤るとチーム全員に効き、戻すまで気づきにくい。
 * actions.test は確認なしで実行するコマンドなので、シェルの許可（actions.shell）と同じ重さで扱う。
 * auto.merge はエージェントに PR のマージを許すので、エージェントに許す操作として扱う（ADR-006・ADR-007）
 */
export const CONFIRM_KEYS: ReadonlyMap<string, string> = new Map([
  ["git.remote", msg("同期先が変わる")],
  ["git.base_branch", msg("マージ済みの判定の基準が変わる")],
  ["worktree.root", msg("作業場所が変わる")],
  ["actions.test", msg("テストとして確認なしで実行するコマンドが変わる（シェルを許すのと同じ）")],
  ["actions.shell", msg("エージェントが任意のシェルを実行できるかが変わる")],
  ["actor.human_only", msg("エージェントに許す操作が変わる")],
  ["auto.merge", msg("エージェントが PR を自動でマージするかが変わる")],
]);

type Values = Record<string, unknown>;

/** key を外した写し */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

/** config（入れ子）から項目のキー（commit.mode）の値を引く */
export function valueAt(config: unknown, key: string): unknown {
  let cursor = config;
  for (const k of key.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[k];
  }
  return cursor;
}

/** 既定から変えたか。リストは中身で比べる */
export function isModified(value: unknown, defaultValue: unknown): boolean {
  return JSON.stringify(value) !== JSON.stringify(defaultValue);
}

/** 保存した値の短い書き方。リストは [a, b]、空のリストは「空」 */
export function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? tr("空") : `[${value.join(", ")}]`;
  return String(value);
}

export function groupOf(key: string): string {
  const top = key.split(".")[0] ?? key;
  return GROUPS.find((g) => g.tops.includes(top))?.id ?? OTHER_GROUP.id;
}

export function nameOf(key: string): string {
  const name = NAMES[key];
  return name === undefined ? key : tr(name);
}

/** 検索語が表示名・キー・説明のどれかに含まれるか（大文字小文字は区別しない） */
export function fieldMatchesQuery(field: ConfigField, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [nameOf(field.key), field.key, field.description].some((s) => s.toLowerCase().includes(q));
}

interface Pending {
  key: string;
  value: unknown;
}

interface FieldMessage {
  kind: "error";
  text: string;
}

export function ConfigPage() {
  const store = useStore();
  const [view, setView] = useState<ConfigShowView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** 入力中の値（テキスト）。保存か取り消しで消す */
  const [drafts, setDrafts] = useState<Values>({});
  /** 確かめを待っている保存 */
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, FieldMessage>>({});

  const load = useCallback(async () => {
    try {
      const res = await store.client.run<ConfigShowView>("config.show", { fields: true });
      setView(res.data);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [store.client]);

  // 開いたときと、読み直し（同期・ファイルの変化・ほかの書き込み）が終わるたびに読み直す。
  // useCommandData は使わない：一覧が変わったとき（store.tickets）でなく、読み直しが終わったとき（store.loading）を合図にし、読み直しの間も読まないため
  useEffect(() => {
    // load は await の後でしか状態を変えないが、規則は同期の setState と見なす
    // oxlint-disable-next-line react/set-state-in-effect
    if (!store.loading) void load();
  }, [store.loading, load]);

  const save = useCallback(
    async (key: string, value: unknown) => {
      setPending(null);
      setSaving(key);
      setSaved(null);
      // store.run は失敗を上の通知の帯にも出すので使わない（拒否の理由は項目の下にだけ出す）
      try {
        // --local なしの config.set はチームの値を返す
        const res = await store.client.run<ConfigShowView["team"]>("config.set", { key, value });
        setView((v) => (v ? { ...v, team: res.data } : v));
        setMessages((d) => without(d, key));
        setSaved(tr("{0} を {1} にした", key, formatValue(valueAt(res.data, key))));
        if (res.warnings.length) store.notify({ kind: "info", text: res.warnings.join(" / ") });
        void store.reload();
      } catch (error) {
        // 値は保存されている値に戻す（下書きを消すと欄は view の値を出す）
        const f = failureOf(error);
        const detail = f.detail ? tr("（{0}）", f.detail) : "";
        setMessages((m) => ({
          ...m,
          [key]: { kind: "error", text: tr("保存できない: {0}{1}", f.message, detail) },
        }));
      } finally {
        setSaving(null);
        setDrafts((d) => without(d, key));
      }
    },
    [store],
  );

  /** 値を変えたとき。確かめる項目は待たせ、それ以外はすぐ保存する。変わっていなければ待ちを解くだけ */
  const change = useCallback(
    (key: string, value: unknown) => {
      if (!view) return;
      if (!isModified(value, valueAt(view.team, key))) {
        setDrafts((d) => without(d, key));
        // 確かめを待つ間に保存されている値へ戻したら、待っている古い値を保存させない
        setPending((p) => (p?.key === key ? null : p));
        return;
      }
      if (CONFIRM_KEYS.has(key)) setPending({ key, value });
      else void save(key, value);
    },
    [view, save],
  );

  const cancel = useCallback(() => {
    if (pending) setDrafts((d) => without(d, pending.key));
    setPending(null);
  }, [pending]);

  const groups = useMemo(() => {
    const fields = (view?.fields ?? []).filter((f) => fieldMatchesQuery(f, query));
    return [...GROUPS, OTHER_GROUP]
      .map((g) => ({ ...g, fields: fields.filter((f) => groupOf(f.key) === g.id) }))
      .filter((g) => g.fields.length > 0);
  }, [view, query]);

  return (
    <div className="config-page">
      <div className="config-head">
        <h2>{tr("設定")}</h2>
        {/* 歯車と同じく、来る前の画面（なければカンバン）に戻る */}
        <button
          type="button"
          className="link config-back"
          onClick={() => toggleRoute(hrefOf({ page: "config" }))}
        >
          {tr("前の画面に戻る")}
        </button>
      </div>
      <p className="config-team" role="note">
        <strong>{tr("チーム全員に効く設定")}</strong>
        <span>
          {trNode(
            "deguboard ブランチの {0} に保存し、push すると同じリポジトリを使う全員に効く。自分だけの上書きは {1} で（この画面には出ない）",
            <code>config.yaml</code>,
            <code>dg config set --local</code>,
          )}
        </span>
      </p>
      <div className="config-tools">
        <input
          type="search"
          placeholder={tr("設定を検索（名前・キー・説明）")}
          aria-label={tr("設定を検索")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <p className="config-saved muted" role="status" aria-live="polite">
        {saved ? tr("保存した: {0}", saved) : null}
      </p>
      {loadError ? <p className="error">{trNode("設定を読めない: {0}", loadError)}</p> : null}
      {!view && !loadError ? <p className="muted">{tr("読み込み中…")}</p> : null}
      {view && groups.length === 0 ? <p className="empty">{tr("該当する設定がない")}</p> : null}
      {groups.map((g) => (
        <section key={g.id} className="config-group" aria-labelledby={`config-group-${g.id}`}>
          <h3 id={`config-group-${g.id}`}>{tr(g.label)}</h3>
          {g.fields.map((f) => {
            const value = valueAt(view!.team, f.key);
            const modified = isModified(value, f.default);
            // 確かめを待つ間は、待っている項目のほかは入力欄も「既定に戻す」も触れない
            // （触れると待ちが移り、元の項目の下書きが確かめの枠なしで残る）
            const locked = saving === f.key || (pending !== null && pending.key !== f.key);
            return (
              <FieldRow
                key={f.key}
                field={f}
                modified={modified}
                busy={saving === f.key}
                locked={locked}
                message={messages[f.key]}
                confirm={
                  pending?.key === f.key ? (
                    <ConfirmBox
                      field={f}
                      value={pending.value}
                      onSave={() => void save(f.key, pending.value)}
                      onCancel={cancel}
                    />
                  ) : null
                }
                onReset={() => change(f.key, f.default)}
              >
                <FieldInput
                  field={f}
                  value={value}
                  draft={drafts[f.key]}
                  disabled={locked}
                  onDraft={(v) => setDrafts((d) => ({ ...d, [f.key]: v }))}
                  onChange={(v) => change(f.key, v)}
                />
              </FieldRow>
            );
          })}
        </section>
      ))}
    </div>
  );
}

function FieldRow({
  field,
  modified,
  busy,
  locked,
  message,
  confirm,
  onReset,
  children,
}: {
  field: ConfigField;
  modified: boolean;
  busy: boolean;
  /** 入力欄と「既定に戻す」を押せなくする（保存中か、ほかの項目が確かめを待っている） */
  locked: boolean;
  message: FieldMessage | undefined;
  confirm: ReactNode;
  onReset(): void;
  children: ReactNode;
}) {
  const id = inputId(field.key);
  return (
    <div className={`config-field${modified ? " modified" : ""}`} data-key={field.key}>
      <div className="config-field-head">
        <label htmlFor={id} className="config-name">
          {nameOf(field.key)}
        </label>
        <code className="config-key">{field.key}</code>
        {modified ? (
          <span
            className="badge config-modified"
            title={tr("既定は {0}", formatValue(field.default))}
          >
            {tr("変更あり")}
          </span>
        ) : null}
        {busy ? <span className="muted">{tr("保存中…")}</span> : null}
      </div>
      <p className="config-desc muted">{field.description}</p>
      <div className="config-control">
        {children}
        {modified ? (
          <button
            type="button"
            className="config-reset"
            onClick={onReset}
            disabled={locked}
            title={tr("既定の {0} に戻す", formatValue(field.default))}
          >
            {tr("既定に戻す")}
          </button>
        ) : null}
      </div>
      {confirm}
      {message ? (
        <p className="config-error error" role="alert">
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

function inputId(key: string): string {
  return `config-${key.replace(/\./g, "-")}`;
}

function FieldInput({
  field,
  value,
  draft,
  disabled,
  onDraft,
  onChange,
}: {
  field: ConfigField;
  value: unknown;
  draft: unknown;
  disabled: boolean;
  onDraft(value: unknown): void;
  onChange(value: unknown): void;
}) {
  const id = inputId(field.key);
  switch (field.type) {
    case "enum":
      return (
        <select
          id={id}
          value={String(draft ?? value ?? "")}
          disabled={disabled}
          onChange={(e) => {
            onDraft(e.target.value);
            onChange(e.target.value);
          }}
        >
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
              {o === field.default ? tr("（既定）") : ""}
            </option>
          ))}
        </select>
      );
    case "boolean": {
      const checked = (draft ?? value) === true;
      return (
        <label className="config-check">
          <input
            id={id}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(e) => {
              onDraft(e.target.checked);
              onChange(e.target.checked);
            }}
          />
          {checked ? tr("有効") : tr("無効")}
        </label>
      );
    }
    case "list":
      return (
        <ListInput
          id={id}
          items={(draft ?? value ?? []) as string[]}
          disabled={disabled}
          onChange={(items) => {
            onDraft(items);
            onChange(items);
          }}
        />
      );
    default:
      return (
        <input
          id={id}
          type="text"
          className="config-text"
          value={String(draft ?? value ?? "")}
          disabled={disabled}
          onChange={(e) => onDraft(e.target.value)}
          onBlur={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // 欄を離れたときに保存する（Enter と blur で 2 回保存しない）
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") onDraft(undefined);
          }}
        />
      );
  }
}

/** リストの入力欄。項目を札で並べ、× で外し、下の欄に打って Enter か「足す」で末尾に足す */
function ListInput({
  id,
  items,
  disabled,
  onChange,
}: {
  id: string;
  items: string[];
  disabled: boolean;
  onChange(items: string[]): void;
}) {
  const [text, setText] = useState("");
  const add = () => {
    const v = text.trim();
    if (!v) return;
    setText("");
    onChange([...items, v]);
  };
  return (
    <div className="config-list">
      {items.length === 0 ? <span className="muted">{tr("空")}</span> : null}
      <ul aria-label={tr("項目")}>
        {items.map((item, i) => (
          <li key={`${i}-${item}`} className="config-list-item">
            <code>{item}</code>
            <button
              type="button"
              aria-label={tr("{0} を外す", item)}
              disabled={disabled}
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <span className="config-list-add">
        <input
          id={id}
          type="text"
          placeholder={tr("項目を足す")}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button type="button" onClick={add} disabled={disabled || !text.trim()}>
          {tr("足す")}
        </button>
      </span>
    </div>
  );
}

/** 確かめる項目の保存の前に出す枠。保存するまで値は config.yaml に書かない */
function ConfirmBox({
  field,
  value,
  onSave,
  onCancel,
}: {
  field: ConfigField;
  value: unknown;
  onSave(): void;
  onCancel(): void;
}) {
  return (
    <div
      className="config-confirm"
      role="alertdialog"
      aria-label={tr("{0} の保存の確認", field.key)}
    >
      <p>
        {trNode(
          "{0} を {1} にする。{2}。チーム全員に効く。保存する？",
          <code>{field.key}</code>,
          <code>{formatValue(value)}</code>,
          tr(CONFIRM_KEYS.get(field.key) ?? ""),
        )}
      </p>
      <div className="config-confirm-actions">
        <button type="button" className="primary" onClick={onSave}>
          {tr("保存する")}
        </button>
        <button type="button" onClick={onCancel}>
          {tr("やめる")}
        </button>
      </div>
    </div>
  );
}
