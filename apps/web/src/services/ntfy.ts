import { api } from "./api";
import { getClient } from "./xmppAdapter";

export type NtfyStatus =
  | { enabled: false }
  | { enabled: true; node: string; topic: string; server: string };

const localNodeKey = (accountId: string) => `lyaotalk:ntfy-node:${accountId}`;
const pendingDisableKey = (accountId: string) => `lyaotalk:ntfy-disable:${accountId}`;
const accountHeader = (accountId: string) => ({ headers: { "X-LyaoTalk-Account-Id": accountId } });

export async function getNtfyStatus(accountId: string): Promise<NtfyStatus> {
  const { data } = await api.get<NtfyStatus>("/push/ntfy", accountHeader(accountId));
  return data;
}

export async function enableNtfy(accountId: string): Promise<NtfyStatus> {
  const client = getClient(accountId);
  if (!client?.connected) throw new Error("XMPP account is not connected");
  const { data } = await api.post<NtfyStatus>("/push/ntfy", {}, accountHeader(accountId));
  if (!data.enabled) throw new Error("ntfy setup failed");
  await client.setPushEnabled(true, data.node);
  localStorage.setItem(localNodeKey(accountId), data.node);
  return data;
}

export async function disableNtfy(accountId: string, node: string): Promise<void> {
  const client = getClient(accountId);
  if (client?.connected) {
    await client.setPushEnabled(false, node);
  } else {
    localStorage.setItem(pendingDisableKey(accountId), node);
  }
  await api.delete("/push/ntfy", accountHeader(accountId));
  localStorage.removeItem(localNodeKey(accountId));
}

export async function testNtfy(accountId: string): Promise<void> {
  await api.post("/push/ntfy/test", {}, accountHeader(accountId));
}

export async function restoreNtfyPush(accountId: string): Promise<void> {
  const client = getClient(accountId);
  if (!client?.connected) return;
  const stale = localStorage.getItem(pendingDisableKey(accountId));
  if (stale) {
    await client.setPushEnabled(false, stale);
    localStorage.removeItem(pendingDisableKey(accountId));
  }
  const node = localStorage.getItem(localNodeKey(accountId));
  if (node) await client.setPushEnabled(true, node);
}
