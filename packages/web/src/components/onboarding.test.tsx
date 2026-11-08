// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostProvider, type Host } from "../host.js";
import { createUiState, memoryBackend } from "../ui-state.js";
import { Onboarding, ONBOARDING_STEPS } from "./onboarding.js";

afterEach(cleanup);

describe("始め方の案内", () => {
  it("init・起票・エージェントに頼むの 3 つの手順を、コマンドつきで出す", () => {
    const host: Host = {
      surface: "sidebar",
      open: () => {},
      show: () => {},
      copy: async () => {},
      state: createUiState(memoryBackend()),
    };
    render(
      <HostProvider host={host}>
        <Onboarding />
      </HostProvider>,
    );
    expect(ONBOARDING_STEPS.map((s) => s.command)).toEqual([
      "dg init",
      'dg ticket create "最初のチケット"',
      "dg skill install",
    ]);
    for (const step of ONBOARDING_STEPS) expect(screen.getByText(step.command)).toBeTruthy();
  });

  it("ボタンはコマンドをクリップボードにコピーするだけ", async () => {
    const copy = vi.fn(async () => {});
    const host: Host = {
      surface: "sidebar",
      open: () => {},
      show: () => {},
      copy,
      state: createUiState(memoryBackend()),
    };
    render(
      <HostProvider host={host}>
        <Onboarding />
      </HostProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "dg init をコピー" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith("dg init"));
    expect(copy).toHaveBeenCalledTimes(1);
  });

  it("init の後は見張りの読み直しで普段の画面に変わることを案内する", () => {
    const host: Host = {
      surface: "sidebar",
      open: () => {},
      show: () => {},
      copy: async () => {},
      state: createUiState(memoryBackend()),
    };
    render(
      <HostProvider host={host}>
        <Onboarding />
      </HostProvider>,
    );
    expect(
      screen.getByText("1 を済ませると、開き直さなくてもいつもの画面に変わります。"),
    ).toBeTruthy();
  });
});
