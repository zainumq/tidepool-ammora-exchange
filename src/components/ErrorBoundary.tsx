import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorBoundaryProps = { children: ReactNode };
type ErrorBoundaryState = { error: Error | null };

/**
 * Last-resort crash guard: without it, a single render crash blanks the
 * whole app. Shows a friendly fallback with a reload button and the error
 * details tucked into a <details> element.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Uncaught render error:", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel" style={{ maxWidth: 640, margin: "48px auto" }}>
        <h2>Something went wrong</h2>
        <p className="muted">
          Tidepool hit an unexpected error while rendering this page. Your
          wallet and funds are unaffected — try reloading.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => window.location.reload()}
        >
          Reload the page
        </button>
        <details style={{ marginTop: 16 }}>
          <summary className="muted small">Error details</summary>
          <pre
            className="mono small"
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
          >
            {this.state.error.message}
          </pre>
        </details>
      </div>
    );
  }
}
