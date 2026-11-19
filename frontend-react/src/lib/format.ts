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

const sizeUnits = ["B", "KB", "MB", "GB", "TB"];
const sizeNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const mediumDate = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
const mediumTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const timeOfDay = new Intl.DateTimeFormat("en-US", { timeStyle: "medium" });

/** A size in bytes as people read it, in steps of 1024 like the Angular app: "4.4 KB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
  const unit = bytes < 1 ? 0 : Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizeUnits.length - 1);
  return `${sizeNumber.format(bytes / 1024 ** unit)} ${sizeUnits[unit]}`;
}

/** A time in epoch milliseconds, as the server sends it, as a date in the viewer's time zone: "Nov 15, 2026". */
export function formatDate(epochMs: number): string {
  const time = new Date(epochMs);
  return Number.isNaN(time.getTime()) ? "Unknown date" : mediumDate.format(time);
}

/** A moment, in epoch milliseconds or as an ISO string, as a date and time in the viewer's time zone. */
export function formatTime(moment: number | string): string {
  const time = new Date(moment);
  return Number.isNaN(time.getTime()) ? "Unknown time" : mediumTime.format(time);
}

/** From one moment to another, as briefly as their dates allow: "Nov 18, 2026, 9:58 – 10:42 AM". */
export function formatSpan(fromMs: number, toMs: number): string {
  if (fromMs === toMs) return formatTime(fromMs);
  return mediumTime.formatRange(new Date(fromMs), new Date(toMs));
}

/** The time of day of a moment, to the second: "10:42:13 AM". */
export function formatTimeOfDay(epochMs: number): string {
  return timeOfDay.format(new Date(epochMs));
}

/** How long something took, in the two largest units it has: "850 ms", "12 s", "3 min 4 s", "1 h 2 min". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "Unknown time";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  const [hours, minutes, rest] = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  if (minutes > 0) return rest > 0 ? `${minutes} min ${rest} s` : `${minutes} min`;
  return `${rest} s`;
}
