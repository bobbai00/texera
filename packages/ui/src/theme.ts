// public/theme-init.js applies the saved theme before first paint; this toggles it afterwards.
import { useSyncExternalStore } from "react";

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

/** Whether the app is in its dark theme now. What draws itself (a graph's own controls) follows this, not the system's setting. */
export function useDark(): boolean {
  return useSyncExternalStore(
    changed => {
      const watch = new MutationObserver(changed);
      watch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
      return () => watch.disconnect();
    },
    isDark,
    () => false
  );
}
