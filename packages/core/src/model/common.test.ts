import { describe, expect, it } from "vitest";
import { isFinishedSet, type Status } from "./common.js";

describe("isFinishedSet（Epic・Plan・Iteration の「終わった」の判定）", () => {
  // 消したチケットは undefined で表す。abandoned だけの集まりと消したチケットを混ぜた集まりの扱いを、表で並べて比べる
  const rows: Array<{ name: string; statuses: (Status | undefined)[]; finished: boolean }> = [
    { name: "チケットが 0 件", statuses: [], finished: false },
    { name: "done だけ", statuses: ["done"], finished: true },
    { name: "abandoned だけ", statuses: ["abandoned"], finished: true },
    { name: "done と abandoned", statuses: ["done", "abandoned"], finished: true },
    { name: "未完了（in_progress）が 1 件", statuses: ["done", "in_progress"], finished: false },
    { name: "未完了（todo）が 1 件", statuses: ["abandoned", "todo"], finished: false },
    { name: "消したチケットと done", statuses: ["done", undefined], finished: true },
    { name: "消したチケットと abandoned", statuses: ["abandoned", undefined], finished: true },
    { name: "消したチケットと未完了", statuses: ["in_progress", undefined], finished: false },
    { name: "消したチケットだけ", statuses: [undefined], finished: false },
    { name: "消したチケットが 2 件", statuses: [undefined, undefined], finished: false },
    {
      name: "消したチケットと done と未完了",
      statuses: ["done", undefined, "review"],
      finished: false,
    },
  ];

  it.each(rows)("$name → 終わった: $finished", ({ statuses, finished }) => {
    expect(isFinishedSet(statuses)).toBe(finished);
  });
});
