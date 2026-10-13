import {
    CanvasTexture,
    Mesh,
    MeshBasicMaterial,
    NearestFilter,
    PlaneGeometry,
    Vector3,
} from 'three';

/**
 * XRDepthOverlay
 *
 * Reads the WebXR depth TEXTURE_2D_ARRAY (gpu-optimized, Meta Quest 3) and
 * draws it as a turbo colour-mapped thumbnail in the corner of the XR view.
 *
 * Display strategy: a Three.js plane parented to the camera so it is always
 * in view. The depth pixels are read via readPixels into a 2D <canvas> which
 * is used as a THREE.CanvasTexture on that plane. No dom-overlay required.
 *
 * GL blit strategy: private WebGL framebuffer (NOT renderer.setRenderTarget)
 * so we never touch Three.js render-target state. resetState() is called once
 * AFTER renderer.render() each frame.
 *
 * Usage:
 *   const overlay = new XRDepthOverlay(renderer, camera);
 *   overlay.enable();
 *   // each frame AFTER renderer.render():
 *   overlay.update(frame, renderer.xr.getReferenceSpace());
 */
export class XRDepthOverlay {
    /**
     * @param {THREE.WebGLRenderer} renderer
     * @param {THREE.Scene} scene  The Three.js scene. The depth plane is added
     *   here and repositioned in world-space every frame to stay in the
     *   viewer's bottom-right corner.
     */
    constructor(renderer, scene) {
        this.renderer = renderer;
        this._scene   = scene;

        this._enabled = false;
        this._session = null;
        this._binding = null;
        this._loggedOnce = false;
        this._debug = {
            sessionDepthUsage: null,
            sourcePreference: 'auto',
            lastPath: 'none',
            lastReason: 'init',
            viewCount: 0,
        };
        this._sourcePreference = 'auto'; // auto | cpu | gpu

        // Off-screen 2D canvas — used only as CanvasTexture source.
        const SIZE = 160;
        this._canvas = document.createElement('canvas');
        this._canvas.width  = SIZE;
        this._canvas.height = SIZE;
        this._ctx = this._canvas.getContext('2d');

        // Three.js plane parented to camera — always visible in XR without
        // dom-overlay. Positioned in camera-local space: bottom-right corner,
        // 70 cm in front of the viewer.
        this._texture = new CanvasTexture(this._canvas);
        this._texture.generateMipmaps = false;
        this._texture.minFilter = NearestFilter;
        this._material = new MeshBasicMaterial({
            map:       this._texture,
            depthTest: false,   // always on top
        });
        this._plane = new Mesh(
            new PlaneGeometry(0.15, 0.15),
            this._material,
        );
        this._plane.position.set(0, 0, -0.6);
        this._plane.renderOrder = 999;
        this._plane.visible = false;
        // Added to the scene so it is part of the scene graph and rendered.
        // Position is updated each frame in update() to follow the XR camera.
        if (scene) scene.add(this._plane);
        this._localOffset = new Vector3(0.22, -0.16, -0.6);

        // GL resources (lazy-initialised on first update).
        this._program  = null;
        this._uTex     = null;
        this._uIsU16   = null;
        this._uScale   = null;
        this._vao      = null;
        this._fb       = null;
        this._colorTex = null;
        this._pixels   = null;
        this._ready    = false;
    }

    // ── Public API ──────────────────────────────────────────────────────

    enable() {
        this._enabled = true;
        this._plane.visible = true;
    }

    disable() {
        this._enabled = false;
        this._plane.visible = false;
    }

    setSourcePreference(mode = 'auto') {
        if (mode !== 'auto' && mode !== 'cpu' && mode !== 'gpu') return false;
        this._sourcePreference = mode;
        this._debug.sourcePreference = mode;
        // Rebuild binding when forcing GPU mode.
        if (mode !== 'gpu') this._binding = null;
        return true;
    }

    getSourcePreference() {
        return this._sourcePreference;
    }

