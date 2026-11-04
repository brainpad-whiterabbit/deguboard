// カンバン（UI-2）。絞り込みの欄（Iteration・Epic・担当者）、選んだ Iteration の見出し、
// 選んだ範囲のチケットを含む Plan の帯（実行計画）と、その範囲のチケットを状態ごとの節（todo / in_progress / review / done。中止は畳んだ節）で出す。
// 範囲は planned か active の Iteration 1 つか「すべて」（planned と active の Iteration すべて）で、Iteration に入っていないチケットはバックログで見る。
// Epic の選択肢は open だけ。開いた Iteration がなければ、列も帯も出さずにバックログへ案内する。絞り込みの値はハッシュに持つ。
// VS Code の左パネル（surface=sidebar）では、Iteration を選択欄の代わりに札の列（すべてを含む）で切り替え、見出しを 2 段と進みの帯に詰め、
// 詳細・件数は出さない（件数は帯の done/全体）。Epic・担当の絞り込みは見出しの右端の漏斗で開き（開閉は host.state）、
// 絞っている間は見出しの下に値の札（× で外す）を出す。状態の節はペイン風の見出しにする。
// 左パネルの行は担当の名前の列を出さず、右端の上の段（Plan の番号の左）に担当の印（AssigneeMark。人は頭文字の丸、agent は持ち主の丸と汎用のアイコン）を出す。
// 左パネルの行の右端には、開いた Plan に入っているチケットなら Plan の番号と、todo なら着手可か待ちの相手（Plan の after とチケットの depends_on）か承認待ち（Plan が承認待ち）を出す。
// 待ちと承認待ちの行（実行中の Run がないもの）はタイトルを説明文の色で薄く出す。
// 左パネルの行の頭には、実行中の Run があるチケットなら回るリング（右端の下の段に「実行中」）を、実行中の Run のない in_progress なら止まった半分塗りの丸を出す。
// 入っている Iteration か Epic が閉じた done・abandoned のチケットは出さない（履歴でたどる）。
// 左パネルの行・状態の節の見出し・Iteration の見出し・Plan の帯は、エージェントに頼める場所にする（吹き出し・右クリック・Shift+F10。UI-15）。
// 節の開閉・最後に選んだ Iteration は host.state に覚える。
// 表示だけで書き込まない。チケットを進める・片付ける・やめる・done を取り消すと、Iteration の作成・閉じるは、吹き出し・右クリックから
// エージェントに頼む（ADR-010）。Status を直に選んで変える頼むことはなく、Iteration の開始は着手（claim）の手順が行う（ADR-006）

import { useLayoutEffect, useMemo, useRef } from "react";
import { ASK_SECTIONS, useAskSpot } from "../components/ask-menu.js";
import {
  ActivityMark,
  AskRow,
  PriorityMark,
  type RowActivity,
  StatusBand,
  StatusDot,
  Tags,
  TicketLink,
} from "../components/parts.js";
import { FilterToggle } from "../components/filter-toggle.js";
import { PlanBand } from "../components/plan-band.js";
import { shortPeriod } from "../components/iteration-parts.js";
import { openPlanByTicket, planColor } from "../components/plan-graph.js";
import {
  isWaitingReadiness,
  KanbanRowEnd,
  kanbanPlanMarks,
  kanbanReadiness,
  type PlanMark,
} from "../components/row-end.js";
import { useChangeFlash } from "../components/change-flash.js";
import { useAskCurrent, useHost, useUiState } from "../host.js";
import { ALL_ITERATIONS, hrefOf, navigate, type BoardQuery } from "../router.js";
import { useStore } from "../store.js";
import {
  BOARD_STATUSES,
  byNumber,
  byPriorityThenNumber,
  claimOptions,
  matchesClaim,
  actorLabel,
  isFinished,
  ITERATION_LABELS,
  NO_CLAIM,
  type Epic,
  type Iteration,
  type Progress,
  type Status,
  type Ticket,
  type TicketRow,
} from "../types.js";

