// Entry point for `pnpm shadow-report`. Runs under Node with TypeScript transforms enabled.
import { readFile, writeFile } from "node:fs/promises";
import { main } from "./cli.ts";

process.exitCode = await main(process.argv.slice(2), {
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, text) => writeFile(path, text, "utf8"),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
});
