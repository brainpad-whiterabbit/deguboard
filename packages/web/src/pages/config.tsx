// 設定画面（#/config）。config.show の fields で葉の項目を既定値・文（configDescription で表示言語の訳にする）・範囲（scope）つきで読み、
// 「チーム」と「自分」のタブで書き分ける。値を変えるたびに 1 項目ずつ保存する。
// 振り返りの観点（retro.perspectives）は観点ごとの入れ子で 1 つの欄に収まらず fields に入らないので、この画面には出さない（dg retro が書く）。
// 項目の文は短く出す：要約（summary）1 行をいつも出し、詳しい説明（description）の全文は「詳しく」に畳む。例（example）は入力欄のプレースホルダに、
// 空のときの動き（empty）は欄の下の 1 行に、選択肢のある項目は選んでいる値の説明（option_descriptions）だけを出す。
// guide.notes.* は同じ説明の項目なので、説明を 1 つだけ出し、差し込む先ごとの行の表にする。
// 検索は表示名・キー・要約・詳しい説明に当て、詳しい説明だけに当たった項目は「詳しく」を開いて出す（当たった文が畳まれて見えないため）。
// - チーム：fields の全項目を出し、チームで共有する config.yaml の値（view.team）を config.set で書く。欄に個人の上書きを重ねない
//   （重ねた値を出すと保存が効かなかったように見える）。自分で上書きしている項目には「自分：値」の印を出し、押すと自分のタブのその項目に移る
// - 自分：個人で上書きできる項目（scope が local）だけを出し、deguboard-local/config.yaml（view.local）を config.set --local で書く。
//   「自分の値を使う」を入れるとチームの値を自分の値として写し、外すと config.unset --local で上書きを外してチームの値を出す
// VS Code の settings.json は使わない（requirements.md 5.10）。左パネルのビューのタイトル行の歯車で開け閉めする。
// 選択欄とチェックは変えたらすぐ、テキストと数は Enter か欄を離れたとき、リストは足す・外すたびに保存する。
// 同期先とブランチの判定・worktree の置き場所・実行するコマンドとエージェントに許す操作を変える項目（CONFIRM_KEYS）は、どちらのタブでも保存の前に欄の下で確かめる
// （自分の値を外して効く値が変わるときも確かめる。空にすると既定に戻る項目を空にするときは、戻る既定の値を出す）。拒否されたら理由を項目の下にだけ出し（上の通知の帯には出さない）、値を保存されている値に戻す。
// 保存は通って読み直しだけが失敗したら、保存できたことと読み直せないことを分けて出し、欄は保存した値で出す

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { failureOf } from "../client/http.js";
import { useStore } from "../store.js";
import type { ConfigField, ConfigScope, ConfigShowView } from "../types.js";
import { configDescription, shownConfigValue, storedConfigValue, tr, msg } from "../l10n.js";
import { trNode } from "../l10n-node.js";

/** 画面のまとまり。キーの最上位（commit.mode なら commit）で振り分ける */
const GROUPS: { id: string; label: string; tops: string[] }[] = [
  { id: "commit", label: msg("コミットと push"), tops: ["commit", "push"] },
  {
    id: "agent",
    label: msg("エージェント"),
    tops: ["actions", "auto", "flow", "work", "merge", "review", "lint", "models", "actor"],
  },
  { id: "metrics", label: msg("計測"), tops: ["metrics"] },
  { id: "notify", label: msg("通知"), tops: ["notify"] },
  { id: "git", label: "Git", tops: ["git", "worktree", "default_project"] },
  { id: "ticket", label: msg("チケット"), tops: ["priority"] },
  { id: "guide", label: msg("ガイドの差し込み"), tops: ["guide"] },
];
/** GROUPS に入っていない項目（スキーマに足したばかりのもの）の受け皿 */
const OTHER_GROUP = { id: "other", label: msg("その他") };

