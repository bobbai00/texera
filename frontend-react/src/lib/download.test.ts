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

import { http, HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it } from "vitest";
import { recordDownloads, type SavedFile } from "@/testing/download";
import { admin } from "@/testing/fixtures";
import { server } from "@/testing/server";
import { signInAs } from "@/testing/session";
import { downloadFile } from "./download";

// A presigned URL as LakeFS gives it: on the storage server, with the grant in its query.
const storageUrl = "http://127.0.0.1:19000/texera-dataset/iris/data.csv";
const presignedUrl = `${storageUrl}?X-Amz-Signature=abc123`;

describe("downloadFile", () => {
  let saved: SavedFile[];

  beforeEach(() => {
    saved = recordDownloads();
  });

  it("saves the file under its name", async () => {
    server.use(http.get(storageUrl, () => HttpResponse.text("sepal_length,species\n5.1,setosa\n")));

    await downloadFile(presignedUrl, "data.csv");

    expect(saved.map(file => file.fileName)).toEqual(["data.csv"]);
    expect(await saved[0].blob.text()).toBe("sepal_length,species\n5.1,setosa\n");
  });

  it("sends no Texera token to the storage server", async () => {
    signInAs(admin);
    let authorization: string | null = "not called";
    server.use(
      http.get(storageUrl, ({ request }) => {
        authorization = request.headers.get("Authorization");
        return HttpResponse.text("5.1");
      })
    );

    await downloadFile(presignedUrl, "data.csv");

    expect(authorization).toBeNull();
  });

  it("fails with a message when the storage server refuses", async () => {
    server.use(
      http.get(storageUrl, () => HttpResponse.xml("<Error><Code>AccessDenied</Code></Error>", { status: 403 }))
    );

    await expect(downloadFile(presignedUrl, "data.csv")).rejects.toThrow("Could not download data.csv.");
    expect(saved).toEqual([]);
  });

  it("fails with a message when the storage server cannot be reached", async () => {
    server.use(http.get(storageUrl, () => HttpResponse.error()));

    await expect(downloadFile(presignedUrl, "data.csv")).rejects.toThrow("Could not download data.csv.");
    expect(saved).toEqual([]);
  });
});
