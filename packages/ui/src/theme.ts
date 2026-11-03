// public/theme-init.js applies the saved theme before first paint; this toggles it afterwards.
const KEY = "texera-theme";

export function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

export function setTheme(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
  try {
    localStorage.setItem(KEY, dark ? "dark" : "light");
  } catch {
    /* not persisted when storage is unavailable */
  }
}

export function toggleTheme() {
  setTheme(!isDark());
}
