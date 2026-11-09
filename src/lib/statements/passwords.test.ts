import { describe, expect, it } from "vitest";
import { isValidDob, passwordCandidates, passwordCandidatesForNames, passwordCandidatesForPeople } from "./passwords";

const inputs = { name4: "Abcd", dob: "05012000", last4s: ["1111", "2222"] };

describe("passwordCandidates", () => {
  it("follows each issuer's documented format", () => {
    expect(passwordCandidates("citi", inputs)).toEqual(["ABCD05JAN"]);
    expect(passwordCandidates("icici", inputs)).toEqual(["abcd0501"]);
    expect(passwordCandidates("indusind", inputs)).toEqual(["abcd0501"]);
    expect(passwordCandidates("idfc", inputs)).toEqual(["0501"]);
    expect(passwordCandidates("au", inputs)).toEqual(["ABCD0501"]);
    expect(passwordCandidates("hdfc", inputs)).toEqual(["ABCD1111", "ABCD2222"]);
    expect(passwordCandidates("axis", inputs)).toEqual(["ABCD0501", "ABCD1111", "ABCD2222"]);
  });

  it("builds HSBC's DOB-as-DDMMYY plus last 6, matching HSBC's own example", () => {
    // HSBC: card 5120 0000 0000 4200, born 2 June 1970 -> 020670004200
    expect(passwordCandidates("hsbc", { name4: "Abcd", dob: "02061970", last4s: [], last6s: ["004200"] })).toEqual(["020670004200"]);
    expect(passwordCandidates("hsbc", { ...inputs, last6s: ["12345", "abcdef"] })).toEqual([]);
  });

  it("offers nothing it can't derive", () => {
    expect(passwordCandidates("hsbc", inputs)).toEqual([]);
    expect(passwordCandidates("unknown-bank", inputs)).toEqual([]);
  });

  it("refuses malformed input instead of trying junk passwords", () => {
    expect(passwordCandidates("citi", { ...inputs, name4: "Abc" })).toEqual([]);
    expect(passwordCandidates("citi", { ...inputs, name4: "Ab1d" })).toEqual([]);
    expect(passwordCandidates("citi", { ...inputs, dob: "31022000" })).toEqual([]);
    expect(passwordCandidates("citi", { ...inputs, dob: "" })).toEqual([]);
  });

  it("removes duplicate last-4s", () => {
    expect(passwordCandidates("hdfc", { ...inputs, last4s: ["1111", "1111"] })).toEqual(["ABCD1111"]);
  });
});

describe("passwordCandidatesForNames", () => {
  it("tries every name in the documented case, then the other case", () => {
    expect(passwordCandidatesForNames("icici", ["Abcd", "Wxyz"], "05012000", [])).toEqual([
      "abcd0501",
      "wxyz0501",
      "ABCD0501",
      "WXYZ0501",
    ]);
  });

  it("flips only the name part, never the month in a DDMMM password", () => {
    expect(passwordCandidatesForNames("citi", ["Abcd"], "05012000", [])).toEqual(["ABCD05JAN", "abcd05JAN"]);
  });

  it("skips a malformed name without dropping the good one", () => {
    expect(passwordCandidatesForNames("au", ["Ab", "Wxyz"], "05012000", [])).toEqual(["WXYZ0501", "wxyz0501"]);
  });

  it("gives nothing for a date-only issuer twice", () => {
    expect(passwordCandidatesForNames("idfc", ["Abcd", "Wxyz"], "05012000", [])).toEqual(["0501"]);
  });
});

describe("passwordCandidatesForPeople", () => {
  it("tries each person with their own DOB, never mixing one's name with another's DOB", () => {
    const people = [
      { names: ["Abcd"], dob: "05012000" },
      { names: ["Wxyz"], dob: "30121995" },
    ];
    const got = passwordCandidatesForPeople("icici", people, []);
    expect(got).toEqual(["abcd0501", "ABCD0501", "wxyz3012", "WXYZ3012"]);
    expect(got).not.toContain("abcd3012");
    expect(got).not.toContain("wxyz0501");
  });

  it("pairs typed last-6s with every person's DOB for HSBC", () => {
    const people = [
      { names: ["Abcd"], dob: "05012000" },
      { names: ["Wxyz"], dob: "30121995" },
    ];
    expect(passwordCandidatesForPeople("hsbc", people, [], ["123456"])).toEqual(["050100123456", "301295123456"]);
  });
});

describe("isValidDob", () => {
  it("accepts real dates, including a leap day", () => {
    expect(isValidDob("29022000")).toBe(true);
    expect(isValidDob("31122000")).toBe(true);
  });

  it("rejects impossible dates and wrong shapes", () => {
    expect(isValidDob("29022001")).toBe(false);
    expect(isValidDob("00012000")).toBe(false);
    expect(isValidDob("01132000")).toBe(false);
    expect(isValidDob("0101200")).toBe(false);
    expect(isValidDob("01/01/2000")).toBe(false);
  });
});
