import { readFileSync } from "node:fs";
import { transform } from "esbuild";

/**
 * One-way compile of a .ts node file to the JS that runs inside n8n.
 * No bundling — imports would not resolve inside a Code node anyway.
 */
export async function compileTs(file: string): Promise<string> {
  const source = readFileSync(file, "utf8");
  const result = await transform(source, {
    loader: "ts",
    format: "cjs",
    target: "node18",
    sourcefile: file,
  });
  return result.code.endsWith("\n") ? result.code : result.code + "\n";
}
