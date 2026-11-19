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

// A small stand-in for Texera's compiler and engine: it computes what a few operator types put out, from tables
// kept in memory, so that the editor's column pickers, errors and results can be tested without a real engine.
// It knows the types below; any other type passes its first input through. It is not a model of how the engine
// works, only of what the editor is told.

import type { Attribute } from "@/lib/workflow/compilation";
import type { LogicalPlan } from "@/lib/workflow/plan";

/** A table: the content of a file that a scan reads, or what an operator puts out. */
export interface MockTable {
  columns: Attribute[];
  rows: Record<string, unknown>[];
}

/** What a plan computes: each operator's output, or why it has none. */
export interface Evaluation {
  outputs: Record<string, MockTable | undefined>;
  errors: Record<string, string>;
}

type Properties = Record<string, unknown>;

/** The engine's own words for an operator whose settings are not complete. */
const notConfigured = (reason: string) =>
  `java.lang.RuntimeException: Operator is not configured properly: requirement failed: ${reason}`;

const operatorTypes: Record<
  string,
  (properties: Properties, inputs: MockTable[], files: Record<string, MockTable>) => MockTable
> = {
  CSVFileScan({ fileName, limit }, _, files) {
    if (typeof fileName !== "string" || !fileName) throw new Error(notConfigured("no input file name"));
    const table = files[fileName];
    if (!table) throw new Error(`java.io.FileNotFoundException: ${fileName}`);
    return typeof limit === "number" ? { ...table, rows: table.rows.slice(0, limit) } : table;
  },
  Filter({ predicates }, [input]) {
    const tests = (predicates ?? []) as { attribute: string; condition: string; value?: string }[];
    if (tests.length === 0) throw new Error(notConfigured("no predicate"));
    return { ...input, rows: input.rows.filter(row => tests.some(test => passes(row[test.attribute], test))) };
  },
  Limit({ limit }, [input]) {
    if (typeof limit !== "number") throw new Error("scala.MatchError: null");
    return { ...input, rows: input.rows.slice(0, limit) };
  },
  Projection({ attributes, isDrop }, [input]) {
    const chosen = (attributes ?? []) as { originalAttribute: string; alias?: string }[];
    const names = new Set(chosen.map(({ originalAttribute }) => originalAttribute));
    const kept = isDrop
      ? input.columns
          .filter(column => !names.has(column.attributeName))
          .map(column => [column, column.attributeName] as const)
      : chosen.map(({ originalAttribute, alias }) => {
          const column = input.columns.find(candidate => candidate.attributeName === originalAttribute);
          if (!column)
            throw new Error(
              `java.lang.RuntimeException: ${originalAttribute} not in [${input.columns.map(each => each.attributeName).join(", ")}]`
            );
          return [column, alias || originalAttribute] as const;
        });
    return {
      columns: kept.map(([column, name]) => ({ ...column, attributeName: name })),
      rows: input.rows.map(row => Object.fromEntries(kept.map(([column, name]) => [name, row[column.attributeName]]))),
    };
  },
  Sort({ attributes }, [input]) {
    const keys = (attributes ?? []) as { attribute?: string; sortPreference?: string }[];
    if (keys.some(key => !key.attribute))
      throw new Error(notConfigured("Each sort key must have an attribute selected."));
    const rows = input.rows.toSorted((a, b) => {
      for (const { attribute, sortPreference } of keys) {
        const order = compare(a[attribute!], b[attribute!]);
        if (order !== 0) return sortPreference === "DESC" ? -order : order;
      }
      return 0;
    });
    return { ...input, rows };
  },
  Distinct(_, [input]) {
    const seen = new Set<string>();
    return {
      ...input,
      rows: input.rows.filter(row => !seen.has(JSON.stringify(row)) && seen.add(JSON.stringify(row))),
    };
  },
  KeywordSearch({ attribute, keyword, isCaseSensitive }, [input]) {
    const fold = (text: unknown) => (isCaseSensitive ? String(text) : String(text).toLowerCase());
    return { ...input, rows: input.rows.filter(row => fold(row[String(attribute)]).includes(fold(keyword))) };
  },
  Union(_, inputs) {
    return { columns: inputs[0].columns, rows: inputs.flatMap(input => input.rows) };
  },
  BarChart({ fields, value }, [input]) {
    const bars = input.rows
      .map(row => `<li>${String(row[String(fields)])}: ${String(row[String(value)])}</li>`)
      .join("");
    return {
      columns: [{ attributeName: "html-content", attributeType: "string" }],
      rows: [{ "html-content": `<html><body><h1>Bar chart</h1><ul>${bars}</ul></body></html>` }],
    };
  },
};

function passes(cell: unknown, { condition, value }: { condition: string; value?: string }): boolean {
  if (condition === "is null") return cell === null || cell === undefined;
  if (condition === "is not null") return cell !== null && cell !== undefined;
  const order = compare(cell, typeof cell === "number" ? Number(value) : value);
  return (
    { "=": order === 0, "!=": order !== 0, ">": order > 0, ">=": order >= 0, "<": order < 0, "<=": order <= 0 }[
      condition
    ] ?? false
  );
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/** Computes a plan, operator by operator, each after the ones it depends on. */
export function evaluate(plan: LogicalPlan, files: Record<string, MockTable>): Evaluation {
  const evaluation: Evaluation = { outputs: {}, errors: {} };
  const waiting = new Map(plan.operators.map(operator => [operator.operatorID as string, operator]));
  const inputsOf = (operatorId: string) =>
    plan.links
      .filter(link => link.toOpId === operatorId)
      .toSorted((a, b) => a.toPortId.id - b.toPortId.id)
      .map(link => link.fromOpId);

  while (waiting.size > 0) {
    const ready = [...waiting.keys()].filter(id => inputsOf(id).every(input => !waiting.has(input)));
    // A cycle: nothing in it can be computed.
    if (ready.length === 0) break;
    for (const id of ready) {
      const { operatorType, inputPorts, ...properties } = waiting.get(id)!;
      waiting.delete(id);
      const inputs = inputsOf(id).map(input => evaluation.outputs[input]);
      const expected = (inputPorts as unknown[]).length;
      // An operator computes nothing until every input port has a link, and every input is computed.
      if (inputs.length < expected || inputs.some(input => input === undefined)) continue;
      try {
        const run = operatorTypes[operatorType as string] ?? ((_: Properties, [first]: MockTable[]) => first);
        evaluation.outputs[id] = run(properties, inputs as MockTable[], files);
      } catch (error) {
        evaluation.errors[id] = (error as Error).message;
      }
    }
  }
  return evaluation;
}
