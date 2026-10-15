/**
 * crossDeviceSync.ts - Sync user metadata across all signed-in devices
 * via PEP private nodes.
 *
 * This is what Conversations doesn't have: when you star a message on
 * your phone, it's instantly starred on your laptop. When you read up to
 * message X on your phone, your laptop's red dot disappears.
 *
 * What we sync:
 *   - Drafts                (per-conversation)
 *   - Starred messages       (set of message IDs)
 *   - Last-read position     (per-conversation, message ID + timestamp)
 *   - Pinned conversations   (set of conversation IDs)
 *
 * What we DON'T sync (intentionally):
 *   - Private theme/density preferences (per-device customization)
 *   - Local notification settings        (per-device)
 *   - Login credentials                   (security)
 *
 * PEP node: liaot:sync:v1
 * Item ID:  one of "drafts", "starred", "read-positions", "pinned"
 *
 * Sync strategy: last-write-wins on each item, with a Lamport clock
 * to detect concurrent edits.
 */

const NS_SYNC = "liaot:sync:v1";

export interface SyncSnapshot {
  drafts: Record<string, string>;                       // convId -> text
  starred: string[];                                     // message IDs
  readPositions: Record<string, { messageId: string; ts: number }>;
  pinned: string[];                                      // conversation IDs
  metaContacts?: { metas: any; jidToMeta: any };         // meta-contact groups
  clock: number;
  updatedAt: number;
}

export class CrossDeviceSync {
  private xmppClient: any;
  private accountId: string;
  private localClock = 0;
  private remoteClock = 0;

  constructor(accountId: string, xmppClient: any) {
    this.accountId = accountId;
    this.xmppClient = xmppClient;
  }

  /**
   * Pull the latest sync state from PEP.
   * Should be called once after XMPP connect to bootstrap local state.
   */
  async pullSnapshot(): Promise<Partial<SyncSnapshot> | null> {
    if (!this.xmppClient?.fetchPepNode) return null;
    try {
      const result = await this.xmppClient.fetchPepNode(
        this.xmppClient.config?.jid?.split("/")[0] ?? "",
        NS_SYNC
      );
      if (!result) return null;

      const items = result.querySelectorAll?.("item") ?? [];
      const snapshot: Partial<SyncSnapshot> = {};
      items.forEach((item: Element) => {
        const id = item.getAttribute("id") ?? "";
        const dataEl = item.querySelector("data");
        if (!dataEl?.textContent) return;
        try {
          const data = JSON.parse(dataEl.textContent);
          if (id === "drafts") snapshot.drafts = data.drafts;
          else if (id === "starred") snapshot.starred = data.ids;
          else if (id === "read-positions") snapshot.readPositions = data.positions;
          else if (id === "pinned") snapshot.pinned = data.ids;
          else if (id === "meta-contacts") snapshot.metaContacts = { metas: data.metas, jidToMeta: data.jidToMeta };
          if (data.clock && data.clock > this.remoteClock) this.remoteClock = data.clock;
        } catch { /* ignore malformed */ }
      });
      return snapshot;
    } catch {
      return null;
    }
  }

  private async pushItem(itemId: string, data: any): Promise<void> {
    if (!this.xmppClient?.publishPepNode) return;
    this.localClock = Math.max(this.localClock, this.remoteClock) + 1;
    const payload = { ...data, clock: this.localClock, updatedAt: Date.now() };
    try {
      await this.xmppClient.publishPepNode(NS_SYNC, {
        type: "raw",
        xml: `<data>${JSON.stringify(payload).replace(/[<>&]/g, "")}</data>`,
      }, itemId);
    } catch {
      // Non-fatal: server might not support PEP, sync degrades to local-only
    }
  }

  async pushDrafts(drafts: Record<string, string>) {
    return this.pushItem("drafts", { drafts });
  }

  async pushStarred(messageIds: string[]) {
    return this.pushItem("starred", { ids: messageIds });
  }

  async pushReadPositions(positions: Record<string, { messageId: string; ts: number }>) {
    return this.pushItem("read-positions", { positions });
  }

  async pushPinned(conversationIds: string[]) {
    return this.pushItem("pinned", { ids: conversationIds });
  }

  async pushMetaContacts(metas: any, jidToMeta: any) {
    return this.pushItem("meta-contacts", { metas, jidToMeta });
  }
}

let _instance: CrossDeviceSync | null = null;

export function initCrossDeviceSync(accountId: string, xmppClient: any) {
  _instance = new CrossDeviceSync(accountId, xmppClient);
  return _instance;
}

export function getCrossDeviceSync(): CrossDeviceSync | null {
  return _instance;
}
