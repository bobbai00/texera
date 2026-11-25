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

import { useStoredState } from "@/components/use-stored-state";

/**
 * Whether the cards of every canvas have their chips around them, the datasets and models each reads and the results
 * it kept, as this viewer chose: shown, unless they hid them. Their browser keeps it; it is no part of a workflow.
 */
export function useChipsShown() {
  return useStoredState<boolean>("texera.workflowCanvas.chips", kept => kept !== false);
}
