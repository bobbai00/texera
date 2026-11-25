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

import { ResourceListPage } from "@/components/resource/resource-list-page";
import { datasetDeletion } from "../api";
import { CreateDatasetDialog } from "./create-dataset-dialog";

/** The datasets page: the datasets the user owns or that are shared with them, and the button to create one. */
export function DatasetListPage() {
  return (
    <ResourceListPage
      kind="dataset"
      actions={<CreateDatasetDialog />}
      deletion={datasetDeletion}
      emptyDescription="Create a dataset to upload files, keep their versions, and share them."
    />
  );
}