/** 項目の表示名。ないものはキーをそのまま出す */
const NAMES: Record<string, string> = {
  "commit.mode": msg("コミットの仕方"),
  "push.mode": msg("push の仕方"),
  "actions.shell": msg("シェルの Action を許す"),
  "actions.test": msg("テストのコマンド"),
  "actions.light_test": msg("軽い検査のコマンド"),
  "actions.light_paths": msg("軽い検査で済ませるパス"),
  "auto.merge": msg("PR を自動でマージする"),
  "auto.decisions": msg("--auto で自動で選ぶ判断"),
  "flow.skip": msg("流れから外す段階"),
  "work.parallel": msg("同時に進めるチケットの上限"),
  "merge.method": msg("マージの方法"),
  "merge.delete_branch": msg("マージしたら作業ブランチを消す"),
  "merge.approval_overrides": msg("人の承認で越えてよい品質ゲートの条件"),
  "review.heavy_categories": msg("重いとみなす見直しの指摘の種類"),
  "lint.require_iteration": msg("Iteration に入れてから進める"),
  "models.light": msg("段階 light のモデル"),
  "models.standard": msg("段階 standard のモデル"),
  "models.heavy": msg("段階 heavy のモデル"),
  // agent ごとの上書き。core の、呼んだ agent を判定できる Adapter の一覧を写すので、そういう Adapter を足したらここにも足す（どの項目にも名前があることをテストが確かめる）
  "models.claude-code.light": msg("段階 light のモデル（Claude Code）"),
  "models.claude-code.standard": msg("段階 standard のモデル（Claude Code）"),
  "models.claude-code.heavy": msg("段階 heavy のモデル（Claude Code）"),
  "models.codex.light": msg("段階 light のモデル（Codex）"),
  "models.codex.standard": msg("段階 standard のモデル（Codex）"),
  "models.codex.heavy": msg("段階 heavy のモデル（Codex）"),
  "actor.human_only": msg("人だけに許すコマンド"),
  "metrics.read_transcripts": msg("会話記録から使用量を読む"),
  "notify.approvals": msg("承認待ちが増えたら通知する"),
  "git.remote": msg("同期先のリモート"),
  "git.base_branch": msg("基準のブランチ"),
  "worktree.root": msg("worktree の置き場所"),
  "worktree.setup": msg("worktree の準備のコマンド"),
  default_project: msg("既定の Project"),
  "priority.high": msg("優先度 high の判断基準"),
  "priority.medium": msg("優先度 medium の判断基準"),
  "priority.low": msg("優先度 low の判断基準"),
  "guide.notes.overview": msg("差し込む文書（概要）"),
  "guide.notes.import": msg("差し込む文書（起票）"),
  "guide.notes.assign": msg("差し込む文書（割り当て）"),
  "guide.notes.check": msg("差し込む文書（点検）"),
  "guide.notes.plan": msg("差し込む文書（計画）"),
  "guide.notes.work": msg("差し込む文書（作業）"),
  "guide.notes.run": msg("差し込む文書（Run）"),
  "guide.notes.parallel": msg("差し込む文書（並べて進める）"),
  "guide.notes.review": msg("差し込む文書（見直しと品質ゲート）"),
  "guide.notes.audit": msg("差し込む文書（リポジトリの見直し）"),
  "guide.notes.release": msg("差し込む文書（リリース）"),
  "guide.notes.done": msg("差し込む文書（完了）"),
  "guide.notes.change": msg("差し込む文書（書き換え）"),
  "guide.notes.discuss": msg("差し込む文書（検討）"),
  "guide.notes.status": msg("差し込む文書（様子）"),
  "guide.notes.retro": msg("差し込む文書（振り返り）"),
  "guide.notes.all": msg("差し込む文書（一気通し）"),
};

/**
 * guide.notes.* の表の行に出す、差し込む先（ガイドの topic）の短い名前。ないものは topic をそのまま出す。
 * core の GUIDE_TOPICS を写すので、topic を足したらここにも足す（どの topic にも名前があることをテストが確かめる）
 */
const NOTE_LABELS: Record<string, string> = {
  overview: msg("概要"),
  import: msg("チケットの起票"),
  assign: msg("割り当て"),
  check: msg("点検"),
  plan: msg("計画"),
  work: msg("作業"),
  run: "Run",
  parallel: msg("並べて進める"),
  review: msg("見直しと品質ゲート"),
  audit: msg("リポジトリの見直し"),
  release: msg("リリース"),
  done: msg("完了"),
  change: msg("書き換え"),
  discuss: msg("検討"),
  status: msg("様子"),
  retro: msg("振り返り"),
  all: msg("一気通し"),
};

const NOTE_PREFIX = "guide.notes.";

/** guide.notes.* の項目か（説明を 1 つにまとめて表で出す） */
function isNoteKey(key: string): boolean {
  return key.startsWith(NOTE_PREFIX);
}

/** guide.notes.* の表の行の名前 */
function noteLabel(key: string): string {
  const topic = key.slice(NOTE_PREFIX.length);
  const label = NOTE_LABELS[topic];
  return label === undefined ? topic : tr(label);
}

/**
 * 保存の前に確かめる項目と、確かめの文に出す変わること。誤ると同期・照合・worktree・実行するコマンド・エージェントに許す操作を壊し、
 * 戻すまで気づきにくい（チームのタブでは全員に効く）。どちらのタブでも確かめる。
 * actions.test・actions.light_test と worktree.setup は確認なしで実行するコマンドなので、シェルの許可（actions.shell）と同じ重さで扱う。
 * auto.merge はエージェントに PR のマージを許すので、エージェントに許す操作として扱う（EX-7）
 */
