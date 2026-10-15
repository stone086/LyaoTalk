import { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/utils/i18n";

type CaptureMode = "photo" | "video";

interface MediaCaptureProps {
  mode: CaptureMode;
  onCaptured: (file: File) => void;
  onFallback: () => void;
  onClose: () => void;
}

export default function MediaCapture({ mode, onCaptured, onFallback, onClose }: MediaCaptureProps) {
  const { t } = useLanguage();
  const previewRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const cancelledRef = useRef(false);
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    let cancelled = false;
    cancelledRef.current = false;
    setError(false);
    setReady(false);
    if (!navigator.mediaDevices?.getUserMedia || (mode === "video" && typeof MediaRecorder === "undefined")) {
      setError(true);
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: mode === "video" })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (previewRef.current) {
          previewRef.current.srcObject = stream;
          void previewRef.current.play();
        }
        setReady(true);
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => {
      cancelled = true;
      cancelledRef.current = true;
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [mode]);

  const takePhoto = () => {
    const preview = previewRef.current;
    if (!preview?.videoWidth || !preview.videoHeight) return;
    const canvas = document.createElement("canvas");
    canvas.width = preview.videoWidth;
    canvas.height = preview.videoHeight;
    canvas.getContext("2d")?.drawImage(preview, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob || cancelledRef.current) return;
      onCaptured(new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" }));
      onClose();
    }, "image/jpeg", 0.9);
  };

  const startRecording = () => {
    const stream = streamRef.current;
    if (!stream) return;
    try {
      const preferred = ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]
        .find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        if (cancelledRef.current || !chunksRef.current.length) return;
        const mimeType = recorder.mimeType.startsWith("video/mp4") ? "video/mp4" : "video/webm";
        const extension = mimeType === "video/mp4" ? "mp4" : "webm";
        onCaptured(new File(chunksRef.current, `video-${Date.now()}.${extension}`, { type: mimeType }));
        onClose();
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setError(true);
    }
  };

  const close = () => {
    cancelledRef.current = true;
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" role="dialog" aria-modal="true" aria-label={t(mode === "photo" ? "chat.camera" : "chat.video")}>
      <div className="popover-surface w-full max-w-xl space-y-3 rounded-2xl p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">{t(mode === "photo" ? "chat.camera" : "chat.video")}</h2>
          <button type="button" className="btn-ghost" onClick={close}>{t("common.cancel")}</button>
        </div>
        {error ? (
          <div className="space-y-3 text-sm">
            <p>{t("chat.cameraUnavailable")}</p>
            <button type="button" className="btn-primary" onClick={() => { onFallback(); close(); }}>{t("chat.chooseExistingFile")}</button>
          </div>
        ) : (
          <>
            <video ref={previewRef} autoPlay muted playsInline className="aspect-video w-full rounded-xl bg-black object-contain" />
            <div className="flex justify-center">
              {mode === "photo" ? (
                <button type="button" className="btn-primary" disabled={!ready} onClick={takePhoto}>{t("chat.takePhoto")}</button>
              ) : recording ? (
                <button type="button" className="btn-primary" onClick={() => recorderRef.current?.stop()}>{t("chat.stopVideo")}</button>
              ) : (
                <button type="button" className="btn-primary" disabled={!ready} onClick={startRecording}>{t("chat.recordVideo")}</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
