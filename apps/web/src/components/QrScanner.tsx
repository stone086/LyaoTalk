import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import jsQR from "jsqr";
import { Camera, Copy, ImageUp, ScanLine, X } from "lucide-react";
import toast from "react-hot-toast";
import { useLanguage } from "@/utils/i18n";
import { parseQrPayload } from "@/utils/qrPayload";

export default function QrScanner({ onClose }: { onClose: () => void }) {
  const { lang } = useLanguage();
  const label = (zh: string, en: string) => lang === "zh-CN" ? zh : en;
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState("");
  const [cameraError, setCameraError] = useState("");
  const payload = result ? parseQrPayload(result, window.location.origin) : null;

  useEffect(() => {
    if (result) return;
    let cancelled = false;
    let stream: MediaStream | undefined;
    let frame = 0;
    let lastScan = 0;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });

    const scan = (now: number) => {
      if (cancelled) return;
      const video = videoRef.current;
      if (context && video?.readyState === HTMLMediaElement.HAVE_ENOUGH_DATA && now - lastScan > 250) {
        lastScan = now;
        const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        const decoded = jsQR(pixels.data, pixels.width, pixels.height);
        if (decoded?.data) {
          setResult(decoded.data);
          return;
        }
      }
      frame = requestAnimationFrame(scan);
    };

    navigator.mediaDevices?.getUserMedia({ audio: false, video: { facingMode: "environment" } })
      .then(async (media) => {
        if (cancelled) { media.getTracks().forEach((track) => track.stop()); return; }
        stream = media;
        if (!videoRef.current) return;
        videoRef.current.srcObject = media;
        await videoRef.current.play();
        if (!cancelled) frame = requestAnimationFrame(scan);
      })
      .catch(() => {
        if (!cancelled) setCameraError(label("无法使用摄像头。你仍可上传二维码图片。", "Camera unavailable. You can upload a QR image instead."));
      });
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError(label("此浏览器无法使用摄像头。请上传二维码图片。", "This browser cannot use the camera. Upload a QR image instead."));
    }
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [result]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const scanImage = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 10 * 1024 * 1024) {
      toast.error(label("请选择不超过 10 MB 的图片。", "Choose an image under 10 MB."));
      return;
    }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.round(image.naturalWidth * scale);
      canvas.height = Math.round(image.naturalHeight * scale);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Canvas unavailable");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const decoded = jsQR(pixels.data, pixels.width, pixels.height);
      if (decoded?.data) setResult(decoded.data);
      else toast.error(label("图片中未识别到二维码。", "No QR code found in the image."));
    } catch {
      toast.error(label("无法读取这张图片。", "Could not read this image."));
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const accept = () => {
    if (!payload) return;
    if (payload.kind === "contact") navigate(`/?add_contact=${encodeURIComponent(payload.jid)}`);
    else if (payload.kind === "invite") navigate(payload.path);
    else if (payload.kind === "link") window.open(payload.url, "_blank", "noopener,noreferrer");
    onClose();
  };

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-label={label("扫描二维码", "Scan QR code")} className="glass w-full max-w-md rounded-2xl p-4 shadow-2xl">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-semibold text-surface-50"><ScanLine size={18} />{label("扫描二维码", "Scan QR code")}</h2>
        <button type="button" onClick={onClose} className="btn-ghost p-2" aria-label={label("关闭", "Close")}><X size={18} /></button>
      </div>
      {!result && <div className="flex aspect-square max-h-[50vh] items-center justify-center overflow-hidden rounded-xl bg-surface-900">
        <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
        {cameraError && <div className="absolute max-w-xs px-5 text-center text-sm text-surface-200"><Camera size={28} className="mx-auto mb-2" />{cameraError}</div>}
      </div>}
      {result && <div className="rounded-xl border border-default bg-surface-900 p-3 text-sm text-surface-100">
        <p className="mb-2 font-medium">{payload?.kind === "contact" ? label("识别到联系人", "Contact found") : payload?.kind === "invite" ? label("识别到服务器邀请", "Server invitation found") : payload?.kind === "link" ? label("识别到链接", "Link found") : label("识别到文本", "Text found")}</p>
        <p className="max-h-32 break-all overflow-auto text-surface-200">{result}</p>
      </div>}
      <div className="mt-3 flex flex-wrap gap-2">
        <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(event) => { void scanImage(event.target.files?.[0]); event.target.value = ""; }} />
        <button type="button" className="btn-ghost flex items-center gap-2 px-3 py-2" onClick={() => inputRef.current?.click()}><ImageUp size={16} />{label("选择图片", "Choose image")}</button>
        {result && <button type="button" className="btn-ghost px-3 py-2" onClick={() => setResult("")}>{label("重新扫描", "Scan again")}</button>}
        {payload && payload.kind !== "text" && <button type="button" className="btn-primary ml-auto px-3 py-2" onClick={accept}>
          {payload.kind === "contact" ? label("添加联系人", "Add contact") : payload.kind === "invite" ? label("打开邀请", "Open invitation") : label("打开链接", "Open link")}
        </button>}
        {payload?.kind === "text" && <button type="button" className="btn-ghost ml-auto flex items-center gap-2 px-3 py-2" onClick={() => void navigator.clipboard.writeText(result).then(() => toast.success(label("已复制", "Copied")))}><Copy size={16} />{label("复制文本", "Copy text")}</button>}
      </div>
    </div>
  </div>;
}
