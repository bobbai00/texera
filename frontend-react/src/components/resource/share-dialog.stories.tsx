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

import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { expect, fn, screen, within } from "storybook/test";
import { Button } from "@/components/ui/button";
import { ownerQuery, type SharedWith, sharedWithQuery } from "./api";
import { ShareDialog } from "./share-dialog";

const iris = { kind: "dataset", id: 12, name: "iris" } as const;

/** Puts the owner and the people the dialog loads in the story's cache, so the story calls no server. */
function withAccess(owner: string, people: SharedWith[]): Decorator {
  return Story => {
    const queryClient = useQueryClient();
    queryClient.setQueryData(ownerQuery(iris).queryKey, owner);
    queryClient.setQueryData(sharedWithQuery(iris).queryKey, people);
    return <Story />;
  };
}

/** The rows of "People with access" as the story shows them, each as its text. */
async function peopleWithAccess() {
  const list = await screen.findByRole("list", { name: "People with access" });
  return within(list)
    .getAllByRole("listitem")
    .map(row => row.textContent);
}

const meta = {
  component: ShareDialog,
  args: {
    resource: iris,
    children: <Button variant="outline">Share</Button>,
    open: true,
    onOpenChange: fn(),
  },
} satisfies Meta<typeof ShareDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const SharedWithTwoPeople: Story = {
  decorators: [
    withAccess("texera", [
      { email: "ada@example.com", name: "ada", access: "view" },
      { email: "grace@example.com", name: "grace", access: "edit" },
    ]),
  ],
  play: async () => {
    await expect(await peopleWithAccess()).toEqual([
      "texera Owner",
      "ada@example.com Can view",
      "grace@example.com Can edit",
    ]);
  },
};

export const SharedWithNoOne: Story = {
  decorators: [withAccess("texera", [])],
  play: async () => {
    await expect(await peopleWithAccess()).toEqual(["texera Owner"]);
  },
};
