// 流れの段階の関所の記録と根拠（EX-8、ADR-030）。dg checkpoint が記録に添える根拠と、dg flow next が記録を数えるかの判定を 1 か所に置く
// （同じ根拠を両方が同じ求め方で読むため）。記録は Iteration の checkpoints（共有）に足し、Iteration の決まらない流れの割り当ての記録と、
// 止まる判定（前に返した段階と事実のハッシュ）だけを deguboard-local/flow/（共有しない）に置く

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { UsageError } from "../errors.js";
import { isTerminal } from "../model/common.js";
import { compareIds, parseId, type IterationId } from "../model/id.js";
import {
  checkpointSchema,
  countedCheckpoints,
  type Checkpoint,
  type CheckpointStage,
} from "../model/iteration.js";
import type { Ticket } from "../model/ticket.js";
import { writeFileAtomic } from "../storage/atomic.js";
import type { Store } from "../storage/store.js";
import { sortedDocs, ticketsInIteration } from "./helpers.js";

/** 流れの対象。Iteration 1 つ、Plan 1 つ、チケット 1 つ以上のどれか */
export interface FlowTarget {
  kind: "iteration" | "plan" | "tickets";
  /** 対象の鍵。解決した ID で、チケットは並べ替える（t1 t2 と t2 t1 を同じ対象にする）。dg に渡す引数としても使える */
  key: string;
  /** 対象の Iteration（<S>）。チケットか Plan の指定で、Iteration が 1 つに決まらなければ null */
  iteration: string | null;
  tickets: Ticket[];
}

/** 対象の解決（dg flow next と dg checkpoint が同じ引数を同じ対象に読む） */
export function resolveFlowTarget(store: Store, refs: readonly string[]): FlowTarget {
  const kinds = refs.map((r) =>
    parseId(r, "iteration") ? "iteration" : parseId(r, "plan") ? "plan" : "ticket",
  );
  if (kinds.some((k) => k !== "ticket")) {
    if (refs.length !== 1)
      throw new UsageError("Specify only one Iteration or Plan (do not mix it with tickets)");
    if (kinds[0] === "iteration") {
      const it = store.require("iteration", refs[0]!);
      return {
        kind: "iteration",
        key: it.id,
        iteration: it.id,
        tickets: ticketsInIteration(store, it.id).map((d) => d.data),
      };
    }
    const plan = store.require("plan", refs[0]!);
    const tickets = plan.data.tickets.flatMap((id) => store.tickets.get(id)?.data ?? []);
    return { kind: "plan", key: plan.id, iteration: commonIteration(tickets), tickets };
  }
  const tickets = [...new Set(refs.map((r) => store.require("ticket", r).data))];
  const key = tickets
    .map((t) => t.id)
    .sort(compareIds)
    .join(" ");
  return { kind: "tickets", key, iteration: commonIteration(tickets), tickets };
}

/** チケットの Iteration が 1 つに決まればそれ（Iteration のないチケットは数えない）。決まらなければ null */
function commonIteration(tickets: readonly Ticket[]): string | null {
  const ids = [...new Set(tickets.flatMap((t) => (t.iteration ? [t.iteration] : [])))];
  return ids.length === 1 ? ids[0]! : null;
}

const allTickets = (store: Store): Ticket[] =>
  sortedDocs(store.tickets.values()).map((d) => d.data);

/** リリースの手順で起票したチケット（ラベル release-<S>）か。<S> がなければどれも違う */
const releaseLabeled = (s: string | null) => (t: Ticket) =>
  s !== null && t.labels.includes(`release-${s}`);

/**
 * 割り当ての候補。チケットか Plan の指定で、対象のうち Iteration に入っていない、終わっていないチケット
 * （todo に限らない。着手済みでも、関所の記録を置く Iteration を決める）。
 * Iteration の指定では候補はない。流れは Iteration の中のチケットを進めるもので、ほかの todo を Iteration に
 * 入れるかは、人が頼んだときに dgassign で決める。閉じた Iteration には入れられないので、候補はない
 */
export function flowCandidates(store: Store, target: FlowTarget): string[] {
  if (target.kind === "iteration") return [];
  const s = target.iteration;
  if (s !== null && store.iterations.get(s as IterationId)?.data.status === "closed") return [];
  return target.tickets
    .filter((t) => !isTerminal(t.status) && t.iteration === undefined)
    .map((t) => t.id)
    .sort(compareIds);
}

/**
 * 見直しとリリースの判定で「すべて done か abandoned」を見るチケット。Iteration の指定では対象と同じ、
 * チケットの指定では対象とその Iteration のチケット。<S> がなければ空。
 * ラベル release-<S> のチケット（リリースの段で起票する 2 つ）は除く。リリースの段の途中で残っていても、リリースを返し続けるため
 */
export function releaseScopeOf(store: Store, target: FlowTarget): Ticket[] {
  const s = target.iteration;
  if (s === null) return [];
  const ids = new Set(target.tickets.map((t) => t.id));
  const scope =
    target.kind === "iteration"
      ? target.tickets
      : [
          ...target.tickets,
          ...allTickets(store).filter((t) => t.iteration === s && !ids.has(t.id)),
        ];
  return scope.filter((t) => !releaseLabeled(s)(t));
}

