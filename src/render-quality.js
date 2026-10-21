// Full-resolution contact shading is a fallback for views without a valid light bake.
// N8AO's neural preset requires 16 AO taps, a 12px denoise radius and two passes.
// Keep these fixed while moving: recompiling or changing modes per frame causes hitches/pops.
export const CONTACT_AO = Object.freeze({
  aoRadius: 0.15,
  distanceFalloff: 1,
  intensity: 1.15,
  aoSamples: 16,
  denoiseSamples: 4,
  denoiseRadius: 12,
  denoiseIterations: 2,
  halfRes: false,
  neuralDenoise: true,
  accumulate: false,
  gammaCorrection: false,
  transparencyAware: true,
})

export function needsContactAO({ enabled, baked, pathTracing }) {
  // A bake already contains occlusion; multiplying another AO layer over it makes corners dirty.
  return enabled && !baked && !pathTracing
}

// Three r182+ rotates its PCF taps using screen-pixel noise. That moves across the room
// with the camera, making otherwise static shadow boundaries crawl. Use a fixed light-space
// 2x2 footprint instead. Each hardware comparison is bilinear (four depth comparisons):
// four lookups give 16 filtered comparisons without random rotation or temporal history.
export function installStableShadowFilter(THREE) {
  const source = THREE.ShaderChunk.shadowmap_pars_fragment
  if (source.includes('HOMEVISUAL_STABLE_PCF')) return true
  const branch = source.indexOf('#if defined( SHADOWMAP_TYPE_PCF )')
  const start = source.indexOf('vec2 texelSize = vec2( 1.0 ) / shadowMapSize;', branch)
  const endToken = ') * 0.2;'
  const end = source.indexOf(endToken, start)
  const nextBranch = source.indexOf('#elif defined( SHADOWMAP_TYPE_VSM )', branch)
  if (branch < 0 || start < 0 || end < 0 || nextBranch < end) return false
  const filter = `// HOMEVISUAL_STABLE_PCF: fixed taps in the light's texture coordinates.
                vec2 offset = vec2( 0.5 * shadowRadius ) / shadowMapSize;
                shadow = (
                  texture( shadowMap, vec3( shadowCoord.xy + vec2( -offset.x, -offset.y ), shadowCoord.z ) ) +
                  texture( shadowMap, vec3( shadowCoord.xy + vec2(  offset.x, -offset.y ), shadowCoord.z ) ) +
                  texture( shadowMap, vec3( shadowCoord.xy + vec2( -offset.x,  offset.y ), shadowCoord.z ) ) +
                  texture( shadowMap, vec3( shadowCoord.xy + vec2(  offset.x,  offset.y ), shadowCoord.z ) )
                ) * 0.25;`
  THREE.ShaderChunk.shadowmap_pars_fragment = source.slice(0, start) + filter + source.slice(end + endToken.length)
  return true
}
