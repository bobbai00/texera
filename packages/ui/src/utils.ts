import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names, letting later Tailwind utilities override earlier conflicting ones. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600_000],
  ["month", 30 * 24 * 3600_000],
  ["week", 7 * 24 * 3600_000],
  ["day", 24 * 3600_000],
  ["hour", 3600_000],
  ["minute", 60_000],
];

/** "3 hours ago", "yesterday", "just now". Accepts epoch milliseconds or an ISO string. */
export function timeAgo(when: number | string | undefined, now = Date.now()): string {
  if (!when) return "";
  const epochMs = typeof when === "string" ? Date.parse(when) : when;
  if (Number.isNaN(epochMs)) return "";
  const diff = epochMs - now;
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return relative.format(Math.round(diff / ms), unit);
  }
  return "just now";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

export const formatNumber = (n: number) => new Intl.NumberFormat("en").format(n);

/** Seconds between two ISO timestamps, formatted for people. */
export function formatDuration(from: string | undefined, to: string | undefined): string {
  if (!from) return "";
  const ms = (to ? Date.parse(to) : Date.now()) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** The first characters of a UUID, for labels where the whole id would be noise. */
export const shortId = (id: string) => id.slice(0, 8);

/** What this browser kept under a key, if it still reads as what is wanted. */
export function recalled<T>(key: string, reads: (saved: unknown) => T | undefined): T | undefined {
  try {
    return reads(JSON.parse(localStorage.getItem(key) ?? "null"));
  } catch {
    return undefined;
  }
}

/** Keeps a value in this browser under a key; undefined forgets it. */
export function keepHere(key: string, value: unknown): void {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* kept for this page only */
  }
}

/** Whether the person asked for less motion. */
export const reducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
