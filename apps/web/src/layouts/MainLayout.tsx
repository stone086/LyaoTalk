import { Outlet, useLocation, useMatch, useNavigate, useSearchParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { clsx } from "clsx";
import Sidebar from "@/components/Sidebar";
import ConversationList from "@/modules/chat/ConversationList";
import RosterPanel from "@/modules/roster/RosterPanel";
import GroupPanel from "@/modules/group/GroupPanel";
import TopBar from "@/components/TopBar";
import RightPanel from "@/components/RightPanel";
import { useLanguage } from "@/utils/i18n";

type LeftTab = "chats" | "contacts" | "groups";

export default function MainLayout() {
  const { t } = useLanguage();
  const [leftTab, setLeftTab] = useState<LeftTab>("chats");
  const [showRight, setShowRight] = useState(false);
  const conversationId = useMatch("/chat/:conversationId")?.params.conversationId;
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const hasActiveConversation = !!conversationId;
  const isChatSurfaceRoute = location.pathname === "/" || location.pathname.startsWith("/chat");
  const shouldHideLeftPanelOnMobile = hasActiveConversation || !isChatSurfaceRoute;
  const shouldHideContentOnMobile = isChatSurfaceRoute && !hasActiveConversation;

  useEffect(() => {
    if (searchParams.get("add_contact")) setLeftTab("contacts");
  }, [searchParams]);

  const startChat = () => {
    setLeftTab("contacts");
  };

  const selectTab = (tab: LeftTab) => {
    setLeftTab(tab);
  };

  return (
    <div className="flex h-[100dvh] w-screen overflow-hidden bg-surface-950">
      <Sidebar />

      <div
        className={clsx(
          "conversation-sidebar relative min-w-0 flex-col border-r border-subtle bg-surface-900/50 md:w-64 md:flex-shrink-0",
          !shouldHideLeftPanelOnMobile && "flex-1 md:flex-none",
          shouldHideLeftPanelOnMobile ? "hidden md:flex" : "flex"
        )}
      >
        <TopBar compact />
        <div className="flex border-b border-subtle flex-shrink-0">
          {(["chats", "contacts", "groups"] as LeftTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => selectTab(tab)}
              className={`flex-1 py-2 text-xs font-medium transition-colors ${
                leftTab === tab
                  ? "text-accent-soft border-b-2 border-accent"
                  : "text-surface-200/40 hover:text-surface-200"
              }`}
            >
              {tab === "chats" ? t("lefttab.chats") : tab === "contacts" ? t("lefttab.contacts") : t("lefttab.groups")}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-hidden">
          {leftTab === "chats" && <ConversationList onStartChat={startChat} />}
          {leftTab === "contacts" && <RosterPanel />}
          {leftTab === "groups" && <GroupPanel />}
        </div>
      </div>

      <div className={clsx("min-w-0 flex-1 flex-col", shouldHideContentOnMobile ? "hidden md:flex" : "flex")}>
        <TopBar
          conversationId={conversationId}
          onToggleRight={() => setShowRight((v) => !v)}
          showRightToggle={!!conversationId}
          onBackToChats={hasActiveConversation ? () => navigate("/") : undefined}
        />
        <div className="relative flex flex-1 overflow-hidden">
          <div className="flex-1 overflow-hidden">
            <Outlet />
          </div>
          {showRight && conversationId && (
            <RightPanel conversationId={conversationId} onClose={() => setShowRight(false)} />
          )}
        </div>
      </div>
    </div>
  );
}
