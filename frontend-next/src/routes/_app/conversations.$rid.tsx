import { createFileRoute } from "@tanstack/react-router";
import { ChatView } from "@texera/chat";
import { resourceQuery } from "@texera/kinds";
import { getAccessToken } from "@/auth/session";

/** A conversation's page is the chat itself. */
export const Route = createFileRoute("/_app/conversations/$rid")({
  loader: ({ context: { queryClient }, params }) => {
    void queryClient.prefetchQuery(resourceQuery(params.rid));
  },
  component: ChatPage,
});

function ChatPage() {
  const { rid } = Route.useParams();
  return <ChatView key={rid} rid={rid} getToken={getAccessToken} />;
}
