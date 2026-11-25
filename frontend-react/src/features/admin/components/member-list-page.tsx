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
import { SearchIcon } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import type { Role } from "@/lib/session";
import { memberListQuery, membersKey, updateMember } from "../api";

export interface MemberListPageProps {
  /** The administrator who is looking: they may not take their own role away. */
  userId: number;
}

const roleNames: Record<Role, string> = {
  INACTIVE: "Waiting for access",
  RESTRICTED: "Restricted",
  REGULAR: "Regular",
  ADMIN: "Administrator",
};

/** The people with an account: who they are, their role, which an administrator changes here, and who waits. */
export function MemberListPage({ userId }: MemberListPageProps) {
  const queryClient = useQueryClient();
  const { data: members } = useSuspenseQuery(memberListQuery());
  const [search, setSearch] = useState("");
  const [onlyWaiting, setOnlyWaiting] = useState(false);
  const update = useMutation({
    mutationFn: updateMember,
    onSettled: () => queryClient.invalidateQueries({ queryKey: membersKey }),
  });
  const waiting = members.filter(member => member.role === "INACTIVE").length;
  const words = search.trim().toLowerCase();
  const shown = members.filter(
    member =>
      (!onlyWaiting || member.role === "INACTIVE") &&
      (!words || `${member.name} ${member.email}`.toLowerCase().includes(words))
  );

  return (
    <Page>
      <PageHeader
        title="Users"
        description="Everyone with an account, and the role that says what they may do."
      />
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-60 flex-1">
          <SearchIcon
            aria-hidden
            className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label="Search by name or email"
            placeholder="Search by name or email"
            className="pl-8"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
        </div>
        <Button
          variant={onlyWaiting ? "secondary" : "outline"}
          aria-pressed={onlyWaiting}
          onClick={() => setOnlyWaiting(!onlyWaiting)}>
          Waiting for access ({waiting})
        </Button>
      </div>
      <ErrorAlert error={update.error} />
      {shown.length === 0 ? (
        <EmptyState title="Nobody matches" />
      ) : (
        <Card className="py-0">
          <Table aria-label="Users">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead>Last signed in</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map(member => (
                <TableRow key={member.id}>
                  <TableCell className="max-w-80">
                    <p className="truncate font-medium">{member.name}</p>
                    <p className="truncate text-muted-foreground">{member.email}</p>
                    {member.role === "INACTIVE" && (member.affiliation || member.joiningReason) && (
                      <p className="text-sm whitespace-normal text-muted-foreground">
                        {[member.affiliation, member.joiningReason].filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={member.role}
                      // An administrator who took their own role away could not give it back.
                      disabled={member.id === userId}
                      onValueChange={role => update.mutate({ ...member, role: role as Role })}>
                      <SelectTrigger
                        aria-label={`Role of ${member.name}`}
                        className="w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent position="popper">
                        {Object.entries(roleNames).map(([role, name]) => (
                          <SelectItem
                            key={role}
                            value={role}>
                            {name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>{formatDate(member.joinedAt)}</TableCell>
                  <TableCell>{member.lastSignIn === null ? "Never" : formatDate(member.lastSignIn)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </Page>
  );
}
