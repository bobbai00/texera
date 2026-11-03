import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { resourcesCreateVersion, resourcesReadVersion } from "@texera/catalog-client";
import { Button, ErrorNote, Skeleton, Tab, TabPanel, Tabs, TabsList, Textarea } from "@texera/ui";
import { Check, FileText, History, Loader2 } from "lucide-react";
import { useState } from "react";
import { unwrap } from "../api";
import { KindHeader } from "../shell/KindHeader";
import { metaLine } from "../shell/MetaLine";
import { Versions } from "../shell/Versions";
import type { KindViewProps } from "../types";
import { skillQuery } from "./spec";

/** A skill: its SKILL.md, versioned; saving writes a new version. */
export default function SkillView({ ref, mode }: KindViewProps) {
  const { data, error } = useQuery(skillQuery(ref.rid));
  const [tab, setTab] = useState("content");
  if (error) return <ErrorNote error={error} prefix="Could not open this skill" className="m-4" />;
  if (!data) return <Skeleton className="m-4 h-64" />;
  return (
    <div className="flex h-full min-h-0 flex-col" data-skill-view={ref.rid}>
      <KindHeader ref={{ kind: "skill", rid: ref.rid }} mode={mode} name={data.metadata.name} meta={metaLine(data.metadata)} />
      <Tabs value={tab} onValueChange={v => setTab(String(v))} className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <Tab value="content">
            <FileText /> SKILL.md
          </Tab>
          <Tab value="versions">
            <History /> Versions
          </Tab>
        </TabsList>
        <TabPanel value="content" className="flex min-h-0 flex-1 flex-col">
          {data.metadata.headVersion > 0 ? (
            <SkillEditor key={data.metadata.headVersion} rid={ref.rid} vno={data.metadata.headVersion} />
          ) : (
            <SkillEditor key="new" rid={ref.rid} />
          )}
        </TabPanel>
        <TabPanel value="versions" className="scrollbar-thin overflow-y-auto">
          <Versions rid={ref.rid} head={data.metadata.headVersion} />
        </TabPanel>
      </Tabs>
    </div>
  );
}

function SkillEditor({ rid, vno }: { rid: string; vno?: number }) {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery({
    queryKey: ["skill-content", rid, vno],
    queryFn: async () => (vno ? await unwrap(resourcesReadVersion({ path: { rid, vno } })) : undefined),
  });
  const original = typeof data?.content === "string" ? data.content : "";
  const [text, setText] = useState<string>();
  const current = text ?? original;
  const save = useMutation({
    mutationFn: () => unwrap(resourcesCreateVersion({ path: { rid }, body: { content: current, expectedHead: vno, message: "Edited SKILL.md" } })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [{ _id: "skillsRead", path: { rid } }] });
      queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesListVersions", path: { rid } }] });
    },
  });
  if (isPending) return <Skeleton className="m-4 h-64" />;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <Textarea value={current} onChange={e => setText(e.target.value)} className="min-h-0 flex-1 font-mono text-xs" spellCheck={false} />
      {save.error && <ErrorNote error={save.error} prefix="Could not save" />}
      <div>
        <Button onClick={() => save.mutate()} disabled={current === original || save.isPending} data-save-skill>
          {save.isPending ? <Loader2 className="animate-spin" /> : <Check />} Save as new version
        </Button>
      </div>
    </div>
  );
}