export const CONFIRM_KEYS: ReadonlyMap<string, string> = new Map([
  ["git.remote", msg("同期先が変わる")],
  ["git.base_branch", msg("マージ済みの判定の基準が変わる")],
  ["worktree.root", msg("作業場所が変わる")],
  ["worktree.setup", msg("claim のたびに確認なしで回すコマンドが変わる（シェルを許すのと同じ）")],
  ["actions.test", msg("テストとして確認なしで実行するコマンドが変わる（シェルを許すのと同じ）")],
  [
    "actions.light_test",
    msg("軽い検査として確認なしで実行するコマンドが変わる（シェルを許すのと同じ）"),
  ],
  ["actions.shell", msg("エージェントが任意のシェルを実行できるかが変わる")],
  ["actor.human_only", msg("エージェントに許す操作が変わる")],
  ["auto.merge", msg("エージェントが PR を自動でマージするかが変わる")],
  ["auto.decisions", msg("エージェントが聞かずに選ぶ判断が変わる")],
  ["merge.approval_overrides", msg("人の承認で越えられる品質ゲートの条件が変わる")],
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

/**
 * 項目の値の表示。優先度の判断基準の既定のままの値は表示言語の訳で出す（UI-11）。field がなければ値のまま
 * （保存した・外した・チームの値・確かめの文・既定の表示が使う）
 */
function valueText(field: ConfigField | undefined, value: unknown): string {
  return formatValue(field ? shownConfigValue(field.key, value, field.default) : value);
}

/** 既定の値の表示（valueText の既定の版） */
function defaultText(field: ConfigField): string {
  return valueText(field, field.default);
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

/** 項目がいつも出す要約（今の言語）。要約がない項目は詳しい説明を要約の代わりに出す */
function summaryOf(field: ConfigField): string {
  return configDescription(field.summary || field.description);
}

/** 「詳しく」に畳む詳しい説明（今の言語）。要約と同じ文（要約がない項目も）なら畳むものはない（null） */
function detailOf(field: ConfigField): string | null {
  if (!field.summary || !field.description || field.summary === field.description) return null;
  return configDescription(field.description);
}

/**
 * 検索語がどこに当たるか（大文字小文字は区別しない）。表示名・キー・要約（今の言語で出している文）に当たれば shown、
 * 詳しい説明にだけ当たれば detail（画面は「詳しく」を開いて出す）、どれにも当たらなければ null。検索語が空なら shown
 */
export function fieldMatch(field: ConfigField, query: string): "shown" | "detail" | null {
  const q = query.trim().toLowerCase();
  if (!q) return "shown";
  const hit = (s: string) => s.toLowerCase().includes(q);
  if ([nameOf(field.key), field.key, summaryOf(field)].some(hit)) return "shown";
  const detail = detailOf(field);
  return detail !== null && hit(detail) ? "detail" : null;
}

/** 例の値の書き方（プレースホルダ）。リストの例は 1 つなら中身だけ、複数なら [a, b] */
function exampleText(field: ConfigField): string | undefined {
  const { example } = field;
  if (example === undefined) return undefined;
  const text =
    Array.isArray(example) && example.length === 1 ? String(example[0]) : formatValue(example);
  return tr("例 {0}", text);
}

/** 書き分ける先：チームの config.yaml か、個人の deguboard-local/config.yaml */
type Tab = ConfigScope;

/**
 * 空にすると既定に戻る（core の config.set が値を消す）項目と値か。
 * どの項目がそうかは core の項目の定義（config.show の fields の clears_to_default）が決め、画面では型や既定値から判断しない
 */
export function clearsToDefault(field: ConfigField, value: unknown): boolean {
  return field.clears_to_default && (value === "" || value === undefined || value === null);
}

interface Pending {
  tab: Tab;
  key: string;
  value: unknown;
  /** 自分の値を外す（config.unset --local）。value は外した後に効くチームの値 */
  unset?: boolean;
}

interface FieldMessage {
  /** error は保存できない。reload は保存は通ったが読み直せない（後で読み直せたら消す） */
  kind: "error" | "reload";
  text: string;
}

export function ConfigPage() {
  const store = useStore();
  const [view, setView] = useState<ConfigShowView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("team");
  const [query, setQuery] = useState("");
  /** 入力中の値（テキスト）。保存か取り消しかタブの切り替えで消す */
  const [drafts, setDrafts] = useState<Values>({});
  /** 確かめを待っている保存 */
  const [pending, setPending] = useState<Pending | null>(null);
  /** 保存中の項目。項目ごとに持ち、自分の保存が終わったときだけその項目を外す（重なった保存で先の終わりが後の印を消さない） */
  const [saving, setSaving] = useState<ReadonlySet<string>>(() => new Set());
  const [saved, setSaved] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, FieldMessage>>({});
  /** チームのタブの「自分：値」から移ったとき、自分のタブで前に出す項目 */
  const [focusKey, setFocusKey] = useState<string | null>(null);

  /**
   * config.show の読み始めの連番。読み直しは逆の順に返りうるので、最後に始めた読み直しの応答だけを画面に出す
   * （開いたときの読み込みと保存の後の読み直しで共有する）。保存の応答を画面に入れるときも進め、
   * 保存より前に始まった読み込みの古い応答を後から出さない
   */
  const showSeq = useRef(0);
  /** 保存の始めの連番。2 つの保存が重なったら、後に始めた保存の「保存した」だけを出す */
  const saveSeq = useRef(0);

  /** 設定を読む。後に始めた読み直しがあれば、古い応答は画面に出さない（読んだ値は返す） */
  const show = useCallback(async (): Promise<ConfigShowView> => {
    const seq = ++showSeq.current;
    const res = await store.client.run<ConfigShowView>("config.show", { fields: true });
    if (seq === showSeq.current) {
      setView(res.data);
      // 読み直せたので、前の保存の「読み直せない」は古い
      setMessages((m) => {
        const stale = Object.keys(m).filter((k) => m[k]!.kind === "reload");
        return stale.length ? stale.reduce((d, k) => without(d, k), m) : m;
      });
    }
    return res.data;
  }, [store.client]);

  const load = useCallback(async () => {
    try {
      await show();
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [show]);

  // 開いたときと、読み直し（同期・ファイルの変化・ほかの書き込み）が終わるたびに読み直す。
  // useCommandData は使わない：一覧が変わったとき（store.tickets）でなく、読み直しが終わったとき（store.loading）を合図にし、読み直しの間も読まないため
  useEffect(() => {
    // load は await の後でしか状態を変えないが、規則は同期の setState と見なす
    // oxlint-disable-next-line react/set-state-in-effect
    if (!store.loading) void load();
  }, [store.loading, load]);

  // 「自分：値」から移ったら、その項目を見える所に出し、「自分の値を使う」に焦点を移す
  useEffect(() => {
    if (tab !== "local" || focusKey === null) return;
    const row = document.querySelector<HTMLElement>(`.config-page [data-key="${focusKey}"]`);
    row?.scrollIntoView?.({ block: "center" });
    row?.querySelector<HTMLElement>(".config-own input")?.focus();
    // oxlint-disable-next-line react/set-state-in-effect
    setFocusKey(null);
  }, [tab, focusKey]);

  /** タブを切り替える。入力中の値と確かめの待ちはタブごとの値に対するものなので捨てる */
  const switchTab = useCallback((next: Tab, key: string | null = null) => {
    setTab(next);
    setDrafts({});
    setPending(null);
    setMessages({});
    setSaved(null);
    setFocusKey(key);
  }, []);

  /** 項目の定義（既定の表示と値の表示に使う）。読み終えるまでは undefined */
  const fieldFor = useCallback((key: string) => view?.fields.find((f) => f.key === key), [view]);

  /** 項目の保存中の印を付ける（on）か外す（!on）。ほかの項目の印には触れない */
  const markSaving = useCallback((key: string, on: boolean) => {
    setSaving((s) => {
      if (s.has(key) === on) return s;
      const next = new Set(s);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const save = useCallback(
    async (p: Pending) => {
      const { key } = p;
      const seq = ++saveSeq.current;
      const latest = () => seq === saveSeq.current;
      setPending(null);
      markSaving(key, true);
      setSaved(null);
      // store.run は失敗を上の通知の帯にも出すので使わない（拒否の理由は項目の下にだけ出す）。
      // 保存の失敗と、保存は通って読み直しだけが失敗したときは分けて出す
      let warnings: string[];
      /** 自分のタブの保存が返した、個人を重ねた値 */
      let merged: ConfigShowView["config"] | null = null;
      try {
        if (p.tab === "team") {
          // --local なしの config.set はチームの値を返す
          const res = await store.client.run<ConfigShowView["team"]>("config.set", {
            key,
            value: p.value,
          });
          warnings = res.warnings;
          // 保存より前に始まった読み込みの応答は、この保存の値を古い値に戻すので画面に出さない（showSeq を進める）
          showSeq.current++;
          setView((v) => (v ? { ...v, team: res.data } : v));
          if (latest())
            setSaved(
              tr("{0} を {1} にした", key, valueText(fieldFor(key), valueAt(res.data, key))),
            );
        } else {
          // --local の config.set・unset は個人を重ねた値しか返さない。上書きが残ったか（空文字で既定に戻す項目は
          // set でも上書きを消す）は core が決めるので、画面で推し量らずに config.show で個人の上書きを読み直す
          const res = p.unset
            ? await store.client.run<ConfigShowView["config"]>("config.unset", { key, local: true })
            : await store.client.run<ConfigShowView["config"]>("config.set", {
                key,
                value: p.value,
                local: true,
              });
          warnings = res.warnings;
          merged = res.data;
        }
      } catch (error) {
        // 値は保存されている値に戻す（下書きを消すと欄は view の値を出す）
        const [message, detail] = failureText(error);
        setMessages((m) => ({
          ...m,
          [key]: { kind: "error", text: tr("保存できない: {0}{1}", message, detail) },
        }));
        markSaving(key, false);
        setDrafts((d) => without(d, key));
        return;
      }
      setMessages((d) => without(d, key));
      if (warnings.length) store.notify({ kind: "info", text: warnings.join(" / ") });
      try {
        if (p.tab === "local") {
          const next = await show();
          if (latest()) setSaved(localSaved(key, next.config, key in next.local, fieldFor(key)));
        }
      } catch (error) {
        // 保存は通っている。下書きを消すと欄は view の値を出すので、保存した値を view に入れて保存前の値に戻さない
        // （上書きが残ったかは推し量る。空文字で上書きを消す項目は clearsToDefault で外すほうに回っている）
        const kept = !p.unset;
        if (merged) {
          const config = merged;
          showSeq.current++;
          setView((v) =>
            v
              ? {
                  ...v,
                  config,
                  local: kept ? { ...v.local, [key]: p.value } : without(v.local, key),
                }
              : v,
          );
          if (latest()) setSaved(localSaved(key, config, kept, fieldFor(key)));
        }
        // 読み直せなかったことは項目の下に分けて出す
        const [message, detail] = failureText(error);
        setMessages((m) => ({
          ...m,
          [key]: { kind: "reload", text: tr("保存したが、読み直せない: {0}{1}", message, detail) },
        }));
      } finally {
        markSaving(key, false);
        setDrafts((d) => without(d, key));
      }
      void store.reload();
    },
    [store, show, fieldFor, markSaving],
  );

  /** 自分の値を外す。確かめる項目で効く値が変わるときは確かめ、確かめの文は外すときのものにする */
  const unsetOwn = useCallback(
    (key: string) => {
      if (!view) return;
      const team = valueAt(view.team, key);
      const p: Pending = { tab: "local", key, value: team, unset: true };
      if (CONFIRM_KEYS.has(key) && isModified(view.local[key], team)) setPending(p);
      else void save(p);
    },
    [view, save],
  );

  /** 値を変えたとき。確かめる項目は待たせ、それ以外はすぐ保存する。変わっていなければ待ちを解くだけ */
  const change = useCallback(
    (key: string, value: unknown) => {
      if (!view) return;
      const current = tab === "team" ? valueAt(view.team, key) : view.local[key];
      if (!isModified(value, current)) {
        setDrafts((d) => without(d, key));
        // 確かめを待つ間に保存されている値へ戻したら、待っている古い値を保存させない
        setPending((p) => (p?.key === key ? null : p));
        return;
      }
      // 自分のタブで空にすると既定に戻る項目（clears_to_default）を空にすると、core は上書きを消す（config set --help）。外すのと同じに扱う
      const field = view.fields.find((f) => f.key === key);
      if (tab === "local" && field && clearsToDefault(field, value)) {
        unsetOwn(key);
        return;
      }
      const p: Pending = { tab, key, value };
      if (CONFIRM_KEYS.has(key)) setPending(p);
      else void save(p);
    },
    [view, tab, save, unsetOwn],
  );

  /**
   * 「自分の値を使う」の付け外し。入れるとチームの値を自分の値として写す（効く値は変わらないので確かめない）。
   * 外すと上書きを外してチームの値に戻す。確かめる項目で効く値が変わるときは確かめる
   */
  const toggleOwn = useCallback(
    (key: string, on: boolean) => {
      if (!view) return;
      if (on) void save({ tab: "local", key, value: valueAt(view.team, key) });
      else unsetOwn(key);
    },
    [view, save, unsetOwn],
  );

  const cancel = useCallback(() => {
    if (pending) setDrafts((d) => without(d, pending.key));
    setPending(null);
  }, [pending]);

  /** 出す項目のまとまりと、詳しい説明にだけ当たった項目（「詳しく」を開いて出す） */
  const { groups, detailHits } = useMemo(() => {
    const detailHits = new Set<string>();
    const fields = (view?.fields ?? []).filter((f) => {
      if (tab !== "team" && f.scope !== "local") return false;
      const match = fieldMatch(f, query);
      if (match === "detail") detailHits.add(f.key);
      return match !== null;
    });
    const groups = [...GROUPS, OTHER_GROUP]
      .map((g) => ({ ...g, fields: fields.filter((f) => groupOf(f.key) === g.id) }))
      .filter((g) => g.fields.length > 0);
    return { groups, detailHits };
  }, [view, tab, query]);

  const overrides = view ? Object.keys(view.local).length : 0;

  return (
    <div className="config-page">
      <h2 className="config-head">{tr("設定")}</h2>
      <div className="config-tabs" role="tablist" aria-label={tr("設定の書き先")}>
        <button
          type="button"
          role="tab"
          id="config-tab-team"
          aria-selected={tab === "team"}
          aria-controls="config-panel"
          className={`config-tab${tab === "team" ? " active" : ""}`}
          onClick={() => switchTab("team")}
        >
          {tr("チーム")}
        </button>
        <button
          type="button"
          role="tab"
          id="config-tab-local"
          aria-selected={tab === "local"}
          aria-controls="config-panel"
          className={`config-tab${tab === "local" ? " active" : ""}`}
          onClick={() => switchTab("local")}
        >
          {tr("自分")}
          {overrides > 0 ? (
            <span className="badge" title={tr("自分で上書きしている項目 {0} 件", overrides)}>
              {overrides}
            </span>
          ) : null}
        </button>
      </div>
      <div id="config-panel" role="tabpanel" aria-labelledby={`config-tab-${tab}`}>
        {tab === "team" ? (
          <p className="config-scope config-team" role="note">
            <strong>{tr("チーム全員に効く設定")}</strong>
            <span>
              {trNode(
                "deguboard ブランチの {0} に保存し、push すると同じリポジトリを使う全員に効く。自分だけ変えたい項目は「自分」のタブで上書きする",
                <code>config.yaml</code>,
              )}
            </span>
          </p>
        ) : (
          <p className="config-scope config-local" role="note">
            <strong>{tr("自分だけに効く設定")}</strong>
            <span>
              {trNode(
                "Git に入らない {0} に保存し、コミットも push もしない。上書きできる項目だけを出し、使わない項目はチームの値が効く",
                <code>deguboard-local/config.yaml</code>,
              )}
            </span>
          </p>
        )}
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
        {groups.map((g) => {
          const notes = g.fields.filter((f) => isNoteKey(f.key));
          return (
            <section key={g.id} className="config-group" aria-labelledby={`config-group-${g.id}`}>
              <h3 id={`config-group-${g.id}`}>{tr(g.label)}</h3>
              {g.fields.filter((f) => !isNoteKey(f.key)).map((f) => rowOf(f, "block"))}
              {notes.length > 0 ? (
                <NotesTable field={notes[0]!} detailOpen={notes.some((f) => detailHits.has(f.key))}>
                  {notes.map((f) => rowOf(f, "note"))}
                </NotesTable>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );

  /** 項目の行。block は説明つきの 1 項目、note は guide.notes.* の表の 1 行（説明は表の上に 1 つだけ出す） */
  function rowOf(f: ConfigField, layout: "block" | "note") {
    const team = valueAt(view!.team, f.key);
    const own = f.key in view!.local;
    const value = tab === "local" && own ? view!.local[f.key] : team;
    // 確かめを待つ間は、待っている項目のほかは入力欄も「既定に戻す」も触れない
    // （触れると待ちが移り、元の項目の下書きが確かめの枠なしで残る）
    const locked = saving.has(f.key) || (pending !== null && pending.key !== f.key);
    const confirm =
      pending?.key === f.key ? (
        <ConfirmBox
          field={f}
          pending={pending}
          onSave={() => void save(pending)}
          onCancel={cancel}
        />
      ) : null;
    if (tab === "team") {
      const modified = isModified(team, f.default);
      return (
        <FieldRow
          key={f.key}
          field={f}
          layout={layout}
          detailOpen={detailHits.has(f.key)}
          current={drafts[f.key] ?? value}
          marked={modified}
          badges={
            <>
              {modified ? (
                <span className="badge config-modified" title={tr("既定は {0}", defaultText(f))}>
                  {tr("変更あり")}
                </span>
              ) : null}
              {own ? (
                <button
                  type="button"
                  className="badge config-override"
                  title={tr("自分の値で上書きしている。押すと「自分」のタブで開く")}
                  onClick={() => switchTab("local", f.key)}
                >
                  {tr("自分：{0}", valueText(f, view!.local[f.key]))}
                </button>
              ) : null}
            </>
          }
          busy={saving.has(f.key)}
          message={messages[f.key]}
          confirm={confirm}
          actions={
            modified ? (
              <button
                type="button"
                className="config-reset"
                onClick={() => change(f.key, f.default)}
                disabled={locked}
                title={tr("既定の {0} に戻す", defaultText(f))}
              >
                {tr("既定に戻す")}
              </button>
            ) : null
          }
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
    }
    return (
      <FieldRow
        key={f.key}
        field={f}
        layout={layout}
        detailOpen={detailHits.has(f.key)}
        current={drafts[f.key] ?? value}
        marked={own}
        badges={
          own && isModified(value, team) ? (
            <span className="badge config-team-value">{tr("チーム：{0}", valueText(f, team))}</span>
          ) : null
        }
        busy={saving.has(f.key)}
        message={messages[f.key]}
        confirm={confirm}
        lead={
          <label className="config-check config-own">
            <input
              type="checkbox"
              checked={own}
              disabled={locked}
              onChange={(e) => toggleOwn(f.key, e.target.checked)}
            />
            {tr("自分の値を使う")}
          </label>
        }
        actions={own ? null : <span className="muted">{tr("チームの値を使っている")}</span>}
      >
        <FieldInput
          field={f}
          value={value}
          draft={drafts[f.key]}
          disabled={locked || !own}
          onDraft={(v) => setDrafts((d) => ({ ...d, [f.key]: v }))}
          onChange={(v) => change(f.key, v)}
        />
      </FieldRow>
    );
  }
}

function FieldRow({
  field,
  layout,
  detailOpen,
  current,
  marked,
  badges,
  busy,
  message,
  confirm,
  lead,
  actions,
  children,
}: {
  field: ConfigField;
  /** block は要約・欄の下の 1 行・「詳しく」つきの 1 項目、note は guide.notes.* の表の 1 行（説明は表の上の NotesTable が出す） */
  layout: "block" | "note";
  /** 検索が詳しい説明にだけ当たったので「詳しく」を開いて出す */
  detailOpen: boolean;
  /** 欄に出している値（入力中の値があればそれ）。選択肢の説明はこの値のものを出す */
  current: unknown;
  /** 左の線で示す（チームは既定から変えた項目、自分は上書きしている項目） */
  marked: boolean;
  badges: ReactNode;
  busy: boolean;
  message: FieldMessage | undefined;
  confirm: ReactNode;
  /** 入力欄の前に置くもの（自分のタブの「自分の値を使う」） */
  lead?: ReactNode;
  /** 入力欄の後に置くもの（「既定に戻す」など） */
  actions: ReactNode;
  children: ReactNode;
}) {
  const id = inputId(field.key);
  const className = `config-field${layout === "note" ? " config-note" : ""}${marked ? " modified" : ""}`;
  const status = (
    <>
      {badges}
      {busy ? <span className="muted">{tr("保存中…")}</span> : null}
    </>
  );
  const body = (
    <>
      {lead}
      <div className="config-control">
        {children}
        {actions}
      </div>
      {layout === "block" ? <FieldHints field={field} current={current} /> : null}
      {confirm}
      {message ? (
        <p className="config-error error" role="alert">
          {message.text}
        </p>
      ) : null}
    </>
  );
  if (layout === "note")
    return (
      <tr className={className} data-key={field.key}>
        <th scope="row">
          <label htmlFor={id} className="config-name" title={nameOf(field.key)}>
            {noteLabel(field.key)}
          </label>
          <code className="config-key">{field.key}</code>
        </th>
        <td>
          <div className="config-field-head">{status}</div>
          {body}
        </td>
      </tr>
    );
  const detail = detailOf(field);
  return (
    <div className={className} data-key={field.key}>
      <div className="config-field-head">
        <label htmlFor={id} className="config-name">
          {nameOf(field.key)}
        </label>
        <code className="config-key">{field.key}</code>
        {status}
      </div>
      <p className="config-summary muted">{summaryOf(field)}</p>
      {body}
      {detail !== null ? <FieldDetail text={detail} open={detailOpen} /> : null}
    </div>
  );
}

/**
 * 欄の下の 1 行：選択肢のある項目は選んでいる値（リストは入っている値ごと）の説明だけを、空にできる項目は空のときの動きを出す。
 * 選択肢の説明は欄に出している値から引くので、値を変えると説明も替わる
 */
function FieldHints({ field, current }: { field: ConfigField; current: unknown }) {
  const options = field.option_descriptions;
  const chosen = options
    ? (Array.isArray(current) ? current : [current])
        .map(String)
        .filter((v) => Object.hasOwn(options, v))
    : [];
  return (
    <>
      {chosen.length > 0 ? (
        <ul className="config-hint config-option-hints" aria-label={tr("選んでいる値の説明")}>
          {chosen.map((v) => (
            <li key={v}>
              <code>{v}</code> {configDescription(options![v]!)}
            </li>
          ))}
        </ul>
      ) : null}
      {field.empty !== undefined ? (
        <p className="config-hint config-empty muted">
          {tr("空のとき: {0}", configDescription(field.empty))}
        </p>
      ) : null}
    </>
  );
}

/** 詳しい説明の全文。畳んで出し、検索が詳しい説明にだけ当たったときは開いて出す（開いた後は利用者が開け閉めできる） */
function FieldDetail({ text, open }: { text: string; open: boolean }) {
  return (
    <details className="config-more" open={open}>
      <summary>{tr("詳しく")}</summary>
      <p className="config-detail muted">{text}</p>
    </details>
  );
}

/**
 * guide.notes.* の表。どの行も同じ説明（core の noteField）なので、要約・空のときの動き・「詳しく」を表の上に 1 つだけ出し、
 * 行は差し込む先の名前と入力欄だけにする。field は説明を引く代表の項目
 */
function NotesTable({
  field,
  detailOpen,
  children,
}: {
  field: ConfigField;
  detailOpen: boolean;
  children: ReactNode;
}) {
  const detail = detailOf(field);
  return (
    <div className="config-notes">
      <p className="config-summary muted">{summaryOf(field)}</p>
      <FieldHints field={field} current={undefined} />
      {detail !== null ? <FieldDetail text={detail} open={detailOpen} /> : null}
      <table className="config-notes-table">
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** 自分のタブで保存した後の「保存した」の文。kept は上書きが残ったか */
function localSaved(
  key: string,
  config: ConfigShowView["config"],
  kept: boolean,
  field: ConfigField | undefined,
): string {
  const value = valueText(field, valueAt(config, key));
  return kept
    ? tr("{0} を自分だけ {1} にした", key, value)
    : tr("{0} の自分の値を外した（チームの {1} を使う）", key, value);
}

/** 項目の下に出す失敗の理由と、括弧で包んだ詳細（なければ空） */
function failureText(error: unknown): [string, string] {
  const f = failureOf(error);
  return [f.message, f.detail ? tr("（{0}）", f.detail) : ""];
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
          placeholder={exampleText(field)}
          choices={field.option_descriptions ? Object.keys(field.option_descriptions) : undefined}
          disabled={disabled}
          onChange={(items) => {
            onDraft(items);
            onChange(items);
          }}
        />
      );
    default:
      // 数の項目（work.parallel）も打った文のまま送り、core の config.set が数に直して範囲を確かめる
      return (
        <input
          id={id}
          type={field.type === "number" ? "number" : "text"}
          className="config-text"
          placeholder={exampleText(field)}
          value={String(draft ?? shownConfigValue(field.key, value, field.default) ?? "")}
          disabled={disabled}
          onChange={(e) => onDraft(e.target.value)}
          onBlur={(e) => {
            // 表示した文のまま離れたら値を変えない（何もしないで離れて、訳の文を config.yaml に書き込まないため）。
            // 文を書き換えたときだけ、訳の文なら既定の値に戻す（storedConfigValue）
            const text = e.target.value;
            const shown = String(shownConfigValue(field.key, value, field.default) ?? "");
            onChange(text === shown ? value : storedConfigValue(field.key, text, field.default));
          }}
          onKeyDown={(e) => {
            // 欄を離れたときに保存する（Enter と blur で 2 回保存しない）
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") onDraft(undefined);
          }}
        />
      );
  }
}

/**
 * リストの入力欄。項目を札で並べ、× で外し、下の欄に打って Enter か「足す」で末尾に足す。
 * 例のある項目は足す欄のプレースホルダに例を出し、選択肢のある項目（choices）は入っていない選択肢を候補（datalist）に出す
 */
function ListInput({
  id,
  items,
  placeholder,
  choices,
  disabled,
  onChange,
}: {
  id: string;
  items: string[];
  placeholder: string | undefined;
  choices: string[] | undefined;
  disabled: boolean;
  onChange(items: string[]): void;
}) {
  const rest = choices?.filter((c) => !items.includes(c));
  const listId = `${id}-choices`;
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
          placeholder={placeholder ?? tr("項目を足す")}
          list={rest ? listId : undefined}
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
        {rest ? (
          <datalist id={listId}>
            {rest.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        ) : null}
      </span>
    </div>
  );
}

/** 確かめる項目の保存の前に出す枠。保存するまで値は config.yaml（自分のタブでは deguboard-local/config.yaml）に書かない */
function ConfirmBox({
  field,
  pending,
  onSave,
  onCancel,
}: {
  field: ConfigField;
  pending: Pending;
  onSave(): void;
  onCancel(): void;
}) {
  const key = <code>{field.key}</code>;
  const value = <code>{valueText(field, pending.value)}</code>;
  const effect = tr(CONFIRM_KEYS.get(field.key) ?? "");
  return (
    <div
      className="config-confirm"
      role="alertdialog"
      aria-label={tr("{0} の保存の確認", field.key)}
    >
      <p>
        {pending.tab === "team"
          ? clearsToDefault(field, pending.value)
            ? // 空にすると core が値を消して既定に戻す（config.set の clears_to_default）。空の値でなく戻る既定の値を出す
              trNode(
                "{0} を空にし、既定の {1} に戻す。{2}。チーム全員に効く。保存する？",
                key,
                <code>{defaultText(field)}</code>,
                effect,
              )
            : trNode("{0} を {1} にする。{2}。チーム全員に効く。保存する？", key, value, effect)
          : pending.unset
            ? trNode(
                "{0} の自分の値を外し、チームの {1} に戻す。{2}。自分だけに効く。保存する？",
                key,
                value,
                effect,
              )
            : trNode("{0} を {1} にする。{2}。自分だけに効く。保存する？", key, value, effect)}
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
