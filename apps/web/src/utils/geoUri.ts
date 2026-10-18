/** RFC 5870 WGS-84 geo URI carried as an XMPP message body. */
export function parseGeoUri(value: string): { latitude: number; longitude: number; mapUrl: string } | null {
  const match = /^geo:([+-]?(?:\d+(?:\.\d+)?|\.\d+)),([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:,[+-]?(?:\d+(?:\.\d+)?|\.\d+))?(?:;u=(?:\d+(?:\.\d+)?|\.\d+))?$/i.exec(value.trim());
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return {
    latitude,
    longitude,
    mapUrl: `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`,
  };
}
