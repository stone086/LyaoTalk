/**
 * groupStore — Tracks MUC (XEP-0045) rooms per account.
 *
 * Source-of-truth distinction:
 *   - `joinState: "idle"`     — room is known (e.g. invite received, public
 *                               directory hit) but we are NOT a member
 *   - `joinState: "joining"`  — join presence sent, awaiting server confirmation
 *   - `joinState: "joined"`   — server confirmed via self-presence (status 110)
 *   - `joinState: "kicked"`   — server removed us (kick / ban / shutdown)
 *   - `joinState: "destroyed"` — room was destroyed
 *   - `joinState: "error"`    — last join attempt failed
 *
 * The previous schema had a single `joined: boolean` flag that the UI
 * flipped immediately on `joinRoom()` call, leading to "frontend has the
 * group but the backend has no room" ghost states. The new state machine
 * is driven entirely by server events; the UI MUST NOT mutate joinState
 * directly.
 *
 * Storage key: `${accountId}::${roomJid}` so the same room joined from
 * two accounts (different nicknames, different join states) doesn't collide.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type RoomJoinState =
  | "idle"
  | "joining"
  | "joined"
  | "kicked"
  | "destroyed"
  | "error";

export interface MucRoom {
  /** Composite key: `${accountId}::${jid}` */
  key: string;
  accountId: string;
  jid: string;
  name: string;
  nickname: string;
  description?: string;
  memberCount?: number;
  isPublic: boolean;
  joinState: RoomJoinState;
  /** Set when joinState = "error"; cleared on next attempt */
  lastError?: string;
  /** Set when joinState = "kicked" / "destroyed"; cleared on rejoin */
  lastRemovalReason?: string;
  subject?: string;
}

export interface MucMember {
  jid: string;
  nickname: string;
  role: "moderator" | "participant" | "visitor";
  affiliation: "owner" | "admin" | "member" | "none";
  presence: "available" | "away" | "unavailable";
}

interface GroupState {
  rooms: Record<string, MucRoom>;          // keyed by `${accountId}::${jid}`
  members: Record<string, MucMember[]>;    // keyed by `${accountId}::${jid}`

  upsertRoom: (room: Omit<MucRoom, "key"> & { key?: string }) => void;
  removeRoom: (accountId: string, jid: string) => void;
  setJoinState: (
    accountId: string,
    jid: string,
    state: RoomJoinState,
    extras?: { lastError?: string; lastRemovalReason?: string },
  ) => void;
  setMembers: (accountId: string, roomJid: string, members: MucMember[]) => void;
  updateRoomSubject: (accountId: string, roomJid: string, subject: string) => void;

  /** Get all rooms the user has actually joined (server-confirmed). */
  getJoinedRooms: (accountId: string) => MucRoom[];
  /** Get one room by composite key. */
  getRoom: (accountId: string, jid: string) => MucRoom | undefined;
  /** Erase all rooms for an account (logout / account removal). */
  clearAccountData: (accountId: string) => void;
}

const k = (accountId: string, jid: string) => `${accountId}::${jid}`;

export const useGroupStore = create<GroupState>()(
  persist(
    (set, get) => ({
      rooms: {},
      members: {},

      upsertRoom: (room) =>
        set((s) => {
          const key = room.key ?? k(room.accountId, room.jid);
          return { rooms: { ...s.rooms, [key]: { ...room, key } } };
        }),

      removeRoom: (accountId, jid) =>
        set((s) => {
          const key = k(accountId, jid);
          const nextRooms = { ...s.rooms };
          const nextMembers = { ...s.members };
          delete nextRooms[key];
          delete nextMembers[key];
          return { rooms: nextRooms, members: nextMembers };
        }),

      setJoinState: (accountId, jid, joinState, extras) =>
        set((s) => {
          const key = k(accountId, jid);
          const existing = s.rooms[key];
          if (!existing) return s;
          return {
            rooms: {
              ...s.rooms,
              [key]: {
                ...existing,
                joinState,
                lastError: extras?.lastError,
                lastRemovalReason: extras?.lastRemovalReason,
              },
            },
          };
        }),

      setMembers: (accountId, roomJid, members) =>
        set((s) => ({
          members: { ...s.members, [k(accountId, roomJid)]: members },
        })),

      updateRoomSubject: (accountId, roomJid, subject) =>
        set((s) => {
          const key = k(accountId, roomJid);
          const existing = s.rooms[key];
          if (!existing) return s;
          return { rooms: { ...s.rooms, [key]: { ...existing, subject } } };
        }),

      getJoinedRooms: (accountId) => {
        const all = get().rooms;
        return (Object.values(all) as MucRoom[]).filter(
          (r) => r.accountId === accountId && r.joinState === "joined",
        );
      },

      getRoom: (accountId, jid) => get().rooms[k(accountId, jid)],

      clearAccountData: (accountId) =>
        set((s) => {
          const nextRooms: Record<string, MucRoom> = {};
          const nextMembers: Record<string, MucMember[]> = {};
          for (const [key, room] of Object.entries(s.rooms) as [string, MucRoom][]) {
            if (room.accountId !== accountId) {
              nextRooms[key] = room;
            }
          }
          for (const [key, members] of Object.entries(s.members) as [string, MucMember[]][]) {
            if (!key.startsWith(`${accountId}::`)) {
              nextMembers[key] = members;
            }
          }
          return { rooms: nextRooms, members: nextMembers };
        }),
    }),
    { name: "liaot-groups" },
  ),
);
