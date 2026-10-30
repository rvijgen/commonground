import {
    DataTexture,
    FloatType,
    RedFormat,
    RedIntegerFormat,
    UnsignedShortType,
    ClampToEdgeWrapping,
    NearestFilter,
    Matrix4,
} from 'three';

/**
 * XRDepthOcclusion
 *
 * Writes real-world depth (from the CPU depth sensor) into the WebGL depth
 * buffer before Three.js renders the scene.  Three.js objects that are
 * behind real-world surfaces then naturally fail the depth test and are
 * discarded — giving per-pixel occlusion without patching any material.
 *
 * Usage:
 *   const occ = new XRDepthOcclusion(renderer);
 *   cg.setDepthOcclusion(occ);
 *
 * CommonGround calls, per frame (inside the XR animation loop):
 *   occ.update(frame, referenceSpace)   // uploads depth data, stores view info
 *   renderer.autoClearDepth = false
 *   occ.renderPrePass()                 // writes gl_FragDepth per eye
 *   renderer.render(scene, camera)      // depth test occlude against real world
 *   renderer.autoClearDepth = true
 */
export class XRDepthOcclusion {
    constructor(renderer) {
        this.renderer   = renderer;
        this._maxClearBoxes = 8;
        this._ready     = false;
        this._readyGPU  = false;
        this._enablePrePass = true;
        // Quest 3 GPU depth: DEPTH_COMPONENT16 sampled as float gives [0,1]
        // where 1.0 = sensor max range (~5 m on Quest 3, rawValueToMeters=1.0).
        // metres = texture.r * rawValueToMeters * 5.0
        this._gpuRangeMetersPrePass = 5.0;
        this._gpuRangeMetersShader = 5.0;
        this._prePassBiasMeters = 0.015; // small bias to avoid depth fighting at surfaces
        this._binding   = null;
        this._session   = null;
        this._viewData  = [];           // populated by update(), consumed by renderPrePass()
        // Pooled per-eye slots (max 2 XR views) with reusable typed-array
        // matrices, so the per-frame update allocates nothing. Slots are
        // filled by _updateInner and pushed into _viewData each frame.
        this._viewSlots = [null, null];
        this._lastBound = null;         // last matched view data from bindUniformsForCamera
        this._depthTexes = [null, null]; // one depth texture per eye (R16UI or R32F)
        this._threeDepthTexes = [null, null];
        this._depthFloatBuffers = [null, null]; // pooled float conversion buffers (f32 mode)
        // CPU depth texture mode: 'u16' (raw uint16 upload, shader scales by
        // rawValueToMeters — no per-pixel JS loop) or 'f32' (JS converts to
        // float metres, R32F upload — the proven path). Decided once by a
        // driver probe (_probeUint16DepthPath); null until then.
        this._cpuTexMode = null;
        this._depthDims  = [null, null]; // {w,h} to detect size changes
        this._xrFramebuffer = null;
        this._cpuUnavailableWarned = false;
        this._floorClearY  = null;   // world-space Y below which depth is cleared (no occlusion)
        this._clearBoxes = [];
        this._programFloor = null;
        this._locViewProjFloor = null;
        this._locFloorY    = null;
        this._floorViewProj = new Float32Array(16); // reused each frame
        this._readyFloor   = false;
        this._tmpMat4 = new Matrix4();
        // 1×1 placeholder so uDepthTex is never null (avoids "no texture on unit 0" warning).
        const placeholder = new DataTexture(new Float32Array([0]), 1, 1, RedFormat, FloatType);
        placeholder.minFilter = NearestFilter;
        placeholder.magFilter = NearestFilter;
        placeholder.needsUpdate = true;
        this._placeholderTex = placeholder;
        this._debug = {
            mode: 'none',
            views: 0,
            lastBind: false,
            bindFailReason: null,
            prePassRan: false,
            prePassDraws: 0,
            prePassUsedFallbackFramebuffer: false,
            reason: 'init',
            depthUsage: null,
            gpuRangeMetersPrePass: 1.0,
            gpuRangeMetersShader: 1.0,
            bindingExists: false,
            bindingCreated: false,
            bindingError: null,
            useShaderOcclusion: null,
            enablePrePass: null,
            cpuTexMode: null,
            eye0: null,
            eye1: null,
        };
    }

    // ── Public API ────────────────────────────────────────────────────────

    /**
     * Call BEFORE renderPrePass() and renderer.render() each frame.
     * Uploads CPU depth data for each XR view into GPU textures.
     */
    update(frame, referenceSpace) {
        try {
            this._updateInner(frame, referenceSpace);
        } catch (e) {
            this._debug.reason = 'exception: ' + e.message;
            this._debug.views = 0;
            console.error('[XRDepthOcclusion] update() threw:', e);
        }
    }

    setGpuRangeMeters(meters) {
        if (!Number.isFinite(meters)) return;
        const m = Math.max(0.1, meters);
        this._gpuRangeMetersPrePass = m;
        this._gpuRangeMetersShader = m;
        this._debug.gpuRangeMetersPrePass = m;
        this._debug.gpuRangeMetersShader = m;
    }

    getGpuRangeMeters() {
        return this._gpuRangeMetersPrePass;
    }

    setGpuPrePassRangeMeters(meters) {
        if (!Number.isFinite(meters)) return;
        this._gpuRangeMetersPrePass = Math.max(0.1, meters);
        this._debug.gpuRangeMetersPrePass = this._gpuRangeMetersPrePass;
    }

    getGpuPrePassRangeMeters() {
        return this._gpuRangeMetersPrePass;
    }

    setGpuShaderRangeMeters(meters) {
        if (!Number.isFinite(meters)) return;
        this._gpuRangeMetersShader = Math.max(0.1, meters);
        this._debug.gpuRangeMetersShader = this._gpuRangeMetersShader;
    }

    getGpuShaderRangeMeters() {
        return this._gpuRangeMetersShader;
    }

    setPrePassEnabled(enabled) {
        this._enablePrePass = !!enabled;
    }

    setPrePassBiasMeters(meters) {
        if (!Number.isFinite(meters)) return;
        this._prePassBiasMeters = meters;
    }

