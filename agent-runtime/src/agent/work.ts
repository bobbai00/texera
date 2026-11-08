/**
 * How the agent goes from reading to changing things. It reads and asks freely. Before its first
 * change in a turn it says what it will do: `start_work`, with the goal, what it reads and what it
 * will make, which the app shows as a plan and draws on the resource graph. A change before that
 * is refused with the reason, so the model calls `start_work` and tries again. In `manual` work
 * mode every change then waits for a person's approval: the turn ends at the change, and the
 * person's yes or no starts the next one. A question with choices (`ask`) also ends the turn; the
 * person's pick is their next message.
 *
 * A change is a call of the platform's own server that the server does not mark read-only. An
 * add-on (PubMed, say) reads, and is never held.
 */

import { type ToolApprovalConfiguration, type ToolSet, tool } from "ai";
import { z } from "zod";
import { functionsIn } from "./workflow-lines.ts";

export const START_WORK_TOOL = "start_work";
export const ASK_TOOL = "ask";

export type WorkMode = "auto" | "manual";

/** What the agent said it will do. */
export interface WorkPlan {
  goal: string;
  reads: string[];
  makes: Array<{ kind: string; name: string; detail?: string }>;
}

/** The work of one turn: how its changes go, and whether the agent has said what it will do. */
export class Work {
  plan?: WorkPlan;
  /** True when the turn continues work an earlier turn started (a decision on an approval). */
  private readonly continued: boolean;

  constructor(
    readonly mode: WorkMode,
    options: { continued?: boolean } = {},
  ) {
    this.continued = options.continued ?? false;
  }

  get started(): boolean {
    return this.continued || this.plan !== undefined;
  }
}

/** What a change before `start_work` is told. */
export const START_WORK_FIRST =
  "Not done: call start_work first, with the goal, what you read and what you will make. Then make this change again.";

const planSchema = z.object({
  goal: z.string().min(1).describe("The goal in one sentence, in the person's words where you can."),
  reads: z
    .array(z.string())
    .describe("The URIs of the resources you read and will use: datasets, models, operators, units."),
  makes: z
    .array(
      z.object({
        kind: z.string().describe("The kind you will make or change: workflow, computing-unit, dataset, ..."),
        name: z.string().describe("Its name, or the name of the resource you will change."),
        detail: z.string().optional().describe("One short line: the profile of a unit, what a change does."),
      }),
    )
    .describe("What you will create or change, in order."),
});

/** `start_work`: the plan, shown to the people of the chat before anything changes. */
export function startWorkTool(work: Work) {
  return tool({
    description:
      "Say what you will do before your first change in a turn: the goal, the resources you read and will use, " +
      "and what you will create or change. Call it once you have read what you need and settled any choice " +
      "with the person, then make the changes. Changes made without it are refused.",
    inputSchema: planSchema,
    execute: async (plan) => {
      work.plan = plan;
      return work.mode === "manual"
        ? { started: true, mode: work.mode, note: "Each change waits for the person's approval." }
        : { started: true, mode: work.mode };
    },
  });
}

const askSchema = z.object({
  question: z.string().min(1).describe("One question, with the reason it matters in a few words."),
  options: z
    .array(
      z.object({
        label: z.string().min(1).describe("A short answer the person can pick."),
        detail: z.string().optional().describe("One line on what picking it means: cost, speed, what changes."),
      }),
    )
    .min(2)
    .max(4),
  other: z.boolean().optional().describe("True when the person may also type an answer of their own."),
});

/** `ask`: a question with choices. The turn ends; the person's pick is their next message. */
export function askTool() {
  return tool({
    description:
      "Ask the person to choose before you go on: a choice that costs money or time, shares data, or has more " +
      "than one sensible answer (a GPU or not, the size of a unit, a dataset version, who gets access). " +
      "Give two to four options. Your turn ends here; the person's pick is their next message.",
    inputSchema: askSchema,
    execute: async () => ({ asked: true }),
  });
}

/** The runtime's own tools of the turn's work. */
export function workTools(work: Work): ToolSet {
  return { [START_WORK_TOOL]: startWorkTool(work), [ASK_TOOL]: askTool() };
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** A change as the person reads it on the approval card: one plain line. */
export function describeChange(toolName: string, input: unknown): string {
  const a = (input ?? {}) as Record<string, unknown>;
  const name = text(a.name);
  switch (toolName) {
    case "create_workflow": {
      const made = name ? `Create the workflow "${name}"` : "Create a workflow";
      const defined = functionsIn(text(a.python) ?? "");
      return defined.length > 0 ? `${made}, with ${defined.join(", ")}` : made;
    }
    case "edit_workflow": {
      // The lines' statements, as the card names them: "set night, delete old"; and where it runs.
      const said = [...(text(a.lines) ?? "").matchAll(/^\s*(set|delete)\s+([A-Za-z0-9-]+)/gm)].map(
        (m) => `${m[1]} ${m[2]}`,
      );
      const defined = functionsIn(text(a.python) ?? "");
      const parts = [
        ...(defined.length > 0 ? [`define ${defined.join(", ")}`] : []),
        ...(said.length > 0
          ? [`${said.slice(0, 4).join(", ")}${said.length > 4 ? `, and ${said.length - 4} more` : ""}`]
          : []),
        ...(text(a.defaultComputingUnit) ? [`its runs go to ${text(a.defaultComputingUnit)}`] : []),
        ...(said.length === 0 && text(a.message) ? [text(a.message) as string] : []),
      ];
      return parts.length > 0 ? `Change the workflow: ${parts.join("; ")}` : "Change the workflow";
    }
    case "run_workflow":
      return text(a.computingUnit) ? `Run the workflow on ${text(a.computingUnit)}` : "Run the workflow";
    case "create_computing_unit":
      return `Start a computing unit${name ? ` "${name}"` : ""}${text(a.profile) ? ` from the profile ${text(a.profile)}` : ""}`;
    case "save_unit_as_profile":
      return name ? `Save the unit as the profile "${name}"` : "Save the unit as a profile";
    case "grant_access":
      return `Give ${text(a.role) ?? "access"} access to someone`;
    case "create_dataset":
      return name ? `Create the dataset "${name}"` : "Create a dataset";
    case "import_dataset_file":
      return text(a.url) ? `Bring ${text(a.url)} into the dataset` : "Bring a file into the dataset";
    case "commit_dataset_version":
      return "Save a new version of the dataset";
    case "pause_execution":
      return "Pause the run";
    case "resume_execution":
      return "Resume the run";
    default:
      return `Call ${toolName}`;
  }
}

/**
 * Whether each call may go ahead, for the loop's `toolApproval`: a change before `start_work` is
 * refused with the reason; in `manual` mode a change after it waits for the person; everything
 * else goes ahead.
 */
export function approvalOf(work: Work, changes: ReadonlySet<string>): ToolApprovalConfiguration<ToolSet, unknown> {
  return ({ toolCall }) => {
    if (!changes.has(toolCall.toolName)) return "not-applicable";
    if (!work.started) return { type: "denied", reason: START_WORK_FIRST };
    if (work.mode === "manual")
      return { type: "user-approval", reason: describeChange(toolCall.toolName, toolCall.input) };
    return "not-applicable";
  };
}
