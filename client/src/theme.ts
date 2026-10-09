/* Light / Dark / System theme choice. index.css follows prefers-color-scheme
 * unless <html> carries data-theme="light" | "dark", so "system" is simply
 * the attribute removed. The choice is remembered per device in
 * localStorage; storage can be unavailable (private mode, blocked site
 * data), so every access is guarded and the app falls back to System. */

export type ThemeChoice = "light" | "dark" | "system";

const KEY = "daybook.theme";

export function savedTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

export function setTheme(choice: ThemeChoice): void {
  applyTheme(choice);
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* not remembered; still applied for this visit */
  }
}
