import { createFileRoute } from "@tanstack/react-router";
import { SharedWithMe } from "@texera/kinds";

/** What other people shared with the person. */
export const Route = createFileRoute("/_app/shared")({ component: SharedWithMe });
