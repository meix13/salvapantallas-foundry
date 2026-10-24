/**
 * Salvapantallas de Escena (Carrusel de Fondos) - Foundry VTT v12 / v13 / v14
 * Permite configurar 2 o más imágenes de fondo de las mismas proporciones en una escena
 * para que vayan rotando cada X segundos (por defecto 20s) con transición suave (crossfade)
 * directamente en PIXI/PrimaryCanvasGroup sin recargar el lienzo de los jugadores.
 */

const MODULE_ID = "salvapantallas-foundry";
const SOCKET_NAME = `module.${MODULE_ID}`;

const DEFAULT_CONFIG = {
    enabled: false,
    intervalSeconds: 20,
    fadeSeconds: 1.5,
    mode: "sequential", // "sequential" | "random"
    images: []
};

// Estado de ejecución en el cliente actual
let slideshowTimerId = null;
let activeFadeCancel = null;
let activeOverlayMesh = null;
let currentDisplayedSrc = null;
let currentSlideIndex = -1;
let originalBackgroundTexture = null;
let preloadedTextures = new Map();

/**
 * Escapa texto para atributos/HTML
 */
function escapeHtml(str) {
    return (str || "")
        .toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * Obtiene la clase FilePicker compatible con Foundry v12/v13/v14
 */
function getFilePickerClass() {
    return foundry?.applications?.apps?.FilePicker?.implementation || window.FilePicker;
}

/**
 * Función loadTexture compatible con Foundry v12/v13/v14
 */
async function loadSceneTexture(src) {
    if (!src) return null;
    if (preloadedTextures.has(src)) {
        const cached = preloadedTextures.get(src);
        if (cached && cached.valid) return cached;
    }
    const loader = foundry?.canvas?.loadTexture || window.loadTexture;
    if (typeof loader !== "function") return null;
    const tex = await loader(src);
    if (tex) {
        preloadedTextures.set(src, tex);
    }
    return tex;
}

/**
 * Obtiene la imagen de fondo nativa configurada actualmente en la escena (compatible con Levels de v14)
 */
function getSceneNativeBackgroundSrc(scene) {
    if (!scene) return "";
    if (scene.background?.src) return scene.background.src;
    const viewLevel = scene.levels?.find?.(l => l.isView) || scene.levels?.contents?.[0];
    if (viewLevel?.textures?.background?.src) return viewLevel.textures.background.src;
    return "";
}

/**
 * Normaliza y devuelve la configuración de salvapantallas guardada en una escena
 */
function getSceneSlideshowConfig(scene) {
    if (!scene) return foundry.utils.deepClone(DEFAULT_CONFIG);
    const raw = scene.getFlag(MODULE_ID, "config") || {};
    const images = Array.isArray(raw.images)
        ? raw.images.map(s => (s || "").toString().trim()).filter(Boolean)
        : [];

    return {
        enabled: Boolean(raw.enabled),
        intervalSeconds: Math.max(2, Number(raw.intervalSeconds) || DEFAULT_CONFIG.intervalSeconds),
        fadeSeconds: Math.max(0, Number(raw.fadeSeconds ?? DEFAULT_CONFIG.fadeSeconds)),
        mode: raw.mode === "random" ? "random" : "sequential",
        images
    };
}

/**
 * Guarda la configuración de salvapantallas en los flags de la escena
 */
async function saveSceneSlideshowConfig(scene, config) {
    if (!scene || !game.user?.isGM) return;
    const cleanConfig = {
        enabled: Boolean(config.enabled),
        intervalSeconds: Math.max(2, Number(config.intervalSeconds) || DEFAULT_CONFIG.intervalSeconds),
        fadeSeconds: Math.max(0, Number(config.fadeSeconds ?? DEFAULT_CONFIG.fadeSeconds)),
        mode: config.mode === "random" ? "random" : "sequential",
        images: Array.isArray(config.images)
            ? config.images.map(s => (s || "").toString().trim()).filter(Boolean)
            : []
    };
    await scene.setFlag(MODULE_ID, "config", cleanConfig);
}

/* ==========================================================================
   1. MOTOR GRÁFICO PIXI / PRIMARY CANVAS GROUP (CROSSFADE SIN RECARGAR)
   ========================================================================== */

/**
 * Cancela cualquier transición en curso y limpia el mesh superpuesto temporal
 */
function cleanupActiveTransition() {
    if (typeof activeFadeCancel === "function") {
        activeFadeCancel();
        activeFadeCancel = null;
    }
    if (activeOverlayMesh) {
        try {
            if (activeOverlayMesh.parent) {
                activeOverlayMesh.parent.removeChild(activeOverlayMesh);
            }
            activeOverlayMesh.destroy({ children: true });
        } catch (e) {}
        activeOverlayMesh = null;
    }
}

/**
 * Ajusta el tamaño del mesh de fondo a las dimensiones del rectángulo de la escena
 */
function resizeMeshToSceneRect(mesh) {
    if (!mesh || !canvas?.dimensions?.sceneRect) return;
    const r = canvas.dimensions.sceneRect;
    const viewLevel = canvas.scene?.levels?.find?.(l => l.isView) || canvas.scene?.levels?.contents?.[0];
    const levelTexConfig = viewLevel?.textures || {
        anchorX: 0.5,
        anchorY: 0.5,
        offsetX: 0,
        offsetY: 0,
        fit: "fill",
        scaleX: 1,
        scaleY: 1,
        rotation: 0
    };

    if (typeof mesh.resize === "function") {
        mesh.resize(r.width, r.height, levelTexConfig);
    } else {
        mesh.width = r.width;
        mesh.height = r.height;
    }
}

/**
 * Aplica directamente una textura al mesh de fondo primario de Foundry
 */
function applyTextureToPrimaryBackground(bgMesh, texture, src) {
    if (!bgMesh || !texture) return;
    bgMesh.texture = texture;
    resizeMeshToSceneRect(bgMesh);
    bgMesh.alpha = 1;
    bgMesh.visible = texture !== PIXI.Texture.EMPTY;

    // Si es un vídeo (.webm / .mp4), asegurar reproducción en bucle
    try {
        const video = game.video?.getVideoSource?.(bgMesh);
        if (video) {
            canvas.primary?.videoMeshes?.add?.(bgMesh);
            game.video.play(video, {
                loop: true,
                volume: game.settings.get("core", "globalAmbientVolume")
            });
        }
    } catch (e) {}

    if (canvas.primary) {
        canvas.primary.sortDirty = true;
    }
    currentDisplayedSrc = src;
}

/**
 * Realiza la transición (corte directo o fundido crossfade) hacia la imagen indicada
 */
async function transitionToBackgroundImage(nextSrc, fadeSeconds = 1.5) {
    if (!canvas?.ready || !canvas?.primary?.background || !nextSrc) return;
    if (currentDisplayedSrc === nextSrc) return;

    const sceneAtStart = canvas.scene?.id;
    const nextTexture = await loadSceneTexture(nextSrc);
    if (!nextTexture || !canvas?.ready || canvas.scene?.id !== sceneAtStart) return;

    const bgMesh = canvas.primary.background;
    if (!bgMesh) return;

    cleanupActiveTransition();

    const fadeMs = Math.max(0, Number(fadeSeconds) * 1000);
    const hasCurrentVisibleBg = bgMesh.visible && bgMesh.texture && bgMesh.texture !== PIXI.Texture.EMPTY;

    // Si no hay fundido o no había fondo visible previo, cambio instantáneo
    if (fadeMs < 50 || !hasCurrentVisibleBg) {
        applyTextureToPrimaryBackground(bgMesh, nextTexture, nextSrc);
        return;
    }

    // Crear un PrimarySpriteMesh temporal encima del fondo para un crossfade 100% opaco
    try {
        const MeshClass = bgMesh.constructor;
        const overlay = new MeshClass({
            name: "SalvapantallasTransitionOverlay",
            texture: nextTexture,
            object: canvas.primary
        });

        overlay.anchor.copyFrom(bgMesh.anchor);
        overlay.position.copyFrom(bgMesh.position);
        overlay.angle = bgMesh.angle;
        overlay.elevation = bgMesh.elevation;
        overlay.sort = (bgMesh.sort || 0) + 1;
        overlay.sortLayer = bgMesh.sortLayer;
        overlay.zIndex = (bgMesh.zIndex || 0) + 0.01;
        overlay.textureAlphaThreshold = bgMesh.textureAlphaThreshold;
        overlay.restrictsLight = bgMesh.restrictsLight;
        overlay.restrictsWeather = bgMesh.restrictsWeather;
        overlay.occlusionMode = bgMesh.occlusionMode;
        overlay.hoverFade = false;
        if (bgMesh.tint !== undefined) overlay.tint = bgMesh.tint;

        resizeMeshToSceneRect(overlay);
        overlay.alpha = 0;
        overlay.visible = true;

        canvas.primary.addChild(overlay);
        canvas.primary.sortDirty = true;
        activeOverlayMesh = overlay;

        // Si el overlay es vídeo, iniciarlo
        try {
            const video = game.video?.getVideoSource?.(overlay);
            if (video) {
                game.video.play(video, { loop: true, volume: 0 });
            }
        } catch (e) {}

        await new Promise((resolve) => {
            let cancelled = false;
            const startTime = performance.now();

            activeFadeCancel = () => {
                cancelled = true;
                resolve();
            };

            function step(now) {
                if (cancelled || !canvas?.ready || canvas.scene?.id !== sceneAtStart) {
                    resolve();
                    return;
                }
                const elapsed = now - startTime;
                const progress = Math.min(1, elapsed / fadeMs);
                // Curva suave easeInOutSine
                const eased = -(Math.cos(Math.PI * progress) - 1) / 2;
                if (activeOverlayMesh) {
                    activeOverlayMesh.alpha = eased;
                }

                if (progress < 1) {
                    requestAnimationFrame(step);
                } else {
                    applyTextureToPrimaryBackground(bgMesh, nextTexture, nextSrc);
                    cleanupActiveTransition();
                    resolve();
                }
            }

            requestAnimationFrame(step);
        });
    } catch (err) {
        console.warn(`${MODULE_ID} | Fallback a cambio directo de textura:`, err);
        cleanupActiveTransition();
        applyTextureToPrimaryBackground(bgMesh, nextTexture, nextSrc);
    }
}

/**
 * Calcula qué índice de imagen toca mostrar según el reloj sincronizado
 * para que todos los jugadores vean exactamente la misma imagen al mismo tiempo.
 */
function computeSyncedSlideIndex(config) {
    const count = config.images.length;
    if (count === 0) return -1;
    if (count === 1) return 0;

    const intervalMs = Math.max(2000, config.intervalSeconds * 1000);
    const serverNow = game.time?.serverTime || Date.now();
    const tickNumber = Math.floor(serverNow / intervalMs);

    if (config.mode === "random") {
        // Generador pseudoaleatorio determinista basado en tickNumber para mantener sincronía entre clientes
        const hash = Math.abs(Math.sin(tickNumber * 12.9898 + 78.233) * 43758.5453);
        return Math.floor((hash - Math.floor(hash)) * count);
    }

    return ((tickNumber % count) + count) % count;
}

/**
 * Precarga en segundo plano todas las imágenes configuradas en la escena actual
 */
async function preloadSlideshowImages(images) {
    for (const src of images) {
        try {
            await loadSceneTexture(src);
        } catch (err) {
            console.warn(`${MODULE_ID} | No se pudo precargar la imagen "${src}":`, err);
        }
    }
}

/**
 * Detiene el temporizador del salvapantallas en el cliente actual
 */
function stopSlideshowLoop({ restoreOriginal = false } = {}) {
    if (slideshowTimerId !== null) {
        clearInterval(slideshowTimerId);
        slideshowTimerId = null;
    }
    cleanupActiveTransition();

    if (restoreOriginal && originalBackgroundTexture && canvas?.ready && canvas?.primary?.background) {
        const nativeSrc = getSceneNativeBackgroundSrc(canvas.scene);
        applyTextureToPrimaryBackground(canvas.primary.background, originalBackgroundTexture, nativeSrc);
    }

    currentDisplayedSrc = null;
    currentSlideIndex = -1;
}

/**
 * Inicia o actualiza el bucle del salvapantallas para la escena visualizada en el lienzo
 */
async function startOrSyncSlideshowForCurrentCanvas() {
    stopSlideshowLoop({ restoreOriginal: false });

    if (!canvas?.ready || !canvas?.scene || !canvas?.primary?.background) return;

    const scene = canvas.scene;
    const config = getSceneSlideshowConfig(scene);

    // Guardar referencia a la textura original del fondo por si el usuario desactiva el salvapantallas en vivo
    if (!originalBackgroundTexture && canvas.primary.background.texture) {
        originalBackgroundTexture = canvas.primary.background.texture;
    }

    if (!config.enabled || config.images.length < 2) {
        if (originalBackgroundTexture && canvas.primary.background.texture !== originalBackgroundTexture) {
            const nativeSrc = getSceneNativeBackgroundSrc(scene);
            applyTextureToPrimaryBackground(canvas.primary.background, originalBackgroundTexture, nativeSrc);
        }
        return;
    }

    // Precargar las primeras 2 imágenes de inmediato y el resto en segundo plano
    await loadSceneTexture(config.images[0]);
    if (config.images[1]) loadSceneTexture(config.images[1]);
    preloadSlideshowImages(config.images.slice(2));

    // Mostrar la imagen inicial correspondiente al instante actual
    const initialIdx = computeSyncedSlideIndex(config);
    currentSlideIndex = initialIdx;
    const initialSrc = config.images[initialIdx];
    await transitionToBackgroundImage(initialSrc, 0.4);

    // Comprobar cada 500ms si el reloj ha cruzado al siguiente intervalo de X segundos
    slideshowTimerId = setInterval(() => {
        if (!canvas?.ready || !canvas?.scene) {
            stopSlideshowLoop();
            return;
        }
        const liveConfig = getSceneSlideshowConfig(canvas.scene);
        if (!liveConfig.enabled || liveConfig.images.length < 2) {
            stopSlideshowLoop({ restoreOriginal: true });
            return;
        }

        const targetIdx = computeSyncedSlideIndex(liveConfig);
        if (targetIdx !== currentSlideIndex && liveConfig.images[targetIdx]) {
            currentSlideIndex = targetIdx;
            transitionToBackgroundImage(liveConfig.images[targetIdx], liveConfig.fadeSeconds);
        }
    }, 500);
}

/**
 * Permite avanzar manualmente a la siguiente imagen (y sincronizar con todos los clientes vía socket)
 */
async function triggerManualStep(direction = 1) {
    if (!canvas?.ready || !canvas?.scene) return;
    const config = getSceneSlideshowConfig(canvas.scene);
    if (config.images.length < 2) {
        ui.notifications.warn("Configura al menos 2 imágenes en el salvapantallas de la escena.");
        return;
    }

    const nextIdx = ((currentSlideIndex < 0 ? 0 : currentSlideIndex) + direction + config.images.length) % config.images.length;
    currentSlideIndex = nextIdx;
    const nextSrc = config.images[nextIdx];
    await transitionToBackgroundImage(nextSrc, config.fadeSeconds);

    if (game.user?.isGM && game.socket) {
        game.socket.emit(SOCKET_NAME, {
            action: "forceSlide",
            sceneId: canvas.scene.id,
            src: nextSrc,
            fadeSeconds: config.fadeSeconds
        });
    }
}

/* ==========================================================================
   2. INTERFAZ EN LA CONFIGURACIÓN DE LA ESCENA (SceneConfig)
   ========================================================================== */

Hooks.on("renderSceneConfig", (app, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;

    if (root.querySelector(".spf-scene-config-box")) return;

    const scene = app.document || app.object;
    if (!scene) return;

    let state = getSceneSlideshowConfig(scene);

    // Localizar la barra de pestañas (<nav>) y los paneles de contenido (div.tab),
    // evitando explícitamente coincidir con los enlaces <a data-tab="..."> del <nav>
    const navBar = root.querySelector("nav.sheet-tabs, nav.tabs");
    const miscNavItem = navBar?.querySelector('[data-tab="misc"]');
    const miscPanel =
        root.querySelector('div.tab[data-tab="misc"], section.tab[data-tab="misc"]') ||
        root.querySelector('div.tab[data-tab="basics"], section.tab[data-tab="basics"]');

    if (!miscPanel) return;

    const bgInput = root.querySelector('[name="background.src"], [name$=".background.src"]');

    const box = document.createElement("div");
    box.className = "spf-scene-config-box";

    // Inputs ocultos para que si el usuario pulsa "Guardar Cambios" en SceneConfig se guarden también vía submit nativo
    const hiddenContainer = document.createElement("div");
    hiddenContainer.style.display = "none";
    box.appendChild(hiddenContainer);

    const contentContainer = document.createElement("div");
    box.appendChild(contentContainer);

    function syncHiddenInputs() {
        hiddenContainer.innerHTML = `
            <input type="hidden" name="flags.${MODULE_ID}.config.enabled" value="${state.enabled ? "true" : "false"}" data-dtype="Boolean" />
            <input type="hidden" name="flags.${MODULE_ID}.config.intervalSeconds" value="${state.intervalSeconds}" data-dtype="Number" />
            <input type="hidden" name="flags.${MODULE_ID}.config.fadeSeconds" value="${state.fadeSeconds}" data-dtype="Number" />
            <input type="hidden" name="flags.${MODULE_ID}.config.mode" value="${escapeHtml(state.mode)}" />
        `;
    }

    async function persistState({ notify = false } = {}) {
        syncHiddenInputs();
        await saveSceneSlideshowConfig(scene, state);

        // Si la escena no tiene imagen de fondo principal configurada y hay imágenes en la lista,
        // rellenar el input de fondo principal con la primera imagen para que Foundry tome las dimensiones automáticamente
        if (state.images.length > 0 && bgInput && !bgInput.value) {
            bgInput.value = state.images[0];
            bgInput.dispatchEvent(new Event("change", { bubbles: true }));
        }

        if (notify) {
            ui.notifications.info(`Salvapantallas actualizado en "${scene.name}".`);
        }
    }

    function renderBoxContent() {
        syncHiddenInputs();
        const isReady = state.enabled && state.images.length >= 2;
        const badgeText = isReady
            ? `Activo (${state.images.length} imágenes · cada ${state.intervalSeconds}s)`
            : state.enabled
                ? `Faltan imágenes (${state.images.length}/2 mín.)`
                : "Desactivado";

        contentContainer.innerHTML = `
            <div class="spf-scene-config-header">
                <div class="spf-scene-config-header-title">
                    <i class="fa-solid fa-images"></i>
                    <span>Salvapantallas de Escena (Carrusel de Fondos)</span>
                </div>
                <span class="spf-badge-status ${isReady ? "is-active" : "is-inactive"}">${escapeHtml(badgeText)}</span>
            </div>

            <div class="spf-enable-row">
                <label class="spf-enable-label">
                    <input type="checkbox" class="spf-chk-enabled" ${state.enabled ? "checked" : ""} />
                    <span>Activar cambio automático de imagen de fondo en esta escena</span>
                </label>
                ${scene.id === canvas?.scene?.id && state.images.length >= 2 ? `
                    <button type="button" class="spf-btn" data-spf-action="test-next" title="Probar transición ahora mismo en el lienzo">
                        <i class="fa-solid fa-forward-step"></i> Probar cambio
                    </button>
                ` : ""}
            </div>

            <div class="spf-controls-grid">
                <div class="spf-control-item">
                    <label>Intervalo (segundos)</label>
                    <input type="number" class="spf-inp-interval" min="2" max="3600" step="1" value="${state.intervalSeconds}" />
                </div>
                <div class="spf-control-item">
                    <label>Fundido suave (segundos)</label>
                    <input type="number" class="spf-inp-fade" min="0" max="15" step="0.5" value="${state.fadeSeconds}" />
                </div>
                <div class="spf-control-item">
                    <label>Orden de rotación</label>
                    <select class="spf-sel-mode">
                        <option value="sequential" ${state.mode === "sequential" ? "selected" : ""}>Secuencial (1 → 2 → 3...)</option>
                        <option value="random" ${state.mode === "random" ? "selected" : ""}>Aleatorio sincronizado</option>
                    </select>
                </div>
            </div>

            <div class="spf-images-header">
                <span class="spf-images-header-title">
                    Imágenes del Carrusel (${state.images.length}) — Mismas proporciones
                </span>
                <div class="spf-images-toolbar">
                    <button type="button" class="spf-btn" data-spf-action="add-current-bg" title="Añadir la imagen de fondo actual de la escena a la lista">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> + Fondo actual
                    </button>
                    <button type="button" class="spf-btn spf-btn-primary" data-spf-action="add-image">
                        <i class="fa-solid fa-plus"></i> Añadir imagen
                    </button>
                </div>
            </div>

            <div class="spf-image-list">
                ${state.images.length === 0 ? `
                    <div class="spf-empty-list">
                        Añade 2 o más imágenes de las mismas proporciones para que el fondo de la escena rote automáticamente como un salvapantallas.
                    </div>
                ` : state.images.map((imgSrc, idx) => `
                    <div class="spf-image-row" data-idx="${idx}">
                        <span class="spf-image-index">#${idx + 1}</span>
                        <img class="spf-image-thumb" src="${escapeHtml(imgSrc)}" alt="Miniatura ${idx + 1}" onerror="this.style.visibility='hidden'" />
                        <input type="text" class="spf-image-input" value="${escapeHtml(imgSrc)}" placeholder="Ruta de imagen o vídeo..." />
                        <div class="spf-image-actions">
                            <button type="button" class="spf-btn spf-btn-icon" data-spf-action="browse" data-idx="${idx}" title="Seleccionar archivo">
                                <i class="fa-solid fa-folder-open"></i>
                            </button>
                            <button type="button" class="spf-btn spf-btn-icon" data-spf-action="move-up" data-idx="${idx}" ${idx === 0 ? "disabled" : ""} title="Subir">
                                <i class="fa-solid fa-arrow-up"></i>
                            </button>
                            <button type="button" class="spf-btn spf-btn-icon" data-spf-action="move-down" data-idx="${idx}" ${idx === state.images.length - 1 ? "disabled" : ""} title="Bajar">
                                <i class="fa-solid fa-arrow-down"></i>
                            </button>
                            <button type="button" class="spf-btn spf-btn-icon spf-btn-danger" data-spf-action="remove" data-idx="${idx}" title="Quitar imagen">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        </div>
                    </div>
                `).join("")}
            </div>

            <p class="spf-hint">
                <i class="fa-solid fa-circle-info"></i>
                El cambio se realiza directamente en el motor gráfico con fundido suave (sin recargar la escena a los jugadores) y está sincronizado entre todos los conectados.
            </p>
        `;

        // Eventos de controles principales
        contentContainer.querySelector(".spf-chk-enabled")?.addEventListener("change", async (ev) => {
            state.enabled = Boolean(ev.target.checked);
            // Si activa el salvapantallas y la lista está vacía pero la escena ya tiene un fondo, incluirlo automáticamente
            const currentBg = bgInput?.value || getSceneNativeBackgroundSrc(scene);
            if (state.enabled && state.images.length === 0 && currentBg) {
                state.images.push(currentBg);
            }
            renderBoxContent();
            await persistState();
        });

        contentContainer.querySelector(".spf-inp-interval")?.addEventListener("change", async (ev) => {
            state.intervalSeconds = Math.max(2, Number(ev.target.value) || 20);
            renderBoxContent();
            await persistState();
        });

        contentContainer.querySelector(".spf-inp-fade")?.addEventListener("change", async (ev) => {
            state.fadeSeconds = Math.max(0, Number(ev.target.value ?? 1.5));
            renderBoxContent();
            await persistState();
        });

        contentContainer.querySelector(".spf-sel-mode")?.addEventListener("change", async (ev) => {
            state.mode = ev.target.value === "random" ? "random" : "sequential";
            renderBoxContent();
            await persistState();
        });

        // Botón probar cambio en vivo
        contentContainer.querySelector('[data-spf-action="test-next"]')?.addEventListener("click", () => {
            triggerManualStep(1);
        });

        // Botón añadir el fondo actual de la escena
        contentContainer.querySelector('[data-spf-action="add-current-bg"]')?.addEventListener("click", async () => {
            const currentBg = (bgInput?.value || getSceneNativeBackgroundSrc(scene) || "").trim();
            if (!currentBg) {
                ui.notifications.warn("La escena aún no tiene una imagen de fondo principal seleccionada arriba.");
                return;
            }
            if (!state.images.includes(currentBg)) {
                state.images.push(currentBg);
                if (state.images.length >= 2) state.enabled = true;
                renderBoxContent();
                await persistState();
            } else {
                ui.notifications.info("Esa imagen ya está incluida en la lista del salvapantallas.");
            }
        });

        // Botón añadir nueva imagen abriendo directamente el FilePicker
        contentContainer.querySelector('[data-spf-action="add-image"]')?.addEventListener("click", () => {
            const FP = getFilePickerClass();
            const lastImg = state.images[state.images.length - 1] || bgInput?.value || getSceneNativeBackgroundSrc(scene) || "";
            if (FP) {
                new FP({
                    type: "imagevideo",
                    current: lastImg,
                    callback: async (path) => {
                        if (path) {
                            state.images.push(path);
                            if (state.images.length >= 2) state.enabled = true;
                            renderBoxContent();
                            await persistState();
                        }
                    }
                }).browse();
            } else {
                state.images.push("");
                renderBoxContent();
            }
        });

        // Eventos por cada fila de imagen
        contentContainer.querySelectorAll(".spf-image-row").forEach((rowEl) => {
            const idx = Number(rowEl.dataset.idx);
            const inp = rowEl.querySelector(".spf-image-input");

            inp?.addEventListener("change", async (ev) => {
                const val = ev.target.value.trim();
                if (val) {
                    state.images[idx] = val;
                } else {
                    state.images.splice(idx, 1);
                }
                renderBoxContent();
                await persistState();
            });
        });

        contentContainer.querySelectorAll('[data-spf-action="browse"]').forEach((btn) => {
            btn.addEventListener("click", () => {
                const idx = Number(btn.dataset.idx);
                const FP = getFilePickerClass();
                if (!FP) return;
                new FP({
                    type: "imagevideo",
                    current: state.images[idx] || "",
                    callback: async (path) => {
                        if (path) {
                            state.images[idx] = path;
                            renderBoxContent();
                            await persistState();
                        }
                    }
                }).browse();
            });
        });

        contentContainer.querySelectorAll('[data-spf-action="move-up"]').forEach((btn) => {
            btn.addEventListener("click", async () => {
                const idx = Number(btn.dataset.idx);
                if (idx > 0) {
                    const tmp = state.images[idx - 1];
                    state.images[idx - 1] = state.images[idx];
                    state.images[idx] = tmp;
                    renderBoxContent();
                    await persistState();
                }
            });
        });

        contentContainer.querySelectorAll('[data-spf-action="move-down"]').forEach((btn) => {
            btn.addEventListener("click", async () => {
                const idx = Number(btn.dataset.idx);
                if (idx < state.images.length - 1) {
                    const tmp = state.images[idx + 1];
                    state.images[idx + 1] = state.images[idx];
                    state.images[idx] = tmp;
                    renderBoxContent();
                    await persistState();
                }
            });
        });

        contentContainer.querySelectorAll('[data-spf-action="remove"]').forEach((btn) => {
            btn.addEventListener("click", async () => {
                const idx = Number(btn.dataset.idx);
                state.images.splice(idx, 1);
                renderBoxContent();
                await persistState();
            });
        });
    }

    renderBoxContent();

    // Crear una pestaña propia "Salvapantallas" en la barra de navegación superior de SceneConfig
    if (navBar && miscNavItem && miscPanel.parentElement) {
        const spfNavItem = document.createElement(miscNavItem.tagName.toLowerCase());
        spfNavItem.className = miscNavItem.className.replace(/\bactive\b/g, "").trim() + " spf-nav-item";
        if (spfNavItem.tagName === "BUTTON") spfNavItem.type = "button";
        spfNavItem.innerHTML = `<i class="fa-solid fa-images"></i> <span>Salvapantallas</span>`;
        navBar.appendChild(spfNavItem);

        const spfPanel = document.createElement("div");
        spfPanel.className = "tab scrollable spf-tab-panel";
        spfPanel.dataset.group = miscPanel.dataset.group || "sheet";
        spfPanel.appendChild(box);
        miscPanel.insertAdjacentElement("afterend", spfPanel);

        // Al pulsar la pestaña "Salvapantallas", desactivar las demás y activar la nuestra
        spfNavItem.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();

            navBar.querySelectorAll(".active").forEach(el => el.classList.remove("active"));
            spfNavItem.classList.add("active");

            miscPanel.parentElement.querySelectorAll(":scope > .tab").forEach(el => el.classList.remove("active"));
            spfPanel.classList.add("active");
        });

        // Al pulsar cualquier pestaña nativa de Foundry, desactivar "Salvapantallas" y asegurar que la nativa se muestre
        navBar.addEventListener("click", (ev) => {
            const clickedNative = ev.target.closest("[data-tab]");
            if (clickedNative && clickedNative !== spfNavItem) {
                const tabId = clickedNative.dataset.tab;
                spfNavItem.classList.remove("active");
                spfPanel.classList.remove("active");

                clickedNative.classList.add("active");
                const nativePanel = miscPanel.parentElement.querySelector(
                    `div.tab[data-tab="${tabId}"], section.tab[data-tab="${tabId}"]`
                );
                if (nativePanel) {
                    nativePanel.classList.add("active");
                }
            }
        });
    } else {
        // Fallback: añadir al final del panel de Miscelánea
        miscPanel.appendChild(box);
    }
});