    /**
     * Call every frame BEFORE renderer.render().
     * @param {XRFrame} frame
     * @param {XRReferenceSpace} referenceSpace
     */
    update(frame, referenceSpace) {
        if (!this._enabled || !frame || !referenceSpace) return;

        const session = frame.session;
        this._debug.sessionDepthUsage = session.depthUsage || null;
        this._debug.sourcePreference = this._sourcePreference;
        this._debug.lastPath = 'none';
        this._debug.lastReason = 'no-pose';

        if (this._session !== session) {
            this._session = session;
            this._binding = null;
            this._loggedOnce = false;
            this._blitLogged = false;
            this._ready    = false;
            this._readyCPU = false;

            if ((session.depthUsage === 'gpu-optimized' || this._sourcePreference === 'gpu') &&
                typeof XRWebGLBinding !== 'undefined') {
                try {
                    this._binding = new XRWebGLBinding(session, this.renderer.getContext());
                } catch (e) {
                    console.warn('XRDepthOverlay: XRWebGLBinding failed', e);
                }
            }
        }

        const pose = frame.getViewerPose(referenceSpace);
        if (!pose || !pose.views.length) return;
        this._debug.viewCount = pose.views.length;
        const view = pose.views[0];

        const gl = this.renderer.getContext();
        if (!(gl instanceof WebGL2RenderingContext)) {
            this._debug.lastReason = 'not-webgl2';
            return;
        }

        const prefer = this._sourcePreference || 'auto';
        const allowCPU = prefer !== 'gpu';
        const allowGPU = prefer !== 'cpu';

        if (allowCPU) {
            // ── CPU path: far plane ~4 m, depth data in ArrayBuffer ──────
            let depthInfo;
            try { depthInfo = frame.getDepthInformation(view); } catch (e) {
                depthInfo = null;
            }
            if (depthInfo) {
                if (!this._blitLogged) {
                    this._blitLogged = true;
                    console.log('[Depth CPU] rawValueToMeters:', depthInfo.rawValueToMeters,
                        '| w:', depthInfo.width, '| h:', depthInfo.height,
                        '| format:', session.depthDataFormat);
                }

                if (!this._readyCPU && !this._initCPU(gl, depthInfo.width, depthInfo.height)) return;
                this._blitCPU(gl, depthInfo);
                this._debug.lastPath = 'cpu';
                this._debug.lastReason = 'ok';
            } else if (prefer === 'cpu') {
                this._debug.lastReason = 'cpu-forced-unavailable';
            }
        }

        if (this._debug.lastPath === 'none' && allowGPU) {
            if (!this._binding && typeof XRWebGLBinding !== 'undefined') {
                try {
                    this._binding = new XRWebGLBinding(session, gl);
                } catch (e) {
                    this._binding = null;
                }
            }
        }

        if (this._debug.lastPath === 'none' && allowGPU && this._binding) {
            // ── GPU path: far plane ~1 m, texture provided by runtime ────
            let depthInfo;
            try { depthInfo = this._binding.getDepthInformation(view); } catch (e) {
                depthInfo = null;
            }
            if (depthInfo) {
                if (!this._blitLogged) {
                    this._blitLogged = true;
                    console.log('[Depth GPU] rawValueToMeters:', depthInfo.rawValueToMeters,
                        '| w:', depthInfo.width, '| h:', depthInfo.height,
                        '| format:', session.depthDataFormat);
                }

                if (!this._ready && !this._init(gl)) return;
                this._blit(gl, depthInfo, session.depthDataFormat === 'unsigned-short');
                this._debug.lastPath = 'gpu';
                this._debug.lastReason = 'ok';
            } else if (prefer === 'gpu') {
                this._debug.lastReason = 'gpu-forced-unavailable';
            }
        }

        if (this._debug.lastPath === 'none') {
            if (!this._loggedOnce) {
                console.warn('XRDepthOverlay: no depth source available. sessionDepthUsage =', session.depthUsage, '| preference =', prefer);
                this._loggedOnce = true;
            }
            if (this._debug.lastReason === 'no-pose') this._debug.lastReason = 'no-handler';
            return;
        }
        // Reposition plane in world-space so it stays in the viewer's
        // bottom-right corner. renderer.xr.getCamera() is the ArrayCamera
        // whose matrixWorld is updated each frame by the XR manager.
        const xrCam = this.renderer.xr.getCamera();
        xrCam.updateMatrixWorld();
        const worldOffset = this._localOffset.clone().applyQuaternion(xrCam.quaternion);
        this._plane.position.copy(xrCam.position).add(worldOffset);
        this._plane.quaternion.copy(xrCam.quaternion);
        this._plane.updateMatrixWorld();
    }

