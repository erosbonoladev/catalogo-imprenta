interface Props {
  currentPage: number;
  totalPages: number;
  onChange: (page: number) => void;
}

const WINDOW_SIZE = 10;
const WINDOW_STEP = WINDOW_SIZE - 1;

export default function Pagination({ currentPage, totalPages, onChange }: Props) {
  const windowStart = 1 + WINDOW_STEP * Math.floor((currentPage - 1) / WINDOW_STEP);
  const windowEnd = Math.min(windowStart + WINDOW_STEP, totalPages);
  const pages = Array.from({ length: windowEnd - windowStart + 1 }, (_, i) => windowStart + i);

  return (
    <nav className="pagination-bar" aria-label="Paginación de resultados">
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => onChange(currentPage - 1)}
        disabled={currentPage <= 1}
      >
        &lt;
      </button>

      {pages.map((page) => (
        <button
          key={page}
          type="button"
          className={`filter-chip${page === currentPage ? " filter-chip-active" : ""}`}
          onClick={() => onChange(page)}
        >
          {page}
        </button>
      ))}

      {windowEnd < totalPages && <span className="pagination-ellipsis">…</span>}

      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => onChange(currentPage + 1)}
        disabled={currentPage >= totalPages}
      >
        &gt;
      </button>
    </nav>
  );
}
