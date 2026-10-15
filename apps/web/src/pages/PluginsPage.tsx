import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { pluginsApi } from "@/services/api";
import { Puzzle, ToggleLeft, ToggleRight, Zap, Globe, Bot, MessageSquare, Bell, BookOpen } from "lucide-react";
import { clsx } from "clsx";
import toast from "react-hot-toast";
import { useLanguage } from "@/utils/i18n";

const PLUGIN_ICONS: Record<string, React.ReactNode> = {
  "ai-summary": <Bot size={18} />,
  "translate": <Globe size={18} />,
  "quick-reply": <Zap size={18} />,
  "bot-bridge": <MessageSquare size={18} />,
  "reminder": <Bell size={18} />,
  "markdown-plus": <BookOpen size={18} />,
};

export default function PluginsPage() {
  const { t } = useLanguage();
  const qc = useQueryClient();
  const { data: pluginsData = [], isLoading } = useQuery({
    queryKey: ["plugins"],
    queryFn: pluginsApi.list,
  });
  const plugins = Array.isArray(pluginsData) ? pluginsData : [];

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      enabled ? pluginsApi.disable(id) : pluginsApi.enable(id),
    onSuccess: (_, { id, enabled }) => {
      toast.success(`${t("plugins.title")} ${enabled ? t("plugins.disabled") : t("plugins.enabled")}`);
      qc.invalidateQueries({ queryKey: ["plugins"] });
    },
  });

  return (
    <div className="h-full overflow-y-auto p-3 sm:p-6">
      <div className="max-w-2xl mx-auto flex flex-col gap-6">
        <div>
          <h1 className="text-xl font-bold text-surface-50">{t("plugins.title")}</h1>
          <p className="text-sm text-surface-200/50 mt-1">{t("plugins.subtitle")}</p>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-surface-200/30">
            <span className="w-5 h-5 border-2 border-surface-200/20 border-t-surface-200/50 rounded-full animate-spin" />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {plugins.map((plugin: any) => (
              <div
                key={plugin.id}
                className={clsx(
                  "glass rounded-xl p-4 flex items-start gap-4 transition-all duration-200",
                  plugin.is_enabled && "border-accent/20 bg-accent/5"
                )}
              >
                <div className={clsx(
                  "w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0",
                  plugin.is_enabled ? "bg-accent/20 text-accent-soft" : "bg-surface-800 text-surface-200/50"
                )}>
                  {PLUGIN_ICONS[plugin.id] ?? <Puzzle size={18} />}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-surface-50">{plugin.name}</h3>
                    <span className="text-[10px] text-surface-200/30">v{plugin.version}</span>
                  </div>
                  <p className="text-xs text-surface-200/50 mt-0.5">
                    {plugin.id === "ai-summary" && t("plugins.desc.ai-summary")}
                    {plugin.id === "translate" && t("plugins.desc.translate")}
                    {plugin.id === "quick-reply" && t("plugins.desc.quick-reply")}
                    {plugin.id === "bot-bridge" && t("plugins.desc.bot-bridge")}
                    {plugin.id === "reminder" && t("plugins.desc.reminder")}
                    {plugin.id === "markdown-plus" && t("plugins.desc.markdown-plus")}
                  </p>
                  <div className="flex gap-1.5 mt-2 flex-wrap">
                    {(Array.isArray(plugin.permissions) ? plugin.permissions : []).map((perm: string) => (
                      <span key={perm}
                        className="px-2 py-0.5 rounded-full text-[10px] bg-surface-800 text-surface-200/50">
                        {perm}
                      </span>
                    ))}
                    {!Array.isArray(plugin.permissions) || plugin.permissions.length === 0 ? (
                      <span className="px-2 py-0.5 rounded-full text-[10px] bg-surface-800 text-surface-200/40">
                        no-permissions
                      </span>
                    ) : null}
                  </div>
                </div>

                <button
                  onClick={() => toggle.mutate({ id: plugin.id, enabled: plugin.is_enabled })}
                  className={clsx(
                    "flex-shrink-0 transition-colors mt-0.5",
                    plugin.is_enabled ? "text-accent" : "text-surface-200/30 hover:text-surface-200"
                  )}
                  title={plugin.is_enabled ? t("plugins.disable") : t("plugins.enable")}
                >
                  {plugin.is_enabled
                    ? <ToggleRight size={24} />
                    : <ToggleLeft size={24} />
                  }
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="glass rounded-xl p-4 text-center">
          <p className="text-sm text-surface-200/50">
            {t("plugins.market")}
          </p>
        </div>
      </div>
    </div>
  );
}
