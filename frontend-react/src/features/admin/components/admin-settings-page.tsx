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

import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { Page, PageHeader } from "@/components/layout/page";
import { Section } from "@/components/layout/section";
import { isOn, type Settings, settingsKey } from "@/components/settings/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { allSettingsKey, allSettingsQuery, changeSetting, resetSetting } from "../api";

/** A switch of an area of the navigation, with the switches of what is in it. */
interface AreaSwitch {
  key: string;
  label: string;
  inside?: AreaSwitch[];
}

const areas: AreaSwitch[] = [
  {
    key: "hub_enabled",
    label: "Hub",
    inside: [
      { key: "home_enabled", label: "Home" },
      { key: "workflow_enabled", label: "Public workflows" },
      { key: "dataset_enabled", label: "Public datasets" },
      { key: "model_enabled", label: "Public models" },
    ],
  },
  {
    key: "your_work_enabled",
    label: "Your work",
    inside: [
      { key: "workflows_enabled", label: "Workflows" },
      { key: "datasets_enabled", label: "Datasets" },
      { key: "models_enabled", label: "Models" },
      { key: "compute_enabled", label: "Computing units" },
      { key: "quota_enabled", label: "Quota" },
      { key: "forum_enabled", label: "Forum" },
    ],
  },
  { key: "about_enabled", label: "About" },
];

/** The settings of a form: each a whole number of at least one. */
const limits = [
  {
    title: "Datasets",
    fields: [
      { key: "dataset_single_file_upload_max_size_mib", label: "Largest file (MiB)" },
      { key: "dataset_max_number_of_concurrent_uploading_file", label: "Files uploaded at once" },
      { key: "dataset_multipart_upload_chunk_size_mib", label: "Size of a chunk (MiB)" },
      { key: "dataset_max_number_of_concurrent_uploading_file_chunks", label: "Chunks uploaded at once" },
    ],
  },
  {
    title: "Models",
    fields: [
      { key: "model_single_file_upload_max_size_mib", label: "Largest file (MiB)" },
      { key: "model_max_number_of_concurrent_uploading_file", label: "Files uploaded at once" },
      { key: "model_multipart_upload_chunk_size_mib", label: "Size of a chunk (MiB)" },
      { key: "model_max_number_of_concurrent_uploading_file_chunks", label: "Chunks uploaded at once" },
    ],
  },
  {
    title: "Results",
    fields: [{ key: "csv_parser_max_columns", label: "Most columns a CSV result is read with" }],
  },
];

/** The deployment's settings: which areas everyone sees, and how much an upload and a result may be. */
export function AdminSettingsPage() {
  const queryClient = useQueryClient();
  const { data: settings } = useSuspenseQuery(allSettingsQuery());
  const changed = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: allSettingsKey }),
      queryClient.invalidateQueries({ queryKey: settingsKey }),
    ]);
  const change = useMutation({
    mutationFn: (values: Settings) =>
      Promise.all(Object.entries(values).map(([key, value]) => changeSetting(key, value))),
    onSettled: changed,
  });
  const reset = useMutation({
    mutationFn: (keys: string[]) => Promise.all(keys.map(resetSetting)),
    onSettled: changed,
  });

  return (
    <Page>
      <PageHeader
        title="Settings"
        description="What everyone sees, and how much they may upload. A change takes effect at once."
      />
      <ErrorAlert error={change.error ?? reset.error} />
      <Section title="Navigation">
        <Card>
          <CardContent className="grid gap-6 sm:grid-cols-3">
            {areas.map(area => (
              <AreaSwitches
                key={area.key}
                area={area}
                settings={settings}
                onChange={(key, on) => change.mutate({ [key]: String(on) })}
              />
            ))}
          </CardContent>
        </Card>
      </Section>
      {limits.map(group => (
        <Section
          key={group.title}
          title={group.title}
          actions={
            <Button
              variant="ghost"
              size="sm"
              disabled={reset.isPending}
              onClick={() => reset.mutate(group.fields.map(field => field.key))}>
              Reset to defaults
            </Button>
          }>
          <LimitsForm
            // A reset gives the form the values anew.
            key={group.fields.map(field => settings[field.key]).join()}
            fields={group.fields}
            settings={settings}
            saving={change.isPending}
            onSave={values => change.mutate(values)}
          />
        </Section>
      ))}
    </Page>
  );
}

function AreaSwitches({
  area,
  settings,
  onChange,
}: {
  area: AreaSwitch;
  settings: Settings;
  onChange: (key: string, on: boolean) => void;
}) {
  const on = isOn(settings, area.key);
  const id = `switch-${area.key}`;
  return (
    <fieldset className="space-y-2">
      <Field orientation="horizontal">
        <Checkbox
          id={id}
          checked={on}
          onCheckedChange={checked => onChange(area.key, checked === true)}
        />
        <FieldLabel
          htmlFor={id}
          className="font-medium">
          {area.label}
        </FieldLabel>
      </Field>
      {area.inside?.map(inner => (
        <Field
          key={inner.key}
          orientation="horizontal"
          className="pl-6">
          <Checkbox
            id={`switch-${inner.key}`}
            checked={isOn(settings, inner.key)}
            // What is inside an area that is off is not shown, whatever its own switch says.
            disabled={!on}
            onCheckedChange={checked => onChange(inner.key, checked === true)}
          />
          <FieldLabel htmlFor={`switch-${inner.key}`}>{inner.label}</FieldLabel>
        </Field>
      ))}
    </fieldset>
  );
}

function LimitsForm({
  fields,
  settings,
  saving,
  onSave,
}: {
  fields: { key: string; label: string }[];
  settings: Settings;
  saving: boolean;
  onSave: (values: Settings) => void;
}) {
  const [values, setValues] = useState(() => Object.fromEntries(fields.map(({ key }) => [key, settings[key] ?? ""])));
  const valid = (value: string) => /^[1-9]\d*$/.test(value);
  const changedValues = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== settings[key]));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (Object.values(values).every(valid)) onSave(changedValues);
  }

  return (
    <Card>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={submit}>
          <FieldGroup className="grid gap-4 sm:grid-cols-2">
            {fields.map(({ key, label }) => (
              <Field
                key={key}
                data-invalid={!valid(values[key])}>
                <FieldLabel htmlFor={key}>{label}</FieldLabel>
                <Input
                  id={key}
                  inputMode="numeric"
                  value={values[key]}
                  aria-invalid={!valid(values[key])}
                  onChange={event => setValues({ ...values, [key]: event.target.value })}
                />
              </Field>
            ))}
          </FieldGroup>
          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={saving || Object.keys(changedValues).length === 0 || !Object.values(values).every(valid)}>
              Save
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
