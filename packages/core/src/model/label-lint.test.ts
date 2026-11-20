// dg lint のラベルの指摘の判定（model/label-lint.ts）。ファイルも git も読まない

import { describe, expect, it } from "vitest";
import type { LabelEntry } from "./labels.js";
import { labelLintFindings } from "./label-lint.js";

const added = "2026-11-01T00:00:00Z";
const before = "2026-10-01T00:00:00Z";
const after = "2026-11-10T00:00:00Z";
const entry = (axis: string, more: Partial<LabelEntry> = {}): LabelEntry => ({
  axis,
  description: `A label of ${axis}`,
  created_at: added,
  ...more,
});
const merged = (axis: string, into: string): LabelEntry =>
  entry(axis, { merged_into: into, merged_at: added });
const axes = [
  { name: "area", description: "Which part" },
  { name: "kind", description: "What kind" },
];
let seq = 0;
const ticket = (labels: string[], status = "todo", id = `t${++seq}`) => ({
  id,
  status,
  labels,
  created_at: added,
});
const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

describe("ラベルの指摘（labelLintFindings）", () => {
  it("軸を書いていない・[] のボードではラベルを見ない", () => {
    const vocabulary = new Map([["ui", entry("nowhere")]]);
    const tickets = [ticket(["Ui", "ui", "tooling"])];
    expect(labelLintFindings(undefined, vocabulary, tickets, [])).toEqual([]);
    expect(labelLintFindings([], vocabulary, tickets, [])).toEqual([]);
  });

  it("語彙にない名前は名前ごとに 1 件、件数を添えて出し、手順のラベルと統合済みの名前は除く", () => {
    const vocabulary = new Map([
      ["ui", entry("area")],
      ["web", merged("area", "ui")],
    ]);
    const findings = labelLintFindings(
      axes,
      vocabulary,
      [
        ticket(["ui", "tooling", "audit-s3"], "done"),
        ticket(["ui", "tooling", "retro-s2", "release-s3", "audit"]),
        ticket(["tooling", "web"], "abandoned"),
      ],
      [],
    ).filter((f) => f.code === "lint_label_undefined");
    expect(findings).toEqual([
      {
        code: "lint_label_undefined",
        message: "The label tooling is not in the vocabulary, but 3 ticket(s) carry it",
      },
    ]);
  });

  it("付いたチケットのない語彙は指摘し、1 件だけの語彙は created_at より後に閉じた Iteration があるときだけ指摘する", () => {
    const vocabulary = new Map([
      ["unused", entry("area")],
      ["once", entry("area")],
      ["twice", entry("area")],
      ["old", merged("area", "twice")],
    ]);
    const tickets = [ticket(["once"], "done"), ticket(["twice"]), ticket(["twice"], "abandoned")];
    const unused = (iterations: { closed_at?: string }[]) =>
      labelLintFindings(axes, vocabulary, tickets, iterations)
        .filter((f) => f.code === "lint_label_unused")
        .map((f) => f.message);
    // 育つ途中：閉じた Iteration がない、閉じたのが語彙を足すより前、閉じていない Iteration だけ
    const growing = ["No ticket carries the label unused"];
    expect(unused([])).toEqual(growing);
    expect(unused([{ closed_at: before }, {}])).toEqual(growing);
    expect(unused([{ closed_at: before }, { closed_at: after }, { closed_at: after }])).toEqual([
      "Only 1 ticket carries the label once, and 2 Iteration(s) closed after it was added",
      "No ticket carries the label unused",
    ]);
  });

  it("todo・in_progress・review のチケットで同じ軸に 2 個以上付いたものを指摘し、done・abandoned には出さない", () => {
    const vocabulary = new Map([
      ["ui", entry("area")],
      ["cli", entry("area")],
      ["core", entry("area")],
      ["bug", entry("kind")],
      ["web", merged("area", "ui")],
    ]);
    const findings = labelLintFindings(
      axes,
      vocabulary,
      [
        ticket(["ui", "cli", "bug"], "todo", "t1"),
        ticket(["ui", "cli", "core"], "in_progress", "t2"),
        ticket(["ui", "core"], "review", "t3"),
        ticket(["ui", "cli"], "done", "t4"),
        ticket(["ui", "cli"], "abandoned", "t5"),
        // 1 軸に 1 個ずつ・統合済みの名前と語彙にない名前は軸に数えない・同じ名前を 2 回は 1 個
        ticket(["ui", "bug", "web", "tooling", "ui"], "todo", "t6"),
      ],
      [],
    ).filter((f) => f.code === "lint_label_axis_multiple");
    expect(findings).toEqual([
      {
        code: "lint_label_axis_multiple",
        ticket: "t1",
        message: "Carries 2 labels of the axis area (ui, cli)",
      },
      {
        code: "lint_label_axis_multiple",
        ticket: "t2",
        message: "Carries 3 labels of the axis area (ui, cli, core)",
      },
      {
        code: "lint_label_axis_multiple",
        ticket: "t3",
        message: "Carries 2 labels of the axis area (ui, core)",
      },
    ]);
  });

  it("大文字と小文字だけが違う名前を、語彙とチケットの名前をあわせて 1 組 1 件で指摘する。統合の記録は見ない", () => {
    const vocabulary = new Map([
      ["ui", entry("area")],
      ["Docs", merged("area", "ui")],
    ]);
    const findings = labelLintFindings(
      axes,
      vocabulary,
      [ticket(["UI"], "done"), ticket(["Ui", "docs"]), ticket(["ui"])],
      [],
    ).filter((f) => f.code === "lint_label_case");
    expect(findings).toEqual([
      { code: "lint_label_case", message: "The labels UI, Ui, ui differ only in case" },
    ]);
  });

  it("どの軸にもない語彙を指摘し、統合の記録は見ない", () => {
    const vocabulary = new Map([
      ["ui", entry("area")],
      ["linux", entry("platform")],
      ["old", merged("gone", "ui")],
    ]);
    const findings = labelLintFindings(
      axes,
      vocabulary,
      [ticket(["ui", "linux"]), ticket(["ui", "linux"])],
      [],
    );
    expect(findings).toEqual([
      {
        code: "lint_label_axis_unknown",
        message: "The label linux belongs to the axis platform, which is not in labels.axes",
      },
    ]);
  });

  it("統合済みの名前が付いたチケットを、done・abandoned も含めてチケットごとに指摘する", () => {
    const vocabulary = new Map([
      ["ui", entry("area")],
      ["web", merged("area", "ui")],
      ["frontend", merged("area", "ui")],
    ]);
    const findings = labelLintFindings(
      axes,
      vocabulary,
      [
        ticket(["web", "frontend"], "abandoned", "t1"),
        ticket(["web"], "done", "t2"),
        ticket(["ui"], "todo", "t3"),
        ticket(["ui"], "todo", "t4"),
      ],
      [],
    );
    expect(codes(findings)).toEqual([
      "lint_label_merged",
      "lint_label_merged",
      "lint_label_merged",
    ]);
    expect(findings.map((f) => [f.ticket, f.message])).toEqual([
      ["t1", "Carries the label web, which was merged into ui"],
      ["t1", "Carries the label frontend, which was merged into ui"],
      ["t2", "Carries the label web, which was merged into ui"],
    ]);
  });
});
