import { useQuery } from "@tanstack/react-query";
import { Button, Skeleton, Tooltip } from "@texera/ui";
import { type Compilation, deleteOperators, operatorImage, updateOperator } from "@texera/workflow-model";
import { AlertTriangle, Eye, EyeOff, Table2, Trash2, X } from "lucide-react";
import { useStore } from "zustand";
import { operatorSchemasQuery } from "../queries";
import { useScope } from "../scope";
import type { EditorStore } from "./editor";
import { PropertyForm } from "./PropertyForm";

/** The selected operator: its name, whether it runs and keeps its result, and its settings. */
export function PropertyPanel({ store, compilation }: { store: EditorStore; compilation?: Compilation }) {
  const selected = useStore(store, s => s.selected);
  const operator = useStore(store, s => s.spec.operators.find(o => o.operatorID === selected));
  const readonly = useStore(store, s => s.readonly);
  const { data: schemas } = useQuery(operatorSchemasQuery(useScope()));
  if (!operator) return null;
  const schema = schemas?.get(operator.operatorType);
  const { edit, select } = store.getState();
  const id = operator.operatorID;
  const error = compilation?.errors[id];

  return (
    <div className="flex h-full flex-col" data-property-panel={operator.operatorType}>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <img src={operatorImage(operator.operatorType)} alt="" className="size-7 rounded-md bg-white object-contain p-0.5" />
        <div className="min-w-0 flex-1">
          <input
            aria-label="Operator name"
            value={operator.customDisplayName ?? ""}
            placeholder={schema?.userFriendlyName}
            disabled={readonly}
            onChange={e => edit(s => updateOperator(s, id, o => ({ ...o, customDisplayName: e.target.value })))}
            className="block w-full truncate rounded bg-transparent text-sm font-semibold outline-none focus:bg-accent/50"
          />
          <div className="truncate text-2xs text-muted-foreground">{schema?.userFriendlyName ?? operator.operatorType}</div>
        </div>
        {!readonly && (
          <>
            <Tooltip content={operator.viewResult ? "Result kept: readable after the execution" : "Keep this operator's result after the execution"}>
              <Button
                variant={operator.viewResult ? "secondary" : "ghost"}
                size="icon-sm"
                aria-label={operator.viewResult ? "Stop keeping the result" : "Keep the result"}
                onClick={() => edit(s => updateOperator(s, id, o => ({ ...o, viewResult: !o.viewResult })))}>
                <Table2 />
              </Button>
            </Tooltip>
            <Tooltip content={operator.isDisabled ? "Enable: include it in executions" : "Disable: leave it out of executions"}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={operator.isDisabled ? "Enable operator" : "Disable operator"}
                onClick={() => edit(s => updateOperator(s, id, o => ({ ...o, isDisabled: !o.isDisabled })))}>
                {operator.isDisabled ? <EyeOff /> : <Eye />}
              </Button>
            </Tooltip>
            <Tooltip content="Delete operator">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete operator"
                onClick={() => {
                  edit(s => deleteOperators(s, [id]));
                  select(null);
                }}>
                <Trash2 />
              </Button>
            </Tooltip>
          </>
        )}
        <Button variant="ghost" size="icon-sm" onClick={() => select(null)} aria-label="Close properties">
          <X />
        </Button>
      </div>
      {error && (
        <p className="flex items-start gap-2 border-b bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{error}</span>
        </p>
      )}
      <form className="scrollbar-thin flex-1 overflow-y-auto p-3" onSubmit={e => e.preventDefault()}>
        {schema ? (
          <PropertyForm
            schema={schema.jsonSchema}
            values={operator.operatorProperties}
            inputs={compilation?.inputs[id] ?? []}
            disabled={readonly}
            onChange={values => edit(s => updateOperator(s, id, o => ({ ...o, operatorProperties: values })))}
          />
        ) : (
          <Skeleton className="h-40" />
        )}
      </form>
    </div>
  );
}
