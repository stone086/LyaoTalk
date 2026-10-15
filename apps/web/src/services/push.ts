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
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!("Notification" in window)) return "denied";
  return await Notification.requestPermission();
}

export async function subscribeToPush(): Promise<boolean> {
  if (!(await isPushSupported())) return false;

  const permission = await requestNotificationPermission();
  if (permission !== "granted") return false;

  // Wait for SW registration
  const registration = await navigator.serviceWorker.ready;

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
  const p256dhBuf = subscription.getKey("p256dh");
  const authBuf = subscription.getKey("auth");
  if (!p256dhBuf || !authBuf) return false;

  // Send to backend
  await api.post("/push/subscribe", {
    endpoint: subscription.endpoint,
    p256dh: arrayBufferToBase64(p256dhBuf),
    auth: arrayBufferToBase64(authBuf),
    user_agent: navigator.userAgent,
  });

  return true;
}

export async function unsubscribeFromPush(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return true;

  try {
    await api.delete("/push/unsubscribe", {
      data: { endpoint: subscription.endpoint },
    });
  } catch { /* non-fatal */ }
  return await subscription.unsubscribe();
}

export async function isPushSubscribed(): Promise<boolean> {
  if (!(await isPushSupported())) return false;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return subscription !== null;
  } catch {
    return false;
  }
}
