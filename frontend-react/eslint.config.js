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

import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import { reactRefresh } from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

// What a component may not spell out, as esquery patterns over its strings.
const rawColor = {
  pattern: String.raw`/(oklch|oklab|rgba?|hsla?|lab|lch)\(|#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/i`,
  message: "Use a color token through its Tailwind utility, such as bg-primary, instead of a color value.",
};
const paletteColor = {
  pattern: String.raw`/\b(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/`,
  message: "Use a color token, such as text-muted-foreground, instead of a color of Tailwind's palette.",
};
const rawLength = {
  pattern: String.raw`/\[-?[\d.]+(px|rem|em)\]/`,
  message: "Use Tailwind's spacing scale, such as w-56 or --spacing(72), instead of a length.",
};

function restrictedImports(message, group) {
  return { "no-restricted-imports": ["error", { patterns: [{ group, message }] }] };
}

export default defineConfig([
  // Generated code is kept as its generator writes it: the route tree, and the shadcn/ui components.
  globalIgnores([
    "dist",
    "storybook-static",
    "coverage",
    "test-results",
    "playwright-report",
    "src/routeTree.gen.ts",
    "src/components/ui",
  ]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // A route guard leaves the page by throwing the router's redirect.
      "@typescript-eslint/only-throw-error": [
        "error",
        {
          // The router's redirect and "not found" are thrown, as it asks.
          allow: [
            { from: "package", package: "@tanstack/router-core", name: "Redirect" },
            { from: "package", package: "@tanstack/router-core", name: "NotFoundError" },
          ],
        },
      ],
    },
  },
  {
    // The React code. The end-to-end tests are not: a Playwright fixture's use() is not React's.
    files: ["src/**/*.{ts,tsx}", ".storybook/*.tsx"],
    extends: [
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite({ extraHOCs: ["createFileRoute", "createRootRouteWithContext"] }),
    ],
    languageOptions: { globals: globals.browser },
  },
  {
    // Storybook reloads its preview instead of refreshing it.
    files: [".storybook/**"],
    rules: { "react-refresh/only-export-components": "off" },
  },
  {
    // The app's own code: what is checked by hand everywhere else is checked here by the linter.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}", "src/**/*.stories.tsx", "src/testing/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        // Colors and lengths are tokens (styles/tokens.css) and Tailwind's scale, in a class name or anywhere else.
        ...[rawColor, paletteColor, rawLength].flatMap(({ pattern, message }) => [
          { selector: `Literal[value=${pattern}]`, message },
          { selector: `TemplateElement[value.raw=${pattern}]`, message },
        ]),
        {
          selector: "BinaryExpression[operator=/^[!=]==?$/] > MemberExpression[property.name='access']",
          message: "Ask can(resource, action) from lib/resource.ts instead of comparing an access level.",
        },
      ],
    },
  },
  // Code depends downward only: routes -> features -> components -> lib.
  {
    files: ["src/lib/**"],
    rules: restrictedImports(
      "lib/ holds code without React that everything else may use, so it imports nothing from above it.",
      ["react", "react-dom", "@tanstack/*", "@/app/*", "@/components/*", "@/features/*", "@/routes/*"]
    ),
  },
  {
    files: ["shared-editing-service/**"],
    ignores: ["shared-editing-service/**/*.test.ts"],
    rules: restrictedImports("The service shares with the app only what lib/ holds: code without React or a browser.", [
      "react",
      "react-dom",
      "@tanstack/*",
      "@/app/*",
      "@/components/*",
      "@/features/*",
      "@/routes/*",
      "@/testing/*",
    ]),
  },
  {
    files: ["src/components/**"],
    ignores: ["src/**/*.test.{ts,tsx}", "src/**/*.stories.tsx"],
    rules: restrictedImports(
      "A shared component takes what differs between features through its props, and what is app-wide from lib/.",
      ["@/app/*", "@/features/*", "@/routes/*"]
    ),
  },
  {
    files: ["src/features/**"],
    ignores: ["src/**/*.test.{ts,tsx}", "src/**/*.stories.tsx"],
    rules: restrictedImports(
      "A feature imports its own files by relative path and shares code only through components/ and lib/.",
      ["@/app/*", "@/features/*", "@/routes/*"]
    ),
  },
]);
