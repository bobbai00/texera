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

import type { Awareness } from "y-protocols/awareness";
import type { Text } from "yjs";
import type { CodeLanguage } from "@/lib/workflow/code";
import type { Operator } from "@/lib/workflow/model";
import { useLanguageHelp } from "../language-help";
import { CodeEditor } from "./code-editor";

export interface CodePanelProps {
  operator: Operator;
  /** The operator's code, as text shared with whoever else has it open. */
  text: Text;
  language: CodeLanguage;
  /** Where each person's cursor is in the code they have open. */
  awareness?: Awareness;
  readOnly?: boolean;
}

/**
 * The code of the operator that is selected, to read or to write, together with whoever else has it open, and with
 * the help of the language's server. It is loaded on its own, when someone first opens an operator's code.
 */
export function CodePanel({ operator, text, language, awareness, readOnly }: CodePanelProps) {
  const help = useLanguageHelp(language, operator.operatorID);
  return (
    <CodeEditor
      label={`Code of ${operator.customDisplayName ?? operator.operatorID}`}
      text={text}
      language={language}
      awareness={awareness}
      readOnly={readOnly}
      extensions={help}
    />
  );
}
