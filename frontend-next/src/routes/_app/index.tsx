import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { NewChat } from "@texera/chat";
import { ProjectOverview, useDestination } from "@texera/kinds";
import { useSession } from "@/auth/session";

export const Route = createFileRoute("/_app/")({ component: NewChatPage });

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/**
 * "/" is the project the person works in, with the chat over it: they see what is there and ask.
 * The first message creates the conversation. With every project in view there is no one project
 * to show, and the page is the box alone.
 */
function NewChatPage() {
  const user = useSession();
  const navigate = useNavigate();
  const { project } = useDestination();
  const hello = `${greeting()}, ${user?.name.split(/[\s.@]/)[0] || "there"}`;
  const open = (rid: string) => navigate({ to: "/conversations/$rid", params: { rid } });
  if (project === undefined) {
    return (
      <div className="scrollbar-thin h-full overflow-y-auto">
        <div className="flex min-h-full flex-col items-center justify-center px-4 py-12">
          <NewChat greeting={hello} onCreated={open} />
        </div>
      </div>
    );
  }
  return (
    <div className="relative h-full" data-landing>
      <div className="scrollbar-thin h-full overflow-y-auto pb-52">
        <ProjectOverview rid={project} />
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-background via-background/70 to-transparent px-4 pt-12 pb-4">
        <div className="pointer-events-auto w-full max-w-2xl">
          <NewChat greeting={hello} onCreated={open} floating />
        </div>
      </div>
    </div>
  );
}
