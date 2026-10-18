import { describe, expect, it } from "vitest";
import { parseGeoUri } from "./geoUri";

describe("geo URI location messages", () => {
  it("recognizes the coordinates sent by native XMPP clients", () => {
    expect(parseGeoUri("geo:29.794495128392455,121.57225472586498")).toMatchObject({
      latitude: 29.794495128392455,
      longitude: 121.57225472586498,
    });
  });

  it("accepts valid optional altitude and uncertainty", () => {
    expect(parseGeoUri("geo:-33.5,151.2,15;u=25")).toEqual({ latitude: -33.5, longitude: 151.2 });
  });

  it("rejects invalid coordinates and extra URI content", () => {
    expect(parseGeoUri("geo:91,0")).toBeNull();
    expect(parseGeoUri("geo:0,181")).toBeNull();
    expect(parseGeoUri("geo:29,121;u=1;crs=unknown")).toBeNull();
    expect(parseGeoUri("geo:29,121\nhttps://example.com")).toBeNull();
  });
});
