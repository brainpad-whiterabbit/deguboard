// 画面の状態。カンバンのチケット・Epic・Iteration・Plan・カンバンの Workflow と同期の状態を CommandClient から読み、書き込みのあとに読み直す。
// 状態管理のライブラリは入れず、React の context だけで持つ。
// cache を渡すと（VS Code の Webview）、読み終えた一覧を残しておき、次に開いたときはそれをすぐ描いてから読み直して差し替える。
// 最初の読み込みは core の中で 1 本ずつ処理されるコマンドが 7 本並び、サイドバーとパネルが同じ列を使うので、その間を空の画面にしない。
// 操作している人（whoami。主体の ID・ユーザ名と、本人とみなす ID の own_ids）も一覧と一緒に読み、me に持つ（担当者が自分かの判定に使う）。
// チケットごとの Run の要約（run.recent。件数と新しい順 3 件。このマシンの実行中の Run を含む）は、
// readRunning のとき（左パネルのカンバンの行の Run の並びに使う）だけ、ほかの一覧を描いた後に遅れて読む。
// cache には残さない（前回の「実行中」を次に開いたときに出さない）。
// 一覧を読めないとき（dg init 前・Git リポジトリの外・git がない）は、エラーの通知を出す前に導入のチェックリスト（client.setup。UI-12）を確かめ、
// 必須の項目を満たさなければ needsSetup にして画面にチェックリストを出させる。読めたときは、推奨の項目の帯を出す入口（setupBand）で、
// 人が帯を出さないと決めていない間だけ確かめて、帯に使う（出さないと決めた後も、タイトル行のアイコンからチェックリストを開けば
// 画面が recheckSetup で確かめる。app.tsx）

import type {
  CommandClient,
  CommandFailure,
  SetupBoardSource,
  SetupView,
  StatusView,
} from "@deguboard/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { failureOf, type SetupOptions } from "./client/http.js";
import type {
  ConfigShowView,
  EpicRow,
  Iteration,
  PlanRow,
  Priority,
  Status,
  TicketRow,
  TicketRunsView,
  WhoamiView,
  WorkflowView,
} from "./types.js";
import { SETUP_BAND_DISMISSED_KEY, type UiState } from "./ui-state.js";
import { shownDefault, shownWorkflow, tr } from "./l10n.js";

/** 優先度の判断基準（config.yaml の priority。config.show が core の既定を混ぜて返す）。読み終えるまでは空 */
const EMPTY_PRIORITY_CRITERIA: Record<Priority, string> = { high: "", medium: "", low: "" };

/**
 * config.show --fields の値から優先度の判断基準の表示を作る。既定のままの値は表示言語の訳にし、書き換えた値は書いた言葉のまま
 * （既定の値の決まり。判定と訳は shownDefault）。既定は fields の default（core が決める）で比べる
 */
function priorityCriteriaOf(view: ConfigShowView): Record<Priority, string> {
  const shown = (level: Priority) =>
    String(
      shownDefault(
        view.config.priority[level],
        view.fields.find((f) => f.key === `priority.${level}`)?.default,
      ),
    );
  return { high: shown("high"), medium: shown("medium"), low: shown("low") };
}

/** cache に残す一覧。読み直しが終わるたびに書き換える */
interface Snapshot {
  tickets: TicketRow[];
  epics: EpicRow[];
  iterations: Iteration[];
  plans: PlanRow[];
  workflow: WorkflowView | null;
  /** 前の版の cache にはないことがある */
  me?: WhoamiView | null | undefined;
}

/** cache の置き場の鍵。形が変わったら番号を上げて古いものを読まない */
export const SNAPSHOT_KEY = "store.snapshot.v4";
/** 前の版の鍵。読み直しの書き込みのときに消し、保存量を増やさない */
const OLD_SNAPSHOT_KEYS = ["store.snapshot.v1", "store.snapshot.v2", "store.snapshot.v3"];

export interface Notice {
  kind: "error" | "info";
  text: string;
  detail?: string | undefined;
}

