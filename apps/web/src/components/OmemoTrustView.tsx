/**
 * OmemoTrustView.tsx - OMEMO device trust UI.
 *
 * v1.7.0 adds a single trust-state model shared by the UI and the service
 * layer. The view shows the user's own fingerprint, an XMPP-style QR payload,
 * peer device records, and an explicit warning when a known device changes its
 * identity fingerprint.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { AlertTriangle, Shield, ShieldCheck, ShieldAlert, ShieldOff, QrCode, X } from "lucide-react";
import { getIdentityFingerprint } from "@/services/omemo";
import {
  listPeerDeviceTrustRecords,
  updatePeerDeviceTrustState,
  type DeviceRecord,
  type DeviceTrustState,
} from "@/services/omemoTrust";
import { useAccountStore } from "@/stores/accountStore";
import toast from "react-hot-toast";
import { useLanguage } from "@/utils/i18n";

type UiDeviceRecord = DeviceRecord & { displayFingerprint: string };

function compactFingerprint(value: string) {
  return value.replace(/\s+/g, "").toLowerCase();
}

function xmppFingerprintQrPayload(jid: string, deviceId: number | undefined, fingerprint: string) {
  const compact = compactFingerprint(fingerprint);
  if (!jid || !compact) return "";
  if (deviceId) {
    return `xmpp:${encodeURIComponent(jid)}?omemo-sid-${deviceId}=${encodeURIComponent(compact)}`;
  }
  return JSON.stringify({
    type: "liaot.omemo-fingerprint",
    version: 1,
    jid,
    fingerprint: compact,
  });
}

function trustIcon(state: DeviceTrustState, keyChanged?: boolean) {
  if (keyChanged) return <AlertTriangle size={14} className="text-warn mt-0.5" />;
  if (state === "verified") return <ShieldCheck size={14} className="text-success mt-0.5" />;
  if (state === "untrusted") return <ShieldOff size={14} className="text-warn mt-0.5" />;
  return <ShieldAlert size={14} className="text-warn/60 mt-0.5" />;
}

export default function OmemoTrustView({ peerJid, onClose }: { peerJid: string; onClose: () => void }) {
  const { t } = useLanguage();
  const accountId = useAccountStore((s) => s.activeAccountId);
  const account = useAccountStore((s) => s.accounts.find((a) => a.id === s.activeAccountId));
  const [devices, setDevices] = useState<UiDeviceRecord[]>([]);
  const [ownFingerprint, setOwnFingerprint] = useState("");
  const [ownDeviceId, setOwnDeviceId] = useState<number | undefined>();
  const [showQr, setShowQr] = useState(false);

  const qrPayload = useMemo(() => xmppFingerprintQrPayload(account?.jid ?? "", ownDeviceId, ownFingerprint), [account?.jid, ownDeviceId, ownFingerprint]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      const own = await getIdentityFingerprint(accountId);
      const ownDeviceRaw = localStorage.getItem(`liaot-e2ee-device:${accountId}`);
      const ownDevice = Number(ownDeviceRaw);
      const peerRecords = await listPeerDeviceTrustRecords(accountId, peerJid);
      const hydrated = peerRecords.map((record) => ({
        ...record,
        displayFingerprint: record.fingerprint || "(not yet established)",
      }));
      if (!cancelled) {
        setOwnFingerprint(own);
        setOwnDeviceId(Number.isFinite(ownDevice) && ownDevice > 0 ? ownDevice : undefined);
        setDevices(hydrated);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, peerJid]);

  const updateTrust = async (deviceId: number, state: DeviceTrustState) => {
    if (!accountId) return;
    const updated = await updatePeerDeviceTrustState(accountId, peerJid, deviceId, state);
    setDevices((items) => items.map((dev) => dev.deviceId === deviceId
      ? { ...dev, ...(updated ?? {}), trustState: state, keyChanged: state === "verified" ? false : dev.keyChanged }
      : dev));
    if (state === "verified") toast.success(t("omemo.deviceVerified"));
    if (state === "untrusted") toast(t("omemo.deviceUntrusted"));
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="w-full max-w-lg max-h-[80vh] overflow-y-auto rounded-xl bg-surface-900 border-default shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-subtle">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-accent-soft" />
            <h2 className="text-sm font-semibold text-surface-50">
              {t("omemo.trustTitle")}: {peerJid.split("@")[0]}
            </h2>
          </div>
          <button onClick={onClose} className="text-surface-200/40 hover:text-surface-50" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-3 border-b border-subtle">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-surface-200">
              {t("omemo.yourFingerprint")}{ownDeviceId ? ` · Device #${ownDeviceId}` : ""}
            </p>
            <button
              onClick={() => setShowQr(!showQr)}
              className="text-xs text-accent-soft hover:underline flex items-center gap-1"
            >
              <QrCode size={12} />
              {showQr ? t("omemo.hideQr") : t("omemo.showQr")}
            </button>
          </div>
          <p className="font-mono text-xs text-surface-50/80 whitespace-pre-wrap break-all inset-surface px-2 py-1.5 rounded">
            {ownFingerprint || t("omemo.fingerprintLoading")}
          </p>
          {showQr && qrPayload && (
            <div className="mt-3 flex flex-col items-center">
              <FingerprintQr data={qrPayload} />
              <p className="text-[10px] text-surface-200/40 mt-2">
                {t("omemo.qrInstructions")}
              </p>
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-b border-subtle bg-warn/5">
          <p className="text-xs text-surface-200/70 leading-relaxed">
            {t("omemo.keyChangeWarning")}
          </p>
        </div>

        <div className="flex-1">
          <p className="text-xs font-medium text-surface-200 px-4 pt-3 pb-2">
            {t("omemo.peerDevices")} ({devices.length})
          </p>
          {devices.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-surface-200/30">
              {t("omemo.noDevicesYet")}
            </div>
          ) : (
            <div className="flex flex-col">
              {devices.map((dev) => (
                <div key={dev.deviceId} className="flex items-start gap-3 px-4 py-3 border-t border-subtle">
                  {trustIcon(dev.trustState, dev.keyChanged)}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-surface-50">Device #{dev.deviceId}</p>
                    <p className="font-mono text-[10px] text-surface-200/50 whitespace-pre-wrap break-all mt-0.5">
                      {dev.displayFingerprint}
                    </p>
                    {dev.keyChanged && dev.previousFingerprint && (
                      <p className="text-[10px] text-warn mt-1">
                        {t("omemo.keyChanged")}: {dev.previousFingerprint}
                      </p>
                    )}
                    <p className="text-[10px] text-surface-200/40 mt-1">
                      {t(`omemo.trust.${dev.trustState}`)}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1">
                    {dev.trustState !== "verified" && (
                      <button
                        onClick={() => updateTrust(dev.deviceId, "verified")}
                        className="text-[10px] px-2 py-0.5 rounded bg-success/20 text-success hover:bg-success/30"
                      >
                        {t("omemo.verify")}
                      </button>
                    )}
                    {dev.trustState !== "untrusted" && (
                      <button
                        onClick={() => updateTrust(dev.deviceId, "untrusted")}
                        className="text-[10px] px-2 py-0.5 rounded bg-warn/20 text-warn hover:bg-warn/30"
                      >
                        {t("omemo.untrust")}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FingerprintQr({ data }: { data: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [qrReady, setQrReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    setQrReady(false);
    QRCode.toCanvas(canvas, data, {
      errorCorrectionLevel: "M",
      margin: 2,
      scale: 6,
      color: { dark: "#0f172a", light: "#ffffff" },
    })
      .then(() => {
        if (!cancelled) setQrReady(true);
      })
      .catch(() => {
        if (!cancelled) setQrReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, [data]);

  return (
    <div className="w-36 h-36 bg-white p-2 rounded flex items-center justify-center">
      <canvas
        ref={canvasRef}
        aria-label="OMEMO fingerprint QR"
        className={`w-full h-full${qrReady ? "" : " hidden"}`}
      />
      {!qrReady && (
        <QrCode size={28} className="text-surface-900" />
      )}
    </div>
  );
}
