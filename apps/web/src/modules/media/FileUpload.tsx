import { useState, useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { attachmentsApi } from "@/services/api";
import { formatFileSize } from "@/utils/helpers";
import { clsx } from "clsx";
import {
  Upload, X, FileText, Image, Film, Music,
  File, CheckCircle, AlertCircle, Download,
} from "lucide-react";
import toast from "react-hot-toast";
import { useLanguage } from "@/utils/i18n";

export interface UploadedFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  downloadUrl: string;
  previewUrl?: string;
}

interface FileUploadProps {
  onUploaded: (file: UploadedFile) => void;
  onCancel: () => void;
  messageId?: string;
  accountId?: string;
}

type UploadStatus = "idle" | "uploading" | "done" | "error";

interface FileItem {
  file: File;
  status: UploadStatus;
  progress: number;
  result?: UploadedFile;
  error?: string;
}

function FileIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith("image/")) return <Image size={16} className="text-blue-400" />;
  if (mimeType.startsWith("video/")) return <Film size={16} className="text-purple-400" />;
  if (mimeType.startsWith("audio/")) return <Music size={16} className="text-green-400" />;
  if (mimeType.includes("pdf")) return <FileText size={16} className="text-red-400" />;
  return <File size={16} className="text-surface-200/50" />;
}

export function FileUploadZone({ onUploaded, onCancel, messageId, accountId }: FileUploadProps) {
  const { t } = useLanguage();
  const [files, setFiles] = useState<FileItem[]>([]);

  const onDrop = useCallback((accepted: File[]) => {
    const items: FileItem[] = accepted.map((f) => ({
      file: f,
      status: "idle",
      progress: 0,
    }));
    setFiles((prev) => [...prev, ...items]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    maxSize: 100 * 1024 * 1024, // 100MB
  });

  const uploadFile = async (index: number) => {
    const item = files[index];
    if (!item || item.status === "uploading" || item.status === "done") return;

    setFiles((prev) => prev.map((f, i) => i === index ? { ...f, status: "uploading", progress: 0 } : f));

    try {
      // Simulate progress
      const progressInterval = setInterval(() => {
        setFiles((prev) => prev.map((f, i) =>
          i === index && f.progress < 90 ? { ...f, progress: f.progress + 10 } : f
        ));
      }, 200);

      const result = await attachmentsApi.upload(item.file, messageId, accountId);
      clearInterval(progressInterval);

      const uploaded: UploadedFile = {
        id: result.id,
        name: result.file_name,
        mimeType: result.mime_type,
        sizeBytes: result.size_bytes,
        downloadUrl: result.download_url,
      };

      setFiles((prev) => prev.map((f, i) =>
        i === index ? { ...f, status: "done", progress: 100, result: uploaded } : f
      ));

      onUploaded(uploaded);
    } catch (e: any) {
      // Surface real backend message (415 unsupported MIME, 413 too large, etc.)
      const detail = e?.response?.data?.detail ?? e?.message ?? t("upload.error");
      const errorMsg = typeof detail === "string" ? detail : t("upload.error");
      setFiles((prev) => prev.map((f, i) =>
        i === index ? { ...f, status: "error", error: errorMsg } : f
      ));
      toast.error(errorMsg);
    }
  };

  const uploadAll = () => files.forEach((_, i) => uploadFile(i));
  const removeFile = (index: number) => setFiles((prev) => prev.filter((_, i) => i !== index));

  return (
    <div className="flex flex-col gap-3">
      {/* Drop zone */}
      <div {...getRootProps()} className={clsx(
        "border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all duration-200",
        isDragActive
          ? "border-accent bg-accent/10"
          : "border-default hover:border-default hover:bg-surface-800/20"
      )}>
        <input {...getInputProps()} />
        <Upload size={24} className={clsx("mx-auto mb-2", isDragActive ? "text-accent" : "text-surface-200/30")} />
        <p className="text-sm text-surface-200/50">
          {isDragActive ? t("upload.dropHere") : t("upload.dragOrClick")}
        </p>
        <p className="text-xs text-surface-200/30 mt-1">{t("upload.maxPerFile")}</p>
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div className="flex flex-col gap-2">
          {files.map((item, i) => (
            <div key={i} className="glass rounded-lg p-3 flex items-center gap-3">
              <FileIcon mimeType={item.file.type} />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-surface-50 truncate">{item.file.name}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-surface-200/40">{formatFileSize(item.file.size)}</span>
                  {item.status === "uploading" && (
                    <div className="flex-1 h-1 bg-surface-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent rounded-full transition-all duration-200"
                        style={{ width: `${item.progress}%` }}
                      />
                    </div>
                  )}
                  {item.status === "done" && <span className="text-xs text-success">{t("upload.uploaded")}</span>}
                  {item.status === "error" && <span className="text-xs text-danger">{item.error}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {item.status === "done" && <CheckCircle size={14} className="text-success" />}
                {item.status === "error" && <AlertCircle size={14} className="text-danger" />}
                {(item.status === "idle" || item.status === "error") && (
                  <button onClick={() => uploadFile(i)}
                    className="p-1 rounded hover-surface text-accent text-xs">
                    <Upload size={12} />
                  </button>
                )}
                <button onClick={() => removeFile(i)}
                  className="p-1 rounded hover-surface text-surface-200/30 hover:text-surface-200">
                  <X size={12} />
                </button>
              </div>
            </div>
          ))}

          <div className="flex gap-2">
            {files.some((f) => f.status === "idle") && (
              <button onClick={uploadAll} className="btn-primary text-sm flex items-center gap-2">
                <Upload size={14} /> {t("upload.uploadAll")}
              </button>
            )}
            <button onClick={onCancel} className="btn-ghost text-sm">{t("upload.done")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Image preview component
export function ImagePreview({ src, alt, onClick }: { src: string; alt: string; onClick?: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  if (error) return (
    <div className="w-full h-32 rounded-lg bg-surface-800 flex items-center justify-center text-surface-200/30">
      <Image size={20} />
    </div>
  );

  return (
    <div className="relative rounded-lg overflow-hidden cursor-pointer" onClick={onClick}>
      {!loaded && (
        <div className="absolute inset-0 bg-surface-800 animate-pulse rounded-lg" />
      )}
      <img
        src={src}
        alt={alt}
        className={clsx(
          "max-w-[280px] max-h-[200px] rounded-lg object-cover transition-opacity duration-200",
          loaded ? "opacity-100" : "opacity-0"
        )}
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
      />
    </div>
  );
}

// File card for messages
export function FileCard({ name, mimeType, sizeBytes, downloadUrl }: {
  name: string; mimeType: string; sizeBytes: number; downloadUrl: string;
}) {
  return (
    <a
      href={downloadUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 p-3 rounded-lg bg-surface-800/50 hover:bg-surface-800
                 border-default hover:border-default transition-all group w-full"
    >
      <div className="w-8 h-8 rounded-lg bg-surface-700 flex items-center justify-center flex-shrink-0">
        <FileIcon mimeType={mimeType} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-surface-50 truncate group-hover:text-accent-soft transition-colors">{name}</p>
        <p className="text-xs text-surface-200/40">{formatFileSize(sizeBytes)}</p>
      </div>
      <Download size={14} className="text-surface-200/30 group-hover:text-accent transition-colors flex-shrink-0" />
    </a>
  );
}
