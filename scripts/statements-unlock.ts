/**
 * statements-unlock.ts — turn locked statement PDFs into readable text files.
 *
 * Run this yourself in a terminal; it asks for the first 4 letters of the name on
 * the card (several allowed, comma-separated) and your date of birth, with
 * nothing shown on screen. It works out each
 * bank's password from those and saves only the extracted text. What you type and
 * the passwords themselves are never printed or written to disk.
 *
 * Statements it can't open are listed by card, and you can type a password for
 * them or press Return to skip. Finished files are skipped on a re-run.
 *
 * Run:  npx tsx scripts/statements-unlock.ts --dir ~/.cardiq-statements [--last4 1111,2222]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { getDocumentProxy } from "unpdf";
import { isValidDob, passwordCandidatesForPeople, type Person } from "../src/lib/statements/passwords";

type Entry = { uid: number; gmail_id: string | null; family: string; subject: string | null; date: string | null; name: string; sha256: string; file: string };
type Cell = { x: number; s: string };
type Line = { y: number; cells: Cell[] };

let pipedLines: string[] | null = null;

/** Reads one line without echoing it. Piped input (used by tests) is read as lines. */
function askHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  if (!process.stdin.isTTY) {
    pipedLines ??= readFileSync(0, "utf8").split("\n");
    process.stdout.write("\n");
    return Promise.resolve(pipedLines.shift() ?? "");
  }
  return new Promise((resolve) => {
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          process.stdin.setRawMode(false);
          process.stdout.write("\nStopped. Nothing typed was kept.\n");
          process.exit(130);
        }
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

/** Opens a PDF; returns null only for a wrong password, so other failures stay visible. */
async function open(bytes: Uint8Array, password: string) {
  try {
    return await getDocumentProxy(new Uint8Array(bytes), { password, verbosity: 0 } as Parameters<typeof getDocumentProxy>[1]);
  } catch (e) {
    if ((e as Error).name === "PasswordException") return null;
    throw e;
  }
}

async function extractLines(pdf: Awaited<ReturnType<typeof getDocumentProxy>>): Promise<Line[][]> {
  const pages: Line[][] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const lines: Line[] = [];
    for (const item of content.items as { str?: string; transform?: number[] }[]) {
      if (!item.str?.trim() || !item.transform) continue;
      const x = Math.round(item.transform[4] * 10) / 10;
      const y = Math.round(item.transform[5] * 10) / 10;
      const line = lines.find((l) => Math.abs(l.y - y) <= 2);
      if (line) line.cells.push({ x, s: item.str });
      else lines.push({ y, cells: [{ x, s: item.str }] });
    }
    lines.sort((a, b) => b.y - a.y);
    for (const l of lines) l.cells.sort((a, b) => a.x - b.x);
    pages.push(lines);
  }
  return pages;
}

function cardLabel(e: Entry): string {
  return `${e.family}: ${(e.subject ?? "").replace(/\d{2,}/g, (d) => (/ending XX/i.test(e.subject ?? "") && d.length === 2 ? d : "#")).replace(/(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/gi, "").replace(/\s+/g, " ").slice(0, 70)}`;
}

async function knownLast4s(): Promise<string[]> {
  const arg = process.argv.indexOf("--last4");
  if (arg >= 0) return process.argv[arg + 1].split(",");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const seen = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("transactions").select("card_last4").range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) seen.add(r.card_last4 as string);
    if (!data || data.length < 1000) break;
  }
  return [...seen];
}

