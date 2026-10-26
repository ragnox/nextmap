// Terrain shaders. Every drawn node is a 64 x 64 grid (plus skirts) whose heights come from the DEM texture of the
// nearest loaded tile at or above it, so a node can draw with its parent's data while its own is still loading.
// Imagery, Sentinel-2, overlays and normals are sampled from their own (possibly ancestor) tiles through uv transforms.

export const terrainVertex = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform vec4 uNode;          // world x, z of the node's north-west corner, node size (m), skirt depth (m)
uniform sampler2D uDem;      // R32F, 259 x 259: 257 samples edge to edge plus a one-sample border
uniform vec4 uDemXf;         // node uv -> DEM tile uv: offset.xy, scale.zw
uniform float uEarthR;
varying vec2 vUv;            // node uv
varying vec3 vWorld;
varying float vHeight;

float demAt(vec2 uv) {
  vec2 t = 1.0 + uv * 256.0;
  ivec2 i = clamp(ivec2(floor(t)), ivec2(0), ivec2(257));
  vec2 f = t - vec2(i);
  float a = texelFetch(uDem, i, 0).r, b = texelFetch(uDem, i + ivec2(1, 0), 0).r;
  float c = texelFetch(uDem, i + ivec2(0, 1), 0).r, d = texelFetch(uDem, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

#include <logdepthbuf_pars_vertex>
void main() {
  vUv = position.xy;
  float h = demAt(uDemXf.xy + position.xy * uDemXf.zw);
  vec3 wp = vec3(uNode.x + position.x * uNode.z, h, uNode.y + position.y * uNode.z);
  vHeight = h;
  if (position.z > 0.5) wp.y -= uNode.w;
  vWorld = wp;
  // the earth's curvature, seen from the camera
  vec2 d = wp.xz - cameraPosition.xz;
  wp.y -= dot(d, d) / (2.0 * uEarthR);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  #include <logdepthbuf_vertex>
}
`;

export const terrainFragment = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D uDem;
uniform vec4 uDemXf;
uniform sampler2D uNormal;   // RGBA8 257 x 257: normal x, z
uniform vec4 uNormalXf;
uniform sampler2D uImg;      // orthophoto
uniform vec4 uImgXf;
uniform sampler2D uS2;       // Sentinel-2 of the season (see below)
uniform vec4 uS2Xf;
uniform float uHasS2;
uniform sampler2D uTiris;    // Land Tirol overlay (transparent)
uniform vec4 uTirisXf;
uniform float uHasTiris;
uniform sampler2D uHybrid;   // roads, tracks and trails (transparent)
uniform vec4 uHybridXf;
uniform float uHasHybrid;
uniform sampler2D uRoutes;   // routes drawn for this tile (transparent)
uniform vec4 uRoutesXf;
uniform float uHasRoutes;

uniform int uSeason;         // 0 summer, 1 winter
uniform int uImagery;        // 0 orthophoto, 1 Sentinel-2 of the season
uniform float uSlope;        // slope-angle overlay opacity
uniform float uContours;     // contour line opacity
uniform float uContourStep;
uniform vec3 uSunDir;
uniform float uRelief;
uniform vec3 uHazeColor;
uniform float uHazeDensity;
uniform float uTileTint;     // debug: tint by tile
varying vec2 vUv;
varying vec3 vWorld;
varying float vHeight;

float demAt(vec2 uv) {
  vec2 t = 1.0 + uv * 256.0;
  ivec2 i = clamp(ivec2(floor(t)), ivec2(0), ivec2(257));
  vec2 f = t - vec2(i);
  float a = texelFetch(uDem, i, 0).r, b = texelFetch(uDem, i + ivec2(1, 0), 0).r;
  float c = texelFetch(uDem, i + ivec2(0, 1), 0).r, d = texelFetch(uDem, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
vec2 xf(vec4 t) { return t.xy + vUv * t.zw; }

vec3 slopeColor(float deg, out float a) {
  // avalanche terrain classes as used in Austrian maps: 30-35 yellow, 35-40 orange, 40-45 red, >45 violet
  a = smoothstep(26.5, 27.5, deg);
  if (deg < 30.0) return vec3(0.75, 0.9, 0.35);
  if (deg < 35.0) return vec3(1.0, 0.86, 0.1);
  if (deg < 40.0) return vec3(1.0, 0.52, 0.05);
  if (deg < 45.0) return vec3(0.9, 0.12, 0.1);
  return vec3(0.55, 0.2, 0.75);
}

#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec2 nuv = (xf(uNormalXf) * 256.0 + 0.5) / 257.0;
  vec2 nxz = texture2D(uNormal, nuv).rg * 2.0 - 1.0;
  vec3 n = normalize(vec3(nxz.x, sqrt(max(1.0 - dot(nxz, nxz), 0.0)), nxz.y));
  float slopeDeg = degrees(acos(clamp(n.y, 0.0, 1.0)));

  vec3 ortho = texture2D(uImg, xf(uImgXf)).rgb;
  // Sentinel-2 tiles carry the snow fraction in alpha: 0 = no data, 1..255 = no snow .. all snow
  vec4 s2 = vec4(0.0);
  float sa = 0.0;
  if (uHasS2 > 0.5) {
    // soften the 10-20 m pixels: a small cross of samples around the point
    vec2 su = xf(uS2Xf), d = vec2(0.7 / 256.0, 0.0);
    s2 = texture2D(uS2, su);
    sa = (2.0 * s2.a + texture2D(uS2, su + d).a + texture2D(uS2, su - d).a + texture2D(uS2, su + d.yx).a + texture2D(uS2, su - d.yx).a) / 6.0;
  }
  float s2ok = step(0.5 / 255.0, s2.a);
  float snow = clamp((sa * 255.0 - 1.0) / 254.0, 0.0, 1.0) * s2ok;
  vec3 albedo = ortho;
  float snowAmt = 0.0;
  if (uImagery == 1 && s2ok > 0.5) {
    albedo = s2.rgb * 1.25;
    snowAmt = snow * 0.5;
  } else if (uSeason == 1) {
    // winter from the summer orthophoto: snow where Sentinel-2 saw it, rock walls too steep to hold it stay bare,
    // and a little of the photo's texture shows through
    // where Sentinel-2 sees partial snow, the orthophoto decides at its own resolution: dark tree crowns stay
    // trees, open ground takes the snow
    float l = dot(ortho, vec3(0.3, 0.59, 0.11));
    float refined = clamp(snow * 1.6 - 0.3 + (l - 0.07) * 4.0, 0.0, 1.0) * step(0.04, snow);
    snowAmt = refined * (1.0 - smoothstep(48.0, 62.0, slopeDeg));
    vec3 snowCol = vec3(0.9, 0.93, 0.97) * (0.92 + 0.16 * smoothstep(0.02, 0.35, l));
    albedo = mix(ortho * vec3(0.82, 0.86, 0.92), snowCol, snowAmt);
  }
  // light: the photos already carry the sun of their flight, so they only get some extra relief; snow is lit fully,
  // with a bluish sky light in the shadows
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 lit = vec3(0.50, 0.57, 0.72) * (0.32 + 0.18 * n.y) + vec3(1.0, 0.97, 0.92) * ndl * 0.82;
  vec3 col = mix(albedo * mix(1.0, 0.55 + 0.6 * ndl, uRelief), albedo * lit * 1.05, snowAmt);
  float shade = 0.55 + 0.6 * ndl;

  if (uSlope > 0.0) {
    float a; vec3 sc = slopeColor(slopeDeg, a);
    col = mix(col, sc * (0.55 + 0.45 * shade), a * uSlope);
  }
  if (uContours > 0.0) {
    float h = demAt(xf(uDemXf));
    float w = max(fwidth(h), 1e-3);
    float major = uContourStep * 5.0;
    float dMinor = abs(fract(h / uContourStep + 0.5) - 0.5) * uContourStep / w;
    float dMajor = abs(fract(h / major + 0.5) - 0.5) * major / w;
    // lines fade out where they would be closer than a few pixels on screen (steep walls, far away)
    float minor = (1.0 - smoothstep(0.4, 1.1, dMinor)) * smoothstep(5.0, 10.0, uContourStep / w) * 0.5;
    float majorL = (1.0 - smoothstep(0.6, 1.5, dMajor)) * smoothstep(5.0, 10.0, major / w);
    col = mix(col, vec3(0.32, 0.18, 0.06), max(minor, majorL) * uContours);
  }
  if (uHasTiris > 0.5) {
    vec4 t = texture2D(uTiris, xf(uTirisXf));
    col = mix(col, t.rgb, t.a * 0.95);
  }
  if (uHasHybrid > 0.5) {
    vec4 hy = texture2D(uHybrid, xf(uHybridXf));
    col = mix(col, hy.rgb, hy.a);
  }
  if (uHasRoutes > 0.5) {
    vec4 r = texture2D(uRoutes, xf(uRoutesXf));
    col = mix(col, r.rgb, r.a);
  }
  if (uTileTint > 0.0) col = mix(col, fract(vec3(uDemXf.z * 7.1, uDemXf.z * 3.3, uDemXf.z * 11.7)), 0.25 * uTileTint);

  float dist = length(vWorld - cameraPosition);
  float haze = 1.0 - exp(-dist * uHazeDensity);
  col = mix(col, uHazeColor, haze * 0.8);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;
