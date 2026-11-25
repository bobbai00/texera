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

import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/session";

/** What an account that is not active yet sees, and its way out. */
export function InactivePage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-xl font-semibold">Your account is not active yet</h1>
        <p className="text-muted-foreground">
          An administrator must activate your account before you can use Texera. Once they have, sign out and sign in
          again.
        </p>
        <Button
          variant="outline"
          onClick={signOut}>
          Sign out
        </Button>
      </div>
    </main>
  );
}