    getPrePassBiasMeters() {
        return this._prePassBiasMeters;
    }

    /**
     * Set the minimum world-space Y height below which depth sensor data is
     * ignored during the pre-pass.  Fragments at or below this Y receive
     * gl_FragDepth = 1.0 (far plane) so the floor never occludes objects above it.
     * Pass null to disable (default).
     * @param {number|null} y  World-space Y in metres (e.g. 0.05 = 5 cm above floor).
     */
    setFloorClearY(y) {
        this._floorClearY = (Number.isFinite(y)) ? y : null;
    }

    getFloorClearY() {
        return this._floorClearY;
    }

    setClearBoxes(boxes = []) {
        if (!Array.isArray(boxes) || boxes.length === 0) {
            this._clearBoxes = [];
            return;
        }

        const sanitized = [];
        for (const box of boxes) {
            const minX = Number(box?.minX);
            const minY = Number(box?.minY);
            const minZ = Number(box?.minZ);
            const maxX = Number(box?.maxX);
            const maxY = Number(box?.maxY);
            const maxZ = Number(box?.maxZ);
            if (
                !Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ)
                || !Number.isFinite(maxX) || !Number.isFinite(maxY) || !Number.isFinite(maxZ)
            ) {
                continue;
            }
            sanitized.push({
                minX: Math.min(minX, maxX),
                minY: Math.min(minY, maxY),
                minZ: Math.min(minZ, maxZ),
                maxX: Math.max(minX, maxX),
                maxY: Math.max(minY, maxY),
                maxZ: Math.max(minZ, maxZ),
            });
            if (sanitized.length >= this._maxClearBoxes) break;
        }
        this._clearBoxes = sanitized;
    }

    getClearBoxes() {
        return this._clearBoxes.slice();
    }

    isPrePassEnabled() {
        return this._enablePrePass;
    }

    _buildClearBoxUniformData() {
        const count = Math.min(this._clearBoxes.length, this._maxClearBoxes);
        const mins = new Float32Array(this._maxClearBoxes * 3);
        const maxs = new Float32Array(this._maxClearBoxes * 3);
        for (let i = 0; i < count; i++) {
            const box = this._clearBoxes[i];
            const offset = i * 3;
            mins[offset] = box.minX;
            mins[offset + 1] = box.minY;
            mins[offset + 2] = box.minZ;
            maxs[offset] = box.maxX;
            maxs[offset + 1] = box.maxY;
            maxs[offset + 2] = box.maxZ;
        }
        return { count, mins, maxs };
    }

    _updateInner(frame, referenceSpace) {
        if (!frame || !referenceSpace) {
            this._debug.mode = 'none';
            this._debug.views = 0;
            this._debug.reason = 'missing-frame-or-refspace';
            return;
        }

        const pose = frame.getViewerPose(referenceSpace);
        if (!pose) { this._debug.reason = 'no-viewer-pose'; return; }

        const gl = this.renderer.getContext();
    // Save TEXTURE_2D_ARRAY binding so Three.js's cache stays in sync.
    const _savedTexArr = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);

    // Recreate XRWebGLBinding on new session.
        if (this._session !== frame.session) {
            this._session = frame.session;
            this._binding = null;
            this._cpuUnavailableWarned = false;
        }

        const layer = this.renderer.xr.getBaseLayer() || frame.session.renderState.baseLayer || null;
        const xrBinding = this.renderer.xr.getBinding ? this.renderer.xr.getBinding() : null;
        this._debug.depthUsage = frame.session.depthUsage || null;
        this._debug.depthDataFormat = frame.session.depthDataFormat || null;
        this._debug.viewCount = pose.views.length;
        this._debug.layerType = layer ? layer.constructor?.name || 'XRLayer' : null;

        if (frame.session.depthUsage && frame.session.depthUsage !== 'cpu-optimized') {
            this._debug.reason = 'cpu-not-granted-runtime-using-gpu';
            if (!this._cpuUnavailableWarned) {
                this._cpuUnavailableWarned = true;
                console.log('[XRDepthOcclusion] Runtime granted', frame.session.depthUsage, '- using GPU depth fallback.');
            }
        }

        if (!layer) {
            this._debug.reason = 'missing-xr-layer';
            return;
        }
        this._xrFramebuffer = layer.framebuffer || null;

        this._viewData.length = 0; // reuse the array; slots are pooled below

        // Prefer CPU, but allow GPU fallback when runtime does not grant CPU.
        if (!this._binding && frame.session.depthUsage === 'gpu-optimized') {
            try {
                this._binding = new XRWebGLBinding(frame.session, gl);
                this._debug.bindingCreated = true;
                this._debug.bindingExists = true;
                this._debug.bindingError = null;
            } catch (e) {
                this._binding = null;
                this._debug.bindingError = e.message;
                this._debug.bindingExists = false;
            }
        }
        this._debug.bindingExists = !!this._binding;

        for (let i = 0; i < pose.views.length && i < 2; i++) {
            const view = pose.views[i];

            // Try CPU first (best range ~5m+), regardless of session grant preference.
            let di = null;
            try {
                di = frame.getDepthInformation(view);
            } catch (e) {
                di = null;
            }

            if (!di) {
                // GPU fallback for runtimes that grant gpu-optimized depth only.
                if (!this._binding) {
                    this._debug.reason = `view${i}-cpu-depth-unavailable-no-gpu-binding`;
                    continue;
                }

                let gdi = null;
                try {
                    gdi = this._binding.getDepthInformation(view);
                } catch (e) {
                    this._debug.reason = `view${i}-gpu-getDepthInfo-exception: ${e.message}`;
                    gdi = null;
                }
                if (!gdi) {
                    this._debug.reason = `view${i}-gpu-getDepthInfo-null`;
                    continue;
                }

                if (!this._readyGPU && !this._initGPU(gl)) {
                    this._debug.reason = `view${i}-gpu-init-failed`;
                    continue;
                }

                const vp = this._getViewportForView(layer, xrBinding || this._binding, view);
                if (!vp) {
                    this._debug.reason = `view${i}-gpu-no-viewport`;
                    continue;
                }
                const subImage = this._getViewSubImage(layer, xrBinding || this._binding, view);
                const texLayer = (subImage && Number.isFinite(subImage.imageIndex))
                    ? subImage.imageIndex : 0;
                let fb = this._xrFramebuffer;
                if (!fb) {
                    fb = subImage ? subImage.framebuffer || null : null;
                }
                this._viewData.push(this._fillViewSlot(
                    i, 'gpu', gdi.texture, null,
                    gdi.normDepthBufferFromNormView.matrix, view, texLayer,
                    gdi.rawValueToMeters, fb, vp,
                ));

                this._fillDebugEye(i, gdi.width, gdi.height, vp, gdi.rawValueToMeters);
                continue;
            }

            if (!this._depthTexes[i]) {
                this._depthTexes[i] = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, this._depthTexes[i]);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.bindTexture(gl.TEXTURE_2D, null);
            }

            // Resize depth texture when dimensions change (usually only once).
            const d = this._depthDims[i];
            if (!d || d.w !== di.width || d.h !== di.height) {
                const u16 = this._ensureCpuTexMode(gl) === 'u16';
                gl.bindTexture(gl.TEXTURE_2D, this._depthTexes[i]);
                if (u16) {
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI,
                        di.width, di.height, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, null);
                } else {
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F,
                        di.width, di.height, 0, gl.RED, gl.FLOAT, null);
                }
                this._depthDims[i] = { w: di.width, h: di.height };

                // Three.js-side texture for custom material sampling. u16 mode:
                // usampler2D, multiply by uRawToMeters in GLSL (integer textures
                // require NEAREST filtering). f32 mode: float metres.
                const tex = u16
                    ? new DataTexture(
                        new Uint16Array(di.width * di.height), di.width, di.height,
                        RedIntegerFormat, UnsignedShortType)
                    : new DataTexture(
                        new Float32Array(di.width * di.height), di.width, di.height,
                        RedFormat, FloatType);
                tex.minFilter = NearestFilter;
                tex.magFilter = NearestFilter;
                tex.wrapS = ClampToEdgeWrapping;
                tex.wrapT = ClampToEdgeWrapping;
                tex.generateMipmaps = false;
                tex.needsUpdate = true;
                if (!u16) this._depthFloatBuffers[i] = tex.image.data;
                this._threeDepthTexes[i] = tex;
            }

            const raw = new Uint16Array(di.data);
            gl.bindTexture(gl.TEXTURE_2D, this._depthTexes[i]);
            if (this._cpuTexMode === 'u16') {
                // Upload raw uint16 values unchanged — the pre-pass shader scales
                // by rawValueToMeters. No per-pixel JS conversion loop.
                this._threeDepthTexes[i].image.data = raw;
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0,
                    di.width, di.height, gl.RED_INTEGER, gl.UNSIGNED_SHORT, raw);
            } else {
                // Convert uint16 raw values → float metres (pooled buffer).
                const floats = this._depthFloatBuffers[i];
                const scale  = di.rawValueToMeters;
                for (let j = 0; j < raw.length; j++) floats[j] = raw[j] * scale;
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0,
                    di.width, di.height, gl.RED, gl.FLOAT, floats);
            }
            gl.bindTexture(gl.TEXTURE_2D, null);

            // Keep Three texture in sync for custom material sampling.
            this._threeDepthTexes[i].needsUpdate = true;

            const vp = this._getViewportForView(layer, xrBinding || this._binding, view);
            if (!vp) {
                this._debug.reason = `view${i}-cpu-no-viewport`;
                continue;
            }
            let fb = this._xrFramebuffer;
            if (!fb) {
                const subImage = this._getViewSubImage(layer, xrBinding || this._binding, view);
                fb = subImage ? subImage.framebuffer || null : null;
            }
            this._viewData.push(this._fillViewSlot(
                i, 'cpu', this._depthTexes[i], this._threeDepthTexes[i],
                di.normDepthBufferFromNormView.matrix, view, i,
                di.rawValueToMeters, fb, vp,
            ));

            this._fillDebugEye(i, di.width, di.height, vp, di.rawValueToMeters);
        }

        this._debug.views = this._viewData.length;
        this._debug.mode = this._viewData.length > 0 ? this._viewData[0].mode : 'none';
        // Keep the specific per-view/early-exit reason when no view produced
        // data — overwriting it with a generic one hides the failure point.
        if (this._viewData.length > 0) this._debug.reason = 'ok';

        // Restore TEXTURE_2D_ARRAY so Three.js cache stays valid.
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, _savedTexArr);

        // Drain any GL errors generated by texParameteri on runtime-owned XR
        // textures (e.g. TEXTURE_COMPARE_MODE may be read-only on Quest 3).
        // Errors left here would otherwise be attributed to Three.js's next
        // GL call (GetShaderiv / GetProgramiv) and corrupt its program cache.
        // Only the GPU path touches runtime-owned textures, and gl.getError is
        // a potential driver sync point — skip the drain on CPU-path frames.
        if (this._viewData.some((vd) => vd.mode === 'gpu')) {
            // eslint-disable-next-line no-empty
            while (gl.getError() !== gl.NO_ERROR) {}
        }
    }

    /**
     * Fill the pooled per-eye view slot (created once per eye index) and
     * return it for pushing into _viewData. Runs every XR frame, so it
     * allocates nothing: matrices are copied into persistent Float32Arrays
     * and the viewport object is reused. Slots carry the superset of CPU/GPU
     * fields; consumers read what their mode needs.
     */
    _fillViewSlot(i, mode, tex, threeTex, uvTransform, view, layerIndex, rawValueToMeters, framebuffer, vp) {
        let slot = this._viewSlots[i];
        if (!slot) {
            slot = this._viewSlots[i] = {
                mode: null,
                tex: null,
                threeTex: null,
                uvTransform: null,
                projMatrix: null,
                projInvMatrix: new Float32Array(16),
                viewMatrix: new Float32Array(16),
                viewInvMatrix: new Float32Array(16),
                layerIndex: 0,
                rawValueToMeters: 1.0,
                framebuffer: null,
                vp: { x: 0, y: 0, w: 0, h: 0 },
            };
        }
        slot.mode = mode;
        slot.tex = tex;
        slot.threeTex = threeTex;
        slot.uvTransform = uvTransform;
        slot.projMatrix = view.projectionMatrix;
        slot.projInvMatrix.set(this._tmpMat4.fromArray(view.projectionMatrix).invert().elements);
        slot.viewMatrix.set(view.transform.inverse.matrix);
        slot.viewInvMatrix.set(view.transform.matrix);
        slot.layerIndex = layerIndex;
        slot.rawValueToMeters = rawValueToMeters;
        slot.framebuffer = framebuffer;
        slot.vp.x = vp.x;
        slot.vp.y = vp.y;
        slot.vp.w = vp.width;
        slot.vp.h = vp.height;
        return slot;
    }

    /** Pooled per-eye debug info — same no-allocation discipline as slots. */
    _fillDebugEye(i, w, h, vp, rawValueToMeters) {
        const key = `eye${i}`;
        let dbg = this._debug[key];
        if (!dbg) {
            dbg = this._debug[key] = {
                depth: { w: 0, h: 0 },
                viewport: { x: 0, y: 0, w: 0, h: 0 },
                rawValueToMeters: 1,
            };
        }
        dbg.depth.w = w;
        dbg.depth.h = h;
        dbg.viewport.x = vp.x;
        dbg.viewport.y = vp.y;
        dbg.viewport.w = vp.width;
        dbg.viewport.h = vp.height;
        dbg.rawValueToMeters = rawValueToMeters;
    }

    /** Decide the CPU depth texture mode once, probing the driver first. */
    _ensureCpuTexMode(gl) {
        if (this._cpuTexMode) return this._cpuTexMode;
        this._cpuTexMode = this._probeUint16DepthPath(gl) ? 'u16' : 'f32';
        this._debug.cpuTexMode = this._cpuTexMode;
        return this._cpuTexMode;
    }

    /**
     * One-shot driver probe for the raw uint16 depth path (R16UI texture +
     * usampler2D in the pre-pass shader). Quest browser builds have rejected
     * seemingly valid texture formats before (see XRDepthOverlay's RGBA8
     * note), and a silent failure here means no occlusion at all — so verify
     * with a throwaway 1×1 alloc+upload and fall back to the float path on
     * any error.
     */
    _probeUint16DepthPath(gl) {
        let tex = null;
        try {
            tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, null);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RED_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array([1]));
            const err = gl.getError();
            gl.bindTexture(gl.TEXTURE_2D, null);
            if (err !== gl.NO_ERROR) {
                console.warn(`[XRDepthOcclusion] R16UI probe failed (0x${err.toString(16)}) — using float depth upload`);
                return false;
            }
            return true;
        } catch (e) {
            console.warn('[XRDepthOcclusion] R16UI probe threw — using float depth upload', e);
            return false;
        } finally {
            if (tex) gl.deleteTexture(tex);
        }
    }

    /** Drop all CPU depth textures so they are re-allocated in the current mode. */
    _resetCpuDepthTextures(gl) {
        for (let i = 0; i < 2; i++) {
            if (this._depthTexes[i]) { gl.deleteTexture(this._depthTexes[i]); this._depthTexes[i] = null; }
            if (this._threeDepthTexes[i]) { this._threeDepthTexes[i].dispose(); this._threeDepthTexes[i] = null; }
            this._depthDims[i] = null;
            this._depthFloatBuffers[i] = null;
        }
    }

    /**
     * Call after update() but BEFORE renderer.render().
     * Draws a fullscreen triangle per eye that writes gl_FragDepth from the
     * depth sensor, populating the depth buffer with real-world geometry.
     * Colour writes are disabled — this pass is depth-only.
     */
    renderPrePass() {
        this._debug.prePassRan = false;
        this._debug.prePassDraws = 0;
        this._debug.prePassUsedFallbackFramebuffer = false;
        if (!this._ready) {
            const glInit = this.renderer.getContext();
            if (!this._init(glInit)) return false;
        }
        if (this._viewData.length === 0) return false;
        const gl = this.renderer.getContext();

        // ── Save GL state ───────────────────────────────────────────────
        const prevProg     = gl.getParameter(gl.CURRENT_PROGRAM);
        const prevFB       = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        const prevVP       = gl.getParameter(gl.VIEWPORT);
        const prevUnit     = gl.getParameter(gl.ACTIVE_TEXTURE);
        // Save bindings at TEXTURE0 (the slot we'll use)
        gl.activeTexture(gl.TEXTURE0);
        const prevTex0     = gl.getParameter(gl.TEXTURE_BINDING_2D);
        const prevTexArr0  = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
        gl.activeTexture(prevUnit);
        const prevDepthTst = gl.isEnabled(gl.DEPTH_TEST);
        const prevDepthFn  = gl.getParameter(gl.DEPTH_FUNC);
        const prevDepthClr = gl.getParameter(gl.DEPTH_CLEAR_VALUE);
        const prevDepthMsk = gl.getParameter(gl.DEPTH_WRITEMASK);
        const prevColorMsk = gl.getParameter(gl.COLOR_WRITEMASK);
        const prevBlend    = gl.isEnabled(gl.BLEND);

        // ── Set up for depth-only pre-pass ──────────────────────────────
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.ALWAYS);          // always overwrite depth
        gl.depthMask(true);
        gl.colorMask(false, false, false, false); // no colour output
        gl.disable(gl.BLEND);

        gl.useProgram(this._program);
        gl.bindVertexArray(this._vao);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(this._locTex, 0);
        const clearBoxUniforms = this._buildClearBoxUniformData();

        const clearedFBs = new Set();
        let clearedFallback = false;

        // ── Draw one fullscreen triangle per eye ────────────────────────
        for (const vd of this._viewData) {
            const { vp } = vd;
            const targetFramebuffer = vd.framebuffer || this._xrFramebuffer;
            if (targetFramebuffer) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, targetFramebuffer);
            } else {
                // XRProjectionLayer path on some runtimes: draw into current FB.
                this._debug.prePassUsedFallbackFramebuffer = true;
            }
            gl.viewport(vp.x, vp.y, vp.w, vp.h);
            // Clear depth once per target framebuffer before writing sensor depth.
            // If we clear once per eye and both eyes share a framebuffer,
            // the second clear erases the first eye depth and causes one-eye-only occlusion.
            if (targetFramebuffer) {
                if (!clearedFBs.has(targetFramebuffer)) {
                    gl.clearDepth(1.0);
                    gl.clear(gl.DEPTH_BUFFER_BIT);
                    clearedFBs.add(targetFramebuffer);
                }
            } else if (!clearedFallback) {
                gl.clearDepth(1.0);
                gl.clear(gl.DEPTH_BUFFER_BIT);
                clearedFallback = true;
            }
            if (vd.mode === 'gpu') {
                gl.useProgram(this._programGPU);
                gl.uniform1i(this._locTexGPU, 0);
                gl.uniform1f(this._locLayerGPU, vd.layerIndex);
                gl.uniform1f(this._locRangeMetersGPU, this._gpuRangeMetersPrePass);
                gl.uniform1f(this._locBiasMetersGPU, this._prePassBiasMeters);
                gl.uniformMatrix4fv(this._locUvXformGPU, false, vd.uvTransform);
                gl.uniformMatrix4fv(this._locProjGPU,    false, vd.projMatrix);
                gl.uniformMatrix4fv(this._locProjInvGPU, false, vd.projInvMatrix);
                gl.uniformMatrix4fv(this._locViewInvGPU, false, vd.viewInvMatrix);
                gl.uniform1f(this._locFloorYGPU, this._floorClearY !== null ? this._floorClearY : 0.0);
                gl.uniform1f(this._locUseFloorClearGPU, this._floorClearY !== null ? 1.0 : 0.0);
                gl.uniform1i(this._locClearBoxCountGPU, clearBoxUniforms.count);
                gl.uniform3fv(this._locClearBoxMinGPU, clearBoxUniforms.mins);
                gl.uniform3fv(this._locClearBoxMaxGPU, clearBoxUniforms.maxs);
                gl.bindTexture(gl.TEXTURE_2D_ARRAY, vd.tex);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                this._debug.prePassDraws++;
                gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
            } else {
                gl.useProgram(this._program);
                gl.uniform1i(this._locTex, 0);
                if (this._locRawToMeters) {
                    gl.uniform1f(this._locRawToMeters, vd.rawValueToMeters != null ? vd.rawValueToMeters : 1.0);
                }
                gl.uniformMatrix4fv(this._locUvXform, false, vd.uvTransform);
                gl.uniformMatrix4fv(this._locProj,    false, vd.projMatrix);
                gl.uniformMatrix4fv(this._locProjInv, false, vd.projInvMatrix);
                gl.uniformMatrix4fv(this._locViewInv, false, vd.viewInvMatrix);
                gl.uniform1f(this._locFloorY, this._floorClearY !== null ? this._floorClearY : 0.0);
                gl.uniform1f(this._locUseFloorClear, this._floorClearY !== null ? 1.0 : 0.0);
                gl.uniform1i(this._locClearBoxCount, clearBoxUniforms.count);
                gl.uniform3fv(this._locClearBoxMin, clearBoxUniforms.mins);
                gl.uniform3fv(this._locClearBoxMax, clearBoxUniforms.maxs);
                gl.bindTexture(gl.TEXTURE_2D, vd.tex);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                this._debug.prePassDraws++;
                gl.bindTexture(gl.TEXTURE_2D, null);
            }
        }

        // ── Restore GL state ─────────────────────────────────────────────        gl.bindVertexArray(null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, prevFB);
        gl.viewport(prevVP[0], prevVP[1], prevVP[2], prevVP[3]);
        gl.useProgram(prevProg);
        // Restore TEXTURE0 bindings exactly, then restore active unit.
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, prevTex0);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, prevTexArr0);
        gl.activeTexture(prevUnit);
        if (prevDepthTst) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
        gl.depthFunc(prevDepthFn);
        gl.clearDepth(prevDepthClr);
        gl.depthMask(prevDepthMsk);
        gl.colorMask(prevColorMsk[0], prevColorMsk[1], prevColorMsk[2], prevColorMsk[3]);
        if (prevBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
        this._debug.prePassRan = this._debug.prePassDraws > 0;
        return true;
    }

    _getViewportForView(layer, binding, view) {
        if (!layer || !view) return null;

        if (typeof layer.getViewport === 'function') {
            return layer.getViewport(view);
        }

        if (binding && typeof binding.getViewSubImage === 'function') {
            try {
                const subImage = binding.getViewSubImage(layer, view);
                return subImage ? subImage.viewport : null;
            } catch (e) {
                this._debug.reason = 'getViewSubImage-failed: ' + e.message;
            }
        }

        // Fallback for runtimes/layers without getViewport/getViewSubImage.
        // Use XR layer framebuffer dimensions and split by eye for stereo.
        const fbw = layer.framebufferWidth || layer.textureWidth || layer.colorTextureWidth || 0;
        const fbh = layer.framebufferHeight || layer.textureHeight || layer.colorTextureHeight || 0;
        if (fbw > 0 && fbh > 0) {
            const isStereo = view.eye === 'left' || view.eye === 'right';
            if (isStereo) {
                const halfW = Math.floor(fbw / 2);
                const x = view.eye === 'left' ? 0 : halfW;
                this._debug.reason = 'viewport-fallback-layer-split';
                return { x, y: 0, width: halfW, height: fbh };
            }
            this._debug.reason = 'viewport-fallback-layer-full';
            return { x: 0, y: 0, width: fbw, height: fbh };
        }

        this._debug.reason = 'missing-viewport-provider';
        return null;
    }

    _getViewSubImage(layer, binding, view) {
        if (!layer || !binding || !view) return null;
        if (typeof binding.getViewSubImage !== 'function') return null;
        try {
            return binding.getViewSubImage(layer, view);
        } catch (e) {
            return null;
        }
    }

    /**
     * Fill uniforms for a custom per-object occlusion shader.
     * Returns true when depth data for this eye is available.
     */
    bindUniformsForCamera(camera, uniforms) {
        const isReady = this._ready || this._readyGPU;
        if (!isReady || this._viewData.length === 0 || !camera) {
            if (!isReady) this._debug.bindFailReason = 'not-ready';
            if (this._viewData.length === 0) this._debug.bindFailReason = 'no-viewdata';
            if (!camera) this._debug.bindFailReason = 'no-camera';
            uniforms.uHasDepth.value = 0;
            uniforms.__rawGpuTex = null;
              // Always keep uDepthTex non-null so Three.js never binds nothing to
              // unit 0, which generates a warning that pollutes the GL error queue.
              if (uniforms.uDepthTex) uniforms.uDepthTex.value = this._placeholderTex;
              this._debug.lastBind = false;
              return false;
        }

        // Determine eye index from the current GL viewport x offset.
        // Render viewports are in screen space (e.g. x=0 left, x=1680 right) while
        // depth texture viewports are in depth-texture space — they can't be compared
        // directly. Using GL viewport x to pick left (0) vs right (>0) eye is reliable.
        const glVp = this.renderer.getContext().getParameter(this.renderer.getContext().VIEWPORT);
        const eyeIndex = glVp[0] > 0 ? 1 : 0;
        const best = this._viewData[eyeIndex] || this._viewData[0];

        if (!best) {
            this._debug.bindFailReason = 'no-matching-viewdata';
            uniforms.uHasDepth.value = 0;
            this._lastBound = null;
            this._debug.lastBind = false;
            return false;
        }

        // When pre-pass is enabled, depth testing in the pipeline is the
        // source of truth. Disable per-fragment shader discard to avoid
        // double-occlusion artifacts and unstable range behavior.
        const useShaderOcclusion = !this._enablePrePass;
        uniforms.uHasDepth.value = useShaderOcclusion ? 1 : 0;
        this._debug.useShaderOcclusion = useShaderOcclusion;
        this._debug.enablePrePass = this._enablePrePass;
        // CPU path: bind the Three.js DataTexture directly.
        // GPU path: use a 1×1 placeholder so Three.js never sees a null sampler (avoids unit-0 warning).
        if (uniforms.uDepthTex !== undefined)
            uniforms.uDepthTex.value = best.mode === 'cpu' ? (best.threeTex || this._placeholderTex) : this._placeholderTex;
        if (uniforms.uUseGpu !== undefined)
            uniforms.uUseGpu.value = best.mode === 'gpu' ? 1 : 0;
        uniforms.uUvTransform.value.fromArray(best.uvTransform);
        uniforms.uViewportPx.value.set(best.vp.x, best.vp.y, best.vp.w, best.vp.h);
        // GPU-specific float uniforms (no-op when not declared in material.uniforms).
        if (uniforms.uGpuLayer !== undefined)
            uniforms.uGpuLayer.value = best.layerIndex != null ? best.layerIndex : 0;
        // CPU u16 mode exposes raw uint16 via uDepthTex — custom samplers
        // multiply by uRawToMeters. In f32 mode the texture holds metres and
        // this stays 1.0.
        if (uniforms.uRawToMeters !== undefined)
            uniforms.uRawToMeters.value = (best.mode === 'cpu' && this._cpuTexMode === 'u16' && best.rawValueToMeters != null)
                ? best.rawValueToMeters : 1.0;
        if (uniforms.uGpuRangeMeters !== undefined)
            uniforms.uGpuRangeMeters.value = this._gpuRangeMetersShader;
        if (uniforms.uProj !== undefined)
            uniforms.uProj.value.fromArray(best.projMatrix);
        if (uniforms.uXRView !== undefined && best.viewMatrix)
            uniforms.uXRView.value.fromArray(best.viewMatrix);
        this._lastBound = best;
        this._debug.lastBind = true;
        return true;
    }

    /**
     * Rebind the runtime-owned XR depth texture onto a Three.js placeholder
     * DataArrayTexture so Three's normal uniform upload path can bind it.
     * This avoids writing sampler uniforms against CURRENT_PROGRAM, which was
     * timing-sensitive and caused intermittent black sampling.
     */
    bindGpuDepthTexture(renderer, threeTexture) {
        const vd = this._lastBound;
        if (!renderer || !threeTexture || !vd || vd.mode !== 'gpu' || !vd.tex) return;
        const props = renderer.properties.get(threeTexture);
        props.__webglTexture = vd.tex;
    }

    // ── Private ───────────────────────────────────────────────────────────

    _init(gl) {
        // Vertex shader: fullscreen triangle, maps view-NDC → depth UV via
        // normDepthBufferFromNormView so we sample inside the valid depth region.
        const vs = `#version 300 es
            uniform mat4 uUvXform;
            out vec2 vUv;
            out vec2 vViewUv;
            void main() {
                vec2 pos;
                if      (gl_VertexID == 0) pos = vec2(-1., -1.);
                else if (gl_VertexID == 1) pos = vec2( 3., -1.);
                else                       pos = vec2(-1.,  3.);
                vec2 rawUv = 0.5 * (pos + 1.0);
                vViewUv = rawUv;
                vUv = (uUvXform * vec4(rawUv, 0., 1.)).xy;
                gl_Position = vec4(pos, 0., 1.);
            }`;

        // Fragment shader: sample perpendicular eye-space depth, project to NDC, write gl_FragDepth.
        // Quest 3 CPU depth (rawValueToMeters-scaled uint16) is perpendicular depth, not ray distance —
        // no slant correction needed, same as the GPU path.
        // u16 mode: the texture holds raw uint16 values, scaled here by
        // uRawToMeters (no per-pixel JS conversion). f32 mode: float metres.
        const u16 = this._ensureCpuTexMode(gl) === 'u16';
        const fs = `#version 300 es
            precision highp float;
            ${u16
                ? 'uniform highp usampler2D uTex;\n            uniform float uRawToMeters;'
                : 'uniform sampler2D uTex;'}
            uniform mat4 uProj;
            uniform mat4 uProjInv;
            uniform mat4 uViewInv;
            uniform float uFloorClearY;
            uniform float uUseFloorClear;
            uniform int uClearBoxCount;
            uniform vec3 uClearBoxMin[8];
            uniform vec3 uClearBoxMax[8];
            in vec2 vUv;
            in vec2 vViewUv;
            out vec4 fragColor;
            void main() {
                ${u16
                    ? 'float metres = float(texture(uTex, vUv).r) * uRawToMeters;'
                    : 'float metres = texture(uTex, vUv).r;'}
                if (metres < 0.05) discard;
                if (uUseFloorClear > 0.5 || uClearBoxCount > 0) {
                    vec2 ndc = vViewUv * 2.0 - 1.0;
                    vec4 viewFar4 = uProjInv * vec4(ndc, 1.0, 1.0);
                    vec3 rayDir = normalize(viewFar4.xyz / max(1e-6, viewFar4.w));
                    float denom = max(1e-4, -rayDir.z);
                    vec3 viewPos = rayDir * (metres / denom);
                    vec3 worldPos = (uViewInv * vec4(viewPos, 1.0)).xyz;
                    if (worldPos.y < uFloorClearY) discard;
                    for (int i = 0; i < 8; i++) {
                        if (i >= uClearBoxCount) break;
                        vec3 boxMin = uClearBoxMin[i];
                        vec3 boxMax = uClearBoxMax[i];
                        bool insideBox =
                            worldPos.x >= boxMin.x && worldPos.x <= boxMax.x &&
                            worldPos.y >= boxMin.y && worldPos.y <= boxMax.y &&
                            worldPos.z >= boxMin.z && worldPos.z <= boxMax.z;
                        if (insideBox) discard;
                    }
                }
                float zEye = -metres;
                vec4 clip = uProj * vec4(0.0, 0.0, zEye, 1.0);
                gl_FragDepth = clamp((clip.z / clip.w) * 0.5 + 0.5, 0.0, 1.0);
                fragColor = vec4(0.0);
            }`;

        const compile = (type, src) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                const e = gl.getShaderInfoLog(s);
                gl.deleteShader(s);
                throw new Error(e);
            }
            return s;
        };

        try {
            const v = compile(gl.VERTEX_SHADER,   vs);
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
            if (u16) {
                // Integer-texture shader rejected — drop to the proven float
                // path and rebuild the depth textures to match.
                console.warn('[XRDepthOcclusion] uint16 pre-pass shader failed, falling back to float:', e);
                this._cpuTexMode = 'f32';
                this._debug.cpuTexMode = 'f32';
                this._resetCpuDepthTextures(gl);
                return this._init(gl);
            }
            console.warn('[XRDepthOcclusion] shader error:', e);
            return false;
        }

        this._locTex     = gl.getUniformLocation(this._program, 'uTex');
        this._locRawToMeters = u16 ? gl.getUniformLocation(this._program, 'uRawToMeters') : null;
        this._locUvXform = gl.getUniformLocation(this._program, 'uUvXform');
        this._locProj    = gl.getUniformLocation(this._program, 'uProj');
        this._locProjInv = gl.getUniformLocation(this._program, 'uProjInv');
        this._locViewInv = gl.getUniformLocation(this._program, 'uViewInv');
        this._locFloorY = gl.getUniformLocation(this._program, 'uFloorClearY');
        this._locUseFloorClear = gl.getUniformLocation(this._program, 'uUseFloorClear');
        this._locClearBoxCount = gl.getUniformLocation(this._program, 'uClearBoxCount');
        this._locClearBoxMin = gl.getUniformLocation(this._program, 'uClearBoxMin[0]');
        this._locClearBoxMax = gl.getUniformLocation(this._program, 'uClearBoxMax[0]');

        this._vao = gl.createVertexArray();
        // Depth textures are allocated lazily in _updateInner() on first frame.
        this.renderer.resetState();
        this._ready = true;
        console.log('[XRDepthOcclusion] initialized — depth pre-pass active');
        return true;
    }

    _initGPU(gl) {
        const vs = `#version 300 es
            uniform mat4 uUvXform;
            out vec2 vUv;
            out vec2 vViewUv;
            void main() {
                vec2 pos;
                if      (gl_VertexID == 0) pos = vec2(-1., -1.);
                else if (gl_VertexID == 1) pos = vec2( 3., -1.);
                else                       pos = vec2(-1.,  3.);
                vec2 rawUv = 0.5 * (pos + 1.0);
                vViewUv = rawUv;
                vUv = (uUvXform * vec4(rawUv, 0., 1.)).xy;
                gl_Position = vec4(pos, 0., 1.);
            }`;

        const fs = `#version 300 es
            precision highp float;
            precision highp sampler2DArray;
            uniform sampler2DArray uTex;
            uniform mat4 uProj;
            uniform mat4 uProjInv;
            uniform mat4 uViewInv;
            uniform float uLayer;
            uniform float uRangeMeters;
            uniform float uBiasMeters;
            uniform float uFloorClearY;
            uniform float uUseFloorClear;
            uniform int uClearBoxCount;
            uniform vec3 uClearBoxMin[8];
            uniform vec3 uClearBoxMax[8];
            in vec2 vUv;
            in vec2 vViewUv;
            out vec4 fragColor;
            float linearizeDepth(float rawDepth, mat4 proj, float fallbackFar) {
                float m22 = proj[2][2];
                float m32 = proj[3][2];
                float nearM = m32 / (m22 - 1.0);
                float farM  = m32 / (m22 + 1.0);
                if (!(farM > nearM) || nearM <= 0.0) { nearM = 0.05; farM = fallbackFar; }
                float zNdc = rawDepth * 2.0 - 1.0;
                float denom = max(1e-6, farM + nearM - zNdc * (farM - nearM));
                return (2.0 * nearM * farM) / denom;
            }
            void main() {
                // Avoid sampling outside the valid depth UV region. At steep
                // head angles this can otherwise clamp to border texels and
                // write incorrect near depth across the viewport.
                if (any(lessThan(vUv, vec2(0.0))) || any(greaterThan(vUv, vec2(1.0)))) discard;
                float rawDepth = texture(uTex, vec3(vUv, uLayer)).r;
                if (rawDepth <= 0.001 || rawDepth >= 0.999) discard;
                float metres = linearizeDepth(rawDepth, uProj, uRangeMeters) + uBiasMeters;
                if (metres < 0.05 || metres > (uRangeMeters + 0.5)) discard;
                if (uUseFloorClear > 0.5 || uClearBoxCount > 0) {
                    vec2 ndc = vViewUv * 2.0 - 1.0;
                    vec4 viewFar4 = uProjInv * vec4(ndc, 1.0, 1.0);
                    vec3 rayDir = normalize(viewFar4.xyz / max(1e-6, viewFar4.w));
                    float denom = max(1e-4, -rayDir.z);
                    vec3 viewPos = rayDir * (metres / denom);
                    vec3 worldPos = (uViewInv * vec4(viewPos, 1.0)).xyz;
                    if (worldPos.y < uFloorClearY) discard;
                    for (int i = 0; i < 8; i++) {
                        if (i >= uClearBoxCount) break;
                        vec3 boxMin = uClearBoxMin[i];
                        vec3 boxMax = uClearBoxMax[i];
                        bool insideBox =
                            worldPos.x >= boxMin.x && worldPos.x <= boxMax.x &&
                            worldPos.y >= boxMin.y && worldPos.y <= boxMax.y &&
                            worldPos.z >= boxMin.z && worldPos.z <= boxMax.z;
                        if (insideBox) discard;
                    }
                }
                // Quest 3 GPU depth is already perpendicular eye-space depth —
                // no slant correction needed. Convert directly to clip depth.
                float zEye = -metres;
                vec4 clip = uProj * vec4(0.0, 0.0, zEye, 1.0);
                gl_FragDepth = clamp((clip.z / clip.w) * 0.5 + 0.5, 0.0, 1.0);
                fragColor = vec4(0.0);
            }`;

        const compile = (type, src) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                const e = gl.getShaderInfoLog(s);
                gl.deleteShader(s);
                throw new Error(e);
            }
            return s;
        };

        try {
            const v = compile(gl.VERTEX_SHADER, vs);
            const f = compile(gl.FRAGMENT_SHADER, fs);
            this._programGPU = gl.createProgram();
            gl.attachShader(this._programGPU, v);
            gl.attachShader(this._programGPU, f);
            gl.linkProgram(this._programGPU);
            gl.deleteShader(v);
            gl.deleteShader(f);
            if (!gl.getProgramParameter(this._programGPU, gl.LINK_STATUS))
                throw new Error(gl.getProgramInfoLog(this._programGPU));
        } catch (e) {
            console.warn('[XRDepthOcclusion] GPU shader error:', e);
            return false;
        }

        this._locTexGPU     = gl.getUniformLocation(this._programGPU, 'uTex');
        this._locUvXformGPU = gl.getUniformLocation(this._programGPU, 'uUvXform');
        this._locProjGPU    = gl.getUniformLocation(this._programGPU, 'uProj');
        this._locProjInvGPU = gl.getUniformLocation(this._programGPU, 'uProjInv');
        this._locViewInvGPU = gl.getUniformLocation(this._programGPU, 'uViewInv');
        this._locLayerGPU   = gl.getUniformLocation(this._programGPU, 'uLayer');
        this._locRangeMetersGPU = gl.getUniformLocation(this._programGPU, 'uRangeMeters');
        this._locBiasMetersGPU  = gl.getUniformLocation(this._programGPU, 'uBiasMeters');
        this._locFloorYGPU  = gl.getUniformLocation(this._programGPU, 'uFloorClearY');
        this._locUseFloorClearGPU = gl.getUniformLocation(this._programGPU, 'uUseFloorClear');
        this._locClearBoxCountGPU = gl.getUniformLocation(this._programGPU, 'uClearBoxCount');
        this._locClearBoxMinGPU = gl.getUniformLocation(this._programGPU, 'uClearBoxMin[0]');
        this._locClearBoxMaxGPU = gl.getUniformLocation(this._programGPU, 'uClearBoxMax[0]');
        this._readyGPU = true;
        this.renderer.resetState();
        return true;
    }

    /**
     * Compiles the floor-clearing GL program (called lazily on first use).
     * Draws a large world-space horizontal quad at _floorClearY and writes
     * gl_FragDepth = 1.0, effectively removing floor depth from the depth buffer.
     */
    _initFloor(gl) {
        const vs = `#version 300 es
            uniform mat4 uViewProj;
            uniform float uFloorY;
            void main() {
                // 6 vertices — two triangles covering a 200×200 m horizontal quad.
                const vec2 xz[4] = vec2[4](
                    vec2(-100.0, -100.0),
                    vec2( 100.0, -100.0),
                    vec2(-100.0,  100.0),
                    vec2( 100.0,  100.0)
                );
                const int idx[6] = int[6](0, 1, 2, 1, 3, 2);
                vec2 p = xz[idx[gl_VertexID]];
                gl_Position = uViewProj * vec4(p.x, uFloorY, p.y, 1.0);
            }`;

        const fs = `#version 300 es
            precision highp float;
            out vec4 fragColor;
            void main() {
                fragColor = vec4(0.0);
                gl_FragDepth = 1.0;
            }`;

        const compile = (type, src) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                const e = gl.getShaderInfoLog(s);
                gl.deleteShader(s);
                throw new Error(e);
            }
            return s;
        };

        try {
            const v = compile(gl.VERTEX_SHADER, vs);
            const f = compile(gl.FRAGMENT_SHADER, fs);
            this._programFloor = gl.createProgram();
            gl.attachShader(this._programFloor, v);
            gl.attachShader(this._programFloor, f);
            gl.linkProgram(this._programFloor);
            gl.deleteShader(v);
            gl.deleteShader(f);
            if (!gl.getProgramParameter(this._programFloor, gl.LINK_STATUS))
                throw new Error(gl.getProgramInfoLog(this._programFloor));
        } catch (e) {
            console.warn('[XRDepthOcclusion] floor-clear shader error:', e);
            return false;
        }

        this._locViewProjFloor = gl.getUniformLocation(this._programFloor, 'uViewProj');
        this._locFloorY        = gl.getUniformLocation(this._programFloor, 'uFloorY');
        this._readyFloor = true;
        return true;
    }
}
