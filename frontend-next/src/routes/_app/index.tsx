import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { NewChat } from "@texera/chat";
import { useSession } from "@/auth/session";

export const Route = createFileRoute("/_app/")({ component: NewChatPage });

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** "/" starts a chat: pick a mode, and the conversation plus its agent are created. */
function NewChatPage() {
  const user = useSession();
  const navigate = useNavigate();
  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="flex min-h-full flex-col items-center justify-center px-4 py-12">
        <NewChat
          greeting={`${greeting()}, ${user?.name.split(/[\s.@]/)[0] || "there"}`}
          onCreated={chat => navigate({ to: "/c/$rid", params: { rid: chat.rid } })}
        />
      </div>
    </div>
  );
}
