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

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { Page, PageHeader, PagePending } from "@/components/layout/page";
import { computingUnitDeletion } from "@/components/resource/api";
import { ComputingUnitDetails } from "@/components/resource/computing-unit-details";
import { ResourceList } from "@/components/resource/resource-list";
import { Button } from "@/components/ui/button";
import { adminComputingUnitsQuery } from "../api";

/**
 * Every computing unit of the deployment, whoever owns it. An administrator may end any of them, which is their
 * role's to allow, not their access to the unit, so the button is there for every unit.
 */
export function AdminComputingUnitPage() {
  const queryClient = useQueryClient();
  const query = adminComputingUnitsQuery();
  const { data: units, error } = useQuery(query);
  const terminate = useMutation({
    mutationFn: computingUnitDeletion.run,
    onSettled: () => queryClient.invalidateQueries({ queryKey: query.queryKey }),
  });

  return (
    <Page>
      <PageHeader
        title="Computing units"
        description="Every computing unit of the deployment, whoever owns it. Its owner is told when one is ended."
      />
      <ErrorAlert error={error ?? terminate.error} />
      {!units ? (
        !error && <PagePending />
      ) : units.length === 0 ? (
        <EmptyState title="No computing units" />
      ) : (
        <ResourceList
          label="Computing units"
          resources={units}
          itemDetails={unit => <ComputingUnitDetails unit={unit} />}
          itemActions={unit => (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              aria-label={`End ${unit.name}`}
              disabled={terminate.isPending}
              onClick={() => terminate.mutate(unit.id)}>
              End
            </Button>
          )}
        />
      )}
    </Page>
  );
}
