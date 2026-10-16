const OMEMO_ENABLED_KEY = "liaot-omemo-enabled";
const OMEMO_EVENT = "lyaotalk:omemo-enabled-change";

export function getOmemoEnabled(): boolean {
  return localStorage.getItem(OMEMO_ENABLED_KEY) !== "0";
}

/** Group encryption is opt-in per room to avoid changing existing plaintext rooms. */
export function getGroupOmemoEnabled(accountId: string, roomJid: string): boolean {
  return localStorage.getItem(`lyaotalk:group-omemo:${accountId}:${roomJid.toLowerCase()}`) === "1";
}

export function setGroupOmemoEnabled(accountId: string, roomJid: string, enabled: boolean): void {
  localStorage.setItem(`lyaotalk:group-omemo:${accountId}:${roomJid.toLowerCase()}`, enabled ? "1" : "0");
}

export function setOmemoEnabled(enabled: boolean) {
  localStorage.setItem(OMEMO_ENABLED_KEY, enabled ? "1" : "0");
  window.dispatchEvent(new CustomEvent(OMEMO_EVENT, { detail: enabled }));
}

export function onOmemoEnabledChange(handler: (enabled: boolean) => void) {
  const onCustom = (event: Event) => {
    const next = (event as CustomEvent<boolean>).detail;
    handler(!!next);
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === OMEMO_ENABLED_KEY) handler(getOmemoEnabled());
  };
  window.addEventListener(OMEMO_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(OMEMO_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}
