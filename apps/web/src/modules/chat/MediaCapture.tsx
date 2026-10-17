import { useEffect, useRef, useState } from "react";
import { Camera, SwitchCamera, Video, X } from "lucide-react";
import { useLanguage } from "@/utils/i18n";
import { videoRecordingToMp4 } from "@/services/videoFormat";

interface MediaCaptureProps {
  onCaptured: (file: File) => void;
  onFallback: () => void;
  onClose: () => void;
}

const MAX_VIDEO_MS = 60_000;

export default function MediaCapture({ onCaptured, onFallback, onClose }: MediaCaptureProps) {
  const { t } = useLanguage();
  const previewRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);
  const recordingRef = useRef(false);
  const startingRef = useRef(false);
  const [error, setError] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");

  useEffect(() => {
    let disposed = false;
    cancelledRef.current = false;
    setReady(false);
    setError(false);
    setVideoError(false);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(true);
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facingMode } }, audio: false })
      .then((stream) => {
        if (disposed) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (previewRef.current) {
          previewRef.current.srcObject = stream;
          void previewRef.current.play().catch(() => {});
        }
        setReady(true);
      })
      .catch(() => { if (!disposed) setError(true); });
    return () => {
      disposed = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [facingMode]);

  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(timer);
  }, [recording]);

  useEffect(() => () => {
    cancelledRef.current = true;
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    microphoneRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const takePhoto = () => {
    const preview = previewRef.current;
    if (!preview?.videoWidth || !preview.videoHeight || recordingRef.current || processing) return;
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

  const stopRecording = () => {
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  };

  const startRecording = async () => {
    if (!streamRef.current || recordingRef.current || startingRef.current || processing || typeof MediaRecorder === "undefined") {
      if (typeof MediaRecorder === "undefined") setError(true);
      return;
    }
    startingRef.current = true;
    try {
      // A denied microphone must not prevent photos or silent video.
      try {
        microphoneRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        microphoneRef.current = null;
      }
      if (cancelledRef.current || !streamRef.current) return;
      const tracks = [...streamRef.current.getVideoTracks(), ...(microphoneRef.current?.getAudioTracks() ?? [])];
      const stream = new MediaStream(tracks);
      const preferred = [
        ...(microphoneRef.current ? ["video/mp4;codecs=avc1.42E01E,mp4a.40.2"] : []),
        "video/mp4;codecs=avc1.42E01E",
        "video/mp4",
        "video/webm;codecs=vp8,opus",
        "video/webm",
      ]
        .find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        recordingRef.current = false;
        setRecording(false);
        microphoneRef.current?.getTracks().forEach((track) => track.stop());
        microphoneRef.current = null;
        if (cancelledRef.current) return;
        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (!chunks.length) { setVideoError(true); setError(true); return; }
        setProcessing(true);
        void videoRecordingToMp4(new Blob(chunks, { type: recorder.mimeType }))
          .then((file) => {
            if (cancelledRef.current) return;
            onCaptured(file);
            onClose();
          })
          .catch(() => { if (!cancelledRef.current) { setVideoError(true); setError(true); } })
          .finally(() => { if (!cancelledRef.current) setProcessing(false); });
      };
      recorder.onerror = () => { setVideoError(true); setError(true); };
      recorderRef.current = recorder;
      recorder.start(250);
      recordingRef.current = true;
      setRecording(true);
      setSeconds(0);
      maxTimerRef.current = setTimeout(stopRecording, MAX_VIDEO_MS);
    } catch {
      microphoneRef.current?.getTracks().forEach((track) => track.stop());
      setVideoError(true);
      setError(true);
    } finally {
      startingRef.current = false;
    }
  };

  const close = () => {
    cancelledRef.current = true;
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[80] flex h-[100dvh] flex-col bg-black text-white" role="dialog" aria-modal="true" aria-label={t("chat.camera")}>
      <div className="flex items-center justify-between px-4 pt-[max(env(safe-area-inset-top),1rem)] pb-3">
        <button type="button" className="rounded-full p-2" onClick={close} aria-label={t("common.cancel")}><X size={26} /></button>
        <span className="text-sm">{processing ? t("chat.processingVideo") : recording ? `${t("chat.recordVideo")} · ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : t("chat.camera")}</span>
        <button type="button" className="rounded-full p-2 disabled:opacity-30" onClick={() => setFacingMode((value) => value === "environment" ? "user" : "environment")} disabled={!ready || recording || processing} aria-label={t("chat.switchCamera")}><SwitchCamera size={24} /></button>
      </div>
      {error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p>{t(videoError ? "chat.videoEncodingFailed" : "chat.cameraUnavailable")}</p>
          <button type="button" className="btn-primary" onClick={() => { onFallback(); close(); }}>{t("chat.chooseExistingFile")}</button>
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black">
            <video ref={previewRef} autoPlay muted playsInline className="h-full w-full object-contain" />
          </div>
          <div className="flex flex-col items-center gap-5 px-4 pt-4 pb-[max(env(safe-area-inset-bottom),1.5rem)]">
            <p className="text-sm text-white/70">{t("chat.captureHint")}</p>
            <div className="grid w-full max-w-md grid-cols-3 items-center justify-items-center">
              <button type="button" disabled={processing} className="flex flex-col items-center gap-1 text-xs text-white/80 disabled:opacity-40" onClick={() => { onFallback(); close(); }} aria-label={t("chat.chooseExistingFile")}><Camera size={24} />{t("chat.gallery")}</button>
              <button
                type="button"
                disabled={!ready || processing}
                className={`h-20 w-20 rounded-full border-4 border-white p-1 touch-none disabled:opacity-40 ${recording ? "scale-90" : ""}`}
                aria-label={t("chat.captureHint")}
                onClick={takePhoto}
              ><span className={`block h-full w-full rounded-full ${recording ? "bg-red-500" : "bg-white"}`} /></button>
              <button type="button" disabled={!ready || processing} className="flex flex-col items-center gap-1 text-xs text-white/80 disabled:opacity-40" onClick={() => recordingRef.current ? stopRecording() : void startRecording()} aria-label={recording ? t("chat.stopVideo") : t("chat.recordVideo")}><Video size={24} />{recording ? t("chat.stopVideo") : t("chat.recordVideo")}</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
