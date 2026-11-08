// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHost, HostProvider } from "../host.js";
import { COPY_NOTICE_MS, CopyableCode } from "./copyable-code.js";

const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (original) Object.defineProperty(navigator, "clipboard", original);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}

describe("値とコピーのボタン", () => {
  it("押すと値をクリップボードに入れて「コピーした」を出し、しばらくして消す", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    render(
      <HostProvider host={createHost("panel", null)}>
        <CopyableCode text="feat/x" label="ブランチ名をコピー" />
      </HostProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ブランチ名をコピー" }));
    });
    expect(writeText).toHaveBeenCalledWith("feat/x");
    expect(screen.getByRole("status").textContent).toBe("コピーした");
    act(() => vi.advanceTimersByTime(COPY_NOTICE_MS));
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("dg serve で navigator.clipboard がなければ「コピーできない」を出す", async () => {
    setClipboard(undefined);
    render(
      <HostProvider host={createHost("panel", null)}>
        <CopyableCode text="feat/x" label="ブランチ名をコピー" />
      </HostProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ブランチ名をコピー" }));
    });
    expect(screen.getByRole("status").textContent).toBe("コピーできない");
  });
});
