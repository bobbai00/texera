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

import { cn } from "cn";
import { FileCodeIcon, GitCompareArrowsIcon, MessageSquareTextIcon, Redo2Icon, Undo2Icon } from "lucide-react";
import { type KeyboardEvent, lazy, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { FloatingArea } from "@/components/floating/floating-area";
import { FloatingPanel } from "@/components/floating/floating-panel";
import { useFloatingPanel } from "@/components/floating/use-floating-panel";
import { PagePending } from "@/components/layout/page";
import { PageLink } from "@/components/layout/page-link";
import { resourceKinds } from "@/components/resource/kinds";
import { Button } from "@/components/ui/button";
import type { OperatorProgress, OperatorResult } from "@/lib/execution/client";
import { formatTime } from "@/lib/format";
import { operatorSpacing } from "@/lib/workflow/canvas-geometry";
import { codeLanguage, codeLanguageNames } from "@/lib/workflow/code";
import { heldByOthers } from "@/lib/workflow/holds";
import { layout } from "@/lib/workflow/layout";
import type { Operator, Point } from "@/lib/workflow/model";
import { newOperator, type OperatorMetadata } from "@/lib/workflow/operator-schema";
import type { Collaborator } from "@/lib/workflow/room";
import { parameterDeclaration, type ParameterType, udfParametersProperty } from "@/lib/workflow/udf-parameters";
import type { WorkflowVersion } from "@/lib/workflow/versions";
import { createWorkflow, type Workflow } from "../api";
import { typing, undoing } from "../keys";
import { operatorName } from "../operator-name";
import { useCanvasCommands } from "../use-canvas-commands";
import { useCardDensity } from "../use-card-density";
import { useChipsShown } from "../use-chips-shown";
import { useUdfParameters } from "../use-udf-parameters";
import type { WorkflowEditing } from "../use-workflow-editing";
import { type Comparison, useWorkflowHistory } from "../use-workflow-history";
import { useWorkspaceViews } from "../use-workspace-views";
import type { WorkspaceView } from "../workspace-views";
import { CanvasMenu } from "./canvas-menu";
import { CollaboratorAvatar } from "./collaborator-avatar";
import { CommentThread } from "./comment-thread";
import { OperatorMenu } from "./operator-menu";
import { OperatorProperties } from "./operator-properties";
import type { PropertyControls } from "./property-form";
import { VersionBar } from "./version-bar";
import { VersionChanges } from "./version-changes";
import { VersionList } from "./version-list";
import { WorkflowMenu } from "./workflow-menu";
import { WorkflowSettingsForm } from "./workflow-settings";
import { type ExecutionUpTo, type Selection, WorkflowCanvas } from "./workflow-canvas";
import { WorkspacePanel } from "./workspace-panel";

export interface WorkflowEditorProps {
  workflow: Workflow;
  metadata: OperatorMetadata;
  editing: WorkflowEditing;
  /** The signed-in user, whose comments are theirs to change. */
  user: { id: number; name: string };
  /** What each operator is doing in the execution being shown, by its id. */
  progress?: Record<string, OperatorProgress>;
  /** What the execution being shown kept of each operator's output, by its id: each is a chip under its card. */
  results?: Record<string, OperatorResult>;
  /** Shows the result an operator kept, from the feature that executes it, as a click on its chip asks. */
  onShowResult?: (operatorId: string) => void;
  /** Controls at the end of the toolbar, such as those that start and stop an execution. */
  toolbar?: ReactNode;
  /** A panel of another feature's that floats over the canvas beside the editor's own, such as the results of an
   * execution: a `FloatingPanel`. */
  panel?: ReactNode;
  /** The controls of an operator's properties that come from another feature, such as picking a dataset's file. */
  propertyControls?: PropertyControls;
  /**
   * Whether the workflow can be executed up to an operator now, and how, from the feature that executes it: an
   * operator's card and the canvas's menu offer it. Without it, nothing does.
   */
  executeUpTo?: (operatorId: string) => ExecutionUpTo;
  /** The workflow's executions, from another feature, shown in the workspace panel beside its versions. */
  executions?: ReactNode;
  /** The version to show in place of the workflow, by its id, as the address names it. */
  version?: number;
  /** Shows a version, or the workflow again. */
  onVersion?: (versionId: number | undefined) => void;
  /** A version was copied into a new workflow, which is the user's to open. */
  onCopied?: (workflowId: number) => void;
  /** The operators that are selected changed. */
  onSelect?: (operatorIds: string[]) => void;
}

// The code editor is loaded when someone first opens an operator's code: most workflows are edited without it.
const CodePanel = lazy(() => import("./code-panel").then(module => ({ default: module.CodePanel })));

const saveLabels = { saved: "Saved", saving: "Saving…", failed: "Not saved" };

const sameIds = (ids: string[], others: string[]) => ids.toSorted().join() === others.toSorted().join();
const nothing: Selection = { operators: [], links: [], commentBoxes: [] };
const nothingHeld: ReadonlyMap<string, Collaborator> = new Map();

/**
 * The workflow editor: the canvas, with panels that float over it. An operator's settings are edited in its card on the
 * canvas, one card open at a time, and chips around its card name the datasets and models it reads and show the result
 * it kept, unless the user hides them. The workspace panel holds the operators to add, the versions, the executions and
 * the settings; the panel on the right holds the comments of what is selected, the code opened from this user's card or
 * the code of the person they follow, or what a version shown changed. Each is moved, resized and minimized as the user
 * likes. The editor shows where the other people editing the workflow are, and lets the user follow one of them. One
 * person at a time edits an operator's settings: whoever opened its card first holds it (holds.ts), and the others see
 * who, and open its card only to read, changing nothing of it until they are done; its code stays anyone's to type in.
 * Someone who may only view the workflow gets the canvas and the panels with nothing to change in them. A version is
 * shown as it was, with what changed, without touching the workflow itself.
 */
export function WorkflowEditor({
  workflow,
  metadata,
  editing,
  user,
  progress,
  results,
  onShowResult,
  toolbar,
  panel,
  propertyControls,
  executeUpTo,
  executions,
  version,
  onVersion,
  onCopied,
  onSelect,
}: WorkflowEditorProps) {
  const { entry, offline, save, saveProblem, collaborators, me } = editing;
  const { document, room, content, history, schemas, inputSchemas, problems } = editing;
  const { lostOfflineChanges, acknowledgeLostChanges } = editing;
  const { readonly } = workflow;
  const [selection, setSelection] = useState<Selection>(nothing);
  /** Where a comment that this user is starting will go. */
  const [draftComment, setDraftComment] = useState<Point>();
  /** Where the pointer is on the canvas, while it is there. */
  const pointer = useRef<Point>(undefined);
  /**
   * The operator whose card this user has open; whether it was added just now, when its first field takes the keyboard;
   * and whether it was opened only to read, as a card someone else held when it was opened is, until it is opened again.
   */
  const [openCard, setOpenCard] = useState<{ operatorId: string; added: boolean; toRead: boolean }>();
  /**
   * The operator whose code this user opened, from its card: it closes as this user closes the card or opens another,
   * and stays open when someone else turns out to hold the card, as no one holds code.
   */
  const [openedCode, setOpenedCode] = useState<string>();
  /** The person this user follows: the canvas selects what they select, and their code opens when they open it. */
  const [followedId, setFollowedId] = useState<number>();
  const followed = collaborators.find(each => each.clientId === followedId);
  /** What the canvas is to select and bring into view: what this user added or pasted, or a change they asked for. */
  const [revealed, setRevealed] = useState<string[]>();

  const workspace = useFloatingPanel({ id: "workflow-workspace", dock: "left", size: { width: 280, height: 480 } });
  const details = useFloatingPanel({ id: "workflow-details", dock: "right", size: { width: 320 } });
  const codeWindow = useFloatingPanel({ id: "workflow-code", dock: "right", size: { width: 560, height: 720 } });
  const rail = useWorkspaceViews([
    // Nothing is added to a version, nor by someone who may only view the workflow.
    ...(readonly || version !== undefined ? [] : (["operators"] as const)),
    "versions",
    ...(executions ? (["executions"] as const) : []),
    "settings",
  ]);
  /** Whether the canvas shows a small map of the whole workflow, which lies over a corner of it. */
  const [map, setMap] = useState(false);
  const [density, setDensity] = useCardDensity();
  const [chips, setChips] = useChipsShown();
  const [comparison, setComparison] = useState<Comparison>("previous");
  /** The version this user restored last, until they have seen that it is restored. */
  const [restored, setRestored] = useState<WorkflowVersion>();
  const [copying, setCopying] = useState(false);
  const [copyProblem, setCopyProblem] = useState<Error>();
  const workflowHistory = useWorkflowHistory({
    workflowId: workflow.id,
    active: (rail.view === "versions" && !workspace.minimized) || version !== undefined,
    versionId: version,
    comparison,
    content,
    saved: save === "saved",
  });
  /** The version shown in place of the workflow, if one is. */
  const viewing = version === undefined ? undefined : workflowHistory.view;
  const versionShown = viewing !== undefined;
  const shownContent = viewing ? viewing.shown : content;
  /** Whether what the canvas shows is only looked at: a version, or a workflow this user may only view. */
  const onlyLooking = readonly || versionShown;
  /**
   * The operators on the canvas that someone else holds, each with whoever holds it (holds.ts): theirs to change until
   * they are done, and meanwhile their cards open here only to read. A hold stops changing, never reading. A version
   * shown is the workflow as it was, which no one holds.
   */
  const held = useMemo(
    () => (versionShown ? nothingHeld : heldByOthers(me, collaborators)),
    [versionShown, me, collaborators]
  );
  const commands = useCanvasCommands({
    document,
    content,
    selection,
    schemas,
    readonly,
    held,
    pointer: () => pointer.current,
    onPasted: setRevealed,
  });

  const selectedOperators = shownContent.operators.filter(each => selection.operators.includes(each.operatorID));
  const selected =
    selectedOperators.length === 1 && selection.commentBoxes.length === 0 ? selectedOperators[0] : undefined;
  const selectedBox =
    !viewing && selection.commentBoxes.length === 1 && selection.operators.length === 0
      ? content.commentBoxes.find(each => each.commentBoxID === selection.commentBoxes[0])
      : undefined;
  /** The operator whose card is open. */
  const opened = openCard && shownContent.operators.find(each => each.operatorID === openCard.operatorId);
  // An operator that leaves the canvas, as when someone deletes it or an undo takes it back, closes its card, and the
  // code opened from it: if it comes back, it comes back closed, and takes the keyboard from nothing this user does.
  if (openCard && !opened) edit(undefined);
  // A card open to change its operator closes when someone else turns out to hold the operator, as when they opened it
  // at the same moment and began first, and then says who is editing it. The code opened from it stays open: code is
  // shared text, which no one holds. A card open only to read stays as it is: there is nothing in it to hold.
  else if (openCard && !onlyLooking && !openCard.toRead && held.has(openCard.operatorId)) setOpenCard(undefined);
  /** Whether the card that is open changes nothing: on a canvas only looked at, or opened only to read. */
  const cardToRead = onlyLooking || openCard?.toRead === true;
  // The others are told which operator this user has open to change, and leave it to them meanwhile; a card open
  // only to read tells them nothing.
  const claimed = cardToRead ? undefined : opened?.operatorID;
  useEffect(() => room.edit(claimed), [room, claimed]);
  // While this user follows someone, which code is open is theirs to say.
  const codeOf = followed ? followed.code : openedCode;
  const coded = codeOf === undefined ? undefined : shownContent.operators.find(each => each.operatorID === codeOf);
  const language = coded && codeLanguage(coded.operatorType);
  const code = !viewing && coded && language ? document.code(coded.operatorID) : undefined;
  const shownCode = code && coded?.operatorID;
  useEffect(() => room.openCode(shownCode), [room, shownCode]);
  // The parameters a UDF's code declares are kept in step with the code this user may type in: the code of the
  // person they follow, or else the code they opened from their card, which stays when someone else takes the card,
  // or else their open card's. A card is never open while they follow someone, and the code they open is their card's,
  // so the two name one operator.
  const stepped = coded ?? opened;
  const steppedSchema = stepped && schemas.get(stepped.operatorType);
  const declaresParameters =
    !onlyLooking && steppedSchema && udfParametersProperty in (steppedSchema.jsonSchema.properties ?? {});
  const parametersProblem = useUdfParameters(document, declaresParameters ? stepped?.operatorID : undefined);

  function addOperator(operatorType: string, position: Point = besideTheLast()) {
    const schema = schemas.get(operatorType);
    if (!schema) return;
    const operator = newOperator(schema);
    document.add({ operators: [operator], operatorPositions: { [operator.operatorID]: position } });
    setRevealed([operator.operatorID]);
    // A new operator is there to be set: its card opens with its first field ready to type in.
    edit(operator.operatorID, true);
  }

  /**
   * Opens an operator's card, closing the one that was open, or closes it: everything this user does to the card they
   * have open. No one is followed meanwhile, since a card is this user's own doing, and the code they opened from a
   * card closes with the card. The card of an operator someone else holds opens only to read, and stays so until it
   * is opened again.
   */
  function edit(operatorId: string | undefined, added = false) {
    setFollowedId(undefined);
    setOpenCard(operatorId === undefined ? undefined : { operatorId, added, toRead: held.has(operatorId) });
    if (openedCode !== operatorId) setOpenedCode(undefined);
  }

  /** A comment as this user makes it now. */
  const commentOf = (text: string) => ({
    content: text,
    creationTime: new Date().toISOString(),
    creatorName: user.name,
    creatorID: user.id,
  });

  /** Where an operator that was not dropped anywhere goes: one column to the right of the rightmost one. */
  function besideTheLast(): Point {
    const places = Object.values(content.operatorPositions);
    const last = places.toSorted((a, b) => b.x - a.x).at(0);
    return last ? { x: last.x + operatorSpacing.column, y: last.y } : { x: 0, y: 0 };
  }

  function handleSelect(next: Selection) {
    const ids = next.operators;
    setSelection(next);
    if (viewing) return;
    room.select(ids);
    onSelect?.(ids);
    // Selecting anything but what the followed person has selected is this user going their own way.
    if (followed && !sameIds(ids, followed.selection)) setFollowedId(undefined);
    if (ids.length + next.commentBoxes.length + next.links.length > 0) setDraftComment(undefined);
  }

  /**
   * Starts following someone, or stops. From then on they say what the canvas shows, not what this user added: this
   * user's card closes, and no card of theirs opens here.
   */
  function follow(clientId: number | undefined) {
    setRevealed(undefined);
    edit(undefined);
    setFollowedId(clientId);
  }

  /**
   * Opens or closes the code of the operator whose card is open. Either is this user's own doing, so they follow no
   * one after it.
   */
  function setCodeOpen(open: boolean) {
    setFollowedId(undefined);
    setOpenedCode(open ? opened?.operatorID : undefined);
  }

  /**
   * Declares one more parameter in the code of the operator whose card is open, and says why it could not, if it
   * could not.
   */
  function addParameter(name: string, type: ParameterType): string | undefined {
    const text = opened && document.code(opened.operatorID);
    if (!opened || !text) return "The code cannot be changed here.";
    const declaration = parameterDeclaration(text.toJSON(), name, type);
    if ("problem" in declaration) return declaration.problem;
    document.typeCode(opened.operatorID, declaration.offset, declaration.text);
    return undefined;
  }

  /**
   * Shows a version in place of the workflow, or the workflow again. Looking at a version follows no one, and the
   * card that was open closes.
   */
  function openVersion(versionId: number | undefined) {
    edit(undefined);
    setDraftComment(undefined);
    setRevealed(undefined);
    onVersion?.(versionId);
  }

  function restore() {
    if (!viewing) return;
    document.restore(viewing.version.content);
    setRestored(viewing.version);
    openVersion(undefined);
  }

  async function copyVersion() {
    if (!viewing) return;
    setCopying(true);
    setCopyProblem(undefined);
    try {
      const name = `${workflow.name} (${formatTime(viewing.version.savedAt)})`;
      onCopied?.(await createWorkflow(name, viewing.version.content));
    } catch (error) {
      setCopyProblem(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setCopying(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") setFollowedId(undefined);
    if (onlyLooking || typing(event.target) || !undoing(event)) return;
    event.preventDefault();
    if (event.shiftKey) document.redo();
    else document.undo();
  }

  if (entry === "refused") {
    return (
      <div className="p-6">
        <ErrorAlert error="You may not open this workflow." />
      </div>
    );
  }
  // Until the workflow's room is entered, there is no workflow to show.
  if (entry === "entering") {
    return (
      <div className="space-y-4 p-6">
        <ErrorAlert error={offline ? "The shared editing service cannot be reached. Trying again…" : undefined} />
        <PagePending />
      </div>
    );
  }

  /**
   * The panel on the right: the changes of the version that is shown, or the comments of what is selected on the
   * canvas, or the code opened from this user's card or the code of the person they follow.
   */
  function detailsPanel(): ReactNode {
    if (viewing) {
      return (
        <FloatingPanel
          panel={details}
          title="What changed"
          icon={GitCompareArrowsIcon}>
          <div className="space-y-4 p-4">
            <ErrorAlert error={copyProblem} />
            <VersionChanges
              diff={viewing.diff}
              schemas={schemas}
              onShow={id => setRevealed([id])}
            />
          </div>
        </FloatingPanel>
      );
    }
    if (selectedBox ?? draftComment) {
      const close = () => {
        setDraftComment(undefined);
        setRevealed([]);
      };
      return (
        <FloatingPanel
          panel={details}
          title={selectedBox ? "Comments" : "New comment"}
          label="Comments"
          icon={MessageSquareTextIcon}
          onClose={close}
          closeLabel="Close the comments">
          <CommentThread
            // Another box is another thread: nothing written for one may show in the next.
            key={selectedBox?.commentBoxID ?? "draft"}
            comments={selectedBox?.comments ?? []}
            userId={user.id}
            canComment={!readonly}
            onAdd={text => {
              if (selectedBox) return document.addComment(selectedBox.commentBoxID, commentOf(text));
              if (!draftComment) return;
              const boxId = document.addCommentBox(draftComment, commentOf(text));
              setDraftComment(undefined);
              setRevealed([boxId]);
            }}
            onEdit={(comment, text) => selectedBox && document.editComment(selectedBox.commentBoxID, comment, text)}
            onRemove={comment => selectedBox && document.removeComment(selectedBox.commentBoxID, comment)}
            onClose={close}
          />
        </FloatingPanel>
      );
    }
    if (coded && language && code) {
      const name = operatorName(coded, schemas);
      const alsoHere = collaborators.filter(each => each.code === coded.operatorID);
      return (
        <FloatingPanel
          panel={codeWindow}
          title={name}
          label={`Code of ${name}`}
          icon={FileCodeIcon}
          status={`${codeLanguageNames[language]}${readonly ? ", view only" : ""}`}
          actions={
            alsoHere.length > 0 && (
              <ul
                aria-label="Also in this code"
                className="mr-1 flex -space-x-1">
                {alsoHere.map(collaborator => (
                  <li
                    key={collaborator.clientId}
                    className="rounded-full ring-2 ring-background">
                    <CollaboratorAvatar collaborator={collaborator} />
                  </li>
                ))}
              </ul>
            )
          }
          onClose={() => setCodeOpen(false)}
          closeLabel="Close the code">
          <Suspense fallback={<PagePending />}>
            <CodePanel
              // Another operator's code is another editor.
              key={coded.operatorID}
              operator={coded}
              name={name}
              text={code}
              language={language}
              awareness={room.awareness}
              readOnly={readonly}
            />
          </Suspense>
        </FloatingPanel>
      );
    }
    return null;
  }

  /**
   * What the open card holds: the operator's properties, to change, or to read in a version, for a reader, or while
   * someone else edits them, when its code still opens to type in.
   */
  function properties(operator: Operator): ReactNode {
    const schema = schemas.get(operator.operatorType);
    return (
      schema && (
        <OperatorProperties
          operator={operator}
          schema={schema}
          inputSchemas={viewing ? [] : (inputSchemas[operator.operatorID] ?? [])}
          problem={viewing ? undefined : problems[operator.operatorID]}
          controls={propertyControls}
          disabled={cardToRead}
          codeReadOnly={onlyLooking}
          onProperty={(key, value) => document.setOperatorProperty(operator.operatorID, key, value)}
          // A version's code is read in its changes, as how it differs.
          onOpenCode={viewing ? undefined : () => setCodeOpen(true)}
          parametersProblem={parametersProblem}
          onAddParameter={addParameter}
        />
      )
    );
  }

  const workspacePanel = (
    <WorkspacePanel
      panel={workspace}
      view={rail.view}
      onView={rail.choose}
      views={rail.views.map(each => ({ view: each, content: workspaceContent(each) }))}
      onReorder={rail.reorder}
    />
  );

  /** What each view of the workspace panel holds. */
  function workspaceContent(each: WorkspaceView): ReactNode {
    switch (each) {
      case "operators":
        return (
          <OperatorMenu
            metadata={metadata}
            onAdd={addOperator}
          />
        );
      case "versions":
        return (
          <VersionList
            history={workflowHistory.history}
            error={workflowHistory.error}
            shown={version}
            onOpen={openVersion}
          />
        );
      case "executions":
        return executions;
      case "settings":
        return (
          <WorkflowSettingsForm
            // The settings someone else saves show at once.
            key={JSON.stringify(shownContent.settings)}
            settings={shownContent.settings}
            readonly={onlyLooking}
            onSave={settings => document.setSettings(settings)}
          />
        );
    }
  }

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onKeyDown={handleKeyDown}>
      <div
        role="toolbar"
        aria-label="Workflow"
        className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5">
        <div className="flex min-w-40 flex-1 items-center gap-1">
          <PageLink
            page={resourceKinds.workflow.listPage}
            className="text-sm text-muted-foreground hover:text-foreground">
            {resourceKinds.workflow.plural}
          </PageLink>
          <span className="text-muted-foreground">/</span>
          <h1 className="truncate text-sm font-medium">{workflow.name}</h1>
          <span
            role="status"
            title={saveProblem}
            className="ml-2 shrink-0 text-sm text-muted-foreground">
            {readonly ? "View only" : offline ? "Offline" : saveLabels[save]}
          </span>
        </div>
        {/* In a narrow place the controls move to a line of their own, under the name. */}
        <div className="flex flex-wrap items-center gap-1">
          {collaborators.length > 0 && (
            <ul
              aria-label="Also editing"
              className="mr-2 flex items-center gap-1">
              {collaborators.map(collaborator => (
                <li key={collaborator.clientId}>
                  <button
                    type="button"
                    aria-label={`Follow ${collaborator.name}`}
                    aria-pressed={collaborator === followed}
                    title={`Follow ${collaborator.name}: see what they select and the code they open`}
                    disabled={viewing !== undefined}
                    className={cn(
                      "block rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      collaborator === followed && "ring-2 ring-ring ring-offset-2 ring-offset-background"
                    )}
                    onClick={() => follow(collaborator === followed ? undefined : collaborator.clientId)}>
                    <CollaboratorAvatar collaborator={collaborator} />
                  </button>
                </li>
              ))}
              {followed && <li className="ml-1 text-sm text-muted-foreground">Following {followed.name}</li>}
            </ul>
          )}
          {!onlyLooking && (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Undo"
                disabled={!history.canUndo}
                onClick={() => document.undo()}>
                <Undo2Icon />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Redo"
                disabled={!history.canRedo}
                onClick={() => document.redo()}>
                <Redo2Icon />
              </Button>
            </>
          )}
          {!viewing && (
            <WorkflowMenu
              name={workflow.name}
              content={content}
              readonly={readonly}
              onArrange={() => document.move(layout(content))}
              map={map}
              onMapChange={setMap}
              density={density}
              onDensityChange={setDensity}
              chips={chips}
              onChipsChange={setChips}
            />
          )}
          {!viewing && toolbar}
        </div>
      </div>
      {viewing && (
        <VersionBar
          view={viewing}
          comparison={comparison}
          canRestore={!readonly}
          copying={copying}
          onComparison={setComparison}
          onOpen={openVersion}
          onRestore={restore}
          onCopy={() => void copyVersion()}
          onClose={() => openVersion(undefined)}
        />
      )}
      {version !== undefined && workflowHistory.history && !viewing && (
        <div
          role="alert"
          className="flex items-center gap-3 border-b bg-muted px-3 py-2 text-sm">
          <p className="min-w-0 flex-1">This workflow has no version {version} to show.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => openVersion(undefined)}>
            Back to the workflow
          </Button>
        </div>
      )}
      {restored && !viewing && (
        <div
          role="status"
          className="flex items-center gap-3 border-b bg-muted px-3 py-2 text-sm">
          <p className="min-w-0 flex-1">The version of {formatTime(restored.savedAt)} is restored.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              document.undo();
              setRestored(undefined);
            }}>
            Undo
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRestored(undefined)}>
            Got it
          </Button>
        </div>
      )}
      {lostOfflineChanges && (
        <div
          role="alert"
          className="flex items-center gap-3 border-b bg-muted px-3 py-2 text-sm">
          <p className="min-w-0 flex-1">
            The connection was away for too long, so the workflow was opened again as it is saved. What you changed
            while offline is not in it.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={acknowledgeLostChanges}>
            Got it
          </Button>
        </div>
      )}
      <FloatingArea
        className="min-h-0 flex-1"
        panels={
          <>
            {workspacePanel}
            {detailsPanel()}
            {!viewing && panel}
          </>
        }>
        <div
          className="size-full"
          {...(viewing ? {} : commands.handlers)}>
          <WorkflowCanvas
            content={shownContent}
            schemas={schemas}
            density={density}
            problems={viewing ? undefined : problems}
            progress={viewing ? undefined : progress}
            // A version reads what its settings say, and kept nothing: the results are the execution's on screen.
            results={viewing ? undefined : results}
            chips={chips}
            onShowResult={onShowResult}
            collaborators={viewing ? undefined : collaborators}
            held={held}
            shown={followed && !viewing ? followed.selection : revealed}
            readOnly={onlyLooking}
            draftComment={viewing ? undefined : draftComment}
            marks={viewing?.marks}
            map={map}
            onMove={positions => document.move(positions)}
            onLink={link => document.link(link)}
            onRemove={elements => document.remove(elements)}
            onPatch={(operatorId, patch) => document.patchOperator(operatorId, patch)}
            editing={opened?.operatorID}
            justAdded={openCard?.added}
            openToRead={openCard?.toRead}
            onEdit={operatorId => edit(operatorId)}
            card={properties}
            // A version is looked at, not executed.
            executeUpTo={viewing ? undefined : executeUpTo}
            onAddOperator={addOperator}
            onSelect={handleSelect}
            onPoint={position => {
              pointer.current = position;
              if (!viewing) room.point(position);
            }}
            menu={
              viewing
                ? undefined
                : target => (
                    <CanvasMenu
                      target={target}
                      operators={selectedOperators}
                      commands={commands}
                      readonly={readonly}
                      onComment={() => setDraftComment(target.at)}
                      onArrange={() => document.move(layout(content))}
                      upTo={selected && executeUpTo?.(selected.operatorID)}
                    />
                  )
            }
          />
        </div>
      </FloatingArea>
    </div>
  );
}
