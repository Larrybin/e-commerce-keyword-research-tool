import { loadDotEnv } from "./env.mjs";

loadDotEnv();

export function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

export function readFlag(name) {
  return process.argv.includes(`--${name}`);
}
