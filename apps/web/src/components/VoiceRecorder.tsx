/**
 * VoiceRecorder.tsx - Hold-to-record voice messages.
 *
 * Records Opus-encoded audio via MediaRecorder, uploads to MinIO via the
 * attachments endpoint, and sends as a regular file message with audio MIME.
 *
 * UX:
 *   - Mic button: tap = toggle, long-press = walkie-talkie style
 *   - During recording: red pulsing dot + elapsed time + waveform
 *   - On release: cancel (drag away) or send (release)
 */
import { useState, useRef, useEffect } from "react";
import { Mic, X, Send } from "lucide-react";
import toast from "react-hot-toast";
import { useLanguage } from "@/utils/i18n";

interface VoiceRecorderProps {
  onSend: (file: File) => Promise<void>;
  onCancel?: () => void;
  embedded?: boolean;
}

export default function VoiceRecorder({ onSend, onCancel, embedded = false }: VoiceRecorderProps) {
  const { t } = useLanguage();
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxDurationRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationRef = useRef<number | null>(null);

  const cleanup = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    if (maxDurationRef.current) clearTimeout(maxDurationRef.current);
    maxDurationRef.current = null;
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    chunksRef.current = [];
    setRecording(false);
    setElapsed(0);
    setAudioLevel(0);
  };

  useEffect(() => () => cleanup(), []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      // Setup audio level monitoring for waveform display
      const ac = new AudioContext();
      audioContextRef.current = ac;
      const source = ac.createMediaStreamSource(stream);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setAudioLevel(Math.min(1, avg / 128));
        animationRef.current = requestAnimationFrame(tick);
      };
      tick();

      // Let browsers without WebM support select their native recording format.
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 32000,
      });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start(500); // gather chunks every 500ms

      setRecording(true);
      const startTime = Date.now();
      intervalRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTime) / 1000));
      }, 100);

      // Auto-stop after 5 minutes
      maxDurationRef.current = setTimeout(() => {
        if (mediaRecorderRef.current?.state === "recording") finishAndSend();
      }, 5 * 60 * 1000);
    } catch (e: any) {
      cleanup();
      toast.error(t("voice.permissionDenied"));
      onCancel?.();
    }
  };

  const finishAndSend = async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;

    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });

    if (chunksRef.current.length === 0) {
      cleanup();
      return;
    }

    const mimeType = recorder.mimeType || chunksRef.current[0]?.type || "audio/webm";
    const extension = mimeType.startsWith("audio/mp4") ? "m4a" : mimeType.startsWith("audio/ogg") ? "ogg" : "webm";
    const blob = new Blob(chunksRef.current, { type: mimeType });
    const file = new File([blob], `voice-${Date.now()}.${extension}`, { type: blob.type });
    cleanup();

    try {
      await onSend(file);
    } catch (e: any) {
      toast.error(e?.message ?? t("voice.sendFailed"));
    }
  };

  const cancelRecording = () => {
    mediaRecorderRef.current?.stop();
    cleanup();
    onCancel?.();
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, "0")}`;
  };

  if (!recording) {
    return (
      <button
        type="button"
        onClick={startRecording}
        className={embedded ? "absolute bottom-1 right-1 rounded-lg p-2.5 text-surface-200/60 transition-colors hover-surface hover:text-accent-soft" : "p-2.5 rounded-xl hover-surface text-surface-200/60 hover:text-accent-soft transition-colors"}
        title={t("voice.record")}
        aria-label={t("voice.record")}
      >
        <Mic size={16} />
      </button>
    );
  }

  return (
    <div className={embedded ? "absolute bottom-[calc(100%+0.5rem)] right-0 z-30 flex min-w-[11rem] items-center gap-2 rounded-xl border border-warn/30 bg-surface-900 px-3 py-2 shadow-xl" : "flex items-center gap-2 px-3 py-2 rounded-xl bg-warn/10 border border-warn/30"}>
      <button
        type="button"
        onClick={cancelRecording}
        className="text-warn hover:text-warn-soft"
        title={t("voice.cancel")}
      >
        <X size={16} />
      </button>
      <div className="flex items-center gap-1 flex-1">
        <div
          className="w-2 h-2 rounded-full bg-warn animate-pulse"
          style={{ transform: `scale(${1 + audioLevel * 0.5})` }}
        />
        <span className="text-xs text-warn font-mono">{formatTime(elapsed)}</span>
      </div>
      <button
        type="button"
        onClick={finishAndSend}
        className="p-1.5 rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
        title={t("voice.send")}
      >
        <Send size={14} />
      </button>
    </div>
  );
}