export type RunResult<O> =
  | { ok: true; data: O; warnings: string[] }
  | { ok: false; error: CommandFailure };

export interface Store {
  client: CommandClient;
  tickets: TicketRow[];
  epics: EpicRow[];
  iterations: Iteration[];
  plans: PlanRow[];
  /** カンバンの Workflow（workflow.yaml。Status の表示名と Run の step の表示名は表示言語に訳したもの） */
  workflow: WorkflowView | null;
  /**
   * 操作している人（core の whoami の出力）。担当者が自分か自分の agent かは isOwnAssignee（own_ids に含まれるか）で決める。
   * 読み終えるまでは null
   */
  me: WhoamiView | null;
  /** チケットごとの Run の要約（run.recent。Run のないチケットは入らない）。読み終えるまでと、readRunning でないときは null */
  ticketRuns: ReadonlyMap<string, TicketRunsView> | null;
  status: StatusView | null;
  /** 優先度の値ごとの判断基準（config.yaml の priority、なければ core の既定）。印のツールチップと詳細の選択の説明に使う */
  priorityCriteria: Record<Priority, string>;
  loading: boolean;
  /** 最初の読み込みが終わったか。終わるまで画面は空状態の文言を出さない */
  loaded: boolean;
  /** 導入のチェックリスト（最後に確かめた結果）。確かめる口のない client と、確かめる前は null */
  setup: SetupView | null;
  /** 一覧を読めず、導入の必須の項目を満たさない（dg init 前・Git リポジトリの外・git がない）。画面は一覧の代わりにチェックリストを出す */
  needsSetup: boolean;
  /** 導入のチェックリストを確かめ直している最中（手で確かめ直すボタンを止める） */
  checkingSetup: boolean;
  /** 導入のチェックリストを確かめ直す。必須を満たさない間は一覧も読み直し、満たしたらいつもの画面に変わる */
  recheckSetup(): Promise<void>;
  /**
   * 入口の setup の通知（拡張ホストの見張り）を受けて確かめ直す。帯もチェックリストも出していない入口（setupBand でも needsSetup でもない）は
   * 何もしない
   */
  onSetupEvent(): Promise<void>;
  /**
   * 人がボードの項目で指定したデータの置き場所（チームのボードが別のリポジトリにあるとき）。指定していなければ null で、
   * コードのリモートを確かめる。ボタンの dg init にも同じ値を渡す。指定をフォルダごとに持つ入口（VS Code 拡張）では、確かめた結果の
   * board（左パネルとエディタのパネルのどちらで指定しても同じ）を写し、指定し直したときだけ付けて頼む。持たない入口（dg serve）では
   * 確かめ直すたびに付けて頼む
   */
  setupBoard: SetupBoardSource | null;
  /** データの置き場所を決めて（null でやめて）、確かめ直す */
  chooseSetupBoard(board: SetupBoardSource | null): Promise<void>;
  notice: Notice | null;
  /** すべて読み直す */
  reload(): Promise<void>;
  /** コマンドを実行し、成功したら読み直す。失敗は通知に出して ok: false で返す（画面側で戻す） */
  run<O = unknown>(name: string, input?: unknown): Promise<RunResult<O>>;
  notify(notice: Notice | null): void;
  /** Status の表示名（Workflow の labels） */
  labelOf(status: Status): string;
}

const StoreContext = createContext<Store | null>(null);

/** 同期の状態を読み直す間隔 */
export const STATUS_POLL_MS = 15_000;

