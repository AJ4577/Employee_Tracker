import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "./lib/api";
import { AuthProvider } from "./lib/auth";
import { configError } from "./lib/supabase";
import { ToastProvider } from "./ui/toast";
import { App } from "./App";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import "./styles.css";

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // Don't hammer the API on permission/validation errors; retry network failures.
      retry: (n, e) => !(e instanceof ApiError && ["forbidden", "not_found", "validation"].includes(e.code)) && n < 2,
    },
    mutations: { retry: false },
  },
});

const root = createRoot(document.getElementById("root")!);
if (configError) {
  root.render(
    <main className="auth-shell">
      <div className="auth-card">
        <h1>Configuration needed</h1>
        <p>{configError}</p>
      </div>
    </main>,
  );
} else {
  root.render(
    <StrictMode>
      <QueryClientProvider client={qc}>
        <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "") || undefined}>
          <AuthProvider>
            <ToastProvider>
              <ErrorBoundary>
                <App />
              </ErrorBoundary>
            </ToastProvider>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}
