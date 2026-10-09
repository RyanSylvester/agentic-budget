import { useEffect, useRef, useState } from "react";
import { AppShell } from "./AppShell";
import { LoginScreen, SignupScreen, inviteFromUrl } from "./AuthScreens";
import { invalidate, onUnauthorized, prime } from "./api";
import { currentMonthLocal } from "./format";
import type { AuthState } from "./types";
import { Skeleton } from "./ui";

/* ---------- loading skeleton ---------- */

/** How long the shell waits on the data primes once auth is known. */
const PRIME_WAIT_MS = 300;

/** First paint while /api/auth/me is in flight: the app's own outline
 *  (sidebar rail on desktop, header and tab bar on mobile, the Overview hero)
 *  so the real shell slots in without the layout jumping. */
function ShellSkeleton() {
  return (
    <div className="min-h-screen md:flex" aria-busy="true" aria-label="Loading Daybook">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-[var(--hairline)] px-4 py-6 md:flex">
        <div className="px-3 font-serif-d text-[20px] font-medium tracking-tight">Daybook</div>
        <div className="mx-3 my-5 border-t border-[var(--hairline)]" />
        <div className="flex flex-col gap-2.5 px-3">
          {["w-24", "w-16", "w-28", "w-20", "w-24", "w-16"].map((w, i) => (
            <Skeleton key={i} className={`my-1.5 h-5 ${w}`} />
          ))}
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="flex items-center justify-between px-5 pb-1 pt-5 md:hidden">
          <span className="font-serif-d text-[19px] font-medium tracking-tight">Daybook</span>
        </header>
        <div className="mx-auto max-w-5xl px-5 pb-32 pt-2 md:px-8 md:py-8 md:pb-16">
          <div className="mb-5 flex h-11 items-center justify-center">
            <Skeleton className="h-5 w-32" />
          </div>
          <div className="pb-1 pt-2">
            <Skeleton className="h-[56px] w-56" />
            <Skeleton className="mt-2.5 h-5 w-44" />
            <Skeleton className="mt-3 h-11 w-52 rounded-[var(--r-pill)]" />
          </div>
          <div className="mt-8 grid gap-4 md:grid-cols-2">
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
          </div>
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--hairline)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] md:hidden">
        <div className="grid grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex min-h-[64px] flex-col items-center justify-center gap-1.5 pt-1">
              <Skeleton className="h-6 w-6 rounded-full" />
              <Skeleton className="h-2.5 w-10" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- auth gate ---------- */

/** Root component: gates the app on GET /api/auth/me. No users yet shows the
 *  signup screen, logged-out shows login (with a link to signup for later
 *  users), and an authenticated session (or a local dev server with auth
 *  disabled) renders the shell. */
export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [failed, setFailed] = useState(false);
  // An invite link (/?invite=CODE) opens straight on signup.
  const [authView, setAuthView] = useState<"login" | "signup">(() => (inviteFromUrl() ? "signup" : "login"));
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
    // paint usually has real data instead of skeletons popping in one by
    // one. The shell waits for them at most PRIME_WAIT_MS after auth: on a
    // slow connection it shows its own skeletons rather than a blank screen.
    // A failed prime is harmless; the tab's own fetch surfaces it.
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
        if (a.authenticated) {
          await Promise.race([primes, new Promise((r) => setTimeout(r, PRIME_WAIT_MS))]);
        }
        setAuth(a);
      })
      .catch(() => setFailed(true));
  };

  useEffect(load, []);

  if (failed) {
    return (
      <div className="flex min-h-screen items-center justify-center px-5">
        <div className="card w-full max-w-sm p-6 text-center">
          <p className="text-md text-[var(--muted)]">Couldn't reach the server.</p>
          <button onClick={load} className="btn-ink mt-3 px-4 py-2 text-md">
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!auth) return <ShellSkeleton />;

  if (auth.setupRequired) return <SignupScreen firstAccount onSignup={load} />;
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
