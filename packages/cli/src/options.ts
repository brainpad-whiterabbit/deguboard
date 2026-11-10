// Zod の入力スキーマから commander の位置引数とオプションを作り、受け取った引数を入力オブジェクトに戻す。
// 型ごとの対応（ここが正本）：
//   string / number / unknown   --key <value>（snake_case は --kebab-case）
//   boolean                     --key（フラグ。no_ で始まる key は --no-key。commander は否定として key を false にするので、それを読む）
//   enum                        --key <value> に choices
//   array（string / enum）      単数形で繰り返す（--label a --label b）。カンマ区切りも受ける
//   array（meta freeText）      単数形で繰り返すだけ。要素が自由文なのでカンマで割らない（--acceptance）
//   nullable                    none で外す（--epic none）
//   record（fields）            --field key=value の繰り返し。true / false / 数値は変換する
//   string（meta cliSource）    位置引数 <file> の中身（YAML / JSON。- で標準入力）を読んだ文字列。オプションにはしない（ticket import。program.ts）
//   record・array（meta cliFile） --<cliFile> <path> の YAML / JSON（- で標準入力）を読んだ値（workflow set の --file・run review-result の --findings-file。program.ts）
//   positionals                 CommandDef.positionals のキーは位置引数。最後が配列なら可変長

import type { AnyCommand } from "@deguboard/core";
import { Argument, InvalidArgumentError, Option, type Command } from "commander";
import type { z } from "zod";

type Def = {
  type: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  entries?: Record<string, unknown>;
};

/** optional / nullable / default を剥がした中身と、剥がした種類 */
export interface FieldShape {
  key: string;
  flag: string;
  kind:
    | "string"
    | "number"
    | "boolean"
    | "enum"
    | "array"
    | "record"
    | "unknown"
    | "objects"
    | "source"
    | "file";
  /** 配列のときの要素の型 */
  element?: "string" | "number" | "enum";
  /** 配列の要素が自由文（zod の meta freeText）。カンマで割らない */
  freeText?: boolean;
  choices?: string[];
  optional: boolean;
  nullable: boolean;
  description: string;
}

function defOf(schema: z.ZodType): Def {
  return (schema as unknown as { _zod: { def: Def } })._zod.def;
}

function unwrap(schema: z.ZodType): { inner: z.ZodType; optional: boolean; nullable: boolean } {
  let inner = schema;
  let optional = false;
  let nullable = false;
  for (;;) {
    const def = defOf(inner);
    if (def.type === "optional" || def.type === "default") optional = true;
    else if (def.type === "nullable") nullable = true;
    else break;
    if (!def.innerType) break;
    inner = def.innerType;
  }
  return { inner, optional, nullable };
}

export function toFlag(key: string): string {
  return key.replace(/_/g, "-");
}

export function describeShape(key: string, schema: z.ZodType): FieldShape {
  const { inner, optional, nullable } = unwrap(schema);
  const def = defOf(inner);
  const description = schema.description ?? inner.description ?? "";
  const base = { key, flag: toFlag(key), optional, nullable, description };
  switch (def.type) {
    case "string":
      // CLI では位置引数のファイルの中身を入れる（zod の meta cliSource）
      if (inner.meta()?.["cliSource"] === true) return { ...base, kind: "source" };
      return { ...base, kind: "string" };
    case "number":
      return { ...base, kind: "number" };
    case "boolean":
      return { ...base, kind: "boolean" };
    case "enum":
      return { ...base, kind: "enum", choices: Object.keys(def.entries ?? {}) };
    case "array": {
      // CLI ではファイルから読む配列（zod の meta cliFile がオプションの名前。run review-result の --findings-file）
      const cliFile = inner.meta()?.["cliFile"];
      if (typeof cliFile === "string") return { ...base, flag: cliFile, kind: "file" };
      const element = unwrap(def.element!).inner;
      const edef = defOf(element);
      if (edef.type === "object") return { ...base, kind: "objects" };
      const kind = edef.type === "number" ? "number" : edef.type === "enum" ? "enum" : "string";
      return {
        ...base,
        kind: "array",
        element: kind,
        ...(inner.meta()?.freeText === true ? { freeText: true } : {}),
        ...(kind === "enum" ? { choices: Object.keys(edef.entries ?? {}) } : {}),
      };
    }
    case "record": {
      // CLI ではファイルから読む値（zod の meta cliFile がオプションの名前）
      const cliFile = inner.meta()?.["cliFile"];
      if (typeof cliFile === "string") return { ...base, flag: cliFile, kind: "file" };
      return { ...base, kind: "record" };
    }
    default:
      return { ...base, kind: "unknown" };
  }
}

export function shapesOf(command: AnyCommand): FieldShape[] {
  const shape = (command.input as unknown as { shape?: Record<string, z.ZodType> }).shape ?? {};
  return Object.entries(shape).map(([key, schema]) => describeShape(key, schema));
}

const NONE = "none";

// commander は argParser が返した null を "" に変えてしまうので、none はここでは文字列のまま通し collectInput で null にする
function parseScalar(shape: FieldShape, raw: string): unknown {
  if (shape.nullable && raw === NONE) return NONE;
  const kind = shape.kind === "array" ? shape.element : shape.kind;
  if (kind === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new InvalidArgumentError("Specify a number");
    return n;
  }
  if (kind === "enum" && shape.choices && !shape.choices.includes(raw)) {
    throw new InvalidArgumentError(`Specify one of:${shape.choices.join(", ")}`);
  }
  return raw;
}

