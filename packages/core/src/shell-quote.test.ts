import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellQuote } from "./shell-quote.js";

describe("shellQuote（シェルに渡す引数を囲む）", () => {
  it("そのまま渡せる値は囲まず、渡せない文字を含む値だけを単一引用符で囲む", () => {
    expect(shellQuote("/usr/bin/node")).toBe("/usr/bin/node");
    expect(shellQuote("git@github.com:team/kanban.git")).toBe("git@github.com:team/kanban.git");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("$(x)")).toBe("'$(x)'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("")).toBe("''");
  });

  it("先頭の = は囲み（zsh の EQUALS が =cmd を展開する）、途中の = は囲まない", () => {
    expect(shellQuote("=foo")).toBe("'=foo'");
    expect(shellQuote("a=b")).toBe("a=b");
  });

  it("囲んだ値を sh が元の 1 つの引数として読む", () => {
    const values = ["plain", "a b", "it's", "$(echo x)", "=foo", "a;b", "", "*", "~", "\\"];
    const r = spawnSync("sh", ["-c", `printf '%s\\n' ${values.map(shellQuote).join(" ")}`], {
      encoding: "utf8",
    });
    expect(r.stdout).toBe(values.map((v) => `${v}\n`).join(""));
  });
});
