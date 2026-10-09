import { useState } from "react";
import { argon2id } from "hash-wasm";
import type { AuthChallenge } from "./types";

/* Login and signup screens for in-app auth.
 *
 * The password never leaves the device: the client derives
 * K = argon2id(password, salt) and only K (as hex) is sent to the server,
 * which checks HMAC_SHA256(pepper, K). See src/auth.ts for the protocol. */

export type DeriveKey = (password: string, saltHex: string, kdfParams: string) => Promise<string>;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Default KDF: argon2id(m=19456, t=2, p=1), 32-byte output as hex.
 *  Injectable so stories can substitute a fast stub. */
export async function deriveKdfKey(password: string, saltHex: string, kdfParams: string): Promise<string> {
  const m = /m=(\d+)/.exec(kdfParams);
  const t = /t=(\d+)/.exec(kdfParams);
  const p = /p=(\d+)/.exec(kdfParams);
  if (!m || !t || !p) throw new Error("bad kdf_params");
  return argon2id({
    password,
    salt: hexToBytes(saltHex),
    parallelism: parseInt(p[1], 10),
    iterations: parseInt(t[1], 10),
    memorySize: parseInt(m[1], 10),
    hashLength: 32,
    outputType: "hex",
  });
}

export function randomSaltHex(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-5">
      <div className="w-full max-w-sm">
        {/* Wordmark: sized on its own, outside the type scale. */}
        <div className="mb-8 text-center font-serif-d text-[28px] font-medium tracking-tight">Daybook</div>
        <div className="card p-6">{children}</div>
      </div>
    </div>
  );
}

const labelCls = "mb-1.5 block text-sm font-medium text-[var(--ink-2)]";
// 16px, off the type scale: anything smaller makes iOS Safari zoom on focus.
const inputCls = "field w-full px-3 py-2.5 text-[16px]";

/** Enforced here only: the server receives the Argon2id output, never the
 *  password, so it cannot see the length. */
export const MIN_PASSWORD_LENGTH = 8;

/** Invite codes are 32 hex characters. People paste them from chats with
 *  stray spaces, dashes or capitals, so tidy those before checking. */
export function normaliseInviteCode(raw: string): string {
  return raw.replace(/[\s-]+/g, "").toLowerCase();
}

export const validInviteCode = (code: string) => /^[0-9a-f]{32}$/.test(code);

/** ?invite=CODE from a shared invite link, if any. */
export function inviteFromUrl(search: string = window.location.search): string {
  return new URLSearchParams(search).get("invite") ?? "";
}

/** Password field with a Show/Hide toggle, so a long password can be
 *  checked on a phone keyboard before submitting. */
