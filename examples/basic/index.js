import { CommonGround } from '../../src/CommonGround.js';
import { XRDepthOverlay } from '../../src/XRDepthOverlay.js';
import { XRDepthOcclusion } from '../../src/XRDepthOcclusion.js';
import {
    Mesh,
    BoxGeometry,
    ShaderMaterial,
    DataTexture,
    DataArrayTexture,
    FloatType,
    RedFormat,
    NearestFilter,
    Vector3,
    Matrix4,
    Vector4,
    Color,
} from 'three';

const OCCLUSION_BUILD = '2026-05-06-occlusion-v4';

function createDepthAwareCubeMaterial(depthOcclusion) {
    const placeholderDepthTex = new DataTexture(new Float32Array([0]), 1, 1, RedFormat, FloatType);
    placeholderDepthTex.minFilter = NearestFilter;
    placeholderDepthTex.magFilter = NearestFilter;
    placeholderDepthTex.needsUpdate = true;
    const placeholderGpuDepthTex = new DataArrayTexture(new Float32Array([0]), 1, 1, 1);
    placeholderGpuDepthTex.minFilter = NearestFilter;
    placeholderGpuDepthTex.magFilter = NearestFilter;
    placeholderGpuDepthTex.needsUpdate = true;

    const mat = new ShaderMaterial({
        uniforms: {
            uDepthTex: { value: placeholderDepthTex }, // CPU fallback (sampler2D)
            uGpuDepthTex: { value: placeholderGpuDepthTex },
            uGpuLayer: { value: 0 },
            uRawToMeters: { value: 1.0 },
            uGpuRangeMeters: { value: 5.0 },
            uUseGpu: { value: 0 },
            uProj: { value: new Matrix4() },
            uXRView: { value: new Matrix4() },

            uUvTransform: { value: new Matrix4() },
            uViewportPx: { value: new Vector4(0, 0, 1, 1) },
            uHasDepth: { value: 0 },
            uBiasMeters: { value: 0.015 },
            uDebugMode: { value: 0 },   // 0=clip, 1=tint, 2=rawDepth, 3=range, 4=compare
            uColor: { value: new Color(0xcccccc) },  // light gray, visible in all modes
        },
        vertexShader: `
            uniform mat4 uXRView;
            varying float vEyeDepth;
            void main() {
                vec4 eyePos = uXRView * modelMatrix * vec4(position, 1.0);
                vEyeDepth = -eyePos.z;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            precision highp float;
            precision highp sampler2DArray;
            uniform sampler2DArray uGpuDepthTex;
            uniform sampler2D uDepthTex;
            uniform float uGpuLayer;
            uniform float uRawToMeters;
            uniform float uGpuRangeMeters;
            uniform int uUseGpu;
            uniform mat4 uProj;
            uniform mat4 uUvTransform;
            uniform vec4 uViewportPx;
            uniform int uHasDepth;
            uniform float uBiasMeters;
            uniform int uDebugMode;
            uniform vec3 uColor;
            varying float vEyeDepth;

            float sampleGpuDepthRaw(vec2 uv, float layer) {
                ivec3 size = textureSize(uGpuDepthTex, 0);
                if (size.x <= 0 || size.y <= 0) return 0.0;
                vec2 c = clamp(uv, vec2(0.0), vec2(1.0));
                ivec2 p = ivec2(c * vec2(size.xy - ivec2(1)));
                int l = int(clamp(layer, 0.0, float(max(size.z - 1, 0))));
                return texelFetch(uGpuDepthTex, ivec3(p, l), 0).r;
            }

            void main() {
                vec3 color = uColor;
                if (uHasDepth == 1) {
                    vec2 viewUv = (gl_FragCoord.xy - uViewportPx.xy) / uViewportPx.zw;
                    if (all(greaterThanEqual(viewUv, vec2(0.0))) && all(lessThanEqual(viewUv, vec2(1.0)))) {
                        vec2 depthUv = (uUvTransform * vec4(viewUv, 0.0, 1.0)).xy;
                        float rawDepth = 0.0;
                        float realMeters = 0.0;
                        if (uUseGpu == 1) {
                            rawDepth = sampleGpuDepthRaw(depthUv, uGpuLayer);
                            realMeters = rawDepth * uRawToMeters * uGpuRangeMeters;
                        } else {
                            realMeters = texture(uDepthTex, depthUv).r;
                            rawDepth = clamp(realMeters / 5.0, 0.0, 1.0);
                        }
                        bool hasDepthSample = realMeters > 0.01 && realMeters <= (uGpuRangeMeters + 0.5);
                        vec2 ndc = viewUv * 2.0 - 1.0;
                        float ax = uProj[0][0];
                        float ay = uProj[1][1];
                        float denom = sqrt(1.0 + (ndc.x * ndc.x) / (ax * ax) + (ndc.y * ndc.y) / (ay * ay));
                        float realZEye = realMeters / max(denom, 1e-4);
                        float virtualZEye = vEyeDepth;
                        float deltaMeters = virtualZEye - realZEye;
                        bool occluded = hasDepthSample && (virtualZEye > realZEye + uBiasMeters);
                        if (uDebugMode == 1) {
                            color = hasDepthSample
                                ? (occluded ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0))
                                : vec3(0.0, 0.0, 1.0); // blue = invalid/out-of-range
                        } else if (uDebugMode == 2) {
                            color = vec3(clamp(realMeters / 5.0, 0.0, 1.0)); // grayscale: 0-5m
                        } else if (uDebugMode == 3) {
                            color = realMeters <= 0.05 ? vec3(1.0, 0.0, 0.0)
                                  : realMeters >= 5.0 ? vec3(0.0, 0.0, 1.0)
                                  : vec3(0.0, 1.0, 0.0); // green = valid depth
                        } else if (uDebugMode == 4) {
                            if (!hasDepthSample) {
                                color = vec3(0.0, 0.0, 1.0); // blue = no usable real depth sample
                            } else {
                                float realNorm = clamp(realZEye / 5.0, 0.0, 1.0);
                                float virtualNorm = clamp(virtualZEye / 5.0, 0.0, 1.0);
                                float marginNorm = clamp((deltaMeters - uBiasMeters) * 8.0 + 0.5, 0.0, 1.0);
                                color = vec3(realNorm, virtualNorm, marginNorm);
                            }
                        } else if (occluded) {
                            discard;
                        }
                    } else if (uDebugMode == 1) {
                        color = vec3(1.0, 0.0, 1.0); // magenta = outside viewport
                    } else if (uDebugMode == 2) {
                        color = vec3(0.5); // gray = outside viewport
                    } else if (uDebugMode == 3) {
                        color = vec3(1.0); // white = outside viewport
                    } else if (uDebugMode == 4) {
                        color = vec3(1.0, 0.0, 1.0); // magenta = outside viewport
                    }
                } else if (uDebugMode == 1) {
                    color = vec3(1.0, 1.0, 0.0); // yellow = no depth bound
                } else if (uDebugMode == 2) {
                    color = vec3(0.3); // dark gray = no depth bound
                } else if (uDebugMode == 3) {
                    color = vec3(0.0, 1.0, 1.0); // cyan = uHasDepth=0, mode 3
                } else if (uDebugMode == 4) {
                    color = vec3(1.0, 1.0, 0.0); // yellow = no depth bound
                }
                gl_FragColor = vec4(color, 1.0);
            }
        `,
        depthTest: true,
        depthWrite: true,
    });

    mat.onBeforeRender = (renderer, scene, camera) => {
        depthOcclusion.bindUniformsForCamera(camera, mat.uniforms);
            depthOcclusion.bindGpuDepthTexture(renderer, mat.uniforms.uGpuDepthTex.value);

        // Debug: log depth binding state
        if (mat.uniforms.uHasDepth.value > 0) {
            console.log('[Occlusion] Depth bound:', {
                hasDepth: mat.uniforms.uHasDepth.value,
            });
        }
    };

    // Headset debug helpers:
    //   window.setOcclusionDebug(0..4)
    mat.userData.setOcclusionDebug = (mode) => {
        // mode: 0=clip, 1=tint, 2=rawDepth, 3=range, 4=compare
        if (mode === true) mode = 1; // backwards compat
        if (mode === false) mode = 0;
        mat.uniforms.uDebugMode.value = mode || 0;
    };
    mat.userData.setOcclusionBias = (meters) => {
        mat.uniforms.uBiasMeters.value = meters;
    };

    return mat;
}

