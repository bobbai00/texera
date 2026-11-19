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

import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { FileTree } from "./file-tree";

const version = "/dataset/texera/iris/v2 - add notes";

const meta = {
  component: FileTree,
  args: {
    // In the order the server sends them: names from Z to A.
    nodes: [
      {
        type: "directory",
        name: "notes",
        parentDir: version,
        children: [
          { type: "file", name: "methods.pdf", parentDir: `${version}/notes`, size: 1_482_133 },
          { type: "file", name: "README.md", parentDir: `${version}/notes`, size: 812 },
        ],
      },
      { type: "file", name: "iris.csv", parentDir: version, size: 4551 },
      { type: "file", name: "flowers.parquet", parentDir: version, size: 27_394_820 },
    ],
    onDownload: fn(),
  },
  // As wide as the column it sits in on the dataset's page.
  decorators: [
    Story => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FileTree>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
