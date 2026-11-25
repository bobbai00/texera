/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { Handle, type Node, type NodeProps, Position, useStore } from "@xyflow/react";
import { cn } from "cn";
import {
  CheckIcon,
  CircleHelpIcon,
  ClockIcon,
  EyeIcon,
  EyeOffIcon,
  LoaderCircleIcon,
  type LucideIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  Settings2Icon,
  SquareIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useContext, useEffect, useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OperatorProgress } from "@/lib/execution/client";
import type { ExecutionState } from "@/lib/execution/protocol";
import { formatRows } from "@/lib/format";
import type { Mark } from "@/lib/workflow/diff";
import type { Operator, PortDescription } from "@/lib/workflow/model";
import type { OperatorSchema } from "@/lib/workflow/operator-schema";
import type { Collaborator } from "@/lib/workflow/room";
import { settingLines, summaryLine } from "@/lib/workflow/summary";
import { ownEvents } from "../keys";
import { operatorImage } from "../operator-images";
import { editingNotice, editingParts, presenceClassNames } from "../presence";
import { CardCanvasContext, cardPartId, resourcesHandle } from "./card-canvas";
import type { ExecutionUpTo } from "./workflow-canvas";

export interface OperatorNodeData extends Record<string, unknown> {
  operator: Operator;
  /** The name the operator goes by: the one it was given, or its type's. */
  name: string;
  /** The name of its type. */
  typeName: string;
  /** Its type's schema, when the backend offers its type: what its settings are, and their names. */
  schema?: OperatorSchema;
  /** Why the operator cannot be executed as it is. */
  problem?: string;
  progress?: OperatorProgress;
  /** The other people who have the operator selected. */
  selectedBy?: Collaborator[];
  /**
   * Who else holds the operator, editing its settings in their card (holds.ts): until they are done, they are theirs
   * to change.
   */
  heldBy?: Collaborator;
  /** How the operator differs from what it is compared with, as when a version is shown. */
  mark?: Mark;
}

export type OperatorNodeType = Node<OperatorNodeData, "operator">;

const markClassNames: Record<Mark, string> = {
  added: "border-success ring-3 ring-success/25",
  changed: "border-warning ring-3 ring-warning/25",
  removed: "border-dashed border-destructive opacity-60",
};
const markNames: Record<Mark, string> = { added: "Added", changed: "Changed", removed: "Removed" };
const markBadgeClassNames: Record<Mark, string> = {
  added: "bg-success",
  changed: "bg-warning",
  removed: "bg-destructive",
};

/**
 * How an operator looks in a state of an execution: the icon its state is shown with, in the color the app gives
 * that state wherever it is shown, as the list of executions does (under way, done, failed or stopped), whether the
 * icon turns, as while it works, and its card's edge, where the state is one to see from afar.
 */
interface StateLook {
  icon: LucideIcon;
  tone: string;
  turns?: boolean;
  card?: string;
}
const notStarted: StateLook = { icon: ClockIcon, tone: "text-muted-foreground" };
const working: StateLook = {
  icon: LoaderCircleIcon,
  tone: "text-warning",
  turns: true,
  card: "border-warning ring-4 ring-warning/15",
};
const pausing: StateLook = { icon: PauseIcon, tone: "text-warning", card: "border-warning" };
const stopped: StateLook = { icon: SquareIcon, tone: "text-destructive" };
const stateLooks: Record<ExecutionState, StateLook> = {
  Uninitialized: notStarted,
  // Under way, though nothing has come through it yet.
  Initializing: { icon: ClockIcon, tone: "text-warning" },
  Running: working,
  Pausing: pausing,
  Paused: pausing,
  Resuming: working,
  Recovering: working,
  Completed: { icon: CheckIcon, tone: "text-success" },
  Failed: { icon: XIcon, tone: "text-destructive", card: "border-destructive" },
  Killed: stopped,
  Terminated: stopped,
  Unknown: { icon: CircleHelpIcon, tone: "text-muted-foreground" },
};

