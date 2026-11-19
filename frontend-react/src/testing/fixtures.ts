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

import type { Role } from "@/lib/session";

/** An account of the fake backend. As on the real one, the login name is also the display name. */
export interface TestUser {
  uid: number;
  name: string;
  email: string;
  password: string;
  role: Role;
  /** What an administrator noted about them. */
  comment?: string;
  /** Where they work and why they asked for access, as they said when they signed up. */
  affiliation?: string;
  joiningReason?: string;
}

/** The admin every Texera install creates (user-system.conf): texera / texera, whose email is "texera" too. */
export const admin: TestUser = { uid: 1, name: "texera", email: "texera", password: "texera", role: "ADMIN" };

/** A regular user. */
export const reader: TestUser = {
  uid: 2,
  name: "reader",
  email: "reader@example.com",
  password: "reader-password",
  role: "REGULAR",
};

/** A new account that an administrator has not activated yet. */
export const newcomer: TestUser = {
  uid: 3,
  name: "newcomer",
  email: "newcomer@example.com",
  password: "newcomer-password",
  role: "INACTIVE",
  affiliation: "UC Irvine",
  joiningReason: "To clean up survey data",
};

/** Every account the fake backend starts with. */
export const users: TestUser[] = [admin, reader, newcomer];
