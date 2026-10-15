/**
 * CallView.tsx - Active-call modal UI.
 *
 * Three states:
 *   1. Incoming ringing - shows large Avatar + Accept/Decline buttons + ringtone
 *   2. Outgoing calling - shows large Avatar + Hangup, "Calling..." text
 *   3. Connected - normal call UI (audio centered avatar, video PiP)
 *
 * Uses WebAudio API to play a ringtone for incoming calls without
 * requiring an audio asset file.
 */
import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Video as VideoIcon, VideoOff, PhoneOff, Phone, ScreenShare, Circle, StopCircle, UserPlus } from "lucide-react";
import { JingleSession } from "@/services/jingle";
import { callOutcome } from "@/services/jingle/callOutcome";
import { groupCallManager } from "@/services/jingle/groupCall";
import Avatar from "@/components/Avatar";
import { useLanguage } from "@/utils/i18n";
import { api } from "@/services/api";
import toast from "react-hot-toast";

interface CallViewProps {
  session: JingleSession;
  onClose: () => void;
}

// Generate a phone-ring tone using WebAudio. Returns a stop function.
function playRingtone(): () => void {
  let ctx: AudioContext | null = null;
  let osc1: OscillatorNode | null = null;
  let osc2: OscillatorNode | null = null;
  let gain: GainNode | null = null;
  let interval: number | null = null;
  let stopped = false;

  try {
    ctx = new AudioContext();
    const ringOnce = () => {
      if (!ctx || stopped) return;
      osc1 = ctx.createOscillator();
      osc2 = ctx.createOscillator();
      gain = ctx.createGain();
      osc1.frequency.value = 440;
      osc2.frequency.value = 659.25;
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 0.05);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.0);
      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);
      osc1.start();
      osc2.start();
      osc1.stop(ctx.currentTime + 1.0);
      osc2.stop(ctx.currentTime + 1.0);
    };
    ringOnce();
    interval = window.setInterval(ringOnce, 3000); // ring every 3 seconds
  } catch {
    // Audio context blocked - silent ringing
  }

  return () => {
    stopped = true;
    if (interval) clearInterval(interval);
    try { osc1?.stop(); } catch {}
    try { osc2?.stop(); } catch {}
    try { ctx?.close(); } catch {}
  };
}