/**
 * 点検の根拠：点検が見るチケットの事実のハッシュ。対象は見直しとリリースの判定と同じチケット（release-<S> を除く。リリースの途中で点検に戻さない）。
 * 入れるのは、チケットの並び（出入り）と、人が書き換える中身（題・本文・優先度・ラベル・依存・Epic・Iteration）。
 * 流れが進むと変わるもの（Status・担当・ブランチ・PR・段・更新の時刻・受け入れ条件の印）は入れない。入れると、作業が進むたびに点検をやり直す
 */
export function checkFactsOf(store: Store, target: FlowTarget): string {
  const rows = releaseScopeOf(store, target)
    .map((t) => [
      t.id,
      t.title,
      t.priority,
      [...t.labels].sort(),
      [...t.depends_on].sort(),
      t.epic ?? null,
      t.iteration ?? null,
      // 受け入れ条件の印（ticket check）は作業の中で付くので、付いていない形にそろえる
      (store.tickets.get(t.id)?.body ?? "").replace(/^(\s*[-*+] )\[[ xX]\]/gm, "$1[ ]"),
    ])
    .sort((a, b) => compareIds(a[0] as string, b[0] as string));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
}

/**
 * 見直しの根拠：done のチケット（番号順）。ラベル audit-<S> のチケット（見直しの指摘を直すチケット）と release-<S> のチケットは入れない。
 * 見直しが自分で起票した直しがマージされても、見直しをやり直さない（やり直すと、指摘のある見直しはいつも 2 回になる）
 */
export function auditDoneOf(store: Store, target: FlowTarget): string[] {
  const s = target.iteration;
  return releaseScopeOf(store, target)
    .filter((t) => t.status === "done" && !t.labels.includes(`audit-${s}`))
    .map((t) => t.id)
    .sort(compareIds);
}

/** 関所を通るときに記録に添える根拠（段階ごとに 1 つ。release・retro・独自の段階は根拠を持たない） */
export function basisOf(stage: string, store: Store, target: FlowTarget): Checkpoint["basis"] {
  switch (stage) {
    case "assign":
      return { candidates: flowCandidates(store, target) };
    case "check":
      return { facts: checkFactsOf(store, target) };
    case "audit":
      return { done: auditDoneOf(store, target) };
    default:
      return undefined;
  }
}

/** 割り当ての記録が見た候補（どの記録の分も合わせる。人が「入れない」と決めた候補を聞き直さない） */
export function askedCandidates(records: readonly Checkpoint[]): Set<string> {
  return new Set(
    records.filter((c) => c.name === "assign").flatMap((c) => c.basis?.candidates ?? []),
  );
}

/** 今のチケットの事実で通った点検の記録があるか（チケットが変わったら、前の記録は数えない） */
export function checkedWith(records: readonly Checkpoint[], facts: string): boolean {
  return records.some((c) => c.name === "check" && c.basis?.facts === facts);
}

/** 今 done のチケットをすべて見た見直しの記録があるか（そのあとにマージされたチケットがあれば、前の記録は数えない） */
export function auditedWith(records: readonly Checkpoint[], done: readonly string[]): boolean {
  return records.some((c) => {
    if (c.name !== "audit") return false;
    const seen = new Set(c.basis?.done ?? []);
    return done.every((id) => seen.has(id));
  });
}

/** 段階の記録があるか（根拠を持たない段階：release・retro） */
export function passed(records: readonly Checkpoint[], name: CheckpointStage): boolean {
  return records.some((c) => c.name === name);
}

/** 記録のある段階の名前（並べ替えて重複を除く）。根拠を持たない段階（retro・独自の段階）を終えたかを、名前があるかで決める */
export function passedStages(records: readonly Checkpoint[]): string[] {
  return [...new Set(records.map((c) => c.name))].sort();
}

/** 対象の Iteration の、数える関所の記録（iteration reopen より前は数えない）。Iteration がなければ空 */
export function iterationCheckpoints(store: Store, iteration: string | null): Checkpoint[] {
  const it = iteration === null ? undefined : store.iterations.get(iteration as IterationId)?.data;
  return it ? countedCheckpoints(it) : [];
}

// ---- deguboard-local/flow/（共有しない） ----

const flowLocalSchema = z.object({
  /** 止まる判定：前に返した段階と、そのときの事実のハッシュ */
  last: z.object({ stage: z.string(), facts: z.string() }).optional(),
  /** Iteration の決まらない流れの割り当ての記録 */
  assign: z.array(checkpointSchema).optional(),
});
export type FlowLocal = z.output<typeof flowLocalSchema>;

/** 対象ごとのファイル。鍵が長い（チケットが多い）ときはハッシュにする */
export function flowLocalPath(localDir: string, key: string): string {
  const name = key.replace(/ /g, "-");
  return path.join(
    localDir,
    "flow",
    `${name.length <= 80 ? name : createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`,
  );
}

/** 読めない・形が違うファイルは、ないものとして読む（止まる判定を忘れるだけで、段階は記録と事実から求め直す） */
export async function readFlowLocal(localDir: string, key: string): Promise<FlowLocal> {
  try {
    const parsed = flowLocalSchema.safeParse(
      JSON.parse(await readFile(flowLocalPath(localDir, key), "utf8")),
    );
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export async function writeFlowLocal(localDir: string, key: string, data: FlowLocal) {
  await writeFileAtomic(flowLocalPath(localDir, key), `${JSON.stringify(data, null, 2)}\n`);
}