/** The look of a state, as the engine names it, and the look of Unknown for a state it does not know. */
const lookOf = (state: string) => stateLooks[state as ExecutionState] ?? stateLooks.Unknown;

/**
 * Where the ports of a side are, one under the other: the first beside the card's name, and each next one a step
 * under it. In steps of the spacing scale.
 */
const firstPort = 7.5;
const portStep = 5.5;

/**
 * An operator on the canvas: a card with its picture, its name, and its settings in one line under it, or, as the
 * viewer chooses, every setting on a line of its own; under that, how it did in the execution shown. Its ports are on
 * its sides, beside its name. Opened, the card holds the operator's settings to edit, and is wider. Closed, it is as
 * wide as the layout counts it (canvas-geometry.ts); a workflow laid out for the Angular app's tiles, which stand
 * closer, may need arranging for its cards to have their room. Its top edge says who else has it selected, and who
 * is editing it in their card, each in their color; while someone else edits it, its edge is in their color too. The
 * lines from the chips of the datasets and models it reads end on its top edge, and those to the chips of its results
 * start at its outputs.
 */
export function OperatorNode({ id, data, selected }: NodeProps<OperatorNodeType>) {
  const { operator, name, typeName, schema, problem, progress, selectedBy = [], heldBy, mark } = data;
  // Whoever is editing it is said once, as editing it, though they have it selected too.
  const selecting = selectedBy.filter(({ clientId }) => clientId !== heldBy?.clientId);
  const canvas = useContext(CardCanvasContext);
  const open = canvas.editing === id;
  const detailed = canvas.density === "detailed";
  const upTo = canvas.executeUpTo?.(id);
  // An operator whose type the backend does not offer says nothing of its settings: nothing says what they are.
  const lines = schema ? settingLines(operator, schema) : [];
  // The type is said under the name only where the name does not say it: in place of the settings in one line, when
  // every setting has a line of its own, and in the open card.
  const typeShown = name !== typeName;
  const under = detailed ? (typeShown ? typeName : "") : summaryLine(lines);
  const ports = Math.max(operator.inputPorts.length, operator.outputPorts.length);

  return (
    <div
      data-selected={selected}
      className={cn(
        "group relative rounded-xl border bg-card text-card-foreground",
        open ? "w-74 shadow-lg" : "w-62 shadow-sm",
        progress && lookOf(progress.state).card,
        problem && "border-destructive",
        operator.isDisabled && "border-dashed",
        mark && markClassNames[mark],
        // A card whose operator has the keyboard is drawn as a selected one: React Flow's node, around the card, takes
        // the keyboard for it and draws no outline of its own.
        "group-focus-visible/node:border-ring group-focus-visible/node:ring-3 group-focus-visible/node:ring-ring/50",
        selected && "border-ring ring-3 ring-ring/50",
        heldBy && presenceClassNames(heldBy).border
      )}
      // As tall as its ports need, one under the other.
      style={ports > 1 ? { minHeight: `calc(var(--spacing) * ${2 * firstPort + portStep * (ports - 1)})` } : undefined}>
      {/* One line on the top edge, which the names share: they lie beside each other, never over each other or over
          the card's name. Who has it selected is on the left, more of them in lines above, and who is editing it on
          the right, where a long name is cut short, never what they do. */}
      {(selecting.length > 0 || heldBy) && (
        <div className="absolute inset-x-3 bottom-full -mb-1.5 flex items-end gap-1">
          {selecting.length > 0 && (
            <ul
              aria-label="Selected by"
              className="flex min-w-12 flex-1 flex-wrap-reverse gap-1">
              {selecting.map(collaborator => (
                <li
                  key={collaborator.clientId}
                  title={collaborator.name}
                  className={cn("max-w-full truncate rounded-sm px-1 text-xs", presenceClassNames(collaborator).label)}>
                  {collaborator.name}
                </li>
              ))}
            </ul>
          )}
          {heldBy && (
            <Holder
              id={id}
              holder={heldBy}
            />
          )}
        </div>
      )}
      {mark && (
        <span
          className={cn(
            "absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-sm px-1.5 text-xs font-medium whitespace-nowrap text-primary-foreground",
            markBadgeClassNames[mark]
          )}>
          {markNames[mark]}
        </span>
      )}
      {/* Where the lines from the chips of what it reads end: nothing is linked to it. */}
      <Handle
        id={resourcesHandle}
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="opacity-0"
      />
      <Ports
        side="input"
        ports={operator.inputPorts}
      />
      <Ports
        side="output"
        ports={operator.outputPorts}
      />
      {open ? (
        <OpenCard
          id={id}
          operator={operator}
          name={name}
          typeName={typeName}
          typeShown={typeShown}
          problem={problem}
          upTo={upTo}
          heldBy={heldBy}
        />
      ) : (
        <>
          <div className="flex items-center gap-2.5 px-3 py-2.5">
            {/* An operator left out of executions is faded, and says so in words, which stay to be read. */}
            <div className={cn("flex min-w-0 flex-1 items-center gap-2.5", operator.isDisabled && "opacity-50")}>
              <Picture
                operatorType={operator.operatorType}
                typeName={typeName}
              />
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-sm font-medium"
                  title={name}>
                  {name}
                </p>
                {under && (
                  <p
                    id={cardPartId(id, "summary")}
                    className="truncate text-xs text-muted-foreground"
                    title={under}>
                    {under}
                  </p>
                )}
              </div>
            </div>
            {operator.isDisabled && (
              <span
                id={cardPartId(id, "left-out")}
                title="Left out of executions"
                className="shrink-0 rounded-sm border px-1 text-xs text-muted-foreground">
                Left out
              </span>
            )}
            <Actions
              operator={operator}
              name={name}
              open={false}
              upTo={upTo}
              heldBy={heldBy}
            />
          </div>
          {detailed && lines.length > 0 && (
            <dl
              id={cardPartId(id, "settings")}
              className={cn("space-y-1 border-t px-3 py-2 text-xs", operator.isDisabled && "opacity-50")}>
              {lines.map(line => (
                <div
                  key={line.key}
                  className="flex gap-2">
                  <dt
                    className="w-24 shrink-0 truncate text-muted-foreground"
                    title={line.label}>
                    {line.label}
                  </dt>
                  <dd
                    className="line-clamp-2 min-w-0 flex-1 wrap-anywhere"
                    title={line.value}>
                    {line.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {/* Why it cannot be executed, which an open card says with its settings. */}
          {problem && (
            <p
              id={cardPartId(id, "problem")}
              className="flex items-start gap-1.5 border-t border-destructive/20 px-3 py-1.5 text-xs text-destructive last:rounded-b-xl"
              title={problem}>
              <TriangleAlertIcon
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0"
              />
              <span className="line-clamp-2 min-w-0 wrap-anywhere">{problem}</span>
            </p>
          )}
        </>
      )}
      {progress && (
        <ExecutionLine
          id={id}
          progress={progress}
        />
      )}
    </div>
  );
}

/**
 * Who is editing the operator in their card, in their color: their name, cut short where the card has no room for all
 * of it, and what they do, which is never cut. Whoever comes to the operator with the keyboard is told it in one
 * sentence, with what it means, which React Flow's own words, of how a node is deleted, would not say.
 */
function Holder({ id, holder }: { id: string; holder: Collaborator }) {
  const [who, doing] = editingParts([holder]);
  const notice = editingNotice([holder]);
  return (
    <span
      title={notice}
      className={cn("ml-auto flex min-w-0 rounded-sm px-1.5 text-xs font-medium", presenceClassNames(holder).label)}>
      <span
        aria-hidden
        className="truncate">
        {who}
      </span>
      <span
        aria-hidden
        className="shrink-0 whitespace-pre">
        {` ${doing}`}
      </span>
      <span
        id={cardPartId(id, "held")}
        className="sr-only">
        {notice}, so it cannot be changed or deleted until they are done.
      </span>
    </span>
  );
}

/** What takes what is typed or pressed, of what an open card holds under its head: the first is its first setting. */
const settings = "input, textarea, select, button";

/**
 * The card of an operator open for editing: its name to change, its buttons, and its settings, which the editor
 * gives. What is pressed, copied, pasted, right-clicked, scrolled or dragged in it, and in what its fields open, as a
 * list of choices, is its own, not the canvas's (`ownEvents`): Backspace in it deletes a character, never the
 * operator. Every change goes into the workflow as it is made, so closing it saves nothing more.
 */
function OpenCard({
  id,
  operator,
  name,
  typeName,
  typeShown,
  problem,
  upTo,
  heldBy,
}: {
  id: string;
  operator: Operator;
  name: string;
  typeName: string;
  /** Whether the card says its type under the name, which does not say it. */
  typeShown: boolean;
  /** Why the operator cannot be executed as it is, which its settings say. */
  problem?: string;
  upTo?: ExecutionUpTo;
  /** Who else is editing the operator, for a card open only to read while they do. */
  heldBy?: Collaborator;
}) {
  const {
    readOnly = false,
    openToRead = false,
    justAdded = false,
    onPatch,
    onEdit,
    card,
  } = useContext(CardCanvasContext);
  const box = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // React Flow draws a card hidden until it has measured it, and what is hidden takes no keyboard.
  const drawn = useStore(state => state.nodeLookup.get(id)?.measured.width !== undefined);
  // The card takes the keyboard once it is drawn, unless something in it has it already: the first of its settings,
  // for an operator just added, which is there to be set, or else the card itself.
  useEffect(() => {
    const section = box.current;
    if (!drawn || !section || section.contains(document.activeElement)) return;
    const first = justAdded ? body.current?.querySelector<HTMLElement>(settings) : undefined;
    (first ?? section).focus({ preventScroll: true });
  }, [drawn, justAdded]);
  // The card may close while it has the keyboard, as when someone else deletes its operator. The keyboard goes back to
  // the operator on the canvas, or to the canvas if the operator is gone, where the editor's keys work, rather than to
  // nothing: once the canvas has let go of what it no longer draws.
  useLayoutEffect(() => {
    const section = box.current;
    return () => {
      if (!section?.contains(document.activeElement)) return;
      const node = section.closest<HTMLElement>(".react-flow__node");
      const canvas = section.closest<HTMLElement>(".react-flow");
      queueMicrotask(() => (node?.isConnected ? node : canvas)?.focus());
    };
  }, []);
  /** Closes the card, and gives the keyboard back to the operator on the canvas. */
  const close = () => {
    const node = box.current?.closest<HTMLElement>(".react-flow__node");
    onEdit?.(undefined);
    node?.focus();
  };

  return (
    <section
      ref={box}
      id={cardPartId(id, "properties")}
      tabIndex={-1}
      aria-label={`Properties of ${name}`}
      className="nodrag nopan nowheel nokey cursor-default outline-none"
      {...ownEvents}
      onKeyDown={event => {
        // An Escape that closed something in the card, such as a list of choices, was that one's.
        if (event.key === "Escape" && !event.defaultPrevented) close();
        ownEvents.onKeyDown(event);
      }}>
      <div className="flex items-center gap-2.5 border-b px-3 py-2.5">
        <Picture
          operatorType={operator.operatorType}
          typeName={typeName}
        />
        <div className="min-w-0 flex-1">
          <Input
            aria-label="Name"
            value={operator.customDisplayName ?? ""}
            placeholder={typeName}
            disabled={readOnly || openToRead || !onPatch}
            // A name that is cleared is no name: the operator goes by its type's again.
            onChange={event => onPatch?.(operator.operatorID, { customDisplayName: event.target.value || undefined })}
            // A field in the card's head, whose edge shows where it is pointed at or has the keyboard.
            className="h-7 truncate border-transparent px-1.5 py-0 text-sm font-medium hover:border-input dark:bg-transparent"
          />
          {typeShown && <p className="truncate px-1.5 text-xs text-muted-foreground">{typeName}</p>}
        </div>
        <Actions
          operator={operator}
          name={name}
          open
          upTo={upTo}
          heldBy={heldBy}
        />
      </div>
      {/* Why it cannot be executed up to here now, to be read, where the operator's settings do not say it. */}
      {upTo?.problem !== undefined && upTo.problem !== problem && (
        <p className="flex items-center gap-1.5 border-b px-3 py-1.5 text-xs text-muted-foreground">
          <PlayIcon
            aria-hidden
            className="size-3.5 shrink-0"
          />
          {upTo.problem}
        </p>
      )}
      <div
        ref={body}
        className="max-h-96 overflow-y-auto p-3">
        {card?.(operator)}
      </div>
      <div className="flex justify-end border-t px-3 py-2">
        <Button
          size="sm"
          onClick={close}>
          <CheckIcon />
          Done
        </Button>
      </div>
    </section>
  );
}

/**
 * Shows a button only while its card is pointed at, selected or has the keyboard, or something in it has: until then
 * it takes no room, is not seen and takes no press, and it comes and goes at once. It is drawn all the same, so that
 * it takes the keyboard: a browser gives the keyboard to the button after a card only if the button can take it once
 * the card has let go of it, when nothing on the card has the keyboard, and else to nothing.
 */
const onDemand = cn(
  "pointer-events-none absolute opacity-0 transition-none",
  "group-hover:pointer-events-auto group-hover:static group-hover:opacity-100",
  "group-focus-within/node:pointer-events-auto group-focus-within/node:static group-focus-within/node:opacity-100",
  "group-data-[selected=true]:pointer-events-auto group-data-[selected=true]:static",
  "group-data-[selected=true]:opacity-100"
);

/**
 * One of the operator's buttons, shown always or on demand (`onDemand`). Whether it is seen is said around the button,
 * apart from how the button itself looks: a disabled button fades itself, which would leave it half seen where it is
 * not to be seen at all, as an eye on a canvas that is only looked at.
 */
function Shown({ always, children }: { always: boolean; children: ReactNode }) {
  return <span className={cn("flex", !always && onDemand)}>{children}</span>;
}

/**
 * How a button looks that cannot be used now, and stays where the keyboard goes to say why: its icon is faded, and
 * its edge, which shows where the keyboard is, is as strong as any other's.
 */
const waitingLook = "aria-disabled:[&_svg]:opacity-50";

/**
 * The operator's own buttons: executing the workflow up to it, its eye, which keeps its result after each execution,
 * and, on a closed card, opening it. The eye stays in sight while it is on, and all of them on an open card; the
 * others show on demand. While someone else edits the operator, the eye waits for them, for whoever looks, and says
 * so, and opening opens the card only to read: a hold stops changing, never reading. Executing changes nothing in the
 * workflow, and stays. In a card open only to read, the eye changes nothing either.
 */
function Actions({
  operator,
  name,
  open,
  upTo,
  heldBy,
}: {
  operator: Operator;
  name: string;
  open: boolean;
  /** Whether the workflow can be executed up to the operator now, and how. */
  upTo?: ExecutionUpTo;
  /**
   * Who else is editing the operator: a closed card opens only to read meanwhile, and a card open to change it closes
   * when someone else takes it, so an open card is told only while it is open to read.
   */
  heldBy?: Collaborator;
}) {
  const { readOnly = false, openToRead = false, onEdit, onPatch } = useContext(CardCanvasContext);
  const keeps = operator.viewResult === true;
  /** Why the eye waits, and why the card opens only to read. */
  const waiting = heldBy && editingNotice([heldBy]);
  /** Whether the card opens, or is open, only to read. */
  const toRead = readOnly || waiting !== undefined || (open && openToRead);
  const [execute, keep, edit] = [
    `Execute up to ${name}`,
    `Keep the result of ${name}`,
    `${toRead ? "View" : "Edit"} ${name}`,
  ];
  return (
    // A press on a button is the button's: it neither drags the card nor pans the canvas, and a double click on it
    // opens no card.
    <div
      className="nodrag nopan flex shrink-0 items-center"
      onDoubleClick={ownEvents.onDoubleClick}>
      {upTo && (
        <Shown always={open}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={execute}
            title={upTo.problem ?? execute}
            // One that cannot be used now stays where the keyboard goes, and says why to whoever comes to it.
            aria-disabled={upTo.problem !== undefined}
            className={waitingLook}
            onClick={upTo.start}>
            <PlayIcon />
          </Button>
        </Shown>
      )}
      <Shown always={open || keeps}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={keep}
          title={waiting ?? keep}
          aria-pressed={keeps}
          disabled={readOnly || (open && openToRead) || !onPatch}
          aria-disabled={waiting !== undefined}
          className={cn(keeps ? "text-primary" : "text-muted-foreground", waitingLook)}
          onClick={waiting ? undefined : () => onPatch?.(operator.operatorID, { viewResult: !keeps })}>
          {keeps ? <EyeIcon /> : <EyeOffIcon />}
        </Button>
      </Shown>
      {onEdit && !open && (
        <Shown always={false}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={edit}
            title={waiting ?? edit}
            onClick={() => onEdit(operator.operatorID)}>
            {toRead ? <Settings2Icon /> : <PencilIcon />}
          </Button>
        </Shown>
      )}
    </div>
  );
}

/** The picture of the operator's type, on a ground of its own: the pictures are drawn for a light one. */
function Picture({ operatorType, typeName }: { operatorType: string; typeName: string }) {
  const image = operatorImage(operatorType);
  return (
    <span
      title={typeName}
      className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-card p-1.5">
      {image && (
        <img
          src={image}
          alt=""
          draggable={false}
          className="size-full object-contain dark:invert"
        />
      )}
    </span>
  );
}

/**
 * Where the operator stands in the execution shown: its state, and the rows it took and put out. The state's color is
 * on its icon, which turns while the operator works, unless the viewer asked for less motion; its word is in the
 * text's, to be read.
 */
function ExecutionLine({ id, progress }: { id: string; progress: OperatorProgress }) {
  const { icon: Icon, tone, turns } = lookOf(progress.state);
  return (
    <div
      id={cardPartId(id, "execution")}
      className="flex items-center gap-1.5 border-t bg-muted/40 px-3 py-1.5 text-xs last:rounded-b-xl">
      <Icon
        aria-hidden
        className={cn("size-3.5 shrink-0", tone, turns && "motion-safe:animate-spin")}
      />
      <span className="font-medium">{progress.state}</span>
      <span className="ml-auto truncate text-muted-foreground tabular-nums">{formatRows(progress)}</span>
    </div>
  );
}

/** The ports of one side, one under the other, from beside the card's name down. A link starts or ends on a port. */
function Ports({ side, ports }: { side: "input" | "output"; ports: PortDescription[] }) {
  return ports.map((port, index) => (
    <Handle
      key={port.portID}
      id={port.portID}
      type={side === "input" ? "target" : "source"}
      position={side === "input" ? Position.Left : Position.Right}
      title={port.displayName || undefined}
      aria-label={`${side === "input" ? "Input" : "Output"} port ${index + 1}`}
      className="size-3! border-2!"
      style={{ top: `calc(var(--spacing) * ${firstPort + portStep * index})` }}
    />
  ));
}
