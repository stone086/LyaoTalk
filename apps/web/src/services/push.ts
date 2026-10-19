/**
 * push.ts - PWA Web Push notification helper.
 *
 * Workflow:
 *   1. Request notification permission from user
 *   2. Register Service Worker
 *   3. Fetch VAPID public key from backend
 *   4. Subscribe to PushManager
 *   5. Send subscription to backend
 *
 * The Service Worker handles incoming push events and shows desktop
 * notifications. Clicking the notification opens the relevant chat.
 */

import { api } from "./api";
import { getClient } from "./xmppAdapter";
import { useAccountStore } from "@/stores/accountStore";
import { collectBrowserCapabilities } from "./browserCompatibility";

const PUSH_NODE_KEY = "lyaotalk:push-node:";
const enabledKey = (accountId: string) => `lyaotalk:push-enabled:${accountId}`;

function pushNode(accountId: string): string {
  const key = `${PUSH_NODE_KEY}${accountId}`;
  let node = localStorage.getItem(key);
  if (!node || !/^[a-zA-Z0-9_-]{1,128}$/.test(node)) {
    node = crypto.randomUUID();
    localStorage.setItem(key, node);
  }
  return node;
}

function selectedAccount(): string | null {
  return useAccountStore.getState().activeAccountId;
}

/** XEP-0357 registrations are session-bound, so restore them on reconnect. */
export async function restoreXmppPush(accountId: string): Promise<void> {
  if (localStorage.getItem(enabledKey(accountId)) !== "1") return;
  if (!(await isPushSupported())) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  const client = getClient(accountId);
  if (!subscription || !client?.connected) return;
  await client.setPushEnabled(true, pushNode(accountId));
  await registerBackendSubscription(accountId, subscription);
}

async function registerBackendSubscription(accountId: string, subscription: PushSubscription): Promise<void> {
  const p256dhBuf = subscription.getKey("p256dh");
  const authBuf = subscription.getKey("auth");
  if (!p256dhBuf || !authBuf) throw new Error("Push subscription keys unavailable");
  await api.post("/push/subscribe", {
    endpoint: subscription.endpoint,
    node: pushNode(accountId),
    p256dh: arrayBufferToBase64(p256dhBuf),
    auth: arrayBufferToBase64(authBuf),
    user_agent: navigator.userAgent,
  }, { headers: { "X-LyaoTalk-Account-Id": accountId } });
}

function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray.buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export async function isPushSupported(): Promise<boolean> {
  const browser = collectBrowserCapabilities();
  return (
    (!browser.isIOS || browser.isStandalonePwa) &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!("Notification" in window)) return "denied";
  return await withTimeout(Notification.requestPermission(), "Notification permission timed out");
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), 15000);
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error); },
    );
  });
}

export async function subscribeToPush(): Promise<boolean> {
  if (!(await isPushSupported())) return false;

  const accountId = selectedAccount();
  const client = accountId ? getClient(accountId) : undefined;
  if (!accountId || !client?.connected) return false;

  const permission = await requestNotificationPermission();
  if (permission !== "granted") return false;

  // Wait for SW registration
  const registration = await withTimeout(navigator.serviceWorker.ready, "Service Worker registration timed out");

  // Fetch VAPID public key from backend
  const { data } = await api.get<{ key: string }>("/push/vapid-public-key");
  if (!data.key) return false;

  const applicationServerKey = urlBase64ToArrayBuffer(data.key);

  // Subscribe (or get existing subscription)
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
  }

  // Extract keys
  await registerBackendSubscription(accountId, subscription);

  try {
    await client.setPushEnabled(true, pushNode(accountId));
  } catch {
    await api.delete("/push/unsubscribe", {
      data: { endpoint: subscription.endpoint },
      headers: { "X-LyaoTalk-Account-Id": accountId },
    }).catch(() => {});
    return false;
  }
  localStorage.setItem(enabledKey(accountId), "1");

  return true;
}

export async function unsubscribeFromPush(targetAccountId?: string): Promise<boolean> {
  const accountId = targetAccountId ?? selectedAccount();
  if (!accountId) return false;
  if (!("serviceWorker" in navigator)) return false;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    localStorage.removeItem(enabledKey(accountId));
    return true;
  }

  const client = getClient(accountId);
  if (client?.connected) {
    try { await client.setPushEnabled(false, pushNode(accountId)); }
    catch { return false; }
  }

  try {
    await api.delete("/push/unsubscribe", {
      data: { endpoint: subscription.endpoint },
      headers: { "X-LyaoTalk-Account-Id": accountId },
    });
  } catch { return false; }
  localStorage.removeItem(enabledKey(accountId));
  const otherEnabled = useAccountStore.getState().accounts.some(
    (account) => account.id !== accountId && localStorage.getItem(enabledKey(account.id)) === "1",
  );
  return otherEnabled || await subscription.unsubscribe();
}

export async function isPushSubscribed(): Promise<boolean> {
  const accountId = selectedAccount();
  if (!accountId || localStorage.getItem(enabledKey(accountId)) !== "1") return false;
  if (!(await isPushSupported())) return false;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return subscription !== null;
  } catch {
    return false;
  }
}
