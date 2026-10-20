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
import { Compass, Hash, MessageSquarePlus, Plus, UserPlus, Users } from "lucide-react";

type LeftTab = "chats" | "contacts" | "groups";
type GroupAction = "create" | "join" | "discover";

export default function MainLayout() {
  const { t } = useLanguage();
  const [leftTab, setLeftTab] = useState<LeftTab>("chats");
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [openAddRequest, setOpenAddRequest] = useState(0);
  const [groupRequest, setGroupRequest] = useState<{ action: GroupAction; id: number } | null>(null);
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
    setOpenAddRequest(0);
    setGroupRequest(null);
    setShowCreateMenu(false);
  };

  const selectTab = (tab: LeftTab) => {
    setLeftTab(tab);
    setOpenAddRequest(0);
    setGroupRequest(null);
    setShowCreateMenu(false);
  };

  const runCreateAction = (action: "contact" | GroupAction) => {
    setShowCreateMenu(false);
    if (action === "contact") {
      setLeftTab("contacts");
      setGroupRequest(null);
      setOpenAddRequest((value) => value + 1);
    } else {
      setLeftTab("groups");
      setOpenAddRequest(0);
      setGroupRequest((request) => ({ action, id: (request?.id ?? 0) + 1 }));
    }
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
          {leftTab === "contacts" && <RosterPanel openAddRequest={openAddRequest} />}
          {leftTab === "groups" && <GroupPanel requestedAction={groupRequest} />}
        </div>
        <div className="absolute bottom-4 right-4 z-30 md:hidden">
          {showCreateMenu && (
            <div className="mb-2 w-56 rounded-xl border border-subtle bg-surface-900 p-1.5 shadow-xl" aria-label={t("conv.newAction")}>
              {([
                { action: "contact" as const, label: t("roster.add"), Icon: UserPlus },
                { action: "create" as const, label: t("group.createRoom"), Icon: Users },
                { action: "join" as const, label: t("group.joinRoom"), Icon: Hash },
                { action: "discover" as const, label: t("group.discover"), Icon: Compass },
              ]).map(({ action, label, Icon }) => (
                <button key={action} type="button" onClick={() => runCreateAction(action)}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-surface-50 hover-surface">
                  <Icon size={16} /> {label}
                </button>
              ))}
            </div>
          )}
          <button type="button" onClick={() => setShowCreateMenu((open) => !open)}
            aria-label={t("conv.newAction")} aria-expanded={showCreateMenu}
            className="btn-primary flex items-center gap-2 rounded-full px-4 py-3 shadow-lg">
            {showCreateMenu ? <Plus size={19} className="rotate-45" /> : <MessageSquarePlus size={19} />}
            <span className="text-sm">{t("conv.newAction")}</span>
          </button>
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
