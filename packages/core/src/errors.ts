// core 全体で使うエラー。入口は exitCode に写す（CL-1：1 = 失敗、2 = 使い方の誤り）

export type OperationErrorCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "TRANSITION_REJECTED"
  | "CLAIM_LOST"
  | "SYNC_CONFLICT"
  | "PUSH_FAILED"
  | "VALIDATION_FAILED"
  | "GIT_ERROR"
  | "IDENTITY_MISSING"
  | "NOT_INITIALIZED"
  | "UNKNOWN_COMMAND"
  | "REJECTED";

export class DeguboardError extends Error {
  readonly exitCode: 1 | 2;
  readonly code: string;
  readonly detail: string | undefined;
  constructor(exitCode: 1 | 2, code: string, message: string, detail?: string) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
    this.code = code;
    this.detail = detail;
  }
}

/** 使い方の誤り。入力の形が違うときだけ */
export class UsageError extends DeguboardError {
  constructor(message: string, detail?: string) {
    super(2, "INVALID_INPUT", message, detail);
  }
}

/** 実行時の失敗。データの状態や Git に依存するもの */
export class OperationError extends DeguboardError {
  declare readonly code: OperationErrorCode;
  constructor(code: OperationErrorCode, message: string, detail?: string) {
    super(1, code, message, detail);
  }
}
