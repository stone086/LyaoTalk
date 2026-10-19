import { getAccountPassword, useAccountStore } from "@/stores/accountStore";
import { useChatStore } from "@/stores/chatStore";
import { useRosterStore } from "@/stores/rosterStore";
import { authApi, clearUserToken, getUserRefreshToken } from "./api";
import { destroyClient } from "./xmppAdapter";
import { markIntentionalDisconnect, unsuperviseConnection } from "./connectionSupervisor";
import { apiSocket } from "./apiSocket";
import { clearLocalAccountData, sealLocalAccountHistory } from "./localDb";
import { revokeAllAesgcmBlobs } from "./aesgcmMedia";
import { unsubscribeFromPush } from "./push";

/** End one account session while leaving every other account connected. */
export async function logoutAccount(accountId: string): Promise<{ remoteRevoked: boolean }> {
  const password = getAccountPassword(accountId);
  if (password) {
    // If sealing fails, keep the session intact rather than discard the only
    // locally decrypted copy of messages that OMEMO cannot replay.
    await sealLocalAccountHistory(accountId, password);
  }
  await unsubscribeFromPush(accountId).catch(() => {});
  const refresh = getUserRefreshToken(accountId);
  let remoteRevoked = false;
  try {
    await authApi.logout(refresh ?? undefined, accountId);
    remoteRevoked = true;
  } catch {
    // Local sign-out must still work when the API is unavailable.
  }
  markIntentionalDisconnect(accountId);
  destroyClient(accountId);
  apiSocket.disconnectAccount(accountId);
  unsuperviseConnection(accountId);
  clearUserToken(accountId);
  useChatStore.getState().clearAccountData(accountId);
  useRosterStore.getState().clearAccountData(accountId);
  revokeAllAesgcmBlobs();
  await clearLocalAccountData(accountId).catch(() => {});
  useAccountStore.getState().removeAccount(accountId);
  return { remoteRevoked };
}
