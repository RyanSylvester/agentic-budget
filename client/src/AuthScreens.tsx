import { useState } from "react";
import { argon2id } from "hash-wasm";

/* Login and first-run setup screens for in-app auth.
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
        <div className="mb-8 text-center font-serif-d text-[28px] font-medium tracking-tight">Daybook</div>
        <div className="card p-6">{children}</div>
      </div>
    </div>
  );
}

const labelCls = "mb-1.5 block text-[13px] font-medium text-[var(--ink-2)]";
const inputCls = "field w-full px-3 py-2.5 text-[16px]";

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function LoginScreen({ onAuthenticated, deriveKey = deriveKdfKey }: {
  onAuthenticated: () => void;
  deriveKey?: DeriveKey;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy || !username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const ch = await postJson("/api/auth/challenge", { username: username.trim() });
      if (!ch.ok) throw new Error("challenge");
      const { salt, kdf_params } = (await ch.json()) as { salt: string; kdf_params: string };
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
      <div className="mb-5 text-[17px] font-semibold">Log in</div>
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
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputCls}
          />
        </div>
        {error && (
          <div role="alert" className="text-[13px] text-[var(--danger)]">
            {error}
          </div>
        )}
        <button type="submit" disabled={busy || !username.trim() || !password} className="btn-ink w-full py-2.5 text-[15px]">
          {busy ? "Checking…" : "Log in"}
        </button>
      </form>
      <p className="mt-4 text-[12px] text-[var(--muted)]">
        Your password never leaves this device. Only a verification code derived from it is sent to the server.
      </p>
    </Shell>
  );
}

export function SetupScreen({ onSetup, deriveKey = deriveKdfKey }: {
  onSetup: () => void;
  deriveKey?: DeriveKey;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy || !username.trim() || !password) return;
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const salt = randomSaltHex();
      const kdfKey = await deriveKey(password, salt, "m=19456,t=2,p=1");
      const r = await postJson("/api/auth/setup", { username: username.trim(), salt, kdfKey });
      if (r.status === 404) {
        setError("Setup is already done. Log in instead.");
      } else if (!r.ok) {
        throw new Error("setup");
      } else {
        onSetup();
      }
    } catch {
      setError("Couldn't reach the server. Try again.");
    }
    setBusy(false);
  };

  return (
    <Shell>
      <div className="mb-1.5 text-[17px] font-semibold">Set up Daybook</div>
      <p className="mb-5 text-[14px] text-[var(--muted)]">Choose a password for this budget.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-4"
      >
        <div>
          <label className={labelCls} htmlFor="setup-username">Username</label>
          <input
            id="setup-username"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="setup-password">Password</label>
          <input
            id="setup-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="setup-confirm">Confirm password</label>
          <input
            id="setup-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={inputCls}
          />
        </div>
        {error && (
          <div role="alert" className="text-[13px] text-[var(--danger)]">
            {error}
          </div>
        )}
        <button type="submit" disabled={busy || !username.trim() || !password} className="btn-ink w-full py-2.5 text-[15px]">
          {busy ? "Creating…" : "Create password"}
        </button>
      </form>
    </Shell>
  );
}