const cg = new CommonGround();
cg.configure({ roomMesh: false, helpers: false, menu: false });
cg.init().then(() => {
    cg.buttonText = 'ENTER XR';
    const depthOcclusion = new XRDepthOcclusion(cg.renderer);
    cg.setDepthOcclusion(depthOcclusion);
    window.depthOcclusion = depthOcclusion;
    window.__occlusionBuild = OCCLUSION_BUILD;
    window.getOcclusionStats = () => ({
        build: OCCLUSION_BUILD,
        ...depthOcclusion._debug,
    });
    window.setOcclusionRange = (meters) => depthOcclusion.setGpuRangeMeters(meters);
    window.setOcclusionPrePassRange = (meters) => depthOcclusion.setGpuPrePassRangeMeters(meters);
    window.setOcclusionShaderRange = (meters) => depthOcclusion.setGpuShaderRangeMeters(meters);
    window.setOcclusionPrePass = (enabled) => depthOcclusion.setPrePassEnabled(enabled);
    
    // Create the depth-aware cube material BEFORE setting up debug helpers
    const h = cg.getCeilingHeight();
    const cubeMat = createDepthAwareCubeMaterial(depthOcclusion);
    window.cubeMat = cubeMat;
    
    window.setOcclusionDebug = (mode) => cubeMat.userData.setOcclusionDebug(mode);
    // Debug modes: 0=normal clip, 1=occlusion-tint (red=block,green=visible), 2=rawDepth-grayscale (sensor data)
    window.setOcclusionDebugMode = (mode) => {
        cubeMat.uniforms.uDebugMode.value = mode || 0;
        console.log(`[Occlusion] Debug mode: ${mode} (0=clip, 1=tint, 2=rawDepth-grayscale)`);
    };
    window.setOcclusionBias = (m) => cubeMat.userData.setOcclusionBias(m);

    // Disable pre-pass initially for debugging
    depthOcclusion.setPrePassEnabled(false);
    console.log('[Occlusion] Pre-pass disabled for debugging. Enable with window.setOcclusionPrePass(true)');
    console.log('[Occlusion] Cube is in rawDepth-viz mode. Switch modes with:');
    console.log('  - window.setOcclusionDebug(0)  → normal clip');
    console.log('  - window.setOcclusionDebug(1)  → occlusion tint (red=block, green=visible)');
    console.log('  - window.setOcclusionDebug(2)  → rawDepth grayscale (sensor data)');
    console.log('  - window.setOcclusionDebug(3)  → diagnostic (red=no-depth, blue=saturated, green=valid)');
    
    // Debug: add frame counter to see if update is being called
    let frameCount = 0;
    const origUpdate = depthOcclusion.update.bind(depthOcclusion);
    depthOcclusion.update = (frame, refSpace) => {
        frameCount++;
        if (frameCount <= 3) {
            console.log(`[Occlusion] Frame ${frameCount}: update() called, viewData length:`, depthOcclusion._viewData?.length);
        }
        return origUpdate(frame, refSpace);
    };
    
    window.getOcclusionFrameCount = () => frameCount;
    
    // Debug helper to see depth state (defined after cubeMat exists)
    window.checkDepthState = () => {
        const stats = depthOcclusion._debug;
        console.log('[Occlusion Debug State]');
        console.log('  frames since start:', frameCount);
        console.log('  viewData length:', stats.viewData?.length || 0);
        console.log('  depthUsage:', stats.depthUsage);
        console.log('  depthDataFormat:', stats.depthDataFormat);
        console.log('  mode:', stats.viewData?.[0]?.mode || 'none');
        console.log('  uHasDepth uniform:', cubeMat.uniforms.uHasDepth.value);
        console.log('[Binding State]');
        console.log('  bindingExists:', stats.bindingExists);
        console.log('  bindingCreated:', stats.bindingCreated);
        console.log('  bindingError:', stats.bindingError || 'none');
        console.log('  reason:', stats.reason);
        console.log('[View Data]');
        console.log('  eye0:', stats.eye0);
        console.log('  eye1:', stats.eye1);
    };
    
    const cube = new Mesh(
        new BoxGeometry(0.2, h, 0.2),
        cubeMat
    );
    cg.addObject('myCube', cube, new Vector3(0, h / 2, 0));
});

