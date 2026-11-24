import { useState } from "react";

/**
 * Client-side pagination for long on-chain lists (56 pools / 174 launches
 * render a full table without it). Resets to page 1 whenever `resetKey`
 * changes (search/filter); the displayed page is clamped when the list
 * shrinks. State is adjusted during render (the React-endorsed pattern
 * for deriving state from props), so no effects are involved.
 */
export function usePagination(totalItems: number, resetKey: string, pageSize = 25) {
  const [state, setState] = useState({ page: 1, key: resetKey });
  if (state.key !== resetKey) {
    setState({ page: 1, key: resetKey });
  }
  const page = state.key === resetKey ? state.page : 1;
  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(page, pageCount);

  return {
    page: safePage,
    pageCount,
    pageSize,
    setPage: (next: number) => setState((s) => ({ ...s, page: next })),
    slice: <T,>(items: readonly T[]): T[] =>
      items.slice((safePage - 1) * pageSize, safePage * pageSize),
  };
}
