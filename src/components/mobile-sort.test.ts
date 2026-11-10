import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { KeyboardEvent, ReactElement } from "react";

// Exercise the real event handler without needing a signed-in browser or DOM.
const hooks = vi.hoisted(() => ({
  index: 0,
  overrides: new Map<number, unknown>(),
  setters: [] as ReturnType<typeof vi.fn>[],
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState(initial: unknown) {
      const index = hooks.index++;
      const setter = vi.fn();
      hooks.setters[index] = setter;
      return [hooks.overrides.has(index) ? hooks.overrides.get(index) : initial, setter];
    },
    useMemo: (calculate: () => unknown) => calculate(),
    useEffect: () => undefined,
    useRef: () => ({ current: null }),
  };
});
import TransactionsTable from "./TransactionsTable";
import AppNavigation from "./AppNavigation";

type Node = ReactElement<{
  children?: unknown; id?: string; value?: string;
  onChange?: (event: { target: { value: string } }) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDialogElement>) => void;
}>;
function elements(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...elements(node.props.children)];
}
const props: Parameters<typeof TransactionsTable>[0] = {
  resultKey: "all", transactions: [], cards: [], taxonomy: [],
  ordersByTxn: new Map(), existingNotes: [],
  onMerchantSave: async () => {}, onCategoryChange: async () => {},
  onNotesChange: async () => {}, onNotesBulk: async () => {},
};
beforeEach(() => {
  hooks.index = 0;
  hooks.overrides.clear();
  hooks.setters.length = 0;
});
it("returns to the first page when changing the phone sort", () => {
  hooks.overrides.set(1, 2);
  const selector = elements(TransactionsTable(props)).find(node => node.props.id === "transaction-sort")!;
  selector.props.onChange!({ target: { value: "amount:desc" } });
  expect(hooks.setters[0]).toHaveBeenCalledWith({ col: "amount", dir: "desc" });
  expect(hooks.setters[1]).toHaveBeenCalledWith(1);
});
it.each(["date", "amount", "merchant", "category", "card"])(
  "represents both desktop sort directions for %s after resizing to phone", col => {
    hooks.overrides.set(0, { col, dir: "desc" });
    const selector = elements(TransactionsTable(props)).find(node => node.props.id === "transaction-sort")!;
    const options = elements(selector.props.children).filter(node => node.type === "option").map(node => node.props.value);
    expect(options).toContain(`${col}:asc`);
    expect(options).toContain(`${col}:desc`);
  },
);

afterEach(() => vi.unstubAllGlobals());

it.each([true, false])("keeps focus inside More at the %s keyboard boundary", shiftKey => {
  const first = { focus: vi.fn() };
  const last = { focus: vi.fn() };
  vi.stubGlobal("document", { activeElement: shiftKey ? first : last });
  const dialog = elements(AppNavigation({ tab: "Spend", onNavigate: () => {}, onSignOut: () => {}, reviewCount: 0, expiringCount: 0 })).find(node => node.type === "dialog")!;
  const preventDefault = vi.fn();
  dialog.props.onKeyDown!({ key: "Tab", shiftKey, preventDefault, currentTarget: { querySelectorAll: () => [first, last] } } as unknown as KeyboardEvent<HTMLDialogElement>);
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(shiftKey ? last.focus : first.focus).toHaveBeenCalledOnce();
});

it.each(["Tab", "Escape"])("retains native %s behaviour away from a focus boundary", key => {
  const first = { focus: vi.fn() };
  const last = { focus: vi.fn() };
  vi.stubGlobal("document", { activeElement: {} });
  const dialog = elements(AppNavigation({ tab: "Spend", onNavigate: () => {}, onSignOut: () => {}, reviewCount: 0, expiringCount: 0 })).find(node => node.type === "dialog")!;
  const preventDefault = vi.fn();
  dialog.props.onKeyDown!({ key, shiftKey: false, preventDefault, currentTarget: { querySelectorAll: () => [first, last] } } as unknown as KeyboardEvent<HTMLDialogElement>);
  expect(preventDefault).not.toHaveBeenCalled();
  expect(first.focus).not.toHaveBeenCalled();
  expect(last.focus).not.toHaveBeenCalled();
});

it("changing row density resets pagination and preserves the selected sort", () => {
  hooks.overrides.set(1, 3);
  const tree = TransactionsTable(props);
  const selector = elements(tree).find(n => (n.props as Record<string, unknown>)["aria-label"] === "Transactions per page")!;
  expect(selector.props.value).toBe(10);
  selector.props.onChange!({target:{value:"50"}});
  expect(hooks.setters.at(-1)).toHaveBeenCalledWith(50);
  expect(hooks.setters[1]).toHaveBeenCalledWith(1);
  expect(hooks.setters[0]).not.toHaveBeenCalled();
});
