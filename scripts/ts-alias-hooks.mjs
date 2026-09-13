// Resolution hooks so the offline unit tests can import the app's TypeScript
// modules directly under `node --experimental-strip-types`: maps the "@/" path
// alias to src/ and fills in the extensionless specifiers TS allows.
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

const resolveFile = (base) => {
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return existsSync(base) && statSync(base).isFile() ? base : null;
};

export function resolve(specifier, context, nextResolve) {
  let base = null;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
  }
  const file = base && resolveFile(base);
  return file ? nextResolve(pathToFileURL(file).href, context) : nextResolve(specifier, context);
}
