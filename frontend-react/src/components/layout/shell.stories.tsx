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
import { DatabaseIcon, WorkflowIcon } from "lucide-react";
import { expect } from "storybook/test";
import { Shell } from "./shell";

const meta = {
  component: Shell,
  args: {
    user: { name: "Ada Lovelace", email: "ada@example.com" },
    navigation: [
      {
        label: "Your work",
        items: [
          { label: "Workflows", icon: WorkflowIcon, page: { angularPath: "/user/workflow" } },
          { label: "Datasets", icon: DatabaseIcon, page: { to: "/datasets" } },
        ],
      },
    ],
    children: <p>The page goes here.</p>,
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Shell>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** On a phone the navigation sits above the page, which keeps the whole width of the screen. */
export const OnAPhone: Story = {
  globals: { viewport: { value: "mobile2" } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("main").offsetWidth).toBe(document.documentElement.clientWidth);
  },
};
