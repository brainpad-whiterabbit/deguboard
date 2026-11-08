// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebviewClient } from "./client/webview.js";
import { createHost, readSurface } from "./host.js";

describe("載っている場所（surface）", () => {
  it("data 属性の sidebar・panel を読み、なければサイドバー", () => {
    expect(readSurface({ surface: "sidebar" })).toBe("sidebar");
    expect(readSurface({ surface: "panel" })).toBe("panel");
    expect(readSurface({})).toBe("sidebar");
    expect(readSurface({ surface: "nope" })).toBe("sidebar");
    expect(readSurface({ surface: "browser" })).toBe("sidebar");
  });

  it("dg serve では ?surface= を読み、なければサイドバー。data 属性があればそちらを優先する", () => {
    expect(readSurface({}, "?surface=sidebar")).toBe("sidebar");
    expect(readSurface({}, "?surface=panel&x=1")).toBe("panel");
    expect(readSurface({}, "?surface=nope")).toBe("sidebar");
    expect(readSurface({}, "?surface=browser")).toBe("sidebar");
    expect(readSurface({}, "")).toBe("sidebar");
    expect(readSurface({ surface: "panel" }, "?surface=sidebar")).toBe("panel");
  });

  it("拡張ホストとつながっていなければ、サイドバーの配置でも詳細はハッシュ遷移で開く", () => {
    const host = createHost("sidebar", null);
    expect(host.surface).toBe("sidebar");
    host.open({ page: "ticket", id: "t3" });
    expect(window.location.hash).toBe("#/tickets/t3");
  });
});

describe("クリップボードへのコピー", () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  afterEach(() => {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  });
  function setClipboard(value: unknown) {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value });
  }
  function fakeClient() {
    return { copy: vi.fn(async () => {}) } as unknown as WebviewClient & {
      copy: ReturnType<typeof vi.fn>;
    };
  }

  it("Webview では navigator.clipboard が使えても試さず、拡張ホスト（vscode.env.clipboard）に頼む", async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    for (const surface of ["panel", "sidebar"] as const) {
      const client = fakeClient();
      await createHost(surface, client).copy("feat/x");
      expect(client.copy).toHaveBeenCalledWith("feat/x");
    }
    expect(writeText).not.toHaveBeenCalled();
  });

  it("拡張ホストとつながっていなければ（dg serve）navigator.clipboard に書く", async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    await createHost("sidebar", null).copy("feat/x");
    expect(writeText).toHaveBeenCalledWith("feat/x");
  });

  it("dg serve で navigator.clipboard がなければ失敗を返す（頼む先がない）", async () => {
    setClipboard(undefined);
    await expect(createHost("panel", null).copy("feat/x")).rejects.toThrow();
  });
});
