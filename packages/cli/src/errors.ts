// エラーの出力と終了コード（CL-1：0 成功 / 1 失敗 / 2 使い方の誤り）

import { DeguboardError } from "@deguboard/core";
import { CommanderError } from "commander";

export interface ErrorView {
  code: string;
  message: string;
  detail?: string;
  exitCode: number;
}

export function toErrorView(error: unknown): ErrorView {
  if (error instanceof DeguboardError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {}),
      exitCode: error.exitCode,
    };
  }
  if (error instanceof CommanderError) {
    // --help や --version の正常終了も CommanderError で来る
    return { code: error.code, message: error.message, exitCode: error.exitCode };
  }
  const message = error instanceof Error ? error.message : String(error);
  const detail = process.env["DEGUBOARD_DEBUG"] && error instanceof Error ? error.stack : undefined;
  return { code: "INTERNAL", message, ...(detail ? { detail } : {}), exitCode: 1 };
}
