interface Props {
  canGoBack: boolean;
  canGoForward: boolean;
  backTitle: string | null;
  forwardTitle: string | null;
  onBack: () => void;
  onForward: () => void;
}

export default function NavigationBar({
  canGoBack,
  canGoForward,
  backTitle,
  forwardTitle,
  onBack,
  onForward,
}: Props) {
  return (
    <div className="nav-history-bar">
      <button
        type="button"
        className="nav-history-btn"
        onClick={onBack}
        disabled={!canGoBack}
        title={backTitle ?? undefined}
        aria-label={backTitle ?? "Volver"}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>
      <div className="nav-history-divider" />
      <button
        type="button"
        className="nav-history-btn"
        onClick={onForward}
        disabled={!canGoForward}
        title={forwardTitle ?? undefined}
        aria-label={forwardTitle ?? "Adelante"}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>
    </div>
  );
}
