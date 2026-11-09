import * as clack from "@clack/prompts";

/** Thrown when the user backs out of a prompt (Ctrl-C or Esc). */
export class Cancelled extends Error {}

function orCancel<T>(value: T | symbol): T {
  if (clack.isCancel(value)) throw new Cancelled();
  return value as T;
}

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

export async function select<T>(message: string, choices: Choice<T>[]): Promise<T> {
  // clack's option type is conditional on T, which doesn't resolve for a generic T.
  return orCancel<T>(await clack.select<T>({ message, options: choices as clack.Option<T>[] }));
}

export async function confirm(message: string): Promise<boolean> {
  return orCancel<boolean>(await clack.confirm({ message }));
}

export async function text(
  message: string,
  options: { placeholder?: string; validate?: (value: string) => string | undefined } = {},
): Promise<string> {
  const { placeholder, validate } = options;
  const value = await clack.text({ message, placeholder, validate: validate && ((input) => validate(input ?? "")) });
  return orCancel<string | undefined>(value) ?? "";
}

export const log = clack.log;
