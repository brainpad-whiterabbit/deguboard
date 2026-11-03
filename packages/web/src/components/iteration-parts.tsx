// Iteration の部品：開始・閉じるのボタン、作成のフォーム、見出しに出す短い期間。
// カンバン（board.tsx）・バックログ（backlog.tsx）・Iteration の詳細（iterations.tsx）で共用する

import { useState } from "react";
import { CloseButton, unfinishedCount } from "./parts.js";
import { useStore } from "../store.js";
import type { Iteration } from "../types.js";

/** Iteration を閉じたとき未完了のチケットがどうなるか（確認の文に添える） */
export const ITERATION_CLOSE_NOTE = "閉じると持ち越しになり、Iteration から外れる。";

/**
 * 同じ Project でほかに active の Iteration があればそれを返す。active は Project に 1 つなので（IT-1）、
 * あれば開始・再開は拒否される。拒否の判定は core のコマンドが行い、画面はボタンを押せなくして理由を出すだけ
 */
export function otherActiveIteration(
  iterations: Iteration[],
  it: { id: string; project: string },
): Iteration | undefined {
  return iterations.find(
    (i) => i.id !== it.id && i.project === it.project && i.status === "active",
  );
}

/** 開始・再開を押せない理由（ボタンの title と、ボタンの横の文に出す） */
export function blockedByActiveReason(other: Iteration, verb: "開始" | "再開"): string {
  return `${other.id} ${other.name} が進行中なので${verb}できない（進行中の Iteration は 1 つ）。先に ${other.id} を閉じる`;
}

/**
 * Iteration の開始・閉じるのボタン。広い画面のカンバンの見出しとバックログの区画の見出しに置く。
 * サイドバー（左パネル）のカンバンとバックログには置かず、詳細の画面（IterationDetailView）で行う
 */
export function IterationActions({ iteration: it }: { iteration: Iteration }) {
  const store = useStore();
  if (it.status === "closed") return null;
  const other = it.status === "planned" ? otherActiveIteration(store.iterations, it) : undefined;
  const reason = other ? blockedByActiveReason(other, "開始") : undefined;
  return (
    <>
      {other ? (
        <span className="muted blocked-note" title={reason}>
          {other.id} が進行中
        </span>
      ) : null}
      {it.status === "planned" ? (
        <button
          type="button"
          className="primary"
          disabled={!!other}
          title={reason}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void store.run("iteration.start", { iteration: it.id });
          }}
        >
          開始する
        </button>
      ) : null}
      <CloseButton
        subject={`${it.id} ${it.name}`}
        unfinished={unfinishedCount(store.tickets.filter((t) => t.iteration === it.id))}
        note={ITERATION_CLOSE_NOTE}
        onClose={() => void store.run("iteration.close", { iteration: it.id })}
      />
    </>
  );
}

/** Iteration を作るフォーム。カンバンの絞り込みの欄（サイドバーでは見出しの札の列の「+」）とバックログの「Iteration なし」の区画から開く。作れたら onDone */
export function IterationCreateForm({ onDone }: { onDone: () => void }) {
  const store = useStore();
  const [form, setForm] = useState({ name: "", goal: "", start: "", end: "" });
  const create = async () => {
    if (!form.name.trim() || !store.project) return;
    const r = await store.run("iteration.create", {
      project: store.project.id,
      name: form.name.trim(),
      ...(form.goal.trim() ? { goal: form.goal.trim() } : {}),
      ...(form.start ? { start: form.start } : {}),
      ...(form.end ? { end: form.end } : {}),
    });
    if (r.ok) onDone();
  };
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <input
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
        placeholder="名前"
        aria-label="名前"
        autoFocus
      />
      <input
        value={form.goal}
        onChange={(e) => setForm({ ...form, goal: e.target.value })}
        placeholder="目標"
        aria-label="目標"
      />
      <input
        type="date"
        value={form.start}
        onChange={(e) => setForm({ ...form, start: e.target.value })}
        aria-label="開始日"
      />
      <input
        type="date"
        value={form.end}
        onChange={(e) => setForm({ ...form, end: e.target.value })}
        aria-label="終了日"
      />
      <button type="submit" className="primary" disabled={!form.name.trim()}>
        作る
      </button>
      <button type="button" onClick={onDone}>
        やめる
      </button>
    </form>
  );
}

/** 見出しに出す期間を短くする（2026-11-15 と 2026-11-28 → 11/15–11/28）。どちらもなければ undefined */
export function shortPeriod(start?: string, end?: string): string | undefined {
  if (!start && !end) return undefined;
  const md = (d: string | undefined) => {
    const m = d ? /^\d{4}-(\d{2})-(\d{2})/.exec(d) : null;
    return m ? `${Number(m[1])}/${Number(m[2])}` : (d ?? "?");
  };
  return `${md(start)}–${md(end)}`;
}
