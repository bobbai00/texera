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

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown formatted as it is meant to be read, with GitHub's tables, task lists and struck-out text, in the app's
 * colors (`.prose` in globals.css). HTML written in the text is shown as text, never run. A link opens in a new tab.
 */
export function MarkdownView({ label, text }: { label: string; text: string }) {
  return (
    <article
      aria-label={label}
      className="prose max-w-none px-6 py-5">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer">
              {children}
            </a>
          ),
        }}>
        {text}
      </Markdown>
    </article>
  );
}
