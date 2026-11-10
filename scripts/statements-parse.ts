/**
 * statements-parse.ts — read every unlocked statement and check each one balances.
 *
 * Reads <dir>/text/*.json (from statements-unlock.ts), writes <dir>/parsed.json,
 * and prints, per bank, how many statements reconciled against their own totals.
 * Read-only: touches nothing in cardIQ.
 *
 * Run:  npx tsx scripts/statements-parse.ts --dir ~/.cardiq-statements [--show-failures]
 */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseStatement, type StatementDoc } from "../src/lib/statements/parse";

const dirIdx = process.argv.indexOf("--dir");
if (dirIdx < 0) throw new Error("Pass --dir <folder>");
const dir = process.argv[dirIdx + 1];
const textDir = join(dir, "text");

const out: unknown[] = [];
const byFamily = new Map<string, { files: number; ok: number; empty: number; lines: number; failed: string[] }>();
for (const f of readdirSync(textDir).filter((n) => n.endsWith(".json")).sort()) {
  const doc: StatementDoc = JSON.parse(readFileSync(join(textDir, f), "utf8"));
  const parsed = parseStatement(doc);
  const label = `${doc.family}`;
  const s = byFamily.get(label) ?? { files: 0, ok: 0, empty: 0, lines: 0, failed: [] };
  s.files++;
  s.lines += parsed.lines.length;
  if (parsed.tie.how === "empty") s.empty++;
  else if (parsed.tie.ok) s.ok++;
  else s.failed.push(`${f} ${doc.date?.slice(0, 10)} ${doc.subject?.slice(0, 50)} dr=${parsed.tie.debits} cr=${parsed.tie.credits} n=${parsed.lines.length}`);
  byFamily.set(label, s);
  out.push({ uid: doc.uid, gmail_id: doc.gmail_id, family: doc.family, subject: doc.subject, date: doc.date, file: f, ...parsed });
}
writeFileSync(join(dir, "parsed.json"), JSON.stringify(out), { mode: 0o600 });

let files = 0;
let ok = 0;
let empty = 0;
for (const [family, s] of [...byFamily].sort()) {
  files += s.files;
  ok += s.ok;
  empty += s.empty;
  console.log(`${family.padEnd(10)} ${String(s.ok).padStart(3)}/${String(s.files - s.empty).padEnd(3)} reconciled, ${s.lines} lines${s.empty ? `; ${s.empty} with no activity` : ""}`);
  if (process.argv.includes("--show-failures")) for (const f of s.failed.slice(0, 8)) console.log(`    ✗ ${f}`);
}
console.log(`ALL        ${ok}/${files - empty} reconciled; ${empty} with no activity`);
