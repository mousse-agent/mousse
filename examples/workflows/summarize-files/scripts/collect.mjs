// scripts/collect.mjs -- illustrative trusted local asset
import { readFile } from "node:fs/promises";
import path from "node:path";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { files } = JSON.parse(input);
const root = process.env.MOUSSE_INPUT_DIR;
const chunks = [];
for (const name of files) {
  const text = await readFile(path.join(root, name), "utf8");
  if (text.trim()) chunks.push(text);
}
process.stdout.write(JSON.stringify({ count: chunks.length, text: chunks.join("\n\n") }));
