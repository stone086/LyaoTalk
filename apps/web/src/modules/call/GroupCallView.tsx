/**
 * GroupCallView.tsx - Mesh group call UI (multiple 1:1 sessions in one view).
 *
 * Layout:
 *   - Grid of participant tiles (auto-arranges by count)
 *   - Each tile shows remote video/audio + name + connection state
 *   - Local self-view in corner
 *   - Hangup button ends all sessions
 *
 * Best for 2-6 participants. Beyond that, mesh becomes bandwidth-heavy
 * (each peer streams to N-1 others) and an SFU is needed.
 */
import { useEffect, useState, useRef } from "react";
import { Mic, MicOff, Video as VideoIcon, VideoOff, PhoneOff, UserPlus } from "lucide-react";
import { GroupCall, GroupCallParticipant } from "@/services/jingle/groupCall";
import { JingleSession } from "@/services/jingle";
import Avatar from "@/components/Avatar";
import { useLanguage } from "@/utils/i18n";

interface GroupCallViewProps {
  groupCall: GroupCall;
  onClose: () => void;
  onAddParticipant?: (jid: string) => void;
}

export default function GroupCallView({ groupCall, onClose, onAddParticipant }: GroupCallViewProps) {
  const { t } = useLanguage();
  const [participants, setParticipants] = useState<GroupCallParticipant[]>(groupCall.getParticipants());
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newJid, setNewJid] = useState("");

  useEffect(() => {
    const refresh = () => setParticipants([...groupCall.getParticipants()]);
    groupCall.on("participant.joined", refresh);
    groupCall.on("participant.left", refresh);
    groupCall.on("participant.state", refresh);
  }, [groupCall]);

  const handleHangup = () => {
    groupCall.endAll();
    onClose();
  };

  const handleMute = () => {
    setMuted(!muted);
    groupCall.getActiveSessions().forEach((s) => s.setMuted(!muted));
  };

  const handleVideo = () => {
    setVideoOff(!videoOff);
    groupCall.getActiveSessions().forEach((s) => s.setVideoEnabled(videoOff));
  };

  const handleAdd = () => {
    if (newJid && onAddParticipant) {
      onAddParticipant(newJid);
      setNewJid("");
      setShowAddDialog(false);
    }
  };

  // Determine grid layout from participant count
  const tileCols = participants.length <= 1 ? 1 :
                   participants.length <= 4 ? 2 :
                   3;
  const isVideo = groupCall.mediaTypes.includes("video");

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-black/70 text-white text-sm">
        <div>
          <p className="font-medium">{t("call.groupCall")}</p>
          <p className="text-xs text-white/60">
            {participants.filter(p => p.state === "joined").length} {t("call.connected")} · {participants.length} {t("call.invited")}
          </p>
        </div>
        {onAddParticipant && (
          <button
            onClick={() => setShowAddDialog(true)}
            className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center"
            title={t("call.addParticipant")}
          >
            <UserPlus size={14} />
          </button>
        )}
      </div>

      {/* Participant grid */}
      <div className="flex-1 p-2 overflow-hidden">
        <div
          className="grid gap-2 h-full"
          style={{ gridTemplateColumns: `repeat(${tileCols}, 1fr)` }}
        >
          {participants.map((p) => (
            <ParticipantTile key={p.jid} participant={p} isVideo={isVideo} />
          ))}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-4 py-6 bg-black/80">
        <button
          onClick={handleMute}
          className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
            muted ? "bg-red-500/30 text-red-300" : "bg-white/10 text-white hover:bg-white/20"
          }`}
        >
          {muted ? <MicOff size={22} /> : <Mic size={22} />}
        </button>
        {isVideo && (
          <button
            onClick={handleVideo}
            className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
              videoOff ? "bg-red-500/30 text-red-300" : "bg-white/10 text-white hover:bg-white/20"
            }`}
          >
            {videoOff ? <VideoOff size={22} /> : <VideoIcon size={22} />}
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
      </div>

      {/* Add participant dialog */}
      {showAddDialog && (
        <div className="fixed inset-0 z-[51] bg-black/60 flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-surface-900 border-default rounded-xl p-4 flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-surface-50">{t("call.addParticipant")}</h3>
            <input
              type="text"
              value={newJid}
              onChange={(e) => setNewJid(e.target.value)}
              placeholder="user@domain.com"
              className="input-field text-sm"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowAddDialog(false)} className="btn-ghost text-sm">
                {t("common.cancel")}
              </button>
              <button onClick={handleAdd} disabled={!newJid} className="btn-primary text-sm">
                {t("call.invite")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ParticipantTile({ participant, isVideo }: { participant: GroupCallParticipant; isVideo: boolean }) {
  const { t } = useLanguage();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasStream, setHasStream] = useState(false);

  useEffect(() => {
    const session = participant.session;
    if (!session) return;
    session.on("stream.remote", (stream: MediaStream) => {
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setHasStream(true);
      }
    });
  }, [participant.session]);

  const stateLabel = participant.state === "joined" ? "" :
                     participant.state === "ringing" ? t("call.ringing") :
                     participant.state === "invited" ? t("call.connecting") :
                     participant.state === "declined" ? t("call.declined") :
                     t("call.ended");

  return (
    <div className="relative bg-surface-800 rounded-lg overflow-hidden flex items-center justify-center">
      {isVideo && hasStream ? (
        <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover" />
      ) : (
        <Avatar name={participant.jid} size="xl" className="scale-150" />
      )}
      <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
        <span className="text-xs text-white/90 px-2 py-0.5 rounded bg-black/50">
          {participant.jid.split("@")[0]}
        </span>
        {stateLabel && (
          <span className="text-[10px] text-white/70 px-2 py-0.5 rounded bg-black/50">
            {stateLabel}
          </span>
        )}
      </div>
    </div>
  );
}
