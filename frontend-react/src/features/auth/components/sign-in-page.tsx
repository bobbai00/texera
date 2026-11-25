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

import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formText } from "@/lib/form";
import { type Registration, register, signIn, signInOptionsQuery, verifyRegistration } from "../api";

/** The shortest password an account is made with. */
const shortestPassword = 6;

/**
 * Signing in, and making an account where the deployment lets people make their own. Where the user goes once
 * signed in is the route's to decide.
 */
export function SignInPage() {
  const { data: options } = useQuery(signInOptionsQuery());

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardContent>
          <h1 className="mb-4 text-xl font-semibold tracking-tight">Sign in to Texera</h1>
          {/* The same tabs whether or not there is a choice, so that the form being typed in stays when the
              deployment's options arrive. */}
          <Tabs defaultValue="sign-in">
            {options?.signUp && (
              <TabsList className="mb-4 w-full">
                <TabsTrigger value="sign-in">Sign in</TabsTrigger>
                <TabsTrigger value="sign-up">Create an account</TabsTrigger>
              </TabsList>
            )}
            <TabsContent value="sign-in">
              <SignInForm />
            </TabsContent>
            {options?.signUp && (
              <TabsContent value="sign-up">
                <SignUpForm emailCode={options.emailCode} />
              </TabsContent>
            )}
          </Tabs>
        </CardContent>
      </Card>
    </main>
  );
}

function SignInForm() {
  const { mutate, error, isPending } = useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) => signIn(username, password),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    mutate({ username: formText(form, "username"), password: formText(form, "password") });
  }

  return (
    <form
      aria-label="Sign in"
      onSubmit={handleSubmit}>
      <FieldGroup>
        <ErrorAlert error={error} />
        <Field>
          <FieldLabel htmlFor="username">Username</FieldLabel>
          <Input
            id="username"
            name="username"
            autoComplete="username"
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        <Button
          type="submit"
          disabled={isPending}>
          Sign in
        </Button>
      </FieldGroup>
    </form>
  );
}

/** Makes an account. Where the deployment emails a code first, the form asks for it once the code is sent. */
function SignUpForm({ emailCode }: { emailCode: boolean }) {
  // What was asked for, once a code was emailed for it.
  const [pending, setPending] = useState<Registration>();
  const [mismatch, setMismatch] = useState(false);
  const ask = useMutation({
    mutationFn: register,
    onSuccess: (session, registration) => {
      if (!session) setPending(registration);
    },
  });
  const verify = useMutation({
    mutationFn: ({ registration, code }: { registration: Registration; code: string }) =>
      verifyRegistration(registration, code),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (pending) return verify.mutate({ registration: pending, code: formText(form, "code").trim() });
    const password = formText(form, "new-password");
    setMismatch(password !== formText(form, "repeated-password"));
    if (password !== formText(form, "repeated-password")) return;
    ask.mutate({ username: formText(form, "new-username").trim(), email: formText(form, "email").trim(), password });
  }

  return (
    <form
      aria-label="Create an account"
      onSubmit={handleSubmit}>
      <FieldGroup>
        <ErrorAlert
          error={verify.error ?? ask.error ?? (mismatch ? "The two passwords are not the same." : undefined)}
        />
        {pending ? (
          <Field>
            <FieldLabel htmlFor="code">Code</FieldLabel>
            <Input
              id="code"
              name="code"
              autoComplete="one-time-code"
              required
            />
            <FieldDescription>We emailed a code to {pending.email}. The account is made with it.</FieldDescription>
          </Field>
        ) : (
          <>
            <Field>
              <FieldLabel htmlFor="new-username">Username</FieldLabel>
              <Input
                id="new-username"
                name="new-username"
                autoComplete="username"
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-password">Password</FieldLabel>
              <Input
                id="new-password"
                name="new-password"
                type="password"
                autoComplete="new-password"
                minLength={shortestPassword}
                required
              />
              <FieldDescription>At least {shortestPassword} characters.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="repeated-password">The password again</FieldLabel>
              <Input
                id="repeated-password"
                name="repeated-password"
                type="password"
                autoComplete="new-password"
                required
              />
            </Field>
          </>
        )}
        <Button
          type="submit"
          disabled={ask.isPending || verify.isPending}>
          {pending || !emailCode ? "Create the account" : "Email me a code"}
        </Button>
        <p className="text-sm text-muted-foreground">An administrator activates a new account before it can be used.</p>
      </FieldGroup>
    </form>
  );
}
