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
import { expect } from "storybook/test";
import { Button } from "@/components/ui/button";
import type { Resource } from "@/lib/resource";
import { ResourceList } from "./resource-list";

const day = 24 * 60 * 60 * 1000;
const nov12 = Date.UTC(2026, 10, 12, 12);

const resources: Resource[] = [
  {
    kind: "dataset",
    id: 12,
    name: "iris-species",
    description: "Measurements of 150 iris flowers from three species, from the UCI Machine Learning Repository.",
    owner: "ada@example.com",
    isPublic: true,
    createdAt: nov12,
    access: "owner",
  },
  {
    kind: "workflow",
    id: 7,
    name: "Iris species classification",
    description: "Trains and evaluates a decision tree on the iris dataset.",
    owner: "Ada Lovelace",
    createdAt: nov12 - day,
    access: "edit",
  },
  {
    kind: "model",
    id: 3,
    name: "iris-decision-tree-with-a-name-that-is-too-long-to-fit-in-a-narrow-place",
    description: "",
    owner: "grace@example.com",
    isPublic: false,
    createdAt: nov12 - 2 * day,
    access: "view",
  },
];

const meta = {
  component: ResourceList,
  args: { label: "Resources", resources },
} satisfies Meta<typeof ResourceList>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Resources of several kinds in one list, as a search across kinds finds them. */
export const MixedKinds: Story = {};

export const WithActions: Story = {
  args: { itemActions: () => <Button variant="outline">Open</Button> },
};

/** The same resources as cards, which stand two or three to a row where there is room. */
export const AsCards: Story = {
  args: { view: "cards" },
};

/**
 * The same list where there is little room, such as a message of the agent's chat or a side panel. It fits the
 * place it is in, not the screen: the owner and the date go under the name, and nothing is cut off or scrolls.
 */
export const InANarrowPlace: Story = {
  decorators: [
    Story => (
      <div className="w-80 rounded-xl bg-muted p-3">
        <p className="mb-2 text-sm">I found three resources about iris:</p>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas }) => {
    const list = canvas.getByRole("list", { name: "Resources" });
    await expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
    for (const row of canvas.getAllByRole("listitem")) {
      await expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    }
  },
};
