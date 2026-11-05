import type { ChatSettings, ConversationSpec, Resource } from "@texera/catalog-client/types";
import { describe, expect, it } from "vitest";
import { AUTOMATIC, asOption, effective, withAddOn, withModel, withUnit } from "./settings";

const uri = (kind: string, n: number) => `texera://${kind}/0b7a1c2d-0000-4000-8000-00000000000${n}`;
const CATALOG = uri("mcp-servers", 1);
const BIO = uri("mcp-servers", 2);
const LAB = uri("mcp-servers", 3);
const HAIKU = uri("model-endpoints", 4);
const OTHER = uri("model-endpoints", 5);
const UNIT = uri("computing-units", 6);
const MINE = uri("computing-units", 7);

/** What the catalog resolves for a chat with no choices of its own. */
const defaults: ChatSettings = {
  project: { rid: "p", name: "lab" },
  agent: { uri: `${uri("agent-templates", 8)}@1`, name: "Texera Agent", from: "platform" },
  modelEndpoint: { uri: HAIKU, name: "anthropic-platform", from: "agent" },
  computingUnit: { uri: UNIT, name: "local unit", from: "platform" },
  mcpServers: [
    { uri: CATALOG, name: "catalog", from: "agent", platform: true },
    { uri: BIO, name: "biomcp", from: "agent", platform: false },
  ],
};

describe("what the chat box shows", () => {
  it("is what the settings resolve to when the chat has chosen nothing", () => {
    expect(effective(defaults, {})).toEqual({ agent: "Texera Agent", model: HAIKU, unit: AUTOMATIC, automaticUnit: "local unit", addOns: [BIO] });
  });

  it("is the chat's own choice where it has one", () => {
    const chosen: ConversationSpec = { modelEndpoint: OTHER, computingUnit: MINE, mcpServers: [LAB] };
    expect(effective(defaults, chosen)).toEqual({ agent: "Texera Agent", model: OTHER, unit: MINE, automaticUnit: "local unit", addOns: [LAB] });
  });

  it("names no automatic unit when nothing falls back to one, or when the unit shown is the chat's own", () => {
    const { computingUnit: _, ...none } = defaults;
    expect(effective(none, {}).automaticUnit).toBeUndefined();
    const resolved: ChatSettings = { ...defaults, computingUnit: { uri: MINE, name: "mine", from: "chat" } };
    expect(effective(resolved, { computingUnit: MINE })).toMatchObject({ unit: MINE, automaticUnit: undefined });
  });

  it("is empty until the settings are known", () => {
    expect(effective(undefined, {})).toBeUndefined();
  });
});

describe("what a picker offers", () => {
  const resource = (kind: string, uri: string, name: string, spec: unknown, status?: unknown) => ({ kind, metadata: { uri, name }, spec, status }) as unknown as Resource;

  it("is a resource by name, with what its kind says about it: the model an endpoint serves, a unit's state", () => {
    const endpoint = resource("model-endpoint", HAIKU, "anthropic-platform", { provider: "anthropic", model: "claude-haiku-5-5" });
    expect(asOption(endpoint)).toEqual({ value: HAIKU, label: "anthropic-platform", hint: "anthropic · claude-haiku-5-5" });
    const unit = resource("computing-unit", MINE, "mine", { provider: "kubernetes" }, { phase: "pending" });
    expect(asOption(unit)).toEqual({ value: MINE, label: "mine", hint: "kubernetes · pending" });
  });

  it("is the name alone when the kind has nothing to add", () => {
    expect(asOption(resource("project", uri("projects", 9), "lab", {}))).toEqual({ value: uri("projects", 9), label: "lab" });
  });
});

describe("what a pick stores in the chat", () => {
  it("keeps the other choices", () => {
    const spec: ConversationSpec = { computingUnit: MINE };
    expect(withModel(spec, OTHER)).toEqual({ computingUnit: MINE, modelEndpoint: OTHER });
    expect(withUnit({ modelEndpoint: OTHER }, MINE)).toEqual({ modelEndpoint: OTHER, computingUnit: MINE });
  });

  it("stores no unit for automatic: the chat is not bound to one", () => {
    expect(withUnit({ modelEndpoint: OTHER, computingUnit: MINE }, AUTOMATIC)).toEqual({ modelEndpoint: OTHER });
  });

  it("makes the add-ons the chat's own list from the first switch, on or off", () => {
    expect(withAddOn({}, defaults, LAB, true)).toEqual({ mcpServers: [BIO, LAB] });
    expect(withAddOn({}, defaults, BIO, false)).toEqual({ mcpServers: [] });
    expect(withAddOn({ mcpServers: [LAB] }, defaults, BIO, true)).toEqual({ mcpServers: [LAB, BIO] });
    // Switching on what is already on, or off what is already off, changes nothing.
    expect(withAddOn({ mcpServers: [LAB] }, defaults, LAB, true)).toEqual({ mcpServers: [LAB] });
    expect(withAddOn({ mcpServers: [LAB] }, defaults, BIO, false)).toEqual({ mcpServers: [LAB] });
  });

  it("never lists the platform's own server as an add-on", () => {
    expect(withAddOn({}, defaults, LAB, true).mcpServers).not.toContain(CATALOG);
  });
});
