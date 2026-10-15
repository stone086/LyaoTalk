import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { getStoredLanguage } from "@/utils/i18n";

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  State
> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info);
  }

  render() {
    const zh = getStoredLanguage() === "zh-CN";
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-6">
          <AlertTriangle size={32} className="text-danger" />
          <div>
            <p className="text-sm font-semibold text-surface-50">{zh ? "发生错误" : "Something went wrong"}</p>
            <p className="text-xs text-surface-200/50 mt-1 max-w-xs">
              {this.state.error?.message ?? (zh ? "发生了未预期错误" : "An unexpected error occurred")}
            </p>
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: undefined })}
            className="btn-ghost text-sm flex items-center gap-2"
          >
            <RefreshCw size={14} /> {zh ? "重试" : "Try again"}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
