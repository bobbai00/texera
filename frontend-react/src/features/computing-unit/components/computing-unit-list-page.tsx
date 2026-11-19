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

import { computingUnitDeletion } from "@/components/resource/api";
import { ComputingUnitDetails } from "@/components/resource/computing-unit-details";
import { ResourceListPage } from "@/components/resource/resource-list-page";
import { CreateUnitDialog } from "./create-unit-dialog";

/** The computing units page: the user's units and those shared with them, where each stands, and a new one. */
export function ComputingUnitListPage() {
  return (
    <ResourceListPage
      kind="computing-unit"
      actions={<CreateUnitDialog />}
      deletion={computingUnitDeletion}
      emptyDescription="A workflow is executed on a computing unit: make one to execute yours."
      itemDetails={unit => <ComputingUnitDetails unit={unit} />}
    />
  );
}
