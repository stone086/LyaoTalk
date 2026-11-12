import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  CalendarDays,
  ExternalLink,
  Globe2,
  Loader2,
  LockKeyhole,
  Newspaper,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { newsApi, type DailyNewsItem } from "@/services/api";
import { useLanguage } from "@/utils/i18n";

function formatEditionDate(value: string, lang: string): string {
  const date = new Date(`${value}T00:00:00+08:00`);
  return new Intl.DateTimeFormat(lang === "zh-CN" ? "zh-CN" : "en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

function formatClock(value: string, lang: string): string {
  return new Intl.DateTimeFormat(lang === "zh-CN" ? "zh-CN" : "en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function relativeTime(value: string, lang: string): string {
  const differenceSeconds = (new Date(value).getTime() - Date.now()) / 1000;
  const absolute = Math.abs(differenceSeconds);
  const formatter = new Intl.RelativeTimeFormat(lang === "zh-CN" ? "zh-CN" : "en", {
    numeric: "auto",
  });
  if (absolute < 3600) return formatter.format(Math.round(differenceSeconds / 60), "minute");
  if (absolute < 86400) return formatter.format(Math.round(differenceSeconds / 3600), "hour");
  return formatter.format(Math.round(differenceSeconds / 86400), "day");
}

function SourceLine({ item, lang }: { item: DailyNewsItem; lang: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-surface-200/65">
      <span className="font-semibold text-accent-soft">{item.source}</span>
      <span className="h-1 w-1 rounded-full bg-surface-200/25" />
      <span>{relativeTime(item.published_at, lang)}</span>
      {item.coverage > 1 && (
        <>
          <span className="h-1 w-1 rounded-full bg-surface-200/25" />
          <span className="inline-flex items-center gap-1">
            <Users size={11} />
            {item.coverage}
          </span>
        </>
      )}
    </div>
  );
}

export default function NewsPage() {
  const { t, lang } = useLanguage();
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["news", "top10"],
    queryFn: newsApi.top10,
    staleTime: 15 * 60 * 1000,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  const stories = data?.items ?? [];
  const topStory = stories[0];
  const remainingStories = stories.slice(1);
  const editionDate = data ? formatEditionDate(data.date, lang) : "";
  const updatedAt = data ? formatClock(data.generated_at, lang) : "";

  return (
    <div className="news-page h-full overflow-y-auto">
      <div className="relative min-h-full">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(ellipse_at_top,rgb(var(--accent)/0.2),transparent_68%)]" />
        <div className="relative mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 sm:py-7 lg:px-9 lg:py-9">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-surface-200/60">
              <Newspaper size={14} className="text-accent-soft" />
              <span>{t("news.dailyBrief")}</span>
              {editionDate && (
                <>
                  <span className="h-px w-7 bg-surface-200/20" />
                  <span className="normal-case tracking-normal">{editionDate}</span>
                </>
              )}
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/35 bg-accent/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-accent-soft">
              <LockKeyhole size={11} />
              {t("news.memberOnly")}
            </span>
          </div>

          <header className="mb-7 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="mb-2 inline-flex items-center gap-2 text-xs font-medium text-accent-soft">
                <Globe2 size={14} />
                <span>{t("news.dailyBrief")}</span>
              </div>
              <h1 className="text-3xl font-black leading-[1.06] tracking-tight text-surface-50 sm:text-4xl lg:text-5xl">
                {t("news.title")}
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-surface-200/75 sm:text-base">
                {t("news.subtitle")}
              </p>
            </div>

            {data && (
              <div className="glass flex shrink-0 items-center gap-3 rounded-2xl px-4 py-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/15 text-accent-soft">
                  <CalendarDays size={19} />
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-surface-200/60">
                    {t("news.today")}
                  </p>
                  <p className="mt-0.5 text-sm font-semibold text-surface-50">
                    {t("news.updatedAt", { time: updatedAt })}
                  </p>
                  <p className="mt-0.5 text-[11px] text-surface-200/55">
                    {t("news.nextUpdate", { time: formatClock(data.next_update, lang) })}
                  </p>
                </div>
              </div>
            )}
          </header>

          {isLoading && (
            <div className="flex flex-col gap-4" aria-busy="true" aria-label={t("news.loading")}>
              <div className="glass flex min-h-[320px] animate-pulse items-end rounded-3xl p-6 sm:p-8">
                <div className="w-full max-w-2xl space-y-4">
                  <div className="h-3 w-28 rounded-full bg-surface-800" />
                  <div className="h-8 w-full rounded-lg bg-surface-800" />
                  <div className="h-8 w-4/5 rounded-lg bg-surface-800" />
                  <div className="h-4 w-2/3 rounded-full bg-surface-800/70" />
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="glass h-32 animate-pulse rounded-2xl" />
                ))}
              </div>
              <p className="flex items-center justify-center gap-2 py-3 text-xs text-surface-200/60">
                <Loader2 size={14} className="animate-spin" />
                {t("news.loading")}
              </p>
            </div>
          )}

          {!isLoading && isError && (
            <div className="glass mx-auto flex max-w-xl flex-col items-center rounded-3xl px-6 py-12 text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-danger/10 text-danger">
                <LockKeyhole size={22} />
              </div>
              <h2 className="text-lg font-bold text-surface-50">{t("news.errorTitle")}</h2>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-surface-200/70">
                {t("news.errorBody")}
              </p>
              <button
                type="button"
                onClick={() => void refetch()}
                disabled={isFetching}
                className="mt-5 inline-flex items-center gap-2 rounded-xl border border-accent/40 bg-accent/15 px-4 py-2 text-sm font-semibold text-accent-soft transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isFetching ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                {t("news.retry")}
              </button>
            </div>
          )}

          {!isLoading && !isError && data && (
            <>
              {data.stale && (
                <div className="mb-4 flex items-center gap-2 rounded-xl border border-warn/30 bg-warn/10 px-3.5 py-2.5 text-xs text-warn">
                  <RefreshCw size={13} />
                  {t("news.stale")}
                </div>
              )}

              {topStory ? (
                <a
                  href={topStory.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group relative block overflow-hidden rounded-3xl border border-accent/30 bg-surface-800 shadow-[0_24px_70px_rgb(0_0_0/0.25)] transition duration-300 hover:border-accent/55"
                >
                  {topStory.image && (
                    <img
                      src={topStory.image}
                      alt=""
                      loading="eager"
                      referrerPolicy="no-referrer"
                      className="absolute inset-0 h-full w-full object-cover opacity-80 transition duration-700 group-hover:scale-[1.03]"
                      onError={(event) => {
                        event.currentTarget.style.display = "none";
                      }}
                    />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-r from-surface-950 via-surface-950/92 to-surface-950/35" />
                  <div className="absolute inset-0 bg-gradient-to-t from-surface-950/95 via-transparent to-transparent" />

                  <div className="relative z-10 flex min-h-[360px] flex-col justify-end p-5 sm:min-h-[410px] sm:p-8 lg:p-10">
                    <div className="mb-4 flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-white">
                        <ShieldCheck size={12} />
                        {t("news.topStory")}
                      </span>
                      <span className="rounded-full border border-white/20 bg-surface-950/55 px-2.5 py-1 text-[10px] font-semibold text-surface-50 backdrop-blur">
                        {t("news.rank", { rank: topStory.rank })}
                      </span>
                      {topStory.coverage > 1 && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-surface-950/45 px-2.5 py-1 text-[10px] text-surface-100/85 backdrop-blur">
                          <Users size={11} />
                          {t("news.alsoReported", { count: topStory.coverage })}
                        </span>
                      )}
                    </div>

                    <h2 className="max-w-4xl text-2xl font-black leading-tight tracking-tight text-white sm:text-3xl lg:text-[2.6rem] lg:leading-[1.08]">
                      {topStory.title}
                    </h2>
                    {topStory.summary && (
                      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-surface-100/80 sm:text-[15px]">
                        {topStory.summary}
                      </p>
                    )}

                    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-surface-100/65">
                        <span className="font-semibold text-accent-soft">{topStory.source}</span>
                        <span className="h-1 w-1 rounded-full bg-white/30" />
                        <span>{relativeTime(topStory.published_at, lang)}</span>
                        {topStory.also_reported_by.length > 0 && (
                          <>
                            <span className="h-1 w-1 rounded-full bg-white/30" />
                            <span>+{topStory.also_reported_by.join(", ")}</span>
                          </>
                        )}
                      </div>
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent-soft transition group-hover:text-white">
                        {t("news.readOriginal")}
                        <ArrowUpRight size={14} />
                      </span>
                    </div>
                  </div>
                </a>
              ) : (
                <div className="glass rounded-2xl p-8 text-center text-sm text-surface-200/70">
                  {t("news.empty")}
                </div>
              )}

              {remainingStories.length > 0 && (
                <>
                  <div className="mb-3 mt-8 flex items-end justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent-soft/80">
                        {t("news.dailyBrief")}
                      </p>
                      <h2 className="mt-1 text-xl font-bold text-surface-50">{t("news.topStories")}</h2>
                    </div>
                    <span className="rounded-full border border-default px-2.5 py-1 text-[10px] font-medium text-surface-200/65">
                      {t("news.storyCount", { count: stories.length })}
                    </span>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    {remainingStories.map((item) => (
                      <a
                        key={`${item.rank}-${item.url}`}
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group glass flex gap-3 rounded-2xl p-3.5 transition duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:bg-surface-800/75 sm:gap-4 sm:p-4"
                      >
                        <div className="flex w-9 shrink-0 flex-col items-center pt-0.5">
                          <span className="font-mono text-2xl font-black leading-none tracking-tighter text-accent-soft/90">
                            {String(item.rank).padStart(2, "0")}
                          </span>
                          <span className="mt-2 h-7 w-px bg-accent/20" />
                        </div>

                        <div className="min-w-0 flex-1">
                          <SourceLine item={item} lang={lang} />
                          <h3 className="mt-1.5 line-clamp-3 text-[15px] font-semibold leading-snug text-surface-50 transition group-hover:text-white">
                            {item.title}
                          </h3>
                          {item.summary && (
                            <p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-surface-200/65">
                              {item.summary}
                            </p>
                          )}
                          <div className="mt-2.5 flex items-center justify-between gap-2">
                            <span className="inline-flex items-center gap-1 text-[10px] text-surface-200/50">
                              <ExternalLink size={10} />
                              {item.source}
                            </span>
                            <ArrowUpRight
                              size={14}
                              className="text-surface-200/35 transition group-hover:text-accent-soft"
                            />
                          </div>
                        </div>

                        {item.image && (
                          <img
                            src={item.image}
                            alt=""
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            className="hidden h-[86px] w-[108px] shrink-0 rounded-xl object-cover sm:block"
                            onError={(event) => {
                              event.currentTarget.style.display = "none";
                            }}
                          />
                        )}
                      </a>
                    ))}
                  </div>
                </>
              )}

              <footer className="mt-8 border-t border-subtle/60 pt-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="max-w-2xl">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-surface-200/50">
                      {t("news.sources")}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {data.sources.map((source) => (
                        <a
                          key={source.name}
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded-full border border-default bg-surface-800/45 px-2.5 py-1 text-[10px] text-surface-200/70 transition hover:border-accent/35 hover:text-accent-soft"
                        >
                          {source.name}
                        </a>
                      ))}
                    </div>
                  </div>
                  <p className="max-w-md text-[11px] leading-relaxed text-surface-200/45 lg:text-right">
                    {t("news.footer")}
                  </p>
                </div>
              </footer>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
