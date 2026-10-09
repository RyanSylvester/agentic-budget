import { useEffect, useRef, useState } from "react";
import { AppShell } from "./AppShell";
import { LoginScreen, SignupScreen } from "./AuthScreens";
import { invalidate, onUnauthorized, prime } from "./api";
import { currentMonthLocal } from "./format";
import type { AuthState } from "./types";
import { Skeleton } from "./ui";

/* ---------- auth gate ---------- */

/** Root component: gates the app on GET /api/auth/me. No users yet shows the
 *  signup screen, logged-out shows login (with a link to signup for later
 *  users), and an authenticated session (or a local dev server with auth
 *  disabled) renders the shell. */
export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [failed, setFailed] = useState(false);
  const [authView, setAuthView] = useState<"login" | "signup">("login");
  const [notice, setNotice] = useState<string | null>(null);
  const signedIn = useRef(false);
  signedIn.current = auth?.authenticated === true;

  // A 401 from any data call means the session ended (expired or logged out
  // elsewhere): drop back to login instead of leaving retry buttons that can
  // never succeed.
  useEffect(() => {
    onUnauthorized(() => {
      if (!signedIn.current) return;
      setNotice("Your session ended. Log in again to pick up where you left off.");
      setAuthView("login");
      setAuth((a) => (a ? { ...a, authenticated: false } : a));
    });
    return () => onUnauthorized(null);
  }, []);

  const load = () => {
    setFailed(false);
    invalidate();
    // Warm the data cache in parallel with the auth check: the five hot
    // endpoints start fetching before the shell even renders, so the first
    // paint already has real data instead of skeletons popping in one by
    // one. A failed prime is harmless; the tab's own fetch surfaces it.
    const month = currentMonthLocal();
    const primes = Promise.allSettled([
      prime("/api/attention"),
      prime(`/api/pots?month=${month}`),
      prime("/api/accounts"),
      prime(`/api/overview?month=${month}`),
      prime("/api/trend"),
    ]);
    fetch("/api/auth/me")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as AuthState;
      })
      .then(async (a) => {
        await primes;
        setAuth(a);
      })
      .catch(() => setFailed(true));
  };

  useEffect(load, []);

  if (failed) {
    return (
      <div className="flex min-h-screen items-center justify-center px-5">
        <div className="card w-full max-w-sm p-6 text-center">
          <p className="text-[15px] text-[var(--muted)]">Couldn't reach the server.</p>
          <button onClick={load} className="btn-ink mt-3 px-4 py-2 text-[15px]">
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!auth) {
    return (
      <div className="flex min-h-screen items-center justify-center px-5">
        <div className="w-full max-w-sm">
          <Skeleton className="mx-auto h-9 w-40" />
          <div className="card mt-6 p-6">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="mt-4 h-11" />
            <Skeleton className="mt-3 h-11" />
            <Skeleton className="mt-4 h-11" />
          </div>
        </div>
      </div>
    );
  }

  if (auth.setupRequired) return <SignupScreen onSignup={load} />;
  if (!auth.authenticated) {
    return authView === "signup" ? (
      <SignupScreen onSignup={load} onBackToLogin={() => setAuthView("login")} />
    ) : (
      <LoginScreen
        notice={notice}
        onAuthenticated={() => {
          setNotice(null);
          load();
        }}
        onSignup={() => setAuthView("signup")}
      />
    );
  }
  return <AppShell />;
}
