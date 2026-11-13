import { useEffect, useState } from "react";
import { adminLogin, adminLogout, forgotPassword, resetPassword } from "../api";
import type { AuthState } from "../types";

type Mode = "closed" | "login" | "forgot" | "reset";

export default function AdminAuth({ auth, onAuthChanged }: { auth: AuthState; onAuthChanged: (a: AuthState) => void }) {
  const [mode, setMode] = useState<Mode>("closed");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A password-reset link lands here as ?reset_token=... — pick it up once,
  // then scrub it from the URL so it doesn't linger in history/bookmarks.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("reset_token");
    if (token) {
      setResetToken(token);
      setMode("reset");
      params.delete("reset_token");
      const next = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (next ? `?${next}` : ""));
    }
  }, []);

  function close() {
    setMode("closed");
    setError(null);
    setInfo(null);
    setPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }

  async function submitLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await adminLogin(email, password);
      onAuthChanged({ authenticated: true, email: r.email });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
    } finally {
      setBusy(false);
    }
  }

  async function submitForgot(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await forgotPassword(email);
      setInfo(r.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError("Passwords don't match");
      return;
    }
    setBusy(true);
    try {
      await resetPassword(resetToken, newPassword);
      setInfo("Password updated — you can log in now.");
      setMode("login");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "reset failed");
    } finally {
      setBusy(false);
    }
  }

  async function doLogout() {
    await adminLogout();
    onAuthChanged({ authenticated: false, email: null });
  }

  if (auth.authenticated) {
    return (
      <span className="admin-badge">
        <span className="admin-email" title={auth.email ?? undefined}>
          {auth.email}
        </span>
        <button className="admin-link-btn" onClick={doLogout}>
          Log out
        </button>
      </span>
    );
  }

  return (
    <>
      <button className="admin-link-btn" onClick={() => setMode("login")}>
        Admin Login
      </button>
      {mode !== "closed" && (
        <div className="modal-backdrop" onClick={close}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={close} aria-label="Close">
              ×
            </button>

            {mode === "login" && (
              <form onSubmit={submitLogin}>
                <h2>Admin login</h2>
                <label className="form-field">
                  Email
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
                </label>
                <label className="form-field">
                  Password
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                </label>
                {error && <div className="form-error">{error}</div>}
                {info && <div className="form-info">{info}</div>}
                <button className="form-submit" type="submit" disabled={busy}>
                  {busy ? "Signing in…" : "Log in"}
                </button>
                <button
                  type="button"
                  className="form-link"
                  onClick={() => {
                    setMode("forgot");
                    setError(null);
                  }}
                >
                  Forgot password?
                </button>
              </form>
            )}

            {mode === "forgot" && (
              <form onSubmit={submitForgot}>
                <h2>Reset password</h2>
                <p className="form-hint">Enter the admin email and a reset link will be generated.</p>
                <label className="form-field">
                  Email
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
                </label>
                {error && <div className="form-error">{error}</div>}
                {info && <div className="form-info">{info}</div>}
                <button className="form-submit" type="submit" disabled={busy}>
                  {busy ? "Sending…" : "Send reset link"}
                </button>
                <button
                  type="button"
                  className="form-link"
                  onClick={() => {
                    setMode("login");
                    setError(null);
                    setInfo(null);
                  }}
                >
                  Back to login
                </button>
              </form>
            )}

            {mode === "reset" && (
              <form onSubmit={submitReset}>
                <h2>Set a new password</h2>
                <label className="form-field">
                  Reset token
                  <input type="text" value={resetToken} onChange={(e) => setResetToken(e.target.value)} required />
                </label>
                <label className="form-field">
                  New password
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    minLength={8}
                    required
                    autoFocus
                  />
                </label>
                <label className="form-field">
                  Confirm password
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    minLength={8}
                    required
                  />
                </label>
                {error && <div className="form-error">{error}</div>}
                <button className="form-submit" type="submit" disabled={busy}>
                  {busy ? "Saving…" : "Set password"}
                </button>
                <button
                  type="button"
                  className="form-link"
                  onClick={() => {
                    setMode("login");
                    setError(null);
                  }}
                >
                  Back to login
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