async function main() {
  const dirIdx = process.argv.indexOf("--dir");
  if (dirIdx < 0) throw new Error("Pass --dir <folder>");
  const dir = process.argv[dirIdx + 1];
  const outDir = join(dir, "text");
  mkdirSync(outDir, { recursive: true, mode: 0o700 });

  const manifest: Entry[] = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const outPath = (e: Entry) => join(outDir, `${e.uid}-${e.sha256.slice(0, 12)}.json`);
  let pending = manifest.filter((e) => !existsSync(outPath(e)));
  console.log(`${manifest.length} statements, ${pending.length} still to open.`);
  if (!pending.length) return;

  const people: Person[] = [];
  for (;;) {
    const n = people.length + 1;
    const typed = await askHidden(
      `Person ${n}: first 4 letters of the name on the card; separate several with commas${n > 1 ? ", or press Return when there's nobody else" : ""} (hidden): `,
    );
    const names = typed.split(",").map((s) => s.trim()).filter(Boolean);
    if (!names.length && n > 1) break;
    const dob = (await askHidden(`Person ${n}: date of birth as DDMMYYYY, e.g. 23121976 (hidden): `)).trim();
    if (!names.length || !names.every((s) => /^[a-zA-Z]{4}$/.test(s)) || !isValidDob(dob)) {
      console.log("Those don't look right (4 letters per name, and a real date as 8 digits). Nothing was opened; please run it again.");
      process.exitCode = 1;
      return;
    }
    people.push({ names, dob });
  }
  const digits = (await askHidden("Card digits you know, comma-separated: a card's last 4, or HSBC's last 6. Return to skip (hidden): "))
    .split(",")
    .map((s) => s.replace(/\s+/g, ""))
    .filter(Boolean);
  if (digits.some((d) => !/^(\d{4}|\d{6})$/.test(d))) {
    console.log("Card digits should be groups of 4 or 6 numbers. Nothing was opened; please run it again.");
    process.exitCode = 1;
    return;
  }
  const last4s = [...new Set([...(await knownLast4s()), ...digits.filter((d) => d.length === 4)])];
  const last6s = digits.filter((d) => d.length === 6);
  console.log(`Trying ${people.length} ${people.length === 1 ? "person" : "people"}...`);

  const worked = new Map<string, string>();
  const failures: string[] = [];
  let opened = 0;

  const tryOpen = async (e: Entry, passwords: string[]): Promise<boolean> => {
    const bytes = new Uint8Array(readFileSync(e.file));
    const known = worked.get(e.family);
    for (const password of known ? [known, ...passwords.filter((p) => p !== known)] : passwords) {
      let pdf;
      try {
        pdf = await open(bytes, password);
      } catch (err) {
        failures.push(`${cardLabel(e)} (${(err as Error).message})`);
        return true;
      }
      if (!pdf) continue;
      worked.set(e.family, password);
      const pages = await extractLines(pdf);
      await pdf.destroy();
      writeFileSync(
        outPath(e),
        JSON.stringify({ uid: e.uid, gmail_id: e.gmail_id, family: e.family, subject: e.subject, date: e.date, name: e.name, sha256: e.sha256, pages }),
        { mode: 0o600 },
      );
      opened++;
      return true;
    }
    return false;
  };

  const stillLocked: Entry[] = [];
  for (const e of pending) {
    if (!(await tryOpen(e, passwordCandidatesForPeople(e.family, people, last4s, last6s)))) stillLocked.push(e);
    if ((opened + stillLocked.length) % 25 === 0) console.log(`  ...checked ${opened + stillLocked.length} of ${pending.length}`);
  }
  console.log(`Opened ${opened} of ${pending.length} using what you typed.`);

  pending = stillLocked;
  const groups = new Map<string, Entry[]>();
  for (const e of pending) groups.set(cardLabel(e), [...(groups.get(cardLabel(e)) ?? []), e]);

  const skipped: string[] = [];
  for (const [label, entries] of groups) {
    let left = entries;
    while (left.length) {
      console.log(`\nStill locked: ${label} (${left.length} files)`);
      if (label.startsWith("hsbc")) console.log("  HSBC's format: date of birth as DDMMYY, then the card's last 6 digits.");
      const typed = await askHidden("Type its password, or press Return to skip (hidden): ");
      if (!typed) {
        skipped.push(`${label} (${left.length} files)`);
        break;
      }
      const next: Entry[] = [];
      for (const e of left) if (!(await tryOpen(e, [typed]))) next.push(e);
      if (next.length === left.length) console.log("  That didn't open any of them.");
      else console.log(`  Opened ${left.length - next.length}.`);
      left = next;
    }
  }

  console.log(`\nDone. Readable: ${manifest.filter((e) => existsSync(outPath(e))).length} of ${manifest.length}.`);
  if (skipped.length) console.log(`Skipped:\n  ${skipped.join("\n  ")}`);
  if (failures.length) {
    console.log(`Couldn't read:\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  }
  console.log("You can tell Claude you're done now.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