/** 選んでいる範囲。all は planned と active の Iteration すべて */
type Selection = { kind: "all" } | { kind: "iteration"; iteration: Iteration };

/**
 * カンバンの iteration の値（ハッシュか最後に選んだもの）が指す範囲。ALL_ITERATIONS なら「すべて」、
 * 閉じていない（planned か active の）Iteration の ID ならその Iteration。閉じた・存在しない Iteration と、それ以外の値（古い「なし」など）は undefined。
 * カンバンの範囲（boardSelection）と、カンバンのタブの行き先に残したハッシュを使えるか（app.tsx）の両方がこれで判定する
 */
export function boardIterationSelection<I extends Pick<Iteration, "id" | "status">>(
  iterations: readonly I[],
  id: string | undefined,
): { kind: "all" } | { kind: "iteration"; iteration: I } | undefined {
  if (id === ALL_ITERATIONS) return { kind: "all" };
  const iteration = iterations.find((i) => i.id === id && i.status !== "closed");
  return iteration ? { kind: "iteration", iteration } : undefined;
}

/**
 * カンバンの範囲を決める（UI-2）。open は planned と active の Iteration（番号の順）。
 * ハッシュの iteration（query）が open の Iteration か「すべて」ならそれ、でなければ（閉じた・存在しない Iteration、古い「なし」の値）
 * 最後に選んだもの（remembered）が使えればそれ、どちらもなければ既定（active、なければ番号の小さい planned）。open が空なら「すべて」
 */
export function boardSelection(
  open: readonly Iteration[],
  query: string | undefined,
  remembered: string | undefined,
): Selection {
  const pick = (id: string | undefined): Selection | undefined => boardIterationSelection(open, id);
  // active は Project に 1 つ（IT-1）なので、札で選んでいなければそれを選ぶ
  const fallback = open.find((i) => i.status === "active") ?? open[0];
  return (
    pick(query) ??
    pick(remembered) ??
    (fallback ? { kind: "iteration", iteration: fallback } : { kind: "all" })
  );
}

/** 範囲（selection）のチケット。「すべて」は open の Iteration に入っているチケットだけで、Iteration に入っていないチケットは含めない */
export function ticketsInSelection<T extends Pick<Ticket, "iteration">>(
  tickets: readonly T[],
  open: readonly Pick<Iteration, "id">[],
  selection: Selection,
): T[] {
  if (selection.kind === "iteration")
    return tickets.filter((t) => t.iteration === selection.iteration.id);
  const ids = new Set(open.map((i) => i.id));
  return tickets.filter((t) => !!t.iteration && ids.has(t.iteration));
}

