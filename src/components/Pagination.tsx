/**
 * Page controls for `usePagination` (see ../lib/pagination). Hidden when
 * everything fits on one page.
 */
export function Pagination({
  page,
  pageCount,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return (
    <div className="pagination">
      <button
        type="button"
        className="btn btn-small btn-ghost"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        ← Prev
      </button>
      <span className="muted small">
        Showing {start}–{end} of {total} · Page {page} of {pageCount}
      </span>
      <button
        type="button"
        className="btn btn-small btn-ghost"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
      >
        Next →
      </button>
    </div>
  );
}
