// Builds the statement-PDF passwords each issuer's own email describes, from what
// the cardholder types into scripts/statements-unlock.ts. Nothing here is stored.

export type PasswordInputs = {
  /** First four letters of the name on the card. */
  name4: string;
  /** Date of birth as DDMMYYYY. */
  dob: string;
  /** Card last-4s already known to cardIQ, for "name + last 4" formats. */
  last4s: string[];
  /** Card last-6s the cardholder typed, for HSBC's "DOB + last 6" format. */
  last6s?: string[];
};

/** One cardholder: every way the name on the card might start, plus their DOB. */
export type Person = { names: string[]; dob: string };

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** True for a real calendar date written as DDMMYYYY. */
export function isValidDob(dob: string): boolean {
  if (!/^\d{8}$/.test(dob)) return false;
  const day = Number(dob.slice(0, 2));
  const month = Number(dob.slice(2, 4));
  const year = Number(dob.slice(4));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Passwords for one issuer when the name on the card could be one of several,
 * e.g. first-name or surname letters. Each name is tried in the issuer's
 * documented case first, then in the other case, since issuers word this loosely.
 */
export function passwordCandidatesForNames(family: string, names: string[], dob: string, last4s: string[], last6s: string[] = []): string[] {
  const out: string[] = [];
  for (const name4 of names) out.push(...passwordCandidates(family, { name4, dob, last4s, last6s }));
  for (const name4 of names) {
    for (const p of passwordCandidates(family, { name4, dob, last4s, last6s })) {
      const flipped = p.replace(/[a-zA-Z]{4}/, (n) => (n === n.toUpperCase() ? n.toLowerCase() : n.toUpperCase()));
      out.push(flipped);
    }
  }
  return [...new Set(out)];
}

/** Every person's candidates for one issuer, in the order the people were typed. */
export function passwordCandidatesForPeople(family: string, people: Person[], last4s: string[], last6s: string[] = []): string[] {
  return [...new Set(people.flatMap((p) => passwordCandidatesForNames(family, p.names, p.dob, last4s, last6s)))];
}

/** Passwords to try for one issuer, most likely first. Unknown issuers get none. */
export function passwordCandidates(family: string, { name4, dob, last4s, last6s = [] }: PasswordInputs): string[] {
  if (!/^[a-zA-Z]{4}$/.test(name4) || !isValidDob(dob)) return [];
  const upper = name4.toUpperCase();
  const lower = name4.toLowerCase();
  const ddmm = dob.slice(0, 4);
  const ddmmm = dob.slice(0, 2) + MONTHS[Number(dob.slice(2, 4)) - 1];
  const nameLast4 = last4s.map((l) => upper + l);

  const byFamily: Record<string, string[]> = {
    citi: [upper + ddmmm],
    hdfc: nameLast4,
    axis: [upper + ddmm, ...nameLast4],
    icici: [lower + ddmm],
    indusind: [lower + ddmm],
    idfc: [ddmm],
    au: [upper + ddmm],
    bob: [upper + ddmm],
    kotak: [upper + ddmm, lower + ddmm],
    // A hand-forwarded copy can come from any of the issuers above.
    forwarded: [...nameLast4, upper + ddmm, lower + ddmm],
    // DOB as DDMMYY, then the primary card's last 6 digits, which only the cardholder knows.
    hsbc: last6s.filter((l) => /^\d{6}$/.test(l)).map((l) => ddmm + dob.slice(6) + l),
  };
  return [...new Set(byFamily[family] ?? [])];
}
