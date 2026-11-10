import { describe, expect, it } from "vitest";
import { withOptionalColumns } from "./optional-columns";

const missing = (col: string) => ({ error: { code: "PGRST204", message: `Could not find the '${col}' column of 'transactions' in the schema cache` } });

describe("withOptionalColumns", () => {
  it("drops each missing optional column in turn and reports what it dropped", async () => {
    const seen: string[][] = [];
    const { result, dropped } = await withOptionalColumns(
      { category: "Dining", subcategory: "Coffee", category_manual: true },
      ["category_manual", "subcategory"],
      async (v) => {
        seen.push(Object.keys(v));
        if ("category_manual" in v) return missing("category_manual");
        if ("subcategory" in v) return missing("subcategory");
        return { error: null };
      },
    );
    expect(result.error).toBeNull();
    expect(dropped).toEqual(["category_manual", "subcategory"]);
    expect(seen.at(-1)).toEqual(["category"]);
  });

  it("never drops a required column — the real error comes back", async () => {
    const { result, dropped } = await withOptionalColumns({ category: "Dining" }, ["subcategory"], async () => missing("category"));
    expect(result.error?.message).toMatch(/category/);
    expect(dropped).toEqual([]);
  });

  it("returns other errors untouched", async () => {
    const { result } = await withOptionalColumns({ a: 1 }, ["a"], async () => ({ error: { code: "42501", message: "permission denied" } }));
    expect(result.error?.code).toBe("42501");
  });
});
