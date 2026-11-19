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

import { request } from "@playwright/test";
import { admin, Backend, gateway, reader } from "./backend.ts";

/**
 * Runs once before all tests: checks that the backend answers, registers the person tests share with, and deletes
 * the datasets of a run that stopped early. The function it returns runs after all tests, and deletes their datasets.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  await asAdmin(async backend => {
    await backend.registerUser(reader);
    await backend.activateUser(reader.username);
    await deleteWhatTestsMade(backend);
  });
  return () => asAdmin(deleteWhatTestsMade);
}

async function deleteWhatTestsMade(backend: Backend): Promise<void> {
  await backend.deleteTestDatasets();
  await backend.deleteTestWorkflows();
}

async function asAdmin(task: (backend: Backend) => Promise<void>): Promise<void> {
  const backend = await Backend.signIn(request, admin).catch((error: unknown) => {
    throw new Error(`Cannot sign in to Texera at ${gateway}. Is the test backend running (yarn stack:up)?`, {
      cause: error,
    });
  });
  try {
    await task(backend);
  } finally {
    await backend.dispose();
  }
}