export function StoreProvider({
  client,
  cache,
  readRunning = false,
  setupBand = false,
  children,
}: {
  /** setup（導入のチェックリストを確かめる口）は dg serve と Webview の client が持つ。持たなければチェックリストを出さない */
  client: CommandClient & {
    setup?: ((options?: SetupOptions) => Promise<SetupView>) | undefined;
  };
  /**
   * 前回の一覧の置き場。渡さなければ（dg serve）残さない。画面の見た目の状態と同じ置き場（host.state）で、
   * 推奨の項目の帯を出さないと決めたこと（SETUP_BAND_DISMISSED_KEY）もここから読む
   */
  cache?: UiState | undefined;
  /** チケットごとの Run の要約を読む（左パネル。カンバンの行の Run の並びに使う） */
  readRunning?: boolean | undefined;
  /**
   * 推奨の項目の帯を出す入口か（host.tsx の showsSetupBand）。出す入口でだけ、一覧を読めた後に導入の項目を確かめる
   * （人が帯を出さないと決めている間は確かめない）。出さない入口（エディタのパネル・dg serve）は、一覧を読めなかったときにだけ確かめ、
   * チェックリストを出していない間は setup の通知でも確かめ直さない（onSetupEvent）
   */
  setupBand?: boolean | undefined;
  children: ReactNode;
}) {
  const [cached] = useState(() => cache?.get<Snapshot>(SNAPSHOT_KEY));
  const [tickets, setTickets] = useState<TicketRow[]>(cached?.tickets ?? []);
  const [epics, setEpics] = useState<EpicRow[]>(cached?.epics ?? []);
  const [iterations, setIterations] = useState<Iteration[]>(cached?.iterations ?? []);
  const [plans, setPlans] = useState<PlanRow[]>(cached?.plans ?? []);
  const [workflow, setWorkflow] = useState<WorkflowView | null>(cached?.workflow ?? null);
  const [me, setMe] = useState<WhoamiView | null>(cached?.me ?? null);
  const [ticketRuns, setTicketRuns] = useState<ReadonlyMap<string, TicketRunsView> | null>(null);
  // 読み直しが重なったとき、古い読み直しの Run の要約で上書きしない
  const runningSeq = useRef(0);
  const [status, setStatus] = useState<StatusView | null>(null);
  const [priorityCriteria, setPriorityCriteria] =
    useState<Record<Priority, string>>(EMPTY_PRIORITY_CRITERIA);
  const [loading, setLoading] = useState(true);
  // 前回の一覧があれば、それを読み終えたものとして先に描く
  const [loaded, setLoaded] = useState(!!cached);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [setup, setSetup] = useState<SetupView | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [checkingSetup, setCheckingSetup] = useState(false);
  // 確かめ直しが重なったとき、古い結果で上書きしない
  const setupSeq = useRef(0);
  // 最後に確かめた結果。reload が、確かめ直すかを決めるのに読む（state を依存に入れると reload が作り直され、最初の読み込みが走り直す）
  const setupRef = useRef<SetupView | null>(null);
  const [setupBoard, setSetupBoard] = useState<SetupBoardSource | null>(null);
  // readSetup が読む今の値。state を依存に入れると reload が作り直され、最初の読み込みが走り直すので ref で渡す
  const setupBoardRef = useRef<SetupBoardSource | null>(null);
  // 人がこの画面で指定し直して、まだ入口に伝えていないか。入口が指定を持つか（確かめた結果に board が付いていたか）
  const setupBoardChosen = useRef(false);
  const setupBoardHeld = useRef(false);

  /** 人が推奨の項目の帯を「このリポジトリでは出さない」にしているか（帯の SetupBand が見た目の状態に残す） */
  const bandDismissed = useCallback(
    () => cache?.get<boolean>(SETUP_BAND_DISMISSED_KEY) === true,
    [cache],
  );

  /**
   * 導入のチェックリストを確かめて持つ。確かめる口がない・確かめられないときは null（前の結果のまま）。
   * 帯を出す入口は、帯を出さないと決めているかを付けて頼む（拡張ホストが、推奨だけが欠けている間の自動の確かめ直しをやめる）
   */
  const readSetup = useCallback(async (): Promise<SetupView | null> => {
    if (!client.setup) return null;
    const seq = ++setupSeq.current;
    try {
      const board = setupBoardRef.current;
      // 指定を持つ入口（拡張ホスト）には指定し直したときだけ伝え、ほかの画面の指定を、この画面の古い指定や指定なしで上書きしない
      const chosen = setupBoardChosen.current;
      const send = setupBoardHeld.current ? chosen : board !== null;
      const options: SetupOptions = {
        ...(setupBand ? { bandDismissed: bandDismissed() } : {}),
        ...(send ? { board } : {}),
      };
      const view = await client.setup(Object.keys(options).length > 0 ? options : undefined);
      if (chosen && setupBoardRef.current === board) setupBoardChosen.current = false;
      if (view.board !== undefined) setupBoardHeld.current = true;
      if (seq === setupSeq.current) {
        setupRef.current = view;
        setSetup(view);
        if (view.board !== undefined && !setupBoardChosen.current) {
          setupBoardRef.current = view.board;
          setSetupBoard(view.board);
        }
      }
      return view;
    } catch {
      return null;
    }
  }, [client, setupBand, bandDismissed]);

  /** 同期の状態を読む。読めなければ null */
  const refreshStatus = useCallback(async (): Promise<StatusView | null> => {
    try {
      const next = await client.status();
      setStatus(next);
      return next;
    } catch {
      // 同期の状態が取れなくても画面は動かす
      return null;
    }
  }, [client]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [config, whoami] = await Promise.all([
        client.run<ConfigShowView>("config.show", { fields: true }),
        client.run<WhoamiView>("whoami"),
      ]);
      setNeedsSetup(false);
      setMe(whoami.data);
      if (config.data.config?.priority) setPriorityCriteria(priorityCriteriaOf(config.data));
      const [t, e, i, p, w] = await Promise.all([
        client.run<TicketRow[]>("ticket.list", { include_abandoned: true }),
        client.run<EpicRow[]>("epic.list"),
        client.run<Iteration[]>("iteration.list"),
        client.run<PlanRow[]>("plan.list"),
        client.run<WorkflowView>("workflow.show"),
      ]);
      setTickets(t.data);
      setEpics(e.data);
      setIterations(i.data);
      setPlans(p.data);
      setWorkflow(w.data);
      cache?.set(SNAPSHOT_KEY, {
        tickets: t.data,
        epics: e.data,
        iterations: i.data,
        plans: p.data,
        workflow: w.data,
        me: whoami.data,
      } satisfies Snapshot);
      for (const key of OLD_SNAPSHOT_KEYS) cache?.remove(key);
      void refreshStatus();
      // 推奨の項目（Skill と hooks・dg コマンドなど）の帯のために確かめる。一覧を描くのを待たせない。
      // 確かめるのは最初と、必須を満たした直後だけ（読み直しのたびに git と dg を起こさない。その後の変化は入口が setup の通知で知らせる）
      // 帯を出さない入口と、人が帯を出さないと決めている間は確かめない（結果を出す場所がないのに、Skill・hooks・.gitignore を確かめさせない）
      if (setupBand && !bandDismissed() && !setupRef.current?.ready) void readSetup();
      if (readRunning) {
        // 行の Run の並び（UI-2）のためだけなので、ほかの一覧を描くのを待たせない。読めなければ前の値のまま（最初なら並びを出さない）
        const seq = ++runningSeq.current;
        void client
          .run<TicketRunsView[]>("run.recent")
          .then((res) => {
            if (seq === runningSeq.current)
              setTicketRuns(new Map(res.data.map((r) => [r.ticket, r])));
          })
          .catch(() => {});
      }
    } catch (error) {
      const f = failureOf(error);
      // 導入の途中（dg init 前・Git リポジトリの外・git がない）は失敗ではなく始まりの状態。エラーの通知は出さず、チェックリストを出す。
      // init が終わった直後は、確かめた結果が先に必須を満たすことがある（見張りの読み直しでいつもの画面に変わる）
      const view = await readSetup();
      if (view && (!view.ready || f.code === "NOT_INITIALIZED")) setNeedsSetup(true);
      else setNotice({ kind: "error", text: f.message, detail: f.detail });
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [client, cache, readRunning, setupBand, bandDismissed, refreshStatus, readSetup]);

  const recheckSetup = useCallback(async () => {
    setCheckingSetup(true);
    try {
      if (needsSetup) return await reload();
      // いつもの画面を出している間は項目だけを確かめ直す。必須を満たさなくなっていたら一覧も読み直す
      const view = await readSetup();
      if (view && !view.ready) await reload();
    } finally {
      setCheckingSetup(false);
    }
  }, [needsSetup, reload, readSetup]);

  const onSetupEvent = useCallback(async () => {
    // 帯もチェックリストも出していない入口（一覧を読めているエディタのパネル）は、入口の setup の通知が来ても確かめ直さない。
    // 結果を出す場所がないのに git と dg を起こさない。チェックリストを出しているパネル（dg init の前）は確かめ直すが、
    // 拡張ホストがフォルダごとに持つボードの指定で確かめるので、左パネルの指定で確かめた結果を上書きしない（readSetup）
    if (!setupBand && !needsSetup) return;
    await recheckSetup();
  }, [setupBand, needsSetup, recheckSetup]);

  const chooseSetupBoard = useCallback(
    async (board: SetupBoardSource | null) => {
      setupBoardRef.current = board;
      setupBoardChosen.current = true;
      setSetupBoard(board);
      await recheckSetup();
    },
    [recheckSetup],
  );

  useEffect(() => {
    // 最初の読み込み。reload は読み込み中の印（setLoading(true)）を同期で立てるが、外（コマンド）から読む始まりの印なので残す
    // oxlint-disable-next-line react/set-state-in-effect
    void reload();
  }, [reload]);

  useEffect(() => {
    // 入口が自動で取り込んだら（StatusView の auto_pulls が前に見た回数から変わったら）、新しいデータを映すために一覧を読み直す
    // （UI-6。dg serve の画面にはデータの見張りがない）。回数を覚えるのはここだけにする。reload の中の状態の読みで覚えると、
    // 一覧の読みとその状態の読みの間に入った取り込みを見たことにしてしまい、一覧が古いまま残る。
    // その代わり、最初の読み込みの前の取り込みと、reload が映し終えた取り込みで、1 回余計に読み直す
    let seen = 0;
    const timer = setInterval(
      () =>
        void refreshStatus().then((next) => {
          if (!next || next.auto_pulls === seen) return undefined;
          seen = next.auto_pulls;
          return reload();
        }),
      STATUS_POLL_MS,
    );
    return () => clearInterval(timer);
  }, [refreshStatus, reload]);

  const run = useCallback(
    async <O,>(name: string, input: unknown = {}): Promise<RunResult<O>> => {
      try {
        const result = await client.run<O>(name, input);
        if (result.warnings.length) setNotice({ kind: "info", text: result.warnings.join(" / ") });
        await reload();
        return { ok: true, data: result.data, warnings: result.warnings };
      } catch (error) {
        const f = failureOf(error);
        setNotice({ kind: "error", text: f.message, detail: f.detail });
        return { ok: false, error: f };
      }
    },
    [client, reload],
  );

  // 既定のままの Status の表示名と、Core が持つ Run の step の表示名は表示言語の訳にして渡す（workflow と labelOf の両方）。
  // cache には core が返したままを残す（表示言語が変わっても訳し直せるように）
  const shownWf = useMemo(() => workflow && shownWorkflow(workflow), [workflow]);
  const value = useMemo<Store>(
    () => ({
      client,
      tickets,
      epics,
      iterations,
      plans,
      workflow: shownWf,
      me,
      ticketRuns,
      status,
      priorityCriteria,
      loading,
      loaded,
      setup,
      needsSetup,
      checkingSetup,
      recheckSetup,
      onSetupEvent,
      setupBoard,
      chooseSetupBoard,
      notice,
      reload,
      run,
      notify: setNotice,
      labelOf: (s) => shownWf?.labels[s] ?? s,
    }),
    [
      client,
      tickets,
      epics,
      iterations,
      plans,
      shownWf,
      me,
      ticketRuns,
      status,
      priorityCriteria,
      loading,
      loaded,
      setup,
      needsSetup,
      checkingSetup,
      recheckSetup,
      onSetupEvent,
      setupBoard,
      chooseSetupBoard,
      notice,
      reload,
      run,
    ],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error(tr("StoreProvider の中で使う"));
  return store;
}
