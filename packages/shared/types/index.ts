// Shared types used across frontend and plugin-sdk

export interface JID {
  local: string;
  domain: string;
  resource?: string;
  toString: () => string;
}

export function parseJID(jid: string): JID {
  const [localDomain, resource] = jid.split("/");
  const [local, domain] = localDomain.split("@");
  return {
    local: local ?? "",
    domain: domain ?? localDomain,
    resource,
    toString: () => jid,
  };
}

export type Presence = "available" | "away" | "dnd" | "xa" | "unavailable";

export interface XmppCapabilities {
  mam: boolean;
  omemo: boolean;
  httpUpload: boolean;
  muc: boolean;
  carbons: boolean;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
