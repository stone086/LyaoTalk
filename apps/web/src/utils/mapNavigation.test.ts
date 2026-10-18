import { describe, expect, it } from "vitest";
import { mapNavigationUrls } from "./mapNavigation";

describe("map app navigation links", () => {
  it("passes WGS-84 coordinates to iOS AMap and Baidu", () => {
    const urls = mapNavigationUrls(29.794495, 121.572255, true);
    expect(urls.amap).toContain("iosamap://navi?");
    expect(urls.amap).toContain("lat=29.794495&lon=121.572255&dev=1");
    expect(urls.baidu).toContain("bdapp://map/navi?");
    expect(urls.baidu).toContain("location=29.794495%2C121.572255&coord_type=wgs84");
  });

  it("uses the Android AMap scheme", () => {
    expect(mapNavigationUrls(29, 121, false).amap).toContain("androidamap://navi?");
  });
});