    dispose() {
        const gl = this.renderer.getContext();
        if (this._program) gl.deleteProgram(this._program);
        if (this._vao)      gl.deleteVertexArray(this._vao);
        if (this._fb)       gl.deleteFramebuffer(this._fb);
        if (this._colorTex) gl.deleteTexture(this._colorTex);
        this._texture.dispose();
        this._material.dispose();
        this._plane.geometry.dispose();
        if (this._scene) this._scene.remove(this._plane);
    }

    // ── GL initialisation ────────────────────────────────────────────────

    _init(gl) {
        const vs = `#version 300 es
            uniform mat4 uUvTransform;
            out vec2 vUv;
            void main() {
                vec2 pos;
                if      (gl_VertexID == 0) pos = vec2(-1., -1.);
                else if (gl_VertexID == 1) pos = vec2( 3., -1.);
                else                       pos = vec2(-1.,  3.);
                // Apply normDepthBufferFromNormView to map view UV → depth UV.
                vec2 rawUv = 0.5 * (pos + 1.0);
                vUv = (uUvTransform * vec4(rawUv, 0., 1.)).xy;
                gl_Position = vec4(pos, 0., 1.);
            }`;

        // Quest 3 uses a DEPTH_COMPONENT16 texture (not R16UI).
        // Must use sampler2DArray (float sampler). Sampling gives a normalized
        // value in [0,1]; multiply by 65535 * rawValueToMeters to get metres.
        // luminance-alpha format is also float, decoded via high/low bytes.
        const fs = `#version 300 es
            precision highp float;
            precision highp sampler2DArray;
            uniform sampler2DArray uTex;
            uniform float uScale;       // rawValueToMeters
            uniform mat4 uUvTransform;  // unused in fs — UVs already transformed in vs
            in vec2 vUv;
            out vec4 outColor;

            vec3 turbo(float t) {
                t = clamp(t, 0., 1.);
                return vec3(1.5*t, 1.6*(1.-abs(t-.5)*2.), 1.4*(1.-t));
            }

            void main() {
                vec4 t = texture(uTex, vec3(vUv, 0.));
                // Quest 3 GPU depth: DEPTH_COMPONENT16 sampled as float in [0,1]
                // where 1.0 = sensor max range (~5 m). rawValueToMeters=1 on Quest 3.
                // Actual metres = t.r * uScale * 5.0.
                float meters = t.r * uScale * 5.0;

                if (meters <= 0.) {
                    outColor = vec4(.8, 0., .8, 1.); // magenta = invalid/no depth
                    return;
                }

                // Greyscale: raw t.r value [0,1] matches texelFetch in occlusion shader.
                outColor = vec4(vec3(t.r), 1.);
            }`;

        const compile = (type, src) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                const log = gl.getShaderInfoLog(s);
                gl.deleteShader(s);
                throw new Error(log);
            }
            return s;
        };

        try {
            const v = compile(gl.VERTEX_SHADER, vs);
            const f = compile(gl.FRAGMENT_SHADER, fs);
            this._program = gl.createProgram();
            gl.attachShader(this._program, v);
            gl.attachShader(this._program, f);
            gl.linkProgram(this._program);
            gl.deleteShader(v);
            gl.deleteShader(f);
            if (!gl.getProgramParameter(this._program, gl.LINK_STATUS))
                throw new Error(gl.getProgramInfoLog(this._program));
        } catch (e) {
            console.warn('XRDepthOverlay: shader compile error:', e);
            return false;
        }

        this._vao = gl.createVertexArray();

        const W = this._canvas.width, H = this._canvas.height;

        this._colorTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._colorTex);
        // Use unsized gl.RGBA (not gl.RGBA8) — Quest 3's WebGL2 implementation
        // rejects sized internal formats in texImage2D with INVALID_ENUM.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);

        this._fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._colorTex, 0);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            console.warn('XRDepthOverlay: framebuffer incomplete:', status);
            return false;
        }

        this._pixels = new Uint8Array(W * H * 4);

        this._ready = true;
        return true;
    }

    // ── Per-frame blit ───────────────────────────────────────────────────

    _blit(gl, depthInfo, isU16) {
        const W = this._canvas.width, H = this._canvas.height;

        // Single program handles both formats via the uIsU16 uniform.
        const prog = this._program;
        // Save the state we need to restore manually (avoids calling
        // renderer.setRenderTarget which can corrupt XR render-target state).
        const prevFB       = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        const prevProg     = gl.getParameter(gl.CURRENT_PROGRAM);
        const prevVP       = gl.getParameter(gl.VIEWPORT);
        const prevDepth    = gl.isEnabled(gl.DEPTH_TEST);
        const prevDepthMsk = gl.getParameter(gl.DEPTH_WRITEMASK);
        const prevBlend    = gl.isEnabled(gl.BLEND);
        const prevCMask    = gl.getParameter(gl.COLOR_WRITEMASK);
        const prevActiveUnit = gl.getParameter(gl.ACTIVE_TEXTURE);
        const prevTex2D      = gl.getParameter(gl.TEXTURE_BINDING_2D);

        // Draw to our private framebuffer.
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fb);
        gl.viewport(0, 0, W, H);
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.disable(gl.BLEND);
        gl.colorMask(true, true, true, true);

        gl.useProgram(prog);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, depthInfo.texture);
        gl.uniform1i(gl.getUniformLocation(prog, 'uTex'),   0);
        gl.uniform1f(gl.getUniformLocation(prog, 'uIsU16'), isU16 ? 1.0 : 0.0);
        gl.uniform1f(gl.getUniformLocation(prog, 'uScale'), depthInfo.rawValueToMeters);
        // Apply normDepthBufferFromNormView so UVs map into the valid depth
        // region of the texture. Without this, most samples are outside the
        // valid area and return 0 (magenta).
        const uvMatrix = depthInfo.normDepthBufferFromNormView.matrix;
        gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uUvTransform'), false, uvMatrix);

        gl.bindVertexArray(this._vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);

        // Read pixels.
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, this._pixels);

        // Restore all GL state we changed.
        gl.bindFramebuffer(gl.FRAMEBUFFER, prevFB);
        gl.viewport(prevVP[0], prevVP[1], prevVP[2], prevVP[3]);
        gl.useProgram(prevProg);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
        gl.bindTexture(gl.TEXTURE_2D, prevTex2D);
        gl.activeTexture(prevActiveUnit);
        if (prevDepth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
        gl.depthMask(prevDepthMsk);
        if (prevBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
        gl.colorMask(prevCMask[0], prevCMask[1], prevCMask[2], prevCMask[3]);

        // Ensure no TEXTURE_2D_ARRAY is bound on any unit before resetState()
        // so Three.js doesn't see it when it calls texParameteri on upload.
        for (let i = 0; i < 4; i++) {
            gl.activeTexture(gl.TEXTURE0 + i);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
        }
        gl.activeTexture(prevActiveUnit);

        // Drain any GL errors from our blit operations before returning
        // control to Three.js — prevents errors cascading into its next frame.
        // eslint-disable-next-line no-empty
        while (gl.getError() !== gl.NO_ERROR) {}
        this.renderer.resetState();

        // Copy pixels to 2D canvas, flipping vertically (WebGL is bottom-up).
        const flipped = new Uint8ClampedArray(W * H * 4);
        for (let y = 0; y < H; y++) {
            const src = (H - 1 - y) * W * 4;
            flipped.set(this._pixels.subarray(src, src + W * 4), y * W * 4);
        }
        this._ctx.putImageData(new ImageData(flipped, W, H), 0, 0);
        // Signal Three.js to re-upload the canvas to GPU next render.
        this._texture.needsUpdate = true;
    }

    // ── CPU depth path ───────────────────────────────────────────────────

    _initCPU(gl, w, h) {
        const vs = `#version 300 es
            uniform mat4 uUvTransform;
            out vec2 vUv;
            void main() {
                vec2 pos;
                if      (gl_VertexID == 0) pos = vec2(-1., -1.);
                else if (gl_VertexID == 1) pos = vec2( 3., -1.);
                else                       pos = vec2(-1.,  3.);
                vUv = (uUvTransform * vec4(0.5 * (pos + 1.0), 0., 1.)).xy;
                gl_Position = vec4(pos, 0., 1.);
            }`;
        const fs = `#version 300 es
            precision highp float;
            uniform sampler2D uTex;
            in vec2 vUv;
            out vec4 outColor;
            vec3 turbo(float t) {
                t = clamp(t, 0., 1.);
                return vec3(1.5*t, 1.6*(1.-abs(t-.5)*2.), 1.4*(1.-t));
            }
            void main() {
                float meters = texture(uTex, vUv).r;
                if (meters <= 0.) { outColor = vec4(.8,0.,.8,1.); return; }
                outColor = vec4(turbo(1. - clamp(meters / 4., 0., 1.)), 1.);
            }`;

        const compile = (type, src) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                const log = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error(log);
            }
            return s;
        };
        try {
            const v = compile(gl.VERTEX_SHADER, vs);
            const f = compile(gl.FRAGMENT_SHADER, fs);
            this._programCPU = gl.createProgram();
            gl.attachShader(this._programCPU, v);
            gl.attachShader(this._programCPU, f);
            gl.linkProgram(this._programCPU);
            gl.deleteShader(v); gl.deleteShader(f);
            if (!gl.getProgramParameter(this._programCPU, gl.LINK_STATUS))
                throw new Error(gl.getProgramInfoLog(this._programCPU));
        } catch (e) { console.warn('XRDepthOverlay CPU shader:', e); return false; }

        this._vaoCPU = gl.createVertexArray();

        // R32F texture — float depth-in-metres uploaded each frame from CPU.
        this._depthTexCPU = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._depthTexCPU);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);

        // RGBA output framebuffer for readPixels → 2D canvas.
        const CW = this._canvas.width, CH = this._canvas.height;
        this._colorTexCPU = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._colorTexCPU);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, CW, CH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);

        this._fbCPU = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbCPU);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._colorTexCPU, 0);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            console.warn('XRDepthOverlay CPU: framebuffer incomplete:', status); return false;
        }

        this._pixelsCPU = new Uint8Array(CW * CH * 4);
        this._depthW = w; this._depthH = h;
        this._readyCPU = true;
        return true;
    }

    _blitCPU(gl, depthInfo) {
        const W = this._canvas.width, H = this._canvas.height;

        // Convert uint16 raw values to float metres and upload to GPU texture.
        const raw = new Uint16Array(depthInfo.data);
        const floats = new Float32Array(raw.length);
        const scale = depthInfo.rawValueToMeters;
        for (let i = 0; i < raw.length; i++) floats[i] = raw[i] * scale;

        const prevActiveUnit = gl.getParameter(gl.ACTIVE_TEXTURE);
        const prevTex2D      = gl.getParameter(gl.TEXTURE_BINDING_2D);
        const prevFB         = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        const prevProg       = gl.getParameter(gl.CURRENT_PROGRAM);
        const prevVP         = gl.getParameter(gl.VIEWPORT);
        const prevDepth      = gl.isEnabled(gl.DEPTH_TEST);
        const prevDepthMsk   = gl.getParameter(gl.DEPTH_WRITEMASK);
        const prevBlend      = gl.isEnabled(gl.BLEND);
        const prevCMask      = gl.getParameter(gl.COLOR_WRITEMASK);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._depthTexCPU);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this._depthW, this._depthH, gl.RED, gl.FLOAT, floats);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbCPU);
        gl.viewport(0, 0, W, H);
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.disable(gl.BLEND);
        gl.colorMask(true, true, true, true);

        const prog = this._programCPU;
        gl.useProgram(prog);
        gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
        gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uUvTransform'), false,
            depthInfo.normDepthBufferFromNormView.matrix);

        gl.bindVertexArray(this._vaoCPU);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);

        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, this._pixelsCPU);

        gl.bindFramebuffer(gl.FRAMEBUFFER, prevFB);
        gl.viewport(prevVP[0], prevVP[1], prevVP[2], prevVP[3]);
        gl.useProgram(prevProg);
        gl.bindTexture(gl.TEXTURE_2D, prevTex2D);
        gl.activeTexture(prevActiveUnit);
        if (prevDepth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
        gl.depthMask(prevDepthMsk);
        if (prevBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
        gl.colorMask(prevCMask[0], prevCMask[1], prevCMask[2], prevCMask[3]);
        // Drain any GL errors from our blit operations before handing back to Three.js.
        // eslint-disable-next-line no-empty
        while (gl.getError() !== gl.NO_ERROR) {}
        this.renderer.resetState();

        const flipped = new Uint8ClampedArray(W * H * 4);
        for (let y = 0; y < H; y++) {
            const src = (H - 1 - y) * W * 4;
            flipped.set(this._pixelsCPU.subarray(src, src + W * 4), y * W * 4);
        }
        this._ctx.putImageData(new ImageData(flipped, W, H), 0, 0);
        this._texture.needsUpdate = true;
    }
}
