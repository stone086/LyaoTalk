import fs from "node:fs";
import path from "node:path";

const rootArg = process.argv[2] ?? "apps/web/src";
const root = path.resolve(rootArg);
const buttonRegex = /<button[\s\S]*?>/g;

if (!fs.existsSync(root)) {
  console.error(`Target source folder not found: ${root}`);
  process.exit(2);
}

function walk(dir) {
  const out = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...walk(full));
    else if (/\.(tsx|jsx)$/.test(item.name)) out.push(full);
  }
  return out;
}

const files = walk(root);
const buttons = [];
const suspicious = [];

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const matches = text.match(buttonRegex) ?? [];

  for (const match of matches) {
    const record = { file: path.relative(process.cwd(), file), button: match.replace(/\s+/g, " ") };
    buttons.push(record);

    const hasOnClick = /onClick=/.test(match);
    const isSubmit = /type=["']submit["']/.test(match);
    const isDisabled = /disabled/.test(match);

    if (!hasOnClick && !isSubmit && !isDisabled) {
      suspicious.push(record);
    }
  }
}

console.log(`Scan root: ${path.relative(process.cwd(), root) || root}`);
console.log(`Buttons found: ${buttons.length}`);
console.log(`Suspicious buttons without onClick/type=submit/disabled: ${suspicious.length}`);

if (suspicious.length > 0) {
  console.log(JSON.stringify(suspicious, null, 2));
  process.exit(1);
}
