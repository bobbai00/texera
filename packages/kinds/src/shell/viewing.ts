// What the person is looking at: the resource of the page they are on, and what that page adds
// about it (the operator selected on a canvas). A chat opened beside the page sends it with
// each message, as the run's context, so the agent knows what "this" is and reads it with its
// own tools. It is a reference, never a copy of the page.

import { useEffect } from "react";
import { create } from "zustand";
import { KINDS } from "../registry";
import type { ResourceRef } from "../types";
import { parsePath, uriOf } from "../uri";

/** One thing the app tells the agent about where the person is: AG-UI's context of a run. */
export interface AppContext {
  description: string;
  value: string;
}

/** What a page tells the agent: its resource by kind, name and URI, then what the page adds. */
export function viewingContext(ref: ResourceRef, name: string | undefined, detail?: string): AppContext[] {
  const what = `${KINDS[ref.kind].label}${name ? ` "${name}"` : ""} (${uriOf(ref)})`;
  return [{ description: "The person is looking at", value: what }, ...(detail ? [{ description: "On that page", value: detail }] : [])];
}

/**
 * The resource a page of the app shows, from its address: every resource page is its URI
 * without the scheme, with the pinned version as a query. A chat is not looked at, it is
 * talked in; a list and the settings name no single resource.
 */
export function pageResource(pathname: string, vno?: number): ResourceRef | undefined {
  const ref = parsePath(pathname)?.ref;
  if (!ref || !ref.rid || ref.kind === "conversation") return undefined;
  return vno === undefined ? ref : { ...ref, vno };
}

interface PageSays {
  /** What is in focus on the page. */
  detail?: string;
  /** Brings the catalog up to date with the page (an edit still waiting to be saved). */
  settle?: () => Promise<void>;
}

const usePage = create<PageSays>(() => ({}));

/** What the page being shown adds about its resource, if anything. */
export const useViewingDetail = (): string | undefined => usePage(s => s.detail);

/** Waits until the catalog has what the page shows, so an agent asked about it reads the same. */
export const settleViewing = (): Promise<void> => usePage.getState().settle?.() ?? Promise.resolve();

/** A page says what is in focus on it and how to settle it, for as long as it is shown. */
export function useTellViewing(detail: string | undefined, settle?: () => Promise<void>): void {
  useEffect(() => {
    usePage.setState({ detail, settle });
    return () => usePage.setState({ detail: undefined, settle: undefined });
  }, [detail, settle]);
}
