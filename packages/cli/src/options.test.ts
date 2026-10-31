import { commands, findCommand } from "@deguboard/core";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { bindInputs, collectInput, describeShape, shapesOf, toFlag } from "./options.js";
import { z } from "zod";

function parse(name: string, argv: string[]): Record<string, unknown> {
  const def = findCommand(name)!;
  // 想定内の引数エラーを stderr に出さない
  const cmd = new Command("x")
    .exitOverride()
    .configureOutput({ writeErr: () => {}, outputError: () => {} });
  const bound = bindInputs(cmd, def);
  let input: Record<string, unknown> = {};
  cmd.action((...args: unknown[]) => {
    input = collectInput(
      bound,
      args.slice(0, -2),
      args[args.length - 2] as Record<string, unknown>,
    );
  });
  cmd.parse(argv, { from: "user" });
  return input;
}

describe("Zod → オプション", () => {
  it("snake_case のキーは --kebab-case になり、boolean はフラグになる", () => {
    expect(toFlag("include_abandoned")).toBe("include-abandoned");
    const shapes = shapesOf(findCommand("ticket.list")!);
    expect(shapes.find((s) => s.key === "include_abandoned")).toMatchObject({
      kind: "boolean",
      flag: "include-abandoned",
      optional: true,
    });
    expect(parse("ticket.list", ["--include-abandoned", "--ready"])).toEqual({
      include_abandoned: true,
      ready: true,
    });
  });

  it("配列は繰り返しとカンマ区切りの両方で受け、nullable は none で null になる", () => {
    expect(
      parse("ticket.create", ["題", "--label", "a,b", "--label", "c", "--depends-on", "1"]),
    ).toEqual({
      title: "題",
      labels: ["a", "b", "c"],
      depends_on: ["1"],
    });
    expect(
      parse("ticket.update", ["t1", "--epic", "none", "--pr", "none", "--iteration", "s2"]),
    ).toEqual({
      ticket: "t1",
      epic: null,
      pr: null,
      iteration: "s2",
    });
    expect(parse("ticket.update", ["t1", "--pr", "42"])).toEqual({ ticket: "t1", pr: 42 });
  });

  it("ticket check は番号を可変長の位置引数で数値として受け、all と undo はフラグになる", () => {
    expect(parse("ticket.check", ["t1", "1", "3", "--undo"])).toEqual({
      ticket: "t1",
      items: [1, 3],
      undo: true,
    });
    expect(parse("ticket.check", ["t1", "1,2"])).toEqual({ ticket: "t1", items: [1, 2] });
    // 番号を省くと [] が入る（all との組み合わせは core が検査する）
    expect(parse("ticket.check", ["t1", "--all"])).toEqual({ ticket: "t1", items: [], all: true });
    expect(() => parse("ticket.check", ["t1", "x"])).toThrow();
  });

  it("自由文の配列（meta freeText）は繰り返しだけで受け、カンマで割らない", () => {
    const shapes = shapesOf(findCommand("ticket.create")!);
    expect(shapes.find((s) => s.key === "acceptance")).toMatchObject({
      kind: "array",
      freeText: true,
    });
    expect(shapes.find((s) => s.key === "labels")?.freeText).toBeUndefined();
    expect(
      parse("ticket.create", ["題", "--acceptance", "a, b", "--acceptance", "c", "--label", "x,y"]),
    ).toEqual({ title: "題", acceptance: ["a, b", "c"], labels: ["x", "y"] });
  });

  it("--field key=value は record になり、true/false と数値を変換する", () => {
    expect(
      parse("ticket.create", [
        "題",
        "--field",
        "estimate=3",
        "--field",
        "client=ACME",
        "--field",
        "urgent=true",
      ]),
    ).toEqual({
      title: "題",
      fields: { estimate: 3, client: "ACME", urgent: true },
    });
  });

  it("positionals の最後が配列なら可変長になり、enum の位置引数は choices になる", () => {
    expect(parse("epic.add", ["e1", "1", "2", "t3"])).toEqual({
      epic: "e1",
      tickets: ["1", "2", "t3"],
    });
    expect(parse("ticket.move", ["1", "review"])).toEqual({ ticket: "1", status: "review" });
    expect(() => parse("ticket.move", ["1", "nope"])).toThrow();
    expect(parse("config.set", ["commit.mode", "each"])).toEqual({
      key: "commit.mode",
      value: "each",
    });
  });

  it("status のような s で終わる単数の配列はそのままの名前になる", () => {
    expect(parse("ticket.list", ["--status", "todo,review"])).toEqual({
      status: ["todo", "review"],
    });
    expect(() => parse("ticket.list", ["--status", "nope"])).toThrow();
  });

  it("すべてのコマンドの入力を落とさずにオプションか位置引数にできる", () => {
    for (const def of commands) {
      const shapes = shapesOf(def);
      const cmd = new Command("x");
      const bound = bindInputs(cmd, def, shapes);
      const covered = new Set([...bound.positionals, ...bound.options].map((s) => s.key));
      for (const s of shapes) expect(covered.has(s.key), `${def.name}.${s.key}`).toBe(true);
      for (const key of def.positionals ?? []) {
        // import の file は入力にないので CLI が別に足す
        if (key === "file") continue;
        expect(
          shapes.some((s) => s.key === key),
          `${def.name} の positionals ${key}`,
        ).toBe(true);
      }
    }
  });

  it("describeShape は optional / nullable / default を剥がして中身の型を返す", () => {
    expect(describeShape("n", z.number().int().optional())).toMatchObject({
      kind: "number",
      optional: true,
    });
    expect(describeShape("e", z.enum(["a", "b"]).nullable().optional())).toMatchObject({
      kind: "enum",
      choices: ["a", "b"],
      nullable: true,
    });
    expect(describeShape("d", z.array(z.object({ a: z.string() })))).toMatchObject({
      kind: "objects",
    });
  });
});
