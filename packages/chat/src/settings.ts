// What the chat box shows of a chat's settings, and what a pick stores. A chat stores its
// choices of how its agent works and nothing else; the catalog resolves what a turn runs with
// (ChatSettings). The box shows the resolved values and writes a choice only when the person
// makes one. Where an execution runs is not among them: that is the run's to say.

import type { ChatSettings, ConversationSpec, Resource } from "@texera/catalog-client/types";
import { KINDS, type KindId } from "@texera/kinds";
import type { SelectOption } from "@texera/ui";

export interface Effective {
  /** The agent's name. */
  agent: string;
  /** The model endpoint's URI. */
  model: string;
  /** The add-on servers a turn mounts, by URI; never the platform's own. */
  addOns: string[];
}

/** What a turn runs with: the chat's choice where it has one, else what the settings resolve to. */
export function effective(settings: ChatSettings | undefined, choices: ConversationSpec): Effective | undefined {
  if (!settings) return undefined;
  return {
    agent: settings.agent.name,
    model: choices.modelEndpoint ?? settings.modelEndpoint.uri,
    addOns: choices.mcpServers ?? settings.mcpServers.filter(s => !s.platform).map(s => s.uri),
  };
}

/** A resource as a pick: its name, and what its kind says about it (the model an endpoint serves). */
export function asOption(resource: Resource): SelectOption<string> {
  const facts = KINDS[resource.kind as KindId].facts?.(resource) ?? [];
  return { value: resource.metadata.uri, label: resource.metadata.name, ...(facts.length > 0 && { hint: facts.join(" · ") }) };
}

export const withModel = (choices: ConversationSpec, modelEndpoint: string): ConversationSpec => ({ ...choices, modelEndpoint });

/** Switches one add-on: from then on the chat's add-ons are its own list. */
export function withAddOn(choices: ConversationSpec, settings: ChatSettings, server: string, on: boolean): ConversationSpec {
  const now = effective(settings, choices)?.addOns ?? [];
  const next = on ? (now.includes(server) ? now : [...now, server]) : now.filter(uri => uri !== server);
  return { ...choices, mcpServers: next };
}
