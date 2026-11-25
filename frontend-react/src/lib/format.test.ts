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

import { describe, expect, it } from "vitest";
import { formatBytes, formatDate, formatDuration, formatSpan, formatTime, formatTimeOfDay } from "./format";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1, "1 B"],
    [1023, "1,023 B"],
    [1024, "1 KB"],
    [4551, "4.4 KB"],
    [1.5 * 1024 ** 2, "1.5 MB"],
    [3 * 1024 ** 3, "3 GB"],
    [2 * 1024 ** 5, "2,048 TB"],
  ])("shows %d bytes as %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("shows %d bytes as an unknown size", bytes => {
    expect(formatBytes(bytes)).toBe("Unknown size");
  });
});

describe("formatDate", () => {
  it("shows a time as its month, day, and year", () => {
    expect(formatDate(Date.UTC(2026, 10, 15, 12))).toBe("Nov 15, 2026");
  });

  it("shows an invalid time as an unknown date", () => {
    expect(formatDate(Number.NaN)).toBe("Unknown date");
  });
});

describe("formatTime", () => {
  it.each([
    [Date.UTC(2026, 10, 18, 15, 5), "Nov 18, 2026, 3:05 PM"],
    ["2026-11-18T09:30:00.000Z", "Nov 18, 2026, 9:30 AM"],
  ])("shows %s as its date and time", (moment, text) => {
    // Intl puts a narrow space before AM and PM.
    expect(formatTime(moment).replace(/\u202f/g, " ")).toBe(text);
  });

  it.each([Number.NaN, "yesterday"])("shows %s as an unknown time", moment => {
    expect(formatTime(moment)).toBe("Unknown time");
  });
});

describe("formatSpan", () => {
  const narrow = (text: string) => text.replace(/[\u202f\u2009]/g, " ");

  it("says a day once for a span within it, and a moment as itself", () => {
    expect(narrow(formatSpan(Date.UTC(2026, 10, 18, 9, 58), Date.UTC(2026, 10, 18, 10, 42)))).toBe(
      "Nov 18, 2026, 9:58 – 10:42 AM"
    );
    expect(narrow(formatSpan(Date.UTC(2026, 10, 18, 9, 58), Date.UTC(2026, 10, 18, 9, 58)))).toBe(
      "Nov 18, 2026, 9:58 AM"
    );
  });
});

describe("formatTimeOfDay", () => {
  it("shows the time of day to the second", () => {
    expect(formatTimeOfDay(Date.UTC(2026, 10, 18, 10, 42, 13)).replace(/\u202f/g, " ")).toBe("10:42:13 AM");
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0 ms"],
    [850, "850 ms"],
    [12_400, "12 s"],
    [184_000, "3 min 4 s"],
    [180_000, "3 min"],
    [3_720_000, "1 h 2 min"],
    [7_200_000, "2 h"],
  ])("shows %d milliseconds as %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it.each([-1, Number.NaN])("shows %d milliseconds as an unknown time", ms => {
    expect(formatDuration(ms)).toBe("Unknown time");
  });
});
