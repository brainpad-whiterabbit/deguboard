// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createHost, readSurface } from "./host.js";

describe("載っている場所（surface）", () => {
  it("data 属性の sidebar・panel を読み、なければブラウザ", () => {
    expect(readSurface({ surface: "sidebar" })).toBe("sidebar");
    expect(readSurface({ surface: "panel" })).toBe("panel");
    expect(readSurface({})).toBe("browser");
    expect(readSurface({ surface: "nope" })).toBe("browser");
  });

  it("ブラウザでは開発用に ?surface= も読み、data 属性があればそちらを優先する", () => {
    expect(readSurface({}, "?surface=sidebar")).toBe("sidebar");
    expect(readSurface({}, "?surface=panel&x=1")).toBe("panel");
    expect(readSurface({}, "?surface=nope")).toBe("browser");
    expect(readSurface({ surface: "panel" }, "?surface=sidebar")).toBe("panel");
  });

  it("拡張ホストとつながっていなければ、サイドバーの配置でも詳細はハッシュ遷移で開く", () => {
    const host = createHost("sidebar", null);
    expect(host.surface).toBe("sidebar");
    host.open({ page: "ticket", id: "t3" });
    expect(window.location.hash).toBe("#/tickets/t3");
  });
});
