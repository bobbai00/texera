// Where a kind's view is shown when it is not the page or the panel beside it: inside the graph
// beside a chat, which keeps a trail of what was opened so the person can go back. A view inside
// a host opens what it links to in the same place, so the chat beside it stays as it is.

import { createContext, useContext } from "react";
import type { ResourceRef } from "../types";

export interface ViewHost {
  /** Shows a resource in the host, after what it shows now. */
  open: (ref: ResourceRef) => void;
  /** Goes back to what the host showed before. */
  back: () => void;
  /** Puts everything the host shows away. */
  close: () => void;
}

export const ViewHostContext = createContext<ViewHost | undefined>(undefined);

/** The host a view is shown in, if it is shown in one. */
export const useViewHost = () => useContext(ViewHostContext);
