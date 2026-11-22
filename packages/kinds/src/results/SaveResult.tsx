// Saving a result: the rows an execution kept of one port become a version of a dataset, one CSV
// file, so they outlive the execution and its retention. A new dataset of the execution's project,
// or the next version of one the person may write; the version's lineage says where it came from.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { workflowsSaveResult } from "@texera/catalog-client";
import type { Execution, PortSummary } from "@texera/catalog-client/types";
import {
  Button,
  ErrorNote,
  Field,
  Input,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  Segmented,
  Select,
} from "@texera/ui";
import { Check, Loader2, Save } from "lucide-react";
import { useState } from "react";
import { unwrap } from "../api";
import { searchQuery } from "../queries";
import { useOpenResource } from "../shell/navigation";

type Into = "new" | "existing";

/** A file name a person would give the rows: the operator's name, plain. */
const fileOf = (title: string) =>
  `${
    title
      .trim()
      .replace(/[^\p{L}\p{N}._ -]+/gu, "")
      .replace(/\s+/g, "-")
      .toLowerCase() || "result"
  }.csv`;

export function SaveResult({
  workflow,
  execution,
  port,
  title,
  project,
}: {
  workflow: string;
  execution: Execution;
  port: PortSummary;
  /** The operator's name, as its card says it. */
  title: string;
  /** The execution's project: where a new dataset goes, and whose datasets are offered. */
  project?: string;
}) {
  const queryClient = useQueryClient();
  const { beside } = useOpenResource();
  const [open, setOpen] = useState(false);
  const [into, setInto] = useState<Into>("new");
  const [name, setName] = useState(`${title} of ${execution.metadata.name}`);
  const [dataset, setDataset] = useState<string | null>(null);
  const [path, setPath] = useState(fileOf(title));
  const datasets = useQuery({
    ...searchQuery({ kind: "dataset", ...(project ? { scope: project } : {}) }),
    enabled: open && into === "existing",
  });
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        workflowsSaveResult({
          path: { rid: workflow, eid: execution.metadata.rid, operatorID: port.operatorID, portID: port.portID },
          body: { ...(into === "existing" && dataset ? { dataset } : { name }), path },
        })
      ),
    onSuccess: () => {
      // The new version is listed, drawn on the graphs, and counted on what it derives from.
      for (const key of [
        [{ _id: "resourcesSearch" }],
        ["resource"],
        [{ _id: "resourcesGraph" }],
        [{ _id: "conversationsGraph" }],
      ])
        queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const saved = save.data;
  const savedName =
    into === "existing" ? datasets.data?.items.find(d => d.metadata.uri === dataset)?.metadata.name : name;
  return (
    <PopoverRoot
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) save.reset();
      }}>
      <PopoverTrigger>
        <Button
          variant="ghost"
          size="xs"
          title="Save these rows as a version of a dataset: it outlives the execution"
          data-save-result>
          <Save /> Save as dataset
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3 text-sm">
        <div className="grid gap-3" data-save-result-form>
          {saved ? (
            <div className="grid gap-1" data-result-saved={saved.uri}>
              <span className="flex items-center gap-1.5">
                <Check className="size-4 shrink-0 text-success" /> Saved as a version of a dataset:
              </span>
              <button
                type="button"
                className="text-left font-medium underline"
                onClick={() => {
                  beside({ kind: "dataset", rid: saved.rid, vno: saved.vno });
                  setOpen(false);
                }}>
                {savedName ?? "the dataset"} v{saved.vno}
              </button>
            </div>
          ) : (
            <form
              className="grid gap-3"
              onSubmit={e => {
                e.preventDefault();
                save.mutate();
              }}>
              <Segmented<Into>
                label="Where the rows go"
                value={into}
                onChange={setInto}
                options={[
                  { value: "new", label: "New dataset" },
                  { value: "existing", label: "Add to a dataset" },
                ]}
              />
              {into === "new" ? (
                <Field label="Name" htmlFor="save-result-name">
                  <Input
                    id="save-result-name"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    required
                    data-save-result-name
                  />
                </Field>
              ) : (
                <Field label="Dataset" help="Its next version gets the file beside the files it has.">
                  <Select
                    aria-label="Dataset"
                    value={dataset}
                    onChange={setDataset}
                    options={(datasets.data?.items ?? []).map(d => ({ value: d.metadata.uri, label: d.metadata.name }))}
                    placeholder={datasets.isPending ? "Loading…" : "Choose a dataset"}
                  />
                </Field>
              )}
              <Field label="File" htmlFor="save-result-file">
                <Input
                  id="save-result-file"
                  value={path}
                  onChange={e => setPath(e.target.value)}
                  required
                  data-save-result-file
                />
              </Field>
              {save.error && <ErrorNote error={save.error} prefix="Could not save the result" />}
              <Button
                type="submit"
                size="sm"
                disabled={save.isPending || (into === "existing" && !dataset) || !path.trim()}
                data-save-result-go>
                {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save
              </Button>
            </form>
          )}
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}
