/** RFC 5870 WGS-84 geo URI carried as an XMPP message body. */
export function parseGeoUri(value: string): { latitude: number; longitude: number } | null {
  const match = /^geo:([+-]?(?:\d+(?:\.\d+)?|\.\d+)),([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:,[+-]?(?:\d+(?:\.\d+)?|\.\d+))?(?:;u=(?:\d+(?:\.\d+)?|\.\d+))?$/i.exec(value.trim());
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

/** Read old LyaoTalk AMap marker messages without sending users to AMap. */
export function parseSharedLocation(value: string): { latitude: number; longitude: number } | null {
  const geo = parseGeoUri(value);
  if (geo) return geo;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "uri.amap.com" || url.pathname !== "/marker") return null;
  if (url.searchParams.get("coordinate")?.toLowerCase() !== "wgs84") return null;
  const position = url.searchParams.get("position");
  if (!position) return null;
  const match = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)),([+-]?(?:\d+(?:\.\d+)?|\.\d+))$/.exec(position);
  if (!match) return null;
  return parseGeoUri(`geo:${match[2]},${match[1]}`);
}
