import type { ModelSpec } from "@texera/catalog-client/types";
import { Box, FileText, Info, Upload } from "lucide-react";
import { FilesTab, UploadTab } from "../files/FilesTabs";
import { AboutModel } from "../files/AboutModel";
import type { KindSpec } from "../types";

export const modelKind: KindSpec = {
  kind: "model",
  label: "Model",
  plural: "Models",
  icon: Box,
  accent: "bg-kind-model/12 text-kind-model",
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