export function BoardPage({ query }: { query: BoardQuery }) {
  const store = useStore();
  const host = useHost();
  const [lastIteration, setLastIteration] = useUiState<string | undefined>(
    "board.iteration",
    undefined,
  );
  // 左パネルの絞り込みの欄（Epic・担当）を開いているか
  const [filtersOpen, setFiltersOpen] = useUiState("board.filters", false);

  const open = useMemo(
    () => store.iterations.filter((i) => i.status !== "closed").sort(byNumber),
    [store.iterations],
  );
  const selection = useMemo(
    () => boardSelection(open, query.iteration, lastIteration),
    [open, query.iteration, lastIteration],
  );
  // タイトル行の吹き出しは選んでいる Iteration を対象にする。「すべて」なら対象なし（UI-15）
  useAskCurrent(selection.kind === "iteration" ? [selection.iteration.id] : []);

  const select = (iteration: string) => {
    setLastIteration(iteration);
    // 担当者は Iteration ごとに顔ぶれが変わるので外す。Epic は残す
    navigate({ page: "board", iteration, epic: query.epic });
  };
  const setFilter = (patch: Partial<BoardQuery>) =>
    navigate({
      page: "board",
      iteration: query.iteration,
      epic: query.epic,
      assignee: query.assignee,
      ...patch,
    });

  const scoped = useMemo(
    () => ticketsInSelection(store.tickets, open, selection),
    [store.tickets, open, selection],
  );
  // 閉じた Epic は出さない。Epic の詳細から閉じた Epic で開いたときは、選んでいるものだけ残す
  const epics = useMemo(
    () => store.epics.filter((e) => e.status === "open" || e.id === query.epic),
    [store.epics, query.epic],
  );
  const claims = useMemo(() => claimOptions(scoped), [scoped]);
  const tickets = useMemo(
    () =>
      hideClosedFinished(scoped, store.iterations, store.epics, query.epic)
        .filter((t) => !query.epic || t.epic === query.epic)
        .filter((t) => matchesClaim(t, query.assignee ?? ""))
        .sort(byPriorityThenNumber),
    [scoped, store.iterations, store.epics, query.epic, query.assignee],
  );
  const chipTickets = useMemo(
    () => hideClosedFinished(store.tickets, store.iterations, store.epics),
    [store.tickets, store.iterations, store.epics],
  );
  const abandoned = tickets.filter((t) => t.status === "abandoned");
  const planOf = useMemo(() => openPlanByTicket(store.plans), [store.plans]);
  const planMarks = useMemo(() => kanbanPlanMarks(store.plans, planOf), [store.plans, planOf]);

  // サイドバーでは、前回の描画から Status か Iteration が変わった行を点滅させる（UI-2。CLI やエージェントの書き込みに気づけるように）
  const sidebar = host.surface === "sidebar";
  const flash = useChangeFlash(store.tickets, host.state, sidebar);

  const filterSelects = (
    <>
      {epics.length > 0 ? (
        <label>
          Epic
          <select
            value={query.epic ?? ""}
            onChange={(e) => setFilter({ epic: e.target.value || undefined })}
          >
            <option value="">すべて</option>
            {epics.map((e) => (
              <option key={e.id} value={e.id}>
                {e.id} {e.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {claims.length > 0 ? (
        <label>
          担当
          <select
            value={query.assignee ?? ""}
            onChange={(e) => setFilter({ assignee: e.target.value || undefined })}
          >
            <option value="">すべて</option>
            {claims.map((c) => (
              <option key={c} value={c} title={c}>
                {c === NO_CLAIM ? "なし" : actorLabel(c)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </>
  );

  return (
    <section>
      {sidebar ? (
        <>
          {/* 左パネルは見出しを 2 段と進みの帯に詰め、詳細は出さない */}
          <SidebarBoardHead
            open={open}
            // 札は閉じた Iteration・Epic の終わったチケットを除いて数え、Epic・担当の絞り込みでは変えない
            tickets={chipTickets}
            selection={selection}
            // 帯は絞り込み（Epic・担当）の後のチケットで数える
            progress={ticketProgress(tickets)}
            onSelect={select}
            filter={
              epics.length > 0 || claims.length > 0
                ? {
                    open: filtersOpen,
                    active: !!query.epic || !!query.assignee,
                    onToggle: () => setFiltersOpen(!filtersOpen),
                  }
                : undefined
            }
          />
          {filtersOpen && (epics.length > 0 || claims.length > 0) ? (
            <div className="board-filters compact" id="board-filters">
              {filterSelects}
            </div>
          ) : null}
          <FilterChips
            epic={query.epic ? store.epics.find((e) => e.id === query.epic) : undefined}
            epicId={query.epic}
            assignee={query.assignee}
            onClear={setFilter}
          />
        </>
      ) : (
        <>
          <div className="board-filters">
            <label>
              Iteration
              <select
                value={selection.kind === "all" ? ALL_ITERATIONS : selection.iteration.id}
                onChange={(e) => select(e.target.value)}
              >
                <option value={ALL_ITERATIONS}>すべて（planned と active）</option>
                {open.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.id} {i.name}（{ITERATION_LABELS[i.status]}）
                  </option>
                ))}
              </select>
            </label>
            {filterSelects}
            <span className="muted count">{tickets.length - abandoned.length} 件</span>
          </div>
          {selection.kind === "iteration" ? (
            <IterationHead iteration={selection.iteration} />
          ) : null}
        </>
      )}
      {open.length === 0 ? (
        <NoOpenIteration />
      ) : (
        <>
          <PlanBand scope={scoped} />
          <div className="board">
            {BOARD_STATUSES.map((status) => (
              <Column
                key={status}
                status={status}
                tickets={tickets.filter((t) => t.status === status)}
                planOf={planOf}
                planMarks={planMarks}
                flashing={flash.flashing}
                // 完了は既定で畳む（どの surface でも。開いた状態は useUiState が保つ）
                defaultOpen={status !== "done"}
              />
            ))}
            {/* 中止は切り替えではなく、あるときだけ最後の列（サイドバーでは最後の節）に畳んで置く */}
            {abandoned.length > 0 ? (
              <Column
                status="abandoned"
                tickets={abandoned}
                planOf={planOf}
                planMarks={planMarks}
                flashing={flash.flashing}
                defaultOpen={false}
              />
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

/** 開いた Iteration がないときの案内（UI-2）。列と帯の代わりに出し、バックログへ導く */
function NoOpenIteration() {
  return (
    <div className="empty board-empty">
      <p>開いた Iteration（planned・active）はない</p>
      <p>
        チケットは <a href={hrefOf({ page: "backlog" })}>バックログ</a> で見る
      </p>
    </div>
  );
}

/**
 * 入っている Iteration か Epic のどちらかが closed の done・abandoned のチケットを除く。
 * 終わっていないチケットは Epic が閉じていても残す。絞り込みで選んだ Epic（epic）のチケットは除かない
 */
export function hideClosedFinished<T extends Ticket>(
  tickets: T[],
  iterations: Pick<Iteration, "id" | "status">[],
  epics: Pick<Epic, "id" | "status">[],
  epic?: string,
): T[] {
  const closedIterations = new Set(
    iterations.filter((i) => i.status === "closed").map((i) => i.id),
  );
  const closedEpics = new Set(epics.filter((e) => e.status === "closed").map((e) => e.id));
  return tickets.filter(
    (t) =>
      !isFinished(t.status) ||
      (!!epic && t.epic === epic) ||
      !((t.iteration && closedIterations.has(t.iteration)) || (t.epic && closedEpics.has(t.epic))),
  );
}

/** 選んだ Iteration の見出し：番号・名前・状態・期間・目標と詳細へのリンク */
function IterationHead({ iteration: it }: { iteration: Iteration }) {
  return (
    <header className="board-head">
      <h1>
        <code>{it.id}</code> {it.name}
      </h1>
      <span className={`badge iteration-${it.status}`}>{ITERATION_LABELS[it.status]}</span>
      {it.start || it.end ? (
        <span className="muted">
          {it.start ?? "?"} 〜 {it.end ?? "?"}
        </span>
      ) : null}
      {it.goal ? <span className="muted goal">{it.goal}</span> : null}
      <span className="actions">
        <a href={hrefOf({ page: "iterations", id: it.id })}>詳細</a>
      </span>
    </header>
  );
}

/**
 * 左パネルのカンバンの見出し（UI-2）。1 段目に Iteration の札の列（IterationChips）と右端の絞り込みボタン（漏斗）、
 * 2 段目に選んでいるものの名前・期間・目標（1 行で省略）、3 段目に状態ごとの色の帯と「n/m done」（件数はここだけ）。
 * 詳細は出さない。
 * filter は絞り込める Epic か担当があるときだけ渡す（漏斗を出す）。絞っている間は漏斗を色付きにする
 */
function SidebarBoardHead({
  open,
  tickets,
  selection,
  progress,
  onSelect,
  filter,
}: {
  open: Iteration[];
  /** 札の進みを数えるチケット。閉じた Iteration・Epic の終わったチケットを除き（hideClosedFinished）、Epic・担当の絞り込みとは関係なく一定 */
  tickets: readonly Ticket[];
  selection: Selection;
  progress: Progress;
  onSelect: (iteration: string) => void;
  filter: { open: boolean; active: boolean; onToggle: () => void } | undefined;
}) {
  const it = selection.kind === "iteration" ? selection.iteration : undefined;
  const name = it
    ? it.name
    : open.length > 0
      ? "planned・active のすべて"
      : "開いた Iteration はない";
  const period = it ? shortPeriod(it.start, it.end) : undefined;
  // 選んでいる Iteration の見出し（名前・期間・目標の段）から、その Iteration を頼む（「すべて」のときは出さない）
  const spot = useAskSpot(
    it
      ? {
          targets: [it.id],
          label: `Iteration の見出し ${it.id}`,
          section: ASK_SECTIONS.boardHeading,
        }
      : null,
  );
  return (
    <header className="board-head sidebar-head">
      <div className="head-line">
        <IterationChips open={open} tickets={tickets} selection={selection} onSelect={onSelect} />
        {filter ? (
          <FilterToggle
            open={filter.open}
            active={filter.active}
            title="Epic・担当で絞り込む"
            controls="board-filters"
            onToggle={filter.onToggle}
          />
        ) : null}
      </div>
      <div className="head-line sub muted" {...(it ? { ...spot.props, tabIndex: 0 } : {})}>
        <span className="name">{name}</span>
        {period ? <span className="period">{period}</span> : null}
        {it?.goal ? (
          <span className="goal" title={it.goal}>
            {it.goal}
          </span>
        ) : null}
        {spot.overlay}
      </div>
      {open.length > 0 ? (
        <div className="head-line">
          <StatusBand progress={progress} />
        </div>
      ) : null}
    </header>
  );
}

/**
 * 左パネルの Iteration の札の列（UI-2）。先頭に「すべて」（planned と active の Iteration すべて。開いた Iteration がなくても出す）、
 * planned と active の Iteration を番号順に並べる。札は番号・進みの輪・done/全体で、選んでいる札は塗り、
 * active は実線、planned は破線の枠。名前・期間・目標はツールチップで読む。
 * 幅に入らなければ列だけが横にスクロールし、選んでいる札が見える位置まで寄せる
 */
function IterationChips({
  open,
  tickets,
  selection,
  onSelect,
}: {
  open: Iteration[];
  tickets: readonly Ticket[];
  selection: Selection;
  onSelect: (iteration: string) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const selected = selection.kind === "iteration" ? selection.iteration.id : ALL_ITERATIONS;
  // 選んでいる札が列の見える範囲から外れていたら、列だけを横にスクロールして寄せる（scrollIntoView は画面ごと動かすので使わない）
  useLayoutEffect(() => {
    const el = strip.current;
    const chip = el?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!el || !chip) return;
    // 列は position: relative なので、offsetLeft は列の左端からの位置
    const left = chip.offsetLeft;
    const right = left + chip.offsetWidth;
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
  }, [selected, open.length]);
  const all = ticketProgress(ticketsInSelection(tickets, open, { kind: "all" }));
  return (
    <div className="iteration-chips" role="group" aria-label="Iteration" ref={strip}>
      <button
        type="button"
        className="iteration-chip all"
        aria-pressed={selected === ALL_ITERATIONS}
        title="すべて（planned と active の Iteration）"
        onClick={() => onSelect(ALL_ITERATIONS)}
      >
        すべて
        <ProgressRing progress={all} />
        <span className="chip-count">
          {all.done}/{all.total}
        </span>
      </button>
      {open.map((i) => {
        // core の iteration.list は進みを返さず、札は画面の都合（閉じた Epic の終わったチケットを除く）で数える対象を決めるので、
        // core の progressOf の写し（ticketProgress）で数える。core が進みを返す Epic の行（履歴）は core の値を読む
        const progress = ticketProgress(tickets.filter((t) => t.iteration === i.id));
        const period = i.start || i.end ? `\n期間 ${i.start ?? "?"} 〜 ${i.end ?? "?"}` : "";
        const goal = i.goal ? `\n目標 ${i.goal}` : "";
        return (
          <button
            key={i.id}
            type="button"
            className={`iteration-chip ${i.status}`}
            aria-pressed={selected === i.id}
            title={`${i.id} ${i.name}（${ITERATION_LABELS[i.status]}）${period}${goal}`}
            onClick={() => onSelect(i.id)}
          >
            <code>{i.id}</code>
            <ProgressRing progress={progress} />
            <span className="chip-count">
              {progress.done}/{progress.total}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 札の進みの小さな輪（done/全体の割合だけ線を引く）。全体が 0 なら輪の下地だけ */
function ProgressRing({ progress }: { progress: Progress }) {
  const r = 4.5;
  const length = 2 * Math.PI * r;
  const ratio = progress.total > 0 ? progress.done / progress.total : 0;
  return (
    <svg className="ring" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <circle
        cx="6"
        cy="6"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.3}
        strokeWidth="2"
      />
      {ratio > 0 ? (
        <circle
          cx="6"
          cy="6"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={`${length * ratio} ${length}`}
          transform="rotate(-90 6 6)"
        />
      ) : null}
    </svg>
  );
}

/**
 * 左パネルのカンバンで絞っている値の札（例「担当 eiki/agent ×」）。× で外す。絞っていなければ何も出さない。
 * Epic は番号を出し、題はツールチップで読む
 */
function FilterChips({
  epic,
  epicId,
  assignee,
  onClear,
}: {
  epic: Epic | undefined;
  epicId: string | undefined;
  assignee: string | undefined;
  onClear: (patch: Partial<BoardQuery>) => void;
}) {
  if (!epicId && !assignee) return null;
  const who = assignee === NO_CLAIM ? "なし" : assignee ? actorLabel(assignee) : "";
  return (
    <div className="filter-chips">
      {epicId ? (
        <span className="filter-chip" title={epic ? `${epic.id} ${epic.title}` : epicId}>
          <span className="filter-chip-text">Epic {epicId}</span>
          <button
            type="button"
            aria-label={`Epic ${epicId} の絞り込みを外す`}
            onClick={() => onClear({ epic: undefined })}
          >
            ×
          </button>
        </span>
      ) : null}
      {assignee ? (
        <span className="filter-chip" title={assignee === NO_CLAIM ? "担当なし" : assignee}>
          <span className="filter-chip-text">担当 {who}</span>
          <button
            type="button"
            aria-label={`担当 ${who} の絞り込みを外す`}
            onClick={() => onClear({ assignee: undefined })}
          >
            ×
          </button>
        </span>
      ) : null}
    </div>
  );
}

/**
 * カンバンに出ているチケットの進み。数え方は core の progressOf（EP-3）の写しで、同じ結果になることを board.test.ts で確かめる
 * （web は core の実行時のコードを取り込まない。ADR-007）
 */
export function ticketProgress(tickets: readonly Pick<Ticket, "status">[]): Progress {
  const by_status: Record<Status, number> = {
    todo: 0,
    in_progress: 0,
    review: 0,
    done: 0,
    abandoned: 0,
  };
  for (const t of tickets) by_status[t.status] += 1;
  return {
    total: tickets.length - by_status.abandoned,
    done: by_status.done,
    by_status,
  };
}

/**
 * 状態ごとの節。広い画面では横に並び、サイドバーでは縦に積む（UI-12）。開閉は host.state に覚える。
 * 見出しに状態の丸印と件数。サイドバーでは枠と背景のないペイン風の見出しで、空の節は見出しの 1 行だけにする。
 * サイドバーの件数は、終わった状態（isFinished）の節では塗らずに数字だけにする
 */
function Column({
  status,
  tickets,
  planOf,
  planMarks,
  flashing,
  defaultOpen,
}: {
  status: Status;
  tickets: TicketRow[];
  /** チケットが入っている開いた Plan の ID */
  planOf: ReadonlyMap<string, string>;
  /** 左パネルの行の右端に出す Plan の番号と待ち（kanbanPlanMarks） */
  planMarks: ReadonlyMap<string, PlanMark>;
  /** 点滅させるチケット（サイドバー） */
  flashing: ReadonlySet<string>;
  defaultOpen: boolean;
}) {
  const store = useStore();
  const host = useHost();
  const [open, setOpen] = useUiState(`board.section.${status}`, defaultOpen);
  const sidebar = host.surface === "sidebar";
  const empty = tickets.length === 0;
  // 節の見出しから、節のチケットをまとめて頼む（空の節は頼む対象がないので出さない）
  const spot = useAskSpot(
    sidebar && !empty
      ? {
          targets: tickets.map((t) => t.id),
          label: `状態の節 ${store.labelOf(status)}`,
          section: ASK_SECTIONS.boardHeading,
        }
      : null,
  );
  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className={`column fold status-${status}${empty ? " is-empty" : ""}`}
      data-status={status}
    >
      <summary {...(spot.overlay ? spot.props : {})}>
        <h2>
          <StatusDot status={status} />
          <span>{store.labelOf(status)}</span>
          <span
            className={sidebar ? `section-count${isFinished(status) ? " is-plain" : ""}` : "muted"}
          >
            {tickets.length}
          </span>
        </h2>
        {spot.overlay}
      </summary>
      {sidebar ? (
        empty ? null : (
          <div className="rows">
            {tickets.map((t) => {
              const mark = planMarks.get(t.id);
              const activity = rowActivity(t, store.runningTickets);
              const running = activity === "running";
              return (
                <AskRow
                  key={t.id}
                  ticket={t}
                  // 実行中の Run を読み終えるまで（null）は薄くしない（読み終えて実行中とわかった行が一瞬薄く出ないように）
                  dimmed={
                    store.runningTickets !== null &&
                    !running &&
                    isWaitingReadiness(kanbanReadiness(t, mark))
                  }
                  flash={flashing.has(t.id)}
                  variant="kanban"
                  ask={ASK_SECTIONS.boardTicket}
                  head={activity ? <ActivityMark activity={activity} /> : undefined}
                  end={
                    mark || running || t.assignee ? (
                      <KanbanRowEnd ticket={t} mark={mark} running={running} />
                    ) : undefined
                  }
                />
              );
            })}
          </div>
        )
      ) : (
        <div className="cards">
          {tickets.map((t) => (
            <Card key={t.id} ticket={t} plan={planOf.get(t.id)} />
          ))}
        </div>
      )}
    </details>
  );
}

/**
 * 左パネルのカンバンの行の頭の印：実行中の Run があれば running（Status によらない）、なければ in_progress だけ idle、ほかは出さない。
 * 実行中の Run を読み終えるまで（null）は出さない（開いた直後に実行中のチケットへ反対の意味の idle を出さないように）
 */
export function rowActivity(
  ticket: Pick<Ticket, "id" | "status">,
  runningTickets: ReadonlySet<string> | null,
): RowActivity | undefined {
  if (!runningTickets) return undefined;
  if (runningTickets.has(ticket.id)) return "running";
  return ticket.status === "in_progress" ? "idle" : undefined;
}

/** 広い画面のカンバンのカード */
function Card({ ticket, plan }: { ticket: Ticket; plan: string | undefined }) {
  return (
    <article className={`card status-${ticket.status}`}>
      <div className="meta">
        <TicketLink id={ticket.id} />
        <PriorityMark priority={ticket.priority} />
        {ticket.epic ? <span>{ticket.epic}</span> : null}
        {ticket.iteration ? <span>{ticket.iteration}</span> : null}
        {plan ? <span className={`plan-tag plan-color-${planColor(plan)}`}>{plan}</span> : null}
      </div>
      <div className="title">{ticket.title}</div>
      <Tags labels={ticket.labels} />
      {ticket.assignee ? (
        <div className="meta" title={ticket.assignee}>
          {actorLabel(ticket.assignee)}
        </div>
      ) : null}
    </article>
  );
}
