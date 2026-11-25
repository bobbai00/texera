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

import type { Operator } from "@/lib/workflow/model";
import type { OperatorSchema } from "@/lib/workflow/operator-schema";

/** The name of an operator type, as the backend offers it, or else its id, for a type the backend does not offer. */
export function typeName(operatorType: string, schemas: Map<string, OperatorSchema>): string {
  return schemas.get(operatorType)?.additionalMetadata.userFriendlyName ?? operatorType;
}

/**
 * The name an operator goes by wherever it is shown: the one it was given, or else its type's, as for one whose name
 * was cleared.
 */
export function operatorName(operator: Operator, schemas: Map<string, OperatorSchema>): string {
  return operator.customDisplayName || typeName(operator.operatorType, schemas);
}
