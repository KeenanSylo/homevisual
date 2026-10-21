import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { installStableShadowFilter, needsContactAO } from '../src/render-quality.js'

test('a valid bake or path tracing prevents adding a second contact-shadow layer', () => {
  for (const enabled of [false, true]) for (const baked of [false, true]) for (const pathTracing of [false, true]) {
    assert.equal(needsContactAO({ enabled, baked, pathTracing }), enabled && !baked && !pathTracing)
  }
})

test('the installed Three.js shader receives camera-independent PCF without modifying other shadow modes', () => {
  const original = THREE.ShaderChunk.shadowmap_pars_fragment
  const chunks = { ShaderChunk: { shadowmap_pars_fragment: original } }
  assert.ok(installStableShadowFilter(chunks), 'Three.js changed its shadow kernel; review the integration')
  const patched = chunks.ShaderChunk.shadowmap_pars_fragment
  const pcf = patched.slice(patched.indexOf('#if defined( SHADOWMAP_TYPE_PCF )'), patched.indexOf('#elif defined( SHADOWMAP_TYPE_VSM )'))
  assert.ok(!pcf.includes('gl_FragCoord'), 'sunlight filtering must not follow screen pixels')
  assert.equal((pcf.match(/texture\( shadowMap/g) || []).length, 4)
  const otherModes = (source) => source.slice(source.indexOf('#elif defined( SHADOWMAP_TYPE_VSM )'))
  assert.equal(otherModes(patched), otherModes(original))
  assert.ok(installStableShadowFilter(chunks))
  assert.equal(chunks.ShaderChunk.shadowmap_pars_fragment, patched)
})

test('an unfamiliar shader is left intact rather than partially patched', () => {
  const chunks = { ShaderChunk: { shadowmap_pars_fragment: 'unfamiliar future implementation' } }
  assert.equal(installStableShadowFilter(chunks), false)
  assert.equal(chunks.ShaderChunk.shadowmap_pars_fragment, 'unfamiliar future implementation')
})
