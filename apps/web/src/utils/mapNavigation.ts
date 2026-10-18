/** geo: coordinates are WGS-84. Tell each map app the source datum explicitly. */
export function mapNavigationUrls(latitude: number, longitude: number, isIos: boolean) {
  const coordinates = `${latitude},${longitude}`;
  const amapScheme = isIos ? "iosamap" : "androidamap";
  const amap = `${amapScheme}://navi?${new URLSearchParams({
    sourceApplication: "LyaoTalk",
    poiname: "目的地",
    lat: String(latitude),
    lon: String(longitude),
    dev: "1",
    style: "2",
  })}`;
  // Baidu documents bdapp:// for links opened from a mobile browser.
  const baidu = `bdapp://map/navi?${new URLSearchParams({
    location: coordinates,
    coord_type: "wgs84",
    src: "webapp.lyaotalk.web",
  })}`;
  return { amap, baidu };
}