function PasswordInput({ id, value, onChange, autoComplete, shown, onToggle, describedBy }: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  shown: boolean;
  onToggle?: () => void;
  describedBy?: string;
}) {
  return (
    <div className="relative">
      <input
        id={id}
        type={shown ? "text" : "password"}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={describedBy}
        className={`${inputCls}${onToggle ? " pr-16" : ""}`}
      />
      {onToggle && (
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={shown}
          aria-controls={id}
          className="absolute inset-y-0 right-0 px-3 text-sm font-medium text-[var(--ink-2)]"
        >
          {shown ? "Hide" : "Show"}
          <span className="sr-only"> password</span>
        </button>
      )}
    </div>
  );
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function LoginScreen({ onAuthenticated, onSignup, notice, deriveKey = deriveKdfKey }: {
  onAuthenticated: () => void;
  notice?: string | null;
  onSignup?: () => void;
  deriveKey?: DeriveKey;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy || !username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const ch = await postJson("/api/auth/challenge", { username: username.trim() });
      if (!ch.ok) throw new Error("challenge");
      const { salt, kdf_params } = (await ch.json()) as AuthChallenge;
      const kdfKey = await deriveKey(password, salt, kdf_params);
      const login = await postJson("/api/auth/login", { username: username.trim(), kdfKey });
      if (login.status === 401) {
        setError("Wrong username or password.");
      } else if (login.status === 429) {
        setError("Too many attempts. Wait a few minutes and try again.");
      } else if (!login.ok) {
        throw new Error("login");
      } else {
        onAuthenticated();
      }
    } catch {
      setError("Couldn't reach the server. Try again.");
    }
    setBusy(false);
  };

  return (
    <Shell>
      <div className="mb-5 text-lg font-semibold">Log in</div>
      {notice && (
        <p role="status" className="mb-4 text-sm text-[var(--ink-2)]">
          {notice}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-4"
      >
        <div>
          <label className={labelCls} htmlFor="login-username">Username</label>
          <input
            id="login-username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="login-password">Password</label>
          <PasswordInput
            id="login-password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            shown={showPassword}
            onToggle={() => setShowPassword((v) => !v)}
          />
        </div>
        {error && (
          <div role="alert" className="text-sm text-[var(--danger)]">
            {error}
          </div>
        )}
        <button type="submit" disabled={busy || !username.trim() || !password} className="btn-ink w-full py-2.5 text-md">
          {busy ? "Checking…" : "Log in"}
        </button>
      </form>
      {onSignup && (
        <button onClick={onSignup} className="mt-2 w-full py-2 text-center text-sm text-[var(--ink-2)] underline underline-offset-2">
          Need an account? Sign up
        </button>
      )}
      <p className="mt-4 text-xs text-[var(--muted)]">
        Your password never leaves this device. Only a verification code derived from it is sent to the server.
      </p>
    </Shell>
  );
}

export function SignupScreen({ onSignup, onBackToLogin, firstAccount = false, deriveKey = deriveKdfKey }: {
  onSignup: () => void;
  onBackToLogin?: () => void;
  /** No accounts exist yet: this one bootstraps the budget and needs no
   *  invite code, so the field is hidden. */
  firstAccount?: boolean;
  deriveKey?: DeriveKey;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // Prefilled from an invite link (/?invite=CODE).
  const [inviteCode, setInviteCode] = useState(() => inviteFromUrl());
  const [inviteTouched, setInviteTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const code = normaliseInviteCode(inviteCode);
  const codeLooksWrong = !firstAccount && code !== "" && !validInviteCode(code);
  const passwordShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;

  const submit = async () => {
    if (busy || !username.trim() || !password) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    if (!firstAccount && !validInviteCode(code)) {
      setInviteTouched(true);
      setError(code ? "That code doesn't look right." : "Enter your invite code.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const salt = randomSaltHex();
      const kdfKey = await deriveKey(password, salt, "m=19456,t=2,p=1");
      const r = await postJson("/api/auth/signup", {
        username: username.trim(),
        salt,
        kdfKey,
        ...(!firstAccount && code ? { inviteCode: code } : {}),
      });
      if (r.status === 400) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Couldn't create the account.");
      } else if (r.status === 429) {
        setError("Too many signups. Wait a few minutes and try again.");
      } else if (!r.ok) {
        throw new Error("signup");
      } else {
        // The invite is spent: drop it from the URL so a refresh or a
        // bookmark does not carry it around.
        const url = new URL(window.location.href);
        if (url.searchParams.has("invite")) {
          url.searchParams.delete("invite");
          window.history.replaceState(null, "", url);
        }
        onSignup();
      }
    } catch {
      setError("Couldn't reach the server. Try again.");
    }
    setBusy(false);
  };

  return (
    <Shell>
      <div className="mb-1.5 text-lg font-semibold">Create your account</div>
      <p className="mb-5 text-sm text-[var(--muted)]">Choose a username and password for this budget.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-4"
      >
        <div>
          <label className={labelCls} htmlFor="signup-username">Username</label>
          <input
            id="signup-username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="signup-password">Password</label>
          <PasswordInput
            id="signup-password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            shown={showPassword}
            onToggle={() => setShowPassword((v) => !v)}
            describedBy="signup-password-hint"
          />
          <p
            id="signup-password-hint"
            className={`mt-1.5 text-xs ${passwordShort ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}
          >
            At least {MIN_PASSWORD_LENGTH} characters
            {passwordShort ? ` (${MIN_PASSWORD_LENGTH - password.length} more)` : ""}.
          </p>
        </div>
        <div>
          <label className={labelCls} htmlFor="signup-confirm">Confirm password</label>
          <PasswordInput
            id="signup-confirm"
            autoComplete="new-password"
            value={confirm}
            onChange={setConfirm}
            shown={showPassword}
          />
        </div>
        {!firstAccount && (
          <div>
            <label className={labelCls} htmlFor="signup-invite">Invite code (required)</label>
            <input
              id="signup-invite"
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              onBlur={() => setInviteTouched(true)}
              aria-invalid={inviteTouched && codeLooksWrong}
              aria-describedby="signup-invite-hint"
              className={`${inputCls} t-nums`}
            />
            <p
              id="signup-invite-hint"
              className={`mt-1.5 text-xs ${inviteTouched && codeLooksWrong ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}
            >
              {inviteTouched && codeLooksWrong ? "That code doesn't look right." : "Ask the person who invited you."}
            </p>
          </div>
        )}
        {error && (
          <div role="alert" className="text-sm text-[var(--danger)]">
            {error}
          </div>
        )}
        <button type="submit" disabled={busy || !username.trim() || !password} className="btn-ink w-full py-2.5 text-md">
          {busy ? "Creating…" : "Create account"}
        </button>
      </form>
      {onBackToLogin && (
        <button onClick={onBackToLogin} className="mt-4 w-full text-center text-sm text-[var(--ink-2)] underline underline-offset-2">
          Already have an account? Log in
        </button>
      )}
      <p className="mt-4 text-xs text-[var(--muted)]">
        Your password never leaves this device. Only a verification code derived from it is sent to the server.
      </p>
    </Shell>
  );
}
