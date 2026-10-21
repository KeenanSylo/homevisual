# Stable apartment lighting

## Diagnosis (2026-10-21)

The phone's dirty cabinet seams and ceiling corners were reproduced in the production build.
The raster pipeline added half-resolution N8AO with six samples, a 0.5 m radius and intensity 4.5
over a Cycles lightmap that already contained architectural occlusion. Disabling that pass removed
the broad dark patches. Raising resolution alone did not solve the shading problem.

Three r186 also rotates its PCF kernel using screen-space interleaved gradient noise. The filtering
pattern therefore changes at a fixed world point as the camera moves. This is separate from the
AO noise. Merely caching the sun's depth map does not eliminate noise in its sampling filter.

## Alternatives evaluated

| Approach | Benefit | Tradeoff / decision |
| --- | --- | --- |
| Increase samples on existing half-resolution AO | Less noise, minimal code changes | Retains broad double-darkening and half-resolution upscaling; rejected |
| Full-resolution, lower-intensity AO everywhere | Cleaner detail; tested conventional and neural denoising | Continues doing unnecessary work over valid bakes; used only as a fallback |
| Continuous path tracing | Physically richer lighting | Camera and geometry changes restart convergence; keep the existing experimental still-image workflow |
| Bake-aware hybrid (selected) | View-independent room light, live movable-object sun shadows, less GPU work on the main tour | Matching bake required for the cheapest path; automatic contact-AO fallback covers other apartments/times |

## Implementation

- `syncRasterLighting()` bypasses screen-space AO whenever a valid room bake is applied, or path
  tracing is selected. A normal scene render still preserves sunlight, reflections, transparency,
  furniture, and baked light probes. The decision follows the bake actually applied to geometry,
  rather than the user's bake preference alone.
- Without a matching bake, use N8AO's full-resolution neural denoiser at 16 AO samples / four denoise
  taps, two passes and radius 12, with a local 0.15 m occlusion radius and intensity 1.15. Parameters
  remain fixed while moving; no per-frame shader recompilation, quality popping or idle accumulation.
- Directional/spot PCF uses four fixed, light-space hardware comparison lookups. Hardware linear
  comparison filtering supplies four depth comparisons per lookup. No screen-space random rotation,
  history buffer or reprojection is required. VSM and point-shadow branches are untouched.
- Sun bias derives from shadow-texel world size and depth range, rather than a large fixed offset
  that can detach shadows from thin cabinet doors. The shadow camera remains fixed relative to
  the apartment/sun, and the depth map is cached until geometry or lighting changes.
- Retina phone resolution remains 1.5–2 render pixels per CSS pixel. This fix does not reduce it.

## Validation

Run `node --test dev/render-quality.test.mjs` after Three.js upgrades. The integration guard also
warns at runtime if an upgraded shader no longer has the expected PCF layout.

Production-build browser QA covers baked/unbaked apartments, overview/plan/walk, day/night,
contact-shading controls, lighting changes, furniture and door interactions, and portrait rotation.
Research screenshots and temporary profiling scripts are outside the repository under
`/tmp/homevisual-lighting/` on the development machine. They are not shipped assets.

A controlled small-camera-motion test tracked 179 fixed world points over 20 frames at DPR 2.
Mean temporal luminance standard deviation fell from 0.6767 to 0.1151 on an 8-bit luminance scale,
about 83% lower. This is a targeted stability comparison of one kitchen view, not a universal score.
The sampler resizes with the actual drawing buffer to avoid confusing adaptive DPR with lighting changes.

In short production-build motion tests, desktop Overview measured 60 FPS and walking 58.8 FPS;
the mobile landscape layout measured 60 FPS. Both ran on the same Mac GPU. Valid baked lighting
skips the AO pass completely, rather than merely reducing its sample count.

Frame rate measurements use headless Chrome with Metal on an M5 Pro. Phone emulation changes
layout and touch inputs, not the physical GPU. It cannot establish iPhone frame rate, thermals,
or Safari behavior; those still require a physical-device check.

## Primary sources

- [N8AO configuration, quality presets and neural-denoiser constraints](https://github.com/N8python/n8ao)
- [Filament: diffuse occlusion and avoiding double-darkening](https://google.github.io/filament/main/filament.html#lighting/occlusion)
- [NVIDIA GPU Gems: deterministic PCF and hardware filtering](https://developer.nvidia.com/gpugems/gpugems/part-ii-lighting-and-shadows/chapter-11-shadow-map-antialiasing)
- [Three.js LightShadow: bias, normal bias and filtering radius](https://threejs.org/docs/pages/LightShadow.html)
- [Three.js migration guide: r182 shadow-filter changes](https://github.com/mrdoob/three.js/wiki/Migration-Guide#181--182)
- [Three.js PCF modernization: noise-rotated disk sampling](https://github.com/mrdoob/three.js/pull/32381)
- [Unity mixed lighting: baked and real-time contributions](https://docs.unity3d.com/Manual/LightModes-introduction.html)
- [Blender render baking: reusing expensive lighting calculations](https://docs.blender.org/manual/en/latest/render/cycles/baking.html)
- [three-gpu-pathtracer: progressive rendering and scene/camera updates](https://github.com/gkjohnson/three-gpu-pathtracer)