/** `key=value` の値。true/false と数値は変換する */
function parseRecordEntry(
  raw: string,
  previous: Record<string, unknown> = {},
): Record<string, unknown> {
  const eq = raw.indexOf("=");
  if (eq <= 0) throw new InvalidArgumentError("Specify it in the form key=value");
  const key = raw.slice(0, eq);
  const text = raw.slice(eq + 1);
  const value =
    text === "true"
      ? true
      : text === "false"
        ? false
        : /^-?\d+(\.\d+)?$/.test(text)
          ? Number(text)
          : text === NONE
            ? null
            : text;
  return { ...previous, [key]: value };
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 1 回の指定が表す要素。自由文の配列はそのまま 1 要素、それ以外はカンマで割る */
function listItems(shape: FieldShape, raw: string): string[] {
  return shape.freeText ? [raw] : splitList(raw);
}

/** 単数形の名前（labels → label、tickets → ticket）。繰り返すオプションの名前に使う */
function singular(flag: string): string {
  if (/(ss|us)$/.test(flag) || !flag.endsWith("s") || flag.length < 2) return flag;
  return flag.slice(0, -1);
}

export interface Bound {
  positionals: FieldShape[];
  options: FieldShape[];
}

/** コマンドに位置引数とオプションを登録する */
export function bindInputs(cmd: Command, command: AnyCommand, shapes = shapesOf(command)): Bound {
  const positionalKeys = command.positionals ?? [];
  const positionals = positionalKeys
    .map((k) => shapes.find((s) => s.key === k))
    .filter((s): s is FieldShape => s !== undefined);
  const options = shapes.filter((s) => !positionalKeys.includes(s.key));

  positionals.forEach((shape, i) => {
    const last = i === positionals.length - 1;
    const variadic = last && shape.kind === "array";
    const name = variadic ? `${shape.key}...` : shape.key;
    const arg = new Argument(shape.optional ? `[${name}]` : `<${name}>`, shape.description);
    if (shape.kind === "enum" && shape.choices) arg.choices(shape.choices);
    if (shape.kind === "number") arg.argParser((raw) => parseScalar(shape, raw));
    // 可変長の値も commander の中で変換する。collectInput で投げると commander のエラーとして扱われ、理由が出ない
    if (variadic && shape.element !== "string") {
      arg.argParser((raw: string, previous: unknown[] = []) => [
        ...previous,
        ...listItems(shape, raw).map((v) => parseScalar(shape, v)),
      ]);
    }
    cmd.addArgument(arg);
  });

  for (const shape of options) {
    const desc = shape.description + (shape.nullable ? ` (${NONE} to clear)` : "");
    switch (shape.kind) {
      case "boolean":
        cmd.addOption(new Option(`--${shape.flag}`, desc));
        break;
      case "array": {
        const flag = singular(shape.flag);
        const opt = new Option(
          `--${flag} <value>`,
          `${desc}. ${shape.freeText ? "Repeat to give several values" : "Repeat or use commas to give several values"}`,
        );
        opt.argParser((raw: string, previous: unknown[] = []) => [
          ...previous,
          ...listItems(shape, raw).map((v) => parseScalar(shape, v)),
        ]);
        cmd.addOption(opt);
        break;
      }
      case "record": {
        const flag = singular(shape.flag);
        const opt = new Option(`--${flag} <key=value>`, `${desc}. Repeat to give several values`);
        opt.argParser((raw: string, previous?: Record<string, unknown>) =>
          parseRecordEntry(raw, previous),
        );
        cmd.addOption(opt);
        break;
      }
      case "objects":
      case "source":
        // CLI では位置引数のファイルから読む（ticket import）。オプションにはしない
        break;
      case "file":
        // 値はファイルのパス。読むのは program.ts
        cmd.addOption(
          new Option(
            `--${shape.flag} <path>`,
            `${desc} (a YAML or JSON file; - reads standard input)`,
          ),
        );
        break;
      default: {
        const opt = new Option(`--${shape.flag} <value>`, desc);
        if (shape.kind === "enum" && shape.choices && !shape.nullable) opt.choices(shape.choices);
        else opt.argParser((raw: string) => parseScalar(shape, raw));
        cmd.addOption(opt);
      }
    }
  }
  return { positionals, options };
}

/** commander が解析した位置引数とオプションを、core の入力オブジェクトにする */
export function collectInput(
  bound: Bound,
  args: unknown[],
  opts: Record<string, unknown>,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  bound.positionals.forEach((shape, i) => {
    const value = args[i];
    if (value === undefined) return;
    if (shape.kind === "array") {
      const list = Array.isArray(value) ? value : [value];
      input[shape.key] = list
        .flatMap((v) => listItems(shape, String(v)))
        .map((v) => parseScalar(shape, v));
    } else if (shape.kind === "unknown") {
      input[shape.key] = value;
    } else {
      input[shape.key] = typeof value === "string" ? parseScalar(shape, value) : value;
    }
  });
  for (const shape of bound.options) {
    // commander はフラグ名を camelCase にする
    const camel = shape.flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    // --no-run のような否定の形は、commander が run: false（省けば true）にする
    if (shape.kind === "boolean" && shape.flag.startsWith("no-")) {
      if (opts[camel.charAt(2).toLowerCase() + camel.slice(3)] === false) input[shape.key] = true;
      continue;
    }
    const name = shape.kind === "array" || shape.kind === "record" ? singular(camel) : camel;
    const value = opts[name];
    if (value === undefined) continue;
    input[shape.key] = shape.nullable && value === NONE ? null : value;
  }
  return input;
}
