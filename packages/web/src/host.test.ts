// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebviewClient } from "./client/webview.js";
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

  it("navigator.clipboard が使えれば、それに書き、拡張ホストには頼まない", async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    const client = fakeClient();
    await createHost("panel", client).copy("feat/x");
    expect(writeText).toHaveBeenCalledWith("feat/x");
    expect(client.copy).not.toHaveBeenCalled();
  });

  it("Webview で navigator.clipboard がなければ、拡張ホストにコピーを頼む", async () => {
    setClipboard(undefined);
    const client = fakeClient();
    await createHost("panel", client).copy("feat/x");
    expect(client.copy).toHaveBeenCalledWith("feat/x");
  });

  it("Webview で navigator.clipboard が拒んでも、拡張ホストにコピーを頼む", async () => {
    setClipboard({ writeText: vi.fn(async () => Promise.reject(new Error("NotAllowedError"))) });
    const client = fakeClient();
    await createHost("sidebar", client).copy("feat/x");
    expect(client.copy).toHaveBeenCalledWith("feat/x");
  });

  it("ブラウザで navigator.clipboard がなければ失敗を返す（頼む先がない）", async () => {
    setClipboard(undefined);
    await expect(createHost("browser", null).copy("feat/x")).rejects.toThrow();
  });
});
