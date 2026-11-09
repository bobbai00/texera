import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { NewChat } from "@texera/chat";
import { ProjectDeck, useDestination } from "@texera/kinds";
import { useSession } from "@/auth/session";

export const Route = createFileRoute("/_app/")({ component: NewChatPage });

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/**
 * "/" is the project the person works in: its logo, cards that roll through what it holds, and
 * the box to ask in. The first message creates the conversation. With every project in view there
 * is no one project to show, and the page is the box alone.
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
    <div className="scrollbar-thin h-full overflow-y-auto" data-landing>
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center gap-6 px-6 py-8">
        <ProjectDeck rid={project} />
        <NewChat greeting={hello} onCreated={open} alone />
      </div>
    </div>
  );
}