/* ==========================================================================
   3. MODAL GESTOR RÁPIDO DESDE EL DIRECTORIO DE ESCENAS
   ========================================================================== */

function openSlideshowManagerModal() {
    if (!game.user?.isGM) return;

    let backdrop = document.getElementById("spf-modal-backdrop");
    if (!backdrop) {
        backdrop = document.createElement("div");
        backdrop.id = "spf-modal-backdrop";
        backdrop.className = "spf-modal-backdrop";
        backdrop.addEventListener("click", (ev) => {
            if (ev.target === backdrop) backdrop.remove();
        });
        document.body.appendChild(backdrop);
    }

    const scenes = [...(game.scenes || [])].sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    backdrop.innerHTML = `
        <div class="spf-modal">
            <div class="spf-modal-header">
                <div class="spf-modal-title">
                    <i class="fa-solid fa-images"></i>
                    <span>GESTOR DE SALVAPANTALLAS DE ESCENA</span>
                </div>
                <div style="display:flex; gap:8px;">
                    <button type="button" class="spf-btn" id="spf-force-next-btn" title="Cambiar a la siguiente imagen en la escena actual">
                        <i class="fa-solid fa-forward-step"></i> Siguiente imagen ahora
                    </button>
                    <button type="button" class="spf-btn" id="spf-close-modal-btn">
                        <i class="fa-solid fa-xmark"></i> Cerrar
                    </button>
                </div>
            </div>
            <div class="spf-modal-body">
                <p style="font-size:12px; color:#94a3b8; margin-top:0; margin-bottom:12px;">
                    Resumen de todas las escenas del mundo. Pulsa <strong>Configurar</strong> para abrir la configuración de esa escena y añadir o editar sus imágenes de salvapantallas.
                </p>
                <table class="spf-scene-table">
                    <thead>
                        <tr>
                            <th>Escena</th>
                            <th>Estado</th>
                            <th>Imágenes</th>
                            <th>Intervalo / Transición</th>
                            <th style="text-align:right;">Acciones</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${scenes.map((sc) => {
                            const cfg = getSceneSlideshowConfig(sc);
                            const isReady = cfg.enabled && cfg.images.length >= 2;
                            return `
                                <tr data-scene-id="${sc.id}">
                                    <td>
                                        <strong>${escapeHtml(sc.name)}</strong>
                                        ${sc.active ? `<span class="spf-badge-status is-active" style="margin-left:6px;">Activa</span>` : ""}
                                    </td>
                                    <td>
                                        <span class="spf-badge-status ${isReady ? "is-active" : "is-inactive"}">
                                            ${isReady ? "Activo" : cfg.enabled ? "Incompleto (<2)" : "Inactivo"}
                                        </span>
                                    </td>
                                    <td>${cfg.images.length} imágenes</td>
                                    <td>Cada ${cfg.intervalSeconds}s (fundido ${cfg.fadeSeconds}s)</td>
                                    <td style="text-align:right;">
                                        <button type="button" class="spf-btn spf-btn-primary" data-open-scene="${sc.id}">
                                            <i class="fa-solid fa-gear"></i> Configurar
                                        </button>
                                    </td>
                                </tr>
                            `;
                        }).join("")}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    backdrop.querySelector("#spf-close-modal-btn")?.addEventListener("click", () => backdrop.remove());
    backdrop.querySelector("#spf-force-next-btn")?.addEventListener("click", () => triggerManualStep(1));
    backdrop.querySelectorAll("[data-open-scene]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const sc = game.scenes?.get(btn.dataset.openScene);
            if (sc) {
                backdrop.remove();
                sc.sheet?.render(true);
            }
        });
    });
}

/* ==========================================================================
   4. HOOKS PRINCIPALES DE FOUNDRY VTT
   ========================================================================== */

Hooks.once("init", () => {
    console.log(`${MODULE_ID} | Inicializando Salvapantallas de Escena (Carrusel de Fondos)...`);

    window.SalvapantallasFoundry = {
        openManager: () => openSlideshowManagerModal(),
        nextSlide: () => triggerManualStep(1),
        prevSlide: () => triggerManualStep(-1),
        syncNow: () => startOrSyncSlideshowForCurrentCanvas()
    };
});

Hooks.once("ready", () => {
    if (game.socket) {
        game.socket.on(SOCKET_NAME, (payload) => {
            if (!payload || !canvas?.ready) return;
            if (payload.action === "forceSlide" && payload.sceneId === canvas.scene?.id && payload.src) {
                transitionToBackgroundImage(payload.src, payload.fadeSeconds ?? 1.5);
            }
        });
    }

    if (canvas?.ready) {
        startOrSyncSlideshowForCurrentCanvas();
    }
});

Hooks.on("canvasReady", () => {
    originalBackgroundTexture = canvas?.primary?.background?.texture || null;
    currentDisplayedSrc = getSceneNativeBackgroundSrc(canvas?.scene) || null;
    currentSlideIndex = -1;
    startOrSyncSlideshowForCurrentCanvas();
});

Hooks.on("canvasTearDown", () => {
    stopSlideshowLoop({ restoreOriginal: false });
    originalBackgroundTexture = null;
    preloadedTextures.clear();
});

Hooks.on("updateScene", (scene, changed) => {
    if (!canvas?.ready || scene.id !== canvas.scene?.id) return;
    if (changed.flags && (MODULE_ID in changed.flags)) {
        startOrSyncSlideshowForCurrentCanvas();
    }
});

Hooks.on("renderSceneDirectory", (app, html) => {
    if (!game.user?.isGM) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root || root.querySelector(".spf-scene-dir-btn")) return;

    const headerActions = root.querySelector(".header-actions");
    if (headerActions) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "spf-scene-dir-btn";
        btn.style.cssText = "background:#0b1120; border:1px solid #38bdf8; color:#38bdf8; font-family:monospace; font-weight:bold;";
        btn.innerHTML = `<i class="fa-solid fa-images"></i> Salvapantallas Escenas`;
        btn.addEventListener("click", () => openSlideshowManagerModal());
        headerActions.appendChild(btn);
    }
});

