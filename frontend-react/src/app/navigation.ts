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

import {
  GaugeIcon,
  ImagesIcon,
  MailIcon,
  PackageIcon,
  PlayIcon,
  ServerIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import { linkOptions } from "@tanstack/react-router";
import type { NavigationGroup } from "@/components/layout/sidebar";
import { resourceKinds } from "@/components/resource/kinds";
import { isOn, type Settings } from "@/components/settings/api";
import type { Session } from "@/lib/session";

/**
 * The main navigation for a user, as the Angular app's sidebar has it: their work, and for an administrator the
 * administration pages. An area the administrator switched off in the settings is not in it. The pages that have
 * not moved to React yet are named by their path in the Angular app (app-routing.constant.ts).
 */
export function navigationFor(session: Pick<Session, "role"> | null, settings: Settings): NavigationGroup[] {
  const kinds = resourceKinds;
  const yourWork: NavigationGroup = {
    label: "Your work",
    items: [
      {
        label: kinds.workflow.plural,
        icon: kinds.workflow.icon,
        page: kinds.workflow.listPage,
        switch: "workflows_enabled",
      },
      {
        label: kinds.dataset.plural,
        icon: kinds.dataset.icon,
        page: kinds.dataset.listPage,
        switch: "datasets_enabled",
      },
      { label: kinds.model.plural, icon: kinds.model.icon, page: kinds.model.listPage, switch: "models_enabled" },
      {
        label: kinds["computing-unit"].plural,
        icon: kinds["computing-unit"].icon,
        page: kinds["computing-unit"].listPage,
        switch: "compute_enabled",
      },
      { label: "Environments", icon: PackageIcon, page: linkOptions({ to: "/environments" }) },
      { label: "Quota", icon: GaugeIcon, page: linkOptions({ to: "/quota" }), switch: "quota_enabled" },
    ]
      .filter(item => item.switch === undefined || isOn(settings, item.switch))
      .map(({ label, icon, page }) => ({ label, icon, page })),
  };
  const admin: NavigationGroup = {
    label: "Admin",
    items: [
      { label: "Users", icon: UsersIcon, page: linkOptions({ to: "/admin/users" }) },
      { label: "Executions", icon: PlayIcon, page: linkOptions({ to: "/admin/executions" }) },
      { label: "Computing units", icon: ServerIcon, page: linkOptions({ to: "/admin/computing-units" }) },
      { label: "Gmail", icon: MailIcon, page: { angularPath: "/admin/gmail" } },
      { label: "Settings", icon: SettingsIcon, page: linkOptions({ to: "/admin/settings" }) },
      { label: "CU images", icon: ImagesIcon, page: { angularPath: "/admin/cu-image" } },
    ],
  };
  const hub: NavigationGroup = {
    label: "Hub",
    items: [
      { label: "Public workflows", kind: "workflow" as const, switch: "workflow_enabled" },
      { label: "Public datasets", kind: "dataset" as const, switch: "dataset_enabled" },
      { label: "Public models", kind: "model" as const, switch: "model_enabled" },
    ]
      .filter(item => isOn(settings, item.switch))
      .map(({ label, kind }) => ({
        label,
        icon: kinds[kind].icon,
        page: linkOptions({ to: "/hub", search: { kind } }),
      })),
  };
  const groups = [
    // Someone who is not signed in has only the hub; anyone else has their own work first.
    ...(session && isOn(settings, "your_work_enabled") ? [yourWork] : []),
    ...(isOn(settings, "hub_enabled") ? [hub] : []),
  ];
  return session?.role === "ADMIN" ? [...groups, admin] : groups;
}
