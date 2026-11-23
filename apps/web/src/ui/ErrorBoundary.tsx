import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/** Shows a recoverable message instead of a blank page when a screen crashes. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Screen crashed:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="auth-shell">
        <div className="auth-card stack" role="alert">
          <h1>Something went wrong</h1>
          <p>This screen hit an unexpected error. Reloading usually fixes it.</p>
          <p className="small muted">
            <code>{this.state.error.message}</code>
          </p>
          <div className="row">
            <button className="btn btn-primary" onClick={() => location.reload()}>
              Reload
            </button>
            <a className="btn btn-secondary" href={import.meta.env.BASE_URL}>
              Go to home
            </a>
          </div>
        </div>
      </main>
    );
  }
}