export default function CallView({ session, onClose }: CallViewProps) {
  const { t } = useLanguage();
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);
  const [state, setState] = useState(session.state);
  const [duration, setDuration] = useState(0);
  const [screenSharing, setScreenSharing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const stopRecordingRef = useRef<(() => Promise<Blob>) | null>(null);
  const info = session.info;
  const stopRingtoneRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    session.on("state.changed", (s) => setState(s));
    session.on("stream.local", (stream: MediaStream) => {
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    });
    session.on("stream.remote", (stream: MediaStream) => {
      const player = remoteVideoRef.current ?? remoteAudioRef.current;
      if (player) player.srcObject = stream;
    });
    session.on("ended", () => {
      const finalInfo = session.info;
      if (finalInfo.errorMessage) setCallError(finalInfo.errorMessage);
      const endedAt = finalInfo.endedAt ?? Date.now();
      const { status, durationSeconds } = callOutcome(finalInfo, endedAt);

      api.post("/calls/log", {
        peer_jid: info.peerJid,
        direction: info.direction,
        media_types: info.mediaTypes.join(","),
        status,
        duration_seconds: durationSeconds,
        started_at: new Date(info.startedAt).toISOString(),
        ended_at: new Date(endedAt).toISOString(),
      }).catch(() => {});

      if (!finalInfo.errorMessage) setTimeout(onClose, 1000);
    });
  }, [session, onClose]);

  // Media can arrive before the connected view mounts its video elements.
  // Reattach the streams after that view appears, including audio-only calls.
  useEffect(() => {
    if (state !== "connected") return;
    const current = session.info;
    if (localVideoRef.current && current.localStream) {
      localVideoRef.current.srcObject = current.localStream;
    }
    const player = remoteVideoRef.current ?? remoteAudioRef.current;
    if (player && current.remoteStream) player.srcObject = current.remoteStream;
  }, [session, state]);

  // Start/stop ringtone for incoming ringing state
  useEffect(() => {
    if (state === "ringing" && info.direction === "incoming") {
      stopRingtoneRef.current = playRingtone();
    } else {
      stopRingtoneRef.current?.();
      stopRingtoneRef.current = null;
    }
    return () => {
      stopRingtoneRef.current?.();
      stopRingtoneRef.current = null;
    };
  }, [state, info.direction]);

  // Duration timer once connected
  useEffect(() => {
    if (state !== "connected") return;
    const start = Date.now();
    const interval = setInterval(() => {
      setDuration(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [state]);

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, "0")}`;
  };

  const isVideo = info.mediaTypes.includes("video");
  const isIncomingRinging = state === "ringing" && info.direction === "incoming";

  const handleAccept = async () => {
    try {
      await session.acceptCall();
    } catch (e) {
      console.error("Failed to accept call:", e);
      const name = e instanceof Error ? e.name : "Error";
      toast.error(name === "NotAllowedError"
        ? "Microphone access is required to answer this call."
        : `Could not answer the call (${name}).`);
      session.hangup("failed-application");
    }
  };

  const handleDecline = () => {
    session.hangup("decline");
  };

  const handleHangup = () => {
    session.hangup();
  };

  const toggleScreenShare = async () => {
    if (screenSharing) {
      await session.stopScreenShare();
      setScreenSharing(false);
    } else {
      const ok = await session.startScreenShare();
      setScreenSharing(ok);
    }
  };

  const toggleRecording = async () => {
    if (recording && stopRecordingRef.current) {
      const blob = await stopRecordingRef.current();
      stopRecordingRef.current = null;
      setRecording(false);
      // Trigger download
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `call-${info.peerJid.split("@")[0]}-${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      const stop = session.startRecording();
      if (stop) {
        stopRecordingRef.current = stop;
        setRecording(true);
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-black/70 text-white text-sm">
        <div>
          <p className="font-medium">{info.peerJid.split("@")[0]}</p>
          <p className="text-xs text-white/60">
            {state === "connected" ? formatDuration(duration) :
             state === "calling" ? t("call.calling") :
             state === "ringing" && info.direction === "incoming" ?
               (isVideo ? t("call.incomingVideo") : t("call.incomingAudio")) :
             state === "ringing" ? t("call.ringing") :
             state === "connecting" ? t("call.connecting") :
             state === "ended" ? t("call.ended") : ""}
          </p>
        </div>
      </div>

      {/* Video / avatar region */}
      <div className="flex-1 relative bg-surface-900 flex items-center justify-center">
        {!isVideo && <audio ref={remoteAudioRef} autoPlay />}
        {isVideo && state === "connected" ? (
          <>
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="w-full h-full object-cover"
            />
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="absolute bottom-4 right-4 w-32 h-48 object-cover rounded-lg border-2 border-white/20"
            />
          </>
        ) : (
          <div className="flex flex-col items-center gap-6">
            <div className="scale-[2.5]">
              <Avatar name={info.peerJid} size="xl" />
            </div>
            {isIncomingRinging && (
              <p className="text-white/80 text-base mt-8 animate-pulse">
                {t("call.calling")}
              </p>
            )}
            {state === "ended" && callError && (
              <p role="alert" className="mx-6 max-w-2xl rounded-lg bg-red-900/60 px-4 py-3 text-center text-sm text-white break-words">
                {callError}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-4 py-6 bg-black/80">
        {state === "ended" && callError ? (
          <button onClick={onClose} className="rounded-lg bg-white/15 px-6 py-3 text-white hover:bg-white/25">
            Close
          </button>
        ) : isIncomingRinging ? (
          // Accept / Decline
          <>
            <button
              onClick={handleDecline}
              className="w-16 h-14 rounded-full bg-red-600 hover:bg-red-700 text-white flex items-center justify-center transition-colors"
              title={t("call.decline")}
              aria-label={t("call.decline")}
            >
              <PhoneOff size={22} />
            </button>
            <button
              onClick={handleAccept}
              className="w-16 h-14 rounded-full bg-green-600 hover:bg-green-700 text-white flex items-center justify-center transition-colors"
              title={t("call.accept")}
              aria-label={t("call.accept")}
            >
              <Phone size={22} />
            </button>
          </>
        ) : (
          // Mute / Video / Hangup
          <>
            <button
              onClick={() => { setMuted(!muted); session.setMuted(!muted); }}
              className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
                muted ? "bg-red-500/30 text-red-300" : "bg-white/10 text-white hover:bg-white/20"
              }`}
            >
              {muted ? <MicOff size={22} /> : <Mic size={22} />}
            </button>

            {isVideo && (
              <button
                onClick={() => { setVideoOff(!videoOff); session.setVideoEnabled(videoOff); }}
                className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
                  videoOff ? "bg-red-500/30 text-red-300" : "bg-white/10 text-white hover:bg-white/20"
                }`}
              >
                {videoOff ? <VideoOff size={22} /> : <VideoIcon size={22} />}
              </button>
            )}

            {state === "connected" && isVideo && (
              <button
                onClick={toggleScreenShare}
                className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
                  screenSharing ? "bg-accent text-white" : "bg-white/10 text-white hover:bg-white/20"
                }`}
                title={t("call.screenShare")}
              >
                <ScreenShare size={20} />
              </button>
            )}

            {state === "connected" && (
              <button
                onClick={toggleRecording}
                className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
                  recording ? "bg-red-600 text-white animate-pulse" : "bg-white/10 text-white hover:bg-white/20"
                }`}
                title={recording ? t("call.stopRecording") : t("call.startRecording")}
              >
                {recording ? <StopCircle size={20} /> : <Circle size={20} />}
              </button>
            )}

            <button
              onClick={handleHangup}
              className="w-16 h-14 rounded-full bg-red-600 hover:bg-red-700 text-white flex items-center justify-center transition-colors"
              aria-label={t("call.hangup")}
              title={t("call.hangup")}
            >
              <PhoneOff size={22} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

