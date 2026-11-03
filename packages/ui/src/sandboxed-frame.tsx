import { useEffect, useRef } from "react";
import { cn } from "./utils";

/** Path of the frame host page; the server sends it with its own permissive CSP. */
export const VIZ_FRAME_PATH = "/viz-frame.html";

/**
 * The only way the app shows HTML it did not write: visualization output of workflows.
 * The HTML goes into /viz-frame.html by postMessage. `sandbox` without `allow-same-origin`
 * gives the frame an opaque origin, so its scripts run but cannot read the app's storage
 * or session, or touch the parent page.
 */
export function SandboxedFrame({ html, title, className }: { html: string; title: string; className?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (target && e.source === target && e.data?.type === "texera-viz-frame-ready") {
        target.postMessage({ html }, "*");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [html]);

  return (
    <iframe
      key={html.length + html.slice(0, 64)}
      ref={frame}
      src={VIZ_FRAME_PATH}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className={cn("w-full rounded-lg border bg-white", className)}
    />
  );
}
