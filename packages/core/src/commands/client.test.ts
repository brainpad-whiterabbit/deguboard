import { describe, expect, it } from "vitest";
import { detailOfRoute, detailRouteOf, initCommandLine } from "./client.js";

describe("チェックリストの dg init の 1 行（initCommandLine）", () => {
  it("渡した値を --remote・--data-remote・--data-branch に付け、省いた値は付けない", () => {
    expect(initCommandLine({})).toBe("dg init");
    expect(
      initCommandLine({
        remote: "upstream",
        dataRemote: "git@github.com:team/kanban.git",
        dataBranch: "kanban",
        newBoard: true,
      }),
    ).toBe(
      "dg init --new-board --remote upstream --data-remote git@github.com:team/kanban.git --data-branch kanban",
    );
  });

  it("シェルにそのまま渡せない値だけを単一引用符で囲む", () => {
    expect(initCommandLine({ dataRemote: "https://example.com/a b.git" })).toBe(
      "dg init --data-remote 'https://example.com/a b.git'",
    );
    expect(initCommandLine({ dataRemote: "$(x)", dataBranch: "it's" })).toBe(
      `dg init --data-remote '$(x)' --data-branch 'it'\\''s'`,
    );
    // zsh の EQUALS は先頭の =cmd を展開するので、先頭の = だけを囲む
    expect(initCommandLine({ dataRemote: "kanban", dataBranch: "=foo" })).toBe(
      "dg init --data-remote kanban --data-branch '=foo'",
    );
    expect(initCommandLine({ dataBranch: "a=b" })).toBe("dg init --data-branch a=b");
  });
});

describe("詳細のルート（WEBVIEW_CONTRACT.detailRoutes）", () => {
  it("チケット・Iteration・Epic・Plan の ID から詳細のルートを組み、形の違う ID は組まない", () => {
    expect(detailRouteOf("t1")).toBe("#/tickets/t1");
    expect(detailRouteOf("s1")).toBe("#/iterations/s1");
    expect(detailRouteOf("e1")).toBe("#/epics/e1");
    expect(detailRouteOf("p1")).toBe("#/plans/p1");
    for (const id of ["x1", "t01", "t", "12", " t1", "t1a"])
      expect(detailRouteOf(id)).toBeUndefined();
  });

  it("詳細のルートから対象を取り、それ以外は undefined（パネルの題に使う）", () => {
    expect(detailOfRoute("#/tickets/t12")).toEqual({ kind: "ticket", id: "t12" });
    expect(detailOfRoute("#/tickets/t12?x=1")).toEqual({ kind: "ticket", id: "t12" });
    expect(detailOfRoute("#/iterations/s3")).toEqual({ kind: "iteration", id: "s3" });
    expect(detailOfRoute("#/epics/e2")).toEqual({ kind: "epic", id: "e2" });
    expect(detailOfRoute("#/plans/p5")).toEqual({ kind: "plan", id: "p5" });
    // Plan の一覧の画面はないので、ID のないルートは詳細でない
    expect(detailOfRoute("#/plans")).toBeUndefined();
    expect(detailOfRoute("#/board")).toBeUndefined();
    expect(detailOfRoute("#/tickets")).toBeUndefined();
    expect(detailOfRoute("#/tickets/")).toBeUndefined();
  });

  it("組んだルートを読むと元の ID に戻る", () => {
    for (const id of ["t12", "s3", "e2", "p5"])
      expect(detailOfRoute(detailRouteOf(id)!)?.id).toBe(id);
  });
});
