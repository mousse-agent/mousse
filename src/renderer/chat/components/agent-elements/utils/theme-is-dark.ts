// The app themes via `html[data-theme="…"]` (+ `color-scheme`), not the
// `.dark` class, so checking only `.dark` would treat every dark theme as
// light. Resolve against data-theme first, then computed color-scheme, then
// the legacy `.dark` class / OS preference.
export function resolveThemeIsDark(): boolean {
  if (typeof document === "undefined") return true;
  const root = document.documentElement;
  const dataTheme = root.getAttribute("data-theme");
  if (dataTheme === "light") return false;
  if (dataTheme === "system") {
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    return true;
  }
  // Every other mousse theme id (dark, dark-modern, one-dark, monokai,
  // solarized-dark, github-dark, high-contrast, blacksphere-plus, …) is
  // dark-only.
  if (dataTheme) return true;
  if (root.classList.contains("dark")) return true;
  try {
    const colorScheme = getComputedStyle(root).colorScheme;
    if (colorScheme.includes("dark")) return true;
    if (colorScheme.includes("light")) return false;
  } catch {
    // getComputedStyle unavailable (SSR/test) — fall through.
  }
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  return true;
}
