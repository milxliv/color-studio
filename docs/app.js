// Color Studio engine. Loads a subject's data.json, renders UI, runs recoloring,
// and supports shareable URL hashes plus optional vote submission to a backend.

(() => {
    "use strict";

    // ---- URL & config -----------------------------------------------------
    const params = new URLSearchParams(location.search);
    const SUBJECT_ID = params.get("subject");
    const BACKEND_URL = (() => {
        const fromQuery = params.get("backend");
        if (fromQuery) return fromQuery.replace(/\/+$/, "");
        const meta = document.querySelector('meta[name="vote-backend"]');
        if (meta && meta.content) return meta.content.replace(/\/+$/, "");
        return null;
    })();

    // ---- Color utils ------------------------------------------------------
    const hexToRgb = hex => ({
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16),
    });

    function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h, s, l = (max + min) / 2;
        if (max === min) { h = s = 0; }
        else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
            }
            h /= 6;
        }
        return [h * 360, s, l];
    }

    function hslToRgb(h, s, l) {
        h /= 360;
        let r, g, b;
        if (s === 0) { r = g = b = l; }
        else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1 / 6) return p + (q - p) * 6 * t;
                if (t < 1 / 2) return q;
                if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = hue2rgb(p, q, h + 1 / 3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1 / 3);
        }
        return [r * 255, g * 255, b * 255];
    }

    const hexHsl = hex => {
        const { r, g, b } = hexToRgb(hex);
        return rgbToHsl(r, g, b);
    };

    const hueInRanges = (h, ranges) =>
        !ranges || ranges.some(([lo, hi]) => h >= lo && h <= hi);

    // ---- Boot -------------------------------------------------------------
    const app = document.getElementById("app");
    const setBoot = (msg, cls = "") => {
        app.innerHTML = `<div class="fatal ${cls}"><h2>${msg.title || "Color Studio"}</h2><p>${msg.body || msg}</p></div>`;
    };

    if (!SUBJECT_ID) {
        renderSubjectList();
    } else {
        loadSubject(SUBJECT_ID).catch(err => {
            console.error(err);
            setBoot({ title: "Couldn't load subject", body: String(err.message || err) });
        });
    }

    async function renderSubjectList() {
        let list;
        try {
            const r = await fetch("subjects/index.json");
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            list = await r.json();
        } catch (e) {
            setBoot({ title: "Color Studio", body: "No subject selected. Append <code>?subject=&lt;id&gt;</code> to the URL." });
            return;
        }
        const cards = (list.subjects || []).map(s => `
            <a class="subject-card" href="?subject=${encodeURIComponent(s.id)}">
                ${s.thumb ? `<img src="subjects/${s.thumb}" alt="">` : ""}
                <div class="name">${escapeHtml(s.name || s.id)}</div>
                <div class="loc">${escapeHtml([s.kind, s.location].filter(Boolean).join(" · "))}</div>
            </a>
        `).join("");
        app.innerHTML = `
            <header><div class="title-block"><h1>Color Studio</h1><div class="sub">Pick a subject</div></div></header>
            <div class="subject-grid">${cards}</div>
        `;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
        }[c]));
    }

    // ---- Subject load -----------------------------------------------------
    async function loadSubject(id) {
        const baseUrl = `subjects/${encodeURIComponent(id)}/`;
        const r = await fetch(baseUrl + "data.json");
        if (!r.ok) throw new Error(`data.json: ${r.status}`);
        const data = await r.json();
        renderShell(data, baseUrl);
        await initEngine(data, baseUrl);
    }

    // ---- DOM construction -------------------------------------------------
    function renderShell(data, baseUrl) {
        const surfacesHtml = data.surfaces.map(s => `
            <div class="surface">
                <div class="swatch" id="sw-${s.id}" style="background:${s.default}">
                    <input type="color" id="c-${s.id}" value="${s.default}">
                </div>
                <div class="surface-label">${escapeHtml(s.label)}<small>${escapeHtml(s.sublabel || "")}</small></div>
                <input class="hex" type="text" id="hex-${s.id}" value="${s.default.toUpperCase()}" maxlength="7">
            </div>
        `).join("");

        const photosHtml = (data.photos || []).map(p => `
            <div class="ref-item">
                <img src="${baseUrl}${p.src}" alt="${escapeHtml(p.label || "")}">
                <div class="caption">${escapeHtml(p.label || "")}</div>
            </div>
        `).join("");

        app.innerHTML = `
            <header>
                <div class="title-block">
                    <h1>${escapeHtml(data.title || data.id)}</h1>
                    <div class="sub">${escapeHtml(data.subtitle || "")}</div>
                </div>
                <div class="meta">
                    ${(data.meta?.lines || []).map(l => `<div>${l}</div>`).join("")}
                    <div id="dateStamp">—</div>
                </div>
            </header>
            <div class="layout">
                <div class="stage">
                    <div class="toggle-row">
                        <button class="toggle-btn active" data-view="proposed">${escapeHtml(data.viewButtons?.proposed || "Proposed")}</button>
                        <button class="toggle-btn" data-view="original">${escapeHtml(data.viewButtons?.original || "Original")}</button>
                    </div>
                    <div class="canvas-wrap">
                        <div class="canvas-label" id="canvasLabel">${escapeHtml(data.viewLabels?.proposed || "Proposed")}</div>
                        ${data.canvasId ? `<div class="canvas-id">${escapeHtml(data.canvasId)}</div>` : ""}
                        <canvas id="bldg" class="bldg"></canvas>
                        <div class="processing-overlay" id="processingOverlay">Rendering…</div>
                    </div>
                    ${photosHtml ? `
                        <div class="ref-strip">
                            <h3>Reference Photos</h3>
                            <div class="ref-grid">${photosHtml}</div>
                            ${data.photosCaption ? `<div style="font-family:'Helvetica Neue',Arial,sans-serif; font-size:10px; color:var(--ink-2); margin-top:10px; line-height:1.5;">${escapeHtml(data.photosCaption)}</div>` : ""}
                        </div>` : ""}
                </div>
                <div class="sidebar">
                    <div class="panel"><h2>Surfaces</h2>${surfacesHtml}</div>
                    ${data.compliance ? `
                        <div class="panel">
                            <h2>${escapeHtml(data.compliance.title || "Compliance")}</h2>
                            <div class="compliance" id="compliance"></div>
                            <div class="accent-meter">
                                <div>Bright/saturated coverage: <strong id="accentPct">—</strong></div>
                                <div class="meter-bar">
                                    <div class="meter-fill" id="meterFill" style="width:0%"></div>
                                    <div class="meter-tick"></div>
                                </div>
                                ${data.compliance.regulationText ? `<div style="margin-top:14px; font-size:10px; line-height:1.5;">${escapeHtml(data.compliance.regulationText)}</div>` : ""}
                            </div>
                        </div>` : ""}
                    <div class="panel"><h2>Reference Palettes</h2><div class="palette-grid" id="paletteGrid"></div></div>
                    <div class="panel">
                        <h2>Actions</h2>
                        <div class="actions">
                            <button class="action" id="btn-png">Save PNG</button>
                            <button class="action ghost" id="btn-share">Share Link</button>
                            <button class="action" id="btn-vote">Vote for This</button>
                            <button class="action ghost" id="btn-reset">Reset</button>
                        </div>
                        <div class="status-note" id="statusNote"></div>
                    </div>
                </div>
            </div>
            <footer>
                <div>${data.footer?.left || ""}</div>
                <div>${data.footer?.right || ""}</div>
            </footer>
        `;

        document.getElementById("dateStamp").textContent =
            new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    }

    // ---- Engine -----------------------------------------------------------
    async function initEngine(data, baseUrl) {
        const surfaceIds = data.surfaces.map(s => s.id);
        const surfaceById = Object.fromEntries(data.surfaces.map(s => [s.id, s]));
        // segId 0 = pass-through, 1..N = surfaces in order
        const segIdFor = id => surfaceIds.indexOf(id) + 1;

        const state = {
            colors: Object.fromEntries(data.surfaces.map(s => [s.id, s.default])),
            activePaletteIdx: data.defaultPaletteIdx ?? -1,
            view: "proposed",
        };

        // Hash override
        const hashColors = parseHash(data);
        if (hashColors) {
            Object.assign(state.colors, hashColors);
            state.activePaletteIdx = matchPaletteIdx(data, state.colors);
        }

        let originalImageData = null;
        let segmentMask = null;

        // ---- Segmentation -------------------------------------------------
        function buildSegmentMask(imgData) {
            const data2 = imgData.data;
            const w = imgData.width, h = imgData.height;
            const mask = new Uint8Array(w * h);
            const rules = data.segmentation?.rules || [];

            for (let i = 0, p = 0; i < data2.length; i += 4, p++) {
                const r = data2[i], g = data2[i + 1], b = data2[i + 2];
                const [hue, sat, lum] = rgbToHsl(r, g, b);
                let assigned = 0;
                for (const rule of rules) {
                    if (rule.rgbMin && (r < rule.rgbMin[0] || g < rule.rgbMin[1] || b < rule.rgbMin[2])) continue;
                    if (rule.rgbMax && (r > rule.rgbMax[0] || g > rule.rgbMax[1] || b > rule.rgbMax[2])) continue;
                    if (rule.lumMin != null && lum < rule.lumMin) continue;
                    if (rule.lumMax != null && lum > rule.lumMax) continue;
                    if (rule.satMin != null && sat < rule.satMin) continue;
                    if (rule.satMax != null && sat > rule.satMax) continue;
                    if (rule.hueRanges && !hueInRanges(hue, rule.hueRanges)) continue;
                    assigned = rule.assign ? segIdFor(rule.assign) : 0;
                    break;
                }
                mask[p] = assigned;
            }
            return mask;
        }

        // ---- Recolor ------------------------------------------------------
        function recolor() {
            if (!originalImageData || !segmentMask) return;
            const src = originalImageData.data;
            const w = originalImageData.width, h = originalImageData.height;
            const canvas = document.getElementById("bldg");
            const ctx = canvas.getContext("2d");
            canvas.width = w; canvas.height = h;

            if (state.view === "original") {
                ctx.putImageData(originalImageData, 0, 0);
                return;
            }

            const out = ctx.createImageData(w, h);
            const dst = out.data;

            const targets = {};
            const refLum = {};
            for (const s of data.surfaces) {
                const segId = segIdFor(s.id);
                targets[segId] = hexHsl(state.colors[s.id]);
                refLum[segId] = s.origHsl?.l ?? targets[segId][2];
            }

            for (let i = 0, p = 0; i < src.length; i += 4, p++) {
                const segId = segmentMask[p];
                if (segId === 0) {
                    dst[i] = src[i]; dst[i + 1] = src[i + 1]; dst[i + 2] = src[i + 2]; dst[i + 3] = src[i + 3];
                    continue;
                }
                const target = targets[segId];
                const ref = refLum[segId];
                const [, , origL] = rgbToHsl(src[i], src[i + 1], src[i + 2]);
                let newL = target[2] + (origL - ref);
                if (newL < 0) newL = 0;
                if (newL > 1) newL = 1;
                const [nr, ng, nb] = hslToRgb(target[0], target[1], newL);
                dst[i] = Math.round(nr); dst[i + 1] = Math.round(ng); dst[i + 2] = Math.round(nb); dst[i + 3] = 255;
            }
            ctx.putImageData(out, 0, 0);
        }

        // ---- Surfaces wiring ---------------------------------------------
        function applyColors() {
            for (const s of data.surfaces) {
                const v = state.colors[s.id];
                document.getElementById("sw-" + s.id).style.background = v;
                document.getElementById("c-" + s.id).value = v;
                document.getElementById("hex-" + s.id).value = v.toUpperCase();
            }
            showProcessing(true);
            requestAnimationFrame(() => requestAnimationFrame(() => {
                recolor();
                if (data.compliance) updateCompliance();
                writeHash();
                showProcessing(false);
            }));
        }
        const showProcessing = b => document.getElementById("processingOverlay").classList.toggle("show", b);

        function wireSurface(s) {
            const colorInput = document.getElementById("c-" + s.id);
            const hexInput = document.getElementById("hex-" + s.id);
            let timer;
            colorInput.addEventListener("input", e => {
                clearTimeout(timer);
                state.colors[s.id] = e.target.value;
                timer = setTimeout(() => { applyColors(); clearActivePalette(); }, 30);
            });
            hexInput.addEventListener("change", e => {
                let v = e.target.value.trim();
                if (!v.startsWith("#")) v = "#" + v;
                if (/^#[0-9a-fA-F]{6}$/.test(v)) {
                    state.colors[s.id] = v.toLowerCase();
                    applyColors();
                    clearActivePalette();
                } else {
                    e.target.value = state.colors[s.id].toUpperCase();
                }
            });
        }
        data.surfaces.forEach(wireSurface);

        // ---- Palettes ----------------------------------------------------
        function renderPalettes() {
            const grid = document.getElementById("paletteGrid");
            grid.innerHTML = (data.palettes || []).map((p, i) => `
                <button class="palette-card ${i === state.activePaletteIdx ? "active" : ""}" data-idx="${i}">
                    <div class="palette-name">${escapeHtml(p.name)}</div>
                    <div class="palette-desc">${escapeHtml(p.desc || "")}</div>
                    <div class="palette-strip">
                        ${data.surfaces.map(s => `<span style="background:${p.colors[s.id]}"></span>`).join("")}
                    </div>
                </button>
            `).join("");
            grid.querySelectorAll(".palette-card").forEach(btn => {
                btn.addEventListener("click", () => {
                    const idx = parseInt(btn.dataset.idx, 10);
                    const p = data.palettes[idx];
                    for (const s of data.surfaces) state.colors[s.id] = p.colors[s.id];
                    state.activePaletteIdx = idx;
                    applyColors();
                    renderPalettes();
                });
            });
        }
        function clearActivePalette() {
            state.activePaletteIdx = -1;
            document.querySelectorAll(".palette-card").forEach(c => c.classList.remove("active"));
        }

        // ---- Compliance --------------------------------------------------
        function isEarthOrNeutral(hex) {
            const c = data.compliance;
            const [h, s] = hexHsl(hex);
            const sPct = s * 100;
            if (sPct < c.satGates.low) return { ok: true, reason: "low-saturation neutral" };
            if (sPct < c.satGates.earth && hueInRanges(h, c.earthHues)) return { ok: true, reason: "muted earth tone" };
            if (sPct < c.satGates.muted) return { ok: true, reason: "muted neutral" };
            return { ok: false, reason: `high saturation (${sPct.toFixed(0)}%)` };
        }
        function updateCompliance() {
            const c = data.compliance;
            const checks = [];
            let brightPct = 0;
            for (const s of data.surfaces) {
                if (s.id === c.accentSurfaceId) continue; // accent allowed bright
                const r = isEarthOrNeutral(state.colors[s.id]);
                if (!r.ok) brightPct += (s.areaShare || 0) * 100;
                checks.push({
                    level: r.ok ? "pass" : "fail",
                    title: c.labels?.[s.id] || `${s.label}: neutral / earth tone`,
                    detail: r.ok
                        ? `OK — ${r.reason}`
                        : `${s.label} is too saturated (${r.reason}). Combined bright coverage may exceed the ${c.thresholds.warn}% allowance.`,
                });
            }
            const accentSurface = surfaceById[c.accentSurfaceId];
            if (accentSurface) {
                const accentPct = (accentSurface.areaShare || 0) * 100;
                checks.push({
                    level: "pass",
                    title: c.labels?.[accentSurface.id] || `${accentSurface.label}: bright color allowed`,
                    detail: `Accent surface ≈ ${accentPct.toFixed(1)}% of façade — within the ${c.thresholds.warn}% allowance.`,
                });
            }
            let totalLevel = "pass";
            if (brightPct > c.thresholds.warn && brightPct <= c.thresholds.fail) totalLevel = "warn";
            if (brightPct > c.thresholds.fail) totalLevel = "fail";
            checks.push({
                level: totalLevel,
                title: `Total bright/saturated coverage: ${brightPct.toFixed(1)}%`,
                detail: brightPct <= c.thresholds.warn
                    ? `Within the ${c.thresholds.warn}% accent allowance.`
                    : (brightPct <= c.thresholds.fail
                        ? `Above ${c.thresholds.warn}% — likely needs design review approval.`
                        : `Significantly exceeds ${c.thresholds.warn}% — likely denied without revision.`),
            });

            document.getElementById("compliance").innerHTML = checks.map(ch => `
                <div class="check-row">
                    <div class="check-icon ${ch.level}">${ch.level === "pass" ? "✓" : ch.level === "warn" ? "!" : "×"}</div>
                    <div class="check-text"><strong>${ch.title}</strong><span>${ch.detail}</span></div>
                </div>
            `).join("");
            const meterPct = Math.min(100, brightPct * (100 / 30));
            const fill = document.getElementById("meterFill");
            fill.style.width = meterPct + "%";
            fill.style.background = brightPct > c.thresholds.warn
                ? (brightPct > c.thresholds.fail ? "#8a3324" : "#b8860b")
                : "#2d5a3d";
            document.getElementById("accentPct").textContent = brightPct.toFixed(1) + "%";
        }

        // ---- Hash encoding -----------------------------------------------
        function writeHash() {
            const parts = data.surfaces.map(s => state.colors[s.id].replace("#", ""));
            const newHash = "#p=" + parts.join("-");
            if (location.hash !== newHash) history.replaceState(null, "", newHash);
        }

        // ---- View toggle, export, share, vote, reset --------------------
        document.querySelectorAll(".toggle-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                document.querySelectorAll(".toggle-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                state.view = btn.dataset.view;
                document.getElementById("canvasLabel").textContent =
                    data.viewLabels?.[state.view] || state.view;
                recolor();
            });
        });

        document.getElementById("btn-png").addEventListener("click", () => {
            const canvas = document.getElementById("bldg");
            const link = document.createElement("a");
            const prefix = data.exportFilenamePrefix || data.id;
            link.download = `${prefix}-${state.view}-${Date.now()}.png`;
            link.href = canvas.toDataURL("image/png");
            link.click();
        });

        document.getElementById("btn-share").addEventListener("click", async () => {
            writeHash();
            const url = location.href;
            try {
                await navigator.clipboard.writeText(url);
                setStatus("Link copied to clipboard.", "ok");
            } catch {
                prompt("Copy this link:", url);
            }
        });

        document.getElementById("btn-vote").addEventListener("click", async () => {
            if (!BACKEND_URL) {
                setStatus("No vote backend configured. Append ?backend=https://… to the URL, or set the vote-backend meta tag in index.html.", "err");
                return;
            }
            const choice = {
                subject: data.id,
                paletteIdx: state.activePaletteIdx,
                paletteName: state.activePaletteIdx >= 0 ? data.palettes[state.activePaletteIdx].name : null,
                colors: { ...state.colors },
            };
            setStatus("Submitting vote…");
            try {
                const r = await fetch(BACKEND_URL + "/vote", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(choice),
                });
                if (!r.ok) throw new Error(r.status + " " + r.statusText);
                const body = await r.json().catch(() => ({}));
                setStatus(`Vote recorded${body.totalForSubject ? ` (${body.totalForSubject} total for this subject)` : ""}.`, "ok");
            } catch (e) {
                setStatus("Vote failed: " + (e.message || e), "err");
            }
        });

        document.getElementById("btn-reset").addEventListener("click", () => {
            for (const s of data.surfaces) state.colors[s.id] = s.default;
            state.activePaletteIdx = data.defaultPaletteIdx ?? -1;
            applyColors();
            renderPalettes();
        });

        function setStatus(msg, cls = "") {
            const el = document.getElementById("statusNote");
            el.className = "status-note " + cls;
            el.textContent = msg;
        }

        // ---- Image load -------------------------------------------------
        await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const off = document.createElement("canvas");
                off.width = img.naturalWidth;
                off.height = img.naturalHeight;
                const offCtx = off.getContext("2d");
                offCtx.drawImage(img, 0, 0);
                originalImageData = offCtx.getImageData(0, 0, off.width, off.height);
                segmentMask = buildSegmentMask(originalImageData);
                applyColors();
                renderPalettes();
                resolve();
            };
            img.onerror = () => {
                document.getElementById("processingOverlay").textContent = "Image failed to load";
                document.getElementById("processingOverlay").classList.add("show");
                reject(new Error("image load failed"));
            };
            img.src = baseUrl + data.image;
        });
    }

    // ---- Hash parsing helpers --------------------------------------------
    function parseHash(data) {
        const m = location.hash.match(/[#&]p=([0-9a-fA-F-]+)/);
        if (!m) return null;
        const parts = m[1].split("-");
        if (parts.length !== data.surfaces.length) return null;
        const out = {};
        for (let i = 0; i < parts.length; i++) {
            if (!/^[0-9a-fA-F]{6}$/.test(parts[i])) return null;
            out[data.surfaces[i].id] = "#" + parts[i].toLowerCase();
        }
        return out;
    }
    function matchPaletteIdx(data, colors) {
        const palettes = data.palettes || [];
        for (let i = 0; i < palettes.length; i++) {
            const p = palettes[i];
            if (data.surfaces.every(s => (p.colors[s.id] || "").toLowerCase() === colors[s.id].toLowerCase())) {
                return i;
            }
        }
        return -1;
    }
})();
