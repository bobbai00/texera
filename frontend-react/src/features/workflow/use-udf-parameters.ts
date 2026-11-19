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

import { useEffect, useState } from "react";
import type { Transaction, YTextEvent } from "yjs";
import { sameValue } from "@/lib/workflow/diff";
import type { WorkflowDocument } from "@/lib/workflow/document";
import { declaredParameters, type UdfParameter, udfParametersProperty } from "@/lib/workflow/udf-parameters";

/** How long after the last keystroke the code is read again for its parameters. */
const readDelayMs = 200;

/**
 * Keeps the parameters that a UDF's code declares in step with the code, as this user types it: a moment after
 * their last keystroke the code is read, and its parameters, with the values they had, are kept if they changed.
 * What someone else types is theirs to keep in step, so only this user's own typing counts here. Gives back why
 * the code's parameters cannot be read, while they cannot.
 */
export function useUdfParameters(
  document: WorkflowDocument,
  /** The operator, if it is one whose code declares parameters and the user may change it. */
  operatorId: string | undefined
): string | undefined {
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    const code = operatorId === undefined ? undefined : document.code(operatorId);
    if (operatorId === undefined || !code) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const operator = document.content().operators.find(each => each.operatorID === operatorId);
      const current = (operator?.operatorProperties[udfParametersProperty] ?? []) as UdfParameter[];
      const declared = declaredParameters(code.toJSON(), current);
      if ("problem" in declared) return setProblem(declared.problem);
      setProblem(undefined);
      if (!sameValue(declared.parameters, current)) {
        document.setOperatorProperty(operatorId, udfParametersProperty, declared.parameters);
      }
    };
    const typed = (_: YTextEvent, transaction: Transaction) => {
      if (!transaction.local) return;
      clearTimeout(timer);
      timer = setTimeout(read, readDelayMs);
    };
    code.observe(typed);
    // Code that was changed where nothing kept its parameters in step is read once, when it is opened.
    read();
    return () => {
      code.unobserve(typed);
      clearTimeout(timer);
      setProblem(undefined);
    };
  }, [document, operatorId]);

  return problem;
}
