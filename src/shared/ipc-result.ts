import type { IpcErrorCode } from "./ipc-errors.js";

export interface IpcOk<T> {
  ok: true;
  value: T;
}

export interface IpcErr {
  ok: false;
  code: IpcErrorCode;
  message: string;
}

export type IpcResult<T> = IpcOk<T> | IpcErr;

export function ok<T>(value: T): IpcOk<T> {
  return { ok: true, value };
}

export function err(code: IpcErrorCode, message: string): IpcErr {
  return { ok: false, code, message };
}
