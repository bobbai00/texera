import { useQuery } from "@tanstack/react-query";
import type { ModelSpec } from "@texera/catalog-client/types";
import { Box, FileText, Info, Upload } from "lucide-react";
import { lazy } from "react";
import { AboutModel } from "../files/AboutModel";
import { filesQuery } from "../files/api";
import { FilesTab, UploadTab } from "../files/FilesTabs";
import { SignatureLines } from "../files/ModelSignature";
import { CardShell, useCardSummary } from "../shell/CardShell";
import type { KindCardProps, KindSpec } from "../types";

/** A model inside a chat message or a list: what it is for, and what it reads and adds at the version in question. */
function ModelCard({ ref, resource }: KindCardProps) {
  const { resource: r, summary } = useCardSummary(ref, resource);
  const vno = ref.vno ?? r?.metadata.head;
  const { data } = useQuery({ ...filesQuery("model", ref.rid, vno ?? 0), enabled: !!vno });
  return (
    <CardShell ref={r ? { ...ref, parent: r.metadata.parent } : ref} summary={summary}>
      {r?.metadata.description && <p className="px-3 pt-2 text-sm text-muted-foreground">{r.metadata.description}</p>}
      {data?.contract && <SignatureLines contract={data.contract} />}
      {r?.metadata.description && !data?.contract && <div className="pb-2" />}
    </CardShell>
  );
}

export const modelKind: KindSpec = {
  kind: "model",
  label: "Model",
  plural: "Models",
  icon: Box,
  accent: "bg-kind-model/12 text-kind-model",
  Card: lazy(() => Promise.resolve({ default: ModelCard })),
  tabs: [
    { value: "about", label: "About", icon: Info, Component: AboutModel },
    { value: "files", label: "Files", icon: FileText, Component: FilesTab },
    { value: "upload", label: "Upload", icon: Upload, Component: UploadTab },
  ],
  // The port that produced a version is recorded by the platform.
  hidden: ["producedBy"],
  defaultSpec: () => ({}) satisfies ModelSpec,
  facts: r => {
    const spec = r.spec as Partial<ModelSpec>;
    return [spec.framework ?? "", spec.task ?? "", r.metadata.head > 0 ? `v${r.metadata.head}` : "no version yet"].filter(Boolean);
  },
};
