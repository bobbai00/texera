import { createFileRoute } from "@tanstack/react-router";
import { ChatView } from "@texera/chat";
import { conversationQuery } from "@texera/kinds";
import { getAccessToken } from "@/auth/session";

export const Route = createFileRoute("/_app/c/$rid")({
  loader: ({ context: { queryClient }, params }) => {
    void queryClient.prefetchQuery(conversationQuery(params.rid));
  },
  component: ChatPage,
});

function ChatPage() {
  const { rid } = Route.useParams();
  return <ChatView key={rid} rid={rid} getToken={getAccessToken} />;
}
