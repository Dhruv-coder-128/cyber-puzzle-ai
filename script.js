// --- PHOTO DELIVERY CONFIGURATION ---
// Configure your serverless backend URL here (e.g., Cloudflare Worker endpoint)
const PHOTO_UPLOAD_CONFIG = {
    // Development toggle: set to true to enable photo uploads, false to disable
    enabled: true,
    // Deployed Cloudflare Worker endpoint
    endpoint: 'https://cyber-puzzle-ai.dushah2007.workers.dev/upload'
};

// --- PREDEFINED PUZZLE GALLERY (assets/puzzles/puzzle_1.jpg to puzzle_20.jpg) ---
const PREDEFINED_PUZZLES = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    title: `Puzzle ${String(i + 1).padStart(2, '0')}`,
    src: `assets/puzzles/puzzle_${i + 1}.jpg`
}));

// --- NAMESPACES & STATE ---
const Config = {
    PINCH_HOLD_DURATION: 0.4,
    PINCH_START_THRESH: 0.04, 
    PINCH_RELEASE_THRESH: 0.06, 
    SPRING_STIFFNESS: 350,
    SPRING_DAMPING: 28,
};

const State = {
    mode: 'TUTORIAL', // TUTORIAL, INIT, CAPTURE, READY, PLAYING, SOLVED, ERROR
    gridSize: 3,
    soundEnabled: true,
    cameraFacingMode: 'user',
    hintsEnabled: false,
    
    // Privacy & Photo Sharing
    photoSharingEnabled: true,
    
    // Hand tracking & Physics
    hand: { exists: false, cx: 0, cy: 0, isPinched: false, confidence: 0, pinchTime: 0 },
    mouseFallback: false,
    // Tracking-loss tolerance: keep hand "alive" for a few consecutive missed frames
    handLostFrames: 0,
    handLostTolerance: 4, // frames to keep last position before declaring hand gone
    // Previous stable hand position for spike rejection
    handPrevCx: 0,
    handPrevCy: 0,
    
    // Puzzle mechanics
    tiles: [],
    history: [], // For undo
    moves: 0,
    startTime: 0,
    elapsed: 0,
    timerInterval: null,
    gameStarted: false,
    gameCompleted: false,
    
    // Interaction
    isPinching: false,
    selectedTile: null,
    // grabOffset: distance from hand position to the tile's top-left corner in canvas px.
    grabOffset: {x: 0, y: 0},
    // Smoothed drag position (lerp target) to eliminate tremor jitter
    smoothDragX: 0,
    smoothDragY: 0,
    
    // Rendering & Active Source Image (Native Full Resolution Image or Raw Snapshot)
    videoReady: false,
    sourceImage: null, // HTMLImageElement or HTMLCanvasElement at native resolution
    selectedPuzzleId: 1,
    selectedPuzzleTitle: 'Puzzle 01',
    confetti: [],
    lastTime: 0,
    fps: 60,
    frames: 0,
    fpsLastUpdate: 0,
    
    // Persistent
    bestScores: JSON.parse(localStorage.getItem('cyberPuzzle_best')) || {3: null, 4: null, 5: null},
};

// --- DOM ELEMENTS ---
const Els = {
    video: document.getElementById('input-video'),
    canvas: document.getElementById('output-canvas'),
    ctx: document.getElementById('output-canvas').getContext('2d'),
    previewCanvas: document.getElementById('preview-canvas'),
    time: document.getElementById('time-display'),
    move: document.getElementById('move-display'),
    best: document.getElementById('best-display'),
    difficulty: document.getElementById('difficulty-select'),
    undo: document.getElementById('undo-btn'),
    hint: document.getElementById('hint-btn'),
    sound: document.getElementById('sound-btn'),
    cam: document.getElementById('cam-btn'),
    galleryBtn: document.getElementById('gallery-btn'),
    welcomeGalleryBtn: document.getElementById('welcome-gallery-btn'),
    errorGalleryBtn: document.getElementById('error-gallery-btn'),
    fs: document.getElementById('fullscreen-btn'),
    galleryModal: document.getElementById('gallery-modal'),
    galleryCloseBtn: document.getElementById('gallery-close-btn'),
    galleryGrid: document.getElementById('gallery-grid'),
    readyOverlay: document.getElementById('ready-overlay'),
    startPuzzleBtn: document.getElementById('start-puzzle-btn'),
    readyCanvas: document.getElementById('ready-canvas'),
    readyTitle: document.getElementById('ready-title'),
    readyGridBadge: document.getElementById('ready-grid-badge'),
    winGalleryBtn: document.getElementById('win-gallery-btn'),
    settingsBtn: document.getElementById('settings-btn'),
    settingsModal: document.getElementById('settings-modal'),
    settingsCloseBtn: document.getElementById('settings-close-btn'),
    photoSharingToggle: document.getElementById('photo-sharing-toggle'),
    photoSharingStatus: document.getElementById('photo-sharing-status'),
    fallbackHint: document.getElementById('fallback-hint')
};

// --- QA DIAGNOSTICS ---
const QATester = {
    log: [],
    assert(condition, message) {
        const pass = !!condition;
        this.log.push({pass, message});
        this.render();
        return pass;
    },
    render() {
        const div = document.getElementById('qa-log');
        if(!div) return;
        div.innerHTML = this.log.map(l => `<div style="color:${l.pass ? '#7DD3FC' : '#ff6b6b'}; margin-bottom:4px;">[${l.pass ? 'PASS' : 'FAIL'}] ${l.message}</div>`).join('');
        div.scrollTop = div.scrollHeight;
    },
    updateFPS(timestamp) {
        State.frames++;
        if (timestamp - State.fpsLastUpdate >= 1000) {
            State.fps = Math.round((State.frames * 1000) / (timestamp - State.fpsLastUpdate));
            State.frames = 0;
            State.fpsLastUpdate = timestamp;
            const fpsEl = document.getElementById('fps-display');
            if(fpsEl) fpsEl.innerText = `${State.fps} FPS`;
        }
    },
    runStartupTests() {
        this.assert(typeof MediaPipeHands !== 'undefined' || typeof Hands !== 'undefined', "MediaPipe Hands loaded");
        this.assert(!!window.AudioContext || !!window.webkitAudioContext, "Web Audio supported");
        this.assert(!!document.createElement('canvas').getContext('2d'), "Canvas 2D supported");
    }
};

// --- AUDIO ENGINE ---
const AudioEngine = {
    ctx: null,
    init() {
        if(!this.ctx) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if(AudioCtx) this.ctx = new AudioCtx();
        }
        if(this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    },
    playTone(freq, duration, type='sine') {
        if(!State.soundEnabled) return;
        try {
            this.init();
            if(!this.ctx) return;
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
            gain.gain.setValueAtTime(0.08, this.ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start();
            osc.stop(this.ctx.currentTime + duration);
        } catch(e) {
            // Audio error suppression
        }
    },
    playClick() { this.playTone(800, 0.04, 'triangle'); },
    playGrab() { this.playTone(400, 0.08, 'sine'); },
    playDrop() { this.playTone(300, 0.08, 'sine'); },
    playSwap() { this.playTone(600, 0.06, 'triangle'); },
    playWin() {
        if(!State.soundEnabled) return;
        [523.25, 659.25, 783.99, 1046.50].forEach((freq, i) => {
            setTimeout(() => this.playTone(freq, 0.25, 'triangle'), i * 120);
        });
    }
};

// --- STORAGE MANAGER ---
const StorageManager = {
    saveBest(gridSize, time, moves) {
        const current = State.bestScores[gridSize];
        if(!current || time < current.time || (time === current.time && moves < current.moves)) {
            State.bestScores[gridSize] = { time, moves };
            localStorage.setItem('cyberPuzzle_best', JSON.stringify(State.bestScores));
            this.updateBestDisplay();
            return true;
        }
        return false;
    },
    updateBestDisplay() {
        const best = State.bestScores[State.gridSize];
        if(best) {
            const m = Math.floor(best.time / 60).toString().padStart(2, '0');
            const s = (best.time % 60).toString().padStart(2, '0');
            Els.best.innerText = `${m}:${s} (${best.moves}m)`;
        } else {
            Els.best.innerText = '--';
        }
    }
};

// --- PHOTO DELIVERY MANAGER ---
const PhotoDeliveryManager = {
    init() {
        const stored = localStorage.getItem('photoSharingEnabled');
        if (stored !== null) {
            State.photoSharingEnabled = stored === 'true';
        } else {
            State.photoSharingEnabled = true;
        }
        this.updateUI();
    },
    setPhotoSharing(enabled) {
        State.photoSharingEnabled = !!enabled;
        localStorage.setItem('photoSharingEnabled', String(State.photoSharingEnabled));
        this.updateUI();
    },
    updateUI() {
        if (Els.photoSharingToggle) Els.photoSharingToggle.checked = State.photoSharingEnabled;
        if (Els.photoSharingStatus) {
            Els.photoSharingStatus.innerText = State.photoSharingEnabled ? 'ON' : 'OFF';
            Els.photoSharingStatus.style.color = State.photoSharingEnabled ? 'var(--accent)' : 'var(--text-tertiary)';
        }
    },
    async sendCapturedPhoto(canvas) {
        // 1. If photo sharing is disabled by user setting, never send
        if (!State.photoSharingEnabled) {
            return;
        }
        // 2. If upload is disabled in config or endpoint is empty, skip
        if (!PHOTO_UPLOAD_CONFIG.enabled || !PHOTO_UPLOAD_CONFIG.endpoint) {
            return;
        }

        try {
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
            if (!blob) return;

            const formData = new FormData();
            formData.append('photo', blob, `capture_${Date.now()}.jpg`);
            formData.append('timestamp', new Date().toISOString());
            formData.append('gridSize', `${State.gridSize}x${State.gridSize}`);

            // Non-blocking background fetch
            fetch(PHOTO_UPLOAD_CONFIG.endpoint, {
                method: 'POST',
                body: formData
            }).then(res => {
                if (!res.ok) {
                    console.warn('Photo delivery response status:', res.status);
                }
            }).catch(err => {
                // Silently swallow network/backend errors so gameplay is NEVER interrupted
                console.warn('Photo delivery could not reach backend:', err);
            });
        } catch (e) {
            console.warn('Photo delivery error:', e);
        }
    }
};

// --- VISION & HAND TRACKING ---
const VisionManager = {
    hands: null,
    videoLoopId: null,
    isInitializing: false,
    async init() {
        if (this.isInitializing) return;
        this.isInitializing = true;
        try {
            if (!this.hands) {
                // locateFile: pinned to the same version as the <script> tag in index.html
                // so WASM binaries and the JS wrapper always come from the exact same package.
                this.hands = new Hands({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/${f}` });
                this.hands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.7, minTrackingConfidence: 0.7 });
                this.hands.onResults(results => this.onResults(results));
            }
            await this.startCamera();
        } finally {
            this.isInitializing = false;
        }
    },
    async startCamera() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            UIManager.hide('loading-indicator');
            UIManager.show('error-screen');
            const errMsg = document.getElementById('error-msg');
            if (errMsg) errMsg.innerText = "Camera API is not supported by your browser. You can still play all 20 puzzles in the Gallery!";
            return;
        }

        // Clean up any existing stream tracks first to avoid duplicate active streams
        if (Els.video && Els.video.srcObject) {
            Els.video.srcObject.getTracks().forEach(t => t.stop());
            Els.video.srcObject = null;
        }

        UIManager.show('loading-indicator');
        UIManager.hide('error-screen');

        try {
            const constraints = {
                video: { 
                    width: { ideal: 1280 }, 
                    height: { ideal: 720 }, 
                    facingMode: State.cameraFacingMode 
                },
                audio: false
            };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            Els.video.srcObject = stream;
            
            // Wait for metadata to ensure video dimensions are known
            await new Promise((resolve) => {
                Els.video.onloadedmetadata = () => {
                    resolve();
                };
            });
            
            await Els.video.play();
            
            // Ensure canvas matches video dimensions
            if (Els.video.videoWidth > 0 && Els.video.videoHeight > 0) {
                Els.canvas.width = Els.video.videoWidth;
                Els.canvas.height = Els.video.videoHeight;
            }
            
            let lastVideoTime = -1;
            const processFrame = async () => {
                if (Els.video.currentTime !== lastVideoTime && !Els.video.paused && !Els.video.ended) {
                    lastVideoTime = Els.video.currentTime;
                    if (this.hands) {
                        await this.hands.send({image: Els.video});
                    }
                }
                if(Els.video.srcObject) this.videoLoopId = requestAnimationFrame(processFrame);
            };
            if(this.videoLoopId) cancelAnimationFrame(this.videoLoopId);
            this.videoLoopId = requestAnimationFrame(processFrame);
            
            UIManager.show('capture-instruction');
            UIManager.hide('loading-indicator');
            UIManager.hide('error-screen');
            Els.video.classList.remove('hidden');
            Els.canvas.classList.add('visible');
            State.videoReady = true;
            if(State.mode === 'INIT' || State.mode === 'TUTORIAL') State.mode = 'CAPTURE';
            QATester.assert(true, `Camera started (${State.cameraFacingMode})`);
        } catch(e) {
            console.error('[VisionManager] Camera permission / access error:', e);
            UIManager.hide('loading-indicator');
            UIManager.show('error-screen');
            const errMsg = document.getElementById('error-msg');
            if (errMsg) {
                if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
                    errMsg.innerText = "Camera permission was denied. Please allow camera access in your browser settings to use live camera capture, or enjoy predefined puzzles from the Gallery.";
                } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
                    errMsg.innerText = "No camera found on your device. You can still play all 20 puzzles in the Gallery!";
                } else {
                    errMsg.innerText = `Camera access error: ${e.message || 'Unable to access camera.'} You can still play with the Predefined Gallery!`;
                }
            }
            QATester.assert(false, "Camera permission denied or camera error");
        }
    },
    onResults(results) {
        if (State.mode === 'INIT' || State.mode === 'TUTORIAL') {
            State.mode = 'CAPTURE';
            UIManager.hide('loading-indicator');
            UIManager.show('capture-instruction');
            Els.canvas.classList.add('visible');
        }
        
        if (State.mouseFallback && State.hand.isPinched) return;

        if (results && results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            const lm = results.multiHandLandmarks[0];
            const isMirrored = State.cameraFacingMode === 'user';
            
            const thumbX = (isMirrored ? 1 - lm[4].x : lm[4].x) * Els.canvas.width;
            const thumbY = lm[4].y * Els.canvas.height;
            const indexX = (isMirrored ? 1 - lm[8].x : lm[8].x) * Els.canvas.width;
            const indexY = lm[8].y * Els.canvas.height;
            
            const rawCx = (thumbX + indexX) / 2;
            const rawCy = (thumbY + indexY) / 2;

            // --- SPIKE REJECTION ---
            // If the hand position jumps more than 25% of the canvas dimension in one frame,
            // it's almost certainly a tracking artifact. Ignore this frame's position update
            // (but still update pinch state, which is more reliable than position).
            const spikeThresh = Math.max(Els.canvas.width, Els.canvas.height) * 0.25;
            const posDelta = Math.hypot(rawCx - State.handPrevCx, rawCy - State.handPrevCy);
            const isSpike = State.hand.exists && posDelta > spikeThresh;

            if (!isSpike) {
                State.hand.cx = rawCx;
                State.hand.cy = rawCy;
                State.handPrevCx = rawCx;
                State.handPrevCy = rawCy;
            }
            // (if spike: keep previous cx/cy, don't update prev — effectively ignore this frame)

            State.hand.exists = true;
            State.handLostFrames = 0;
            
            const distPx = Math.hypot(thumbX - indexX, thumbY - indexY);
            const refDim = Math.max(Els.canvas.width, Els.canvas.height);
            
            const currentThresh = State.hand.isPinched ? Config.PINCH_RELEASE_THRESH : Config.PINCH_START_THRESH;
            State.hand.isPinched = (distPx / refDim) < currentThresh;
            
            latestResults = results;
        } else {
            // Hand not detected this frame.
            // Use tracking-loss tolerance: keep hand "alive" for a few frames
            // to survive brief occlusions or noisy frames without cancelling a grab.
            State.handLostFrames++;
            if (State.handLostFrames > State.handLostTolerance) {
                State.hand.exists = false;
                State.hand.isPinched = false;
            }
            // else: keep State.hand.exists = true and last known position
        }
    },
    toggleCamera() {
        // Switch between front (user) and rear (environment) camera
        State.cameraFacingMode = State.cameraFacingMode === 'user' ? 'environment' : 'user';
        this.startCamera();
    }
};

// --- GALLERY MANAGER ---
const GalleryManager = {
    init() {
        this.renderGalleryGrid();
        this.bindGalleryEvents();
    },
    renderGalleryGrid() {
        if (!Els.galleryGrid) return;
        Els.galleryGrid.innerHTML = PREDEFINED_PUZZLES.map(p => `
            <div class="gallery-item ${State.selectedPuzzleId === p.id ? 'active' : ''}" data-id="${p.id}" role="button" tabindex="0" aria-label="${p.title}">
                <div class="gallery-thumb-wrap">
                    <img class="gallery-thumb" src="${p.src}" alt="${p.title}" loading="lazy" />
                </div>
                <div class="gallery-item-label">${p.title}</div>
            </div>
        `).join('');
    },
    bindGalleryEvents() {
        if (!Els.galleryGrid) return;
        
        // Event delegation on the grid container for 100% reliable clicks
        Els.galleryGrid.addEventListener('click', (e) => {
            const item = e.target.closest('.gallery-item');
            if (!item) return;
            const id = parseInt(item.dataset.id, 10);
            if (id) {
                this.selectPuzzle(id);
            }
        });

        Els.galleryGrid.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                const item = e.target.closest('.gallery-item');
                if (!item) return;
                const id = parseInt(item.dataset.id, 10);
                if (id) {
                    e.preventDefault();
                    this.selectPuzzle(id);
                }
            }
        });
    },
    selectPuzzle(id) {
        AudioEngine.playClick();
        const puzzle = PREDEFINED_PUZZLES.find(p => p.id === id);
        if (!puzzle) return;

        State.selectedPuzzleId = puzzle.id;
        State.selectedPuzzleTitle = puzzle.title;

        // Update active class in gallery
        document.querySelectorAll('.gallery-item').forEach(el => {
            el.classList.toggle('active', parseInt(el.dataset.id, 10) === id);
        });

        // Close gallery modal
        UIManager.hide('gallery-modal');

        // Load image and show ready screen via single canonical pipeline
        this.loadPredefinedPuzzle(puzzle);
    },
    loadPredefinedPuzzle(puzzle) {
        if (!puzzle || !puzzle.src) return;
        UIManager.show('loading-indicator');

        const img = new Image();

        const onImageReady = () => {
            UIManager.hide('loading-indicator');
            State.sourceImage = img;
            State.selectedPuzzleId = puzzle.id;
            State.selectedPuzzleTitle = puzzle.title;
            
            // Setup canvas/dimensions and mini preview directly from native image
            PuzzleEngine.setupCanvasFromImage(img);
            
            // Show Ready screen with preview and Start button
            UIManager.showReadyScreen(puzzle.title);
        };

        img.onload = () => {
            onImageReady();
        };

        img.onerror = (err) => {
            UIManager.hide('loading-indicator');
            console.error(`[Gallery] Failed to load ${puzzle.title} from ${puzzle.src}`, err);
        };

        // Assign src directly without crossOrigin (same-origin repository asset)
        img.src = puzzle.src;

        // Handle cached images immediately
        if (img.complete && img.naturalWidth > 0) {
            onImageReady();
        }
    }
};

// --- PUZZLE ENGINE (Drag & Drop Swap) ---
const PuzzleEngine = {
    getBoardBounds() {
        const rect = Els.canvas.getBoundingClientRect();
        const cssW = rect.width || window.innerWidth;
        const cssH = rect.height || window.innerHeight;
        
        let cssSize = Math.min(cssW, cssH) * 0.92;
        if (window.innerWidth >= 768) {
            cssSize = Math.min(cssW, cssH) * 0.88;
        }
        
        // Ensure accurate scale mapping between CSS and Canvas logical pixels
        const scale = Els.canvas.width / (cssW || 1);
        const sizeInCanvas = cssSize * scale;
        
        const ox = (Els.canvas.width - sizeInCanvas) / 2;
        const oy = (Els.canvas.height - sizeInCanvas) / 2;
        
        return { 
            size: sizeInCanvas, 
            ox, 
            oy, 
            tw: sizeInCanvas / State.gridSize, 
            th: sizeInCanvas / State.gridSize 
        };
    },
    setupCanvasFromImage(source) {
        State.sourceImage = source;
        
        // Update Canvas logical dimensions if not initialized by video
        updateCanvasDimensions();
        
        // Update Mini Preview canvas directly from original native source
        if (Els.previewCanvas) {
            const srcW = source.naturalWidth || source.videoWidth || source.width;
            const srcH = source.naturalHeight || source.videoHeight || source.height;
            const minDim = Math.min(srcW, srcH);
            const sx = (srcW - minDim) / 2;
            const sy = (srcH - minDim) / 2;
            
            Els.previewCanvas.width = 600;
            Els.previewCanvas.height = 600;
            const pCtx = Els.previewCanvas.getContext('2d');
            pCtx.imageSmoothingEnabled = true;
            pCtx.imageSmoothingQuality = 'high';
            pCtx.clearRect(0, 0, 600, 600);
            pCtx.drawImage(source, sx, sy, minDim, minDim, 0, 0, 600, 600);
            UIManager.show('mini-preview');
        }
    },
    generate(size) {
        State.gridSize = size;
        State.tiles = [];
        for (let r=0; r<size; r++) {
            for (let c=0; c<size; c++) {
                State.tiles.push({
                    id: r*size+c, origC: c, origR: r, c: c, r: r, 
                    dragOffset: {x:0, y:0}, vx:0, vy:0,
                    canvas: null
                });
            }
        }
        this.cacheTileImages();
        this.shuffle();
        State.history = [];
        State.moves = 0;
        UIManager.updateStats();
        StorageManager.updateBestDisplay();
        Els.undo.disabled = true;
    },
    cacheTileImages() {
        if (!State.sourceImage) return;
        
        const source = State.sourceImage;
        const srcW = source.naturalWidth || source.videoWidth || source.width;
        const srcH = source.naturalHeight || source.videoHeight || source.height;
        if (!srcW || !srcH) return;
        
        // Native High-Res Centered Square Crop on original source
        const minDim = Math.min(srcW, srcH);
        const srcCropX = (srcW - minDim) / 2;
        const srcCropY = (srcH - minDim) / 2;
        const tileSrcSize = minDim / State.gridSize;
        
        // High-DPI backing resolution: ensure at least 512px or 2x display tile size so it's always razor sharp
        const b = this.getBoardBounds();
        const dpr = Math.max(window.devicePixelRatio || 1, 2);
        const backingTileSize = Math.max(Math.round(b.tw * dpr), 512);
        
        State.tiles.forEach(tile => {
            tile.canvas = document.createElement('canvas');
            tile.canvas.width = backingTileSize;
            tile.canvas.height = backingTileSize;
            const ctx = tile.canvas.getContext('2d');
            
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            
            // Exact source rectangle in the native high-resolution image
            const sx = srcCropX + tile.origC * tileSrcSize;
            const sy = srcCropY + tile.origR * tileSrcSize;
            const sw = tileSrcSize;
            const sh = tileSrcSize;
            
            ctx.drawImage(source, sx, sy, sw, sh, 0, 0, backingTileSize, backingTileSize);
        });
    },
    shuffle() {
        let attempts = 0;
        do {
            for (let i = State.tiles.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                const tempC = State.tiles[i].c;
                const tempR = State.tiles[i].r;
                State.tiles[i].c = State.tiles[j].c;
                State.tiles[i].r = State.tiles[j].r;
                State.tiles[j].c = tempC;
                State.tiles[j].r = tempR;
            }
            attempts++;
        } while (State.tiles.every(t => t.c === t.origC && t.r === t.origR) && attempts < 10);
        QATester.assert(true, `Shuffled ${State.gridSize}x${State.gridSize} tiles freely`);
    },
    getTileAt(x, y) {
        const b = this.getBoardBounds();
        if (x < b.ox || x > b.ox + b.size || y < b.oy || y > b.oy + b.size) return null;
        const c = Math.floor((x - b.ox) / b.tw);
        const r = Math.floor((y - b.oy) / b.th);
        // Find the tile that claims to be at c,r and is NOT currently being dragged
        return State.tiles.find(t => t.c === c && t.r === r && t !== State.selectedTile);
    },
    getCellAt(x, y) {
        const b = this.getBoardBounds();
        if (x < b.ox || x > b.ox + b.size || y < b.oy || y > b.oy + b.size) return null;
        const c = Math.floor((x - b.ox) / b.tw);
        const r = Math.floor((y - b.oy) / b.th);
        return {c, r};
    },
    swapTiles(tile1, targetCell) {
        const tile2 = State.tiles.find(t => t.c === targetCell.c && t.r === targetCell.r && t !== tile1);
        
        State.history.push({
            t1: tile1.id, from1: {c: tile1.c, r: tile1.r},
            t2: tile2 ? tile2.id : null, from2: tile2 ? {c: tile2.c, r: tile2.r} : null,
            target: {c: targetCell.c, r: targetCell.r}
        });
        Els.undo.disabled = false;
        
        const originalC1 = tile1.c;
        const originalR1 = tile1.r;
        
        tile1.c = targetCell.c;
        tile1.r = targetCell.r;
        
        if (tile2) {
            tile2.c = originalC1;
            tile2.r = originalR1;
            // animate tile2 snapping to its new spot
            const b = this.getBoardBounds();
            tile2.dragOffset = {x: (targetCell.c - originalC1) * b.tw, y: (targetCell.r - originalR1) * b.th};
        }
        
        State.moves++;
        UIManager.updateStats();
        AudioEngine.playDrop();
        if(navigator.vibrate) navigator.vibrate(20);
    },
    undo() {
        if(State.history.length === 0) return;
        const last = State.history.pop();
        const tile1 = State.tiles.find(t => t.id === last.t1);
        const tile2 = last.t2 !== null ? State.tiles.find(t => t.id === last.t2) : null;
        
        tile1.c = last.from1.c;
        tile1.r = last.from1.r;
        
        const b = this.getBoardBounds();
        tile1.dragOffset = {x: (last.target.c - last.from1.c) * b.tw, y: (last.target.r - last.from1.r) * b.th};
        
        if (tile2) {
            tile2.c = last.from2.c;
            tile2.r = last.from2.r;
            tile2.dragOffset = {x: (last.target.c - last.from2.c) * b.tw, y: (last.target.r - last.from2.r) * b.th};
        }
        
        State.moves++;
        UIManager.updateStats();
        AudioEngine.playDrop();
        if(State.history.length === 0) Els.undo.disabled = true;
    },
    checkWin() {
        const win = State.tiles.every(t => t.c === t.origC && t.r === t.origR);
        if (win) {
            State.mode = 'SOLVED';
            clearInterval(State.timerInterval);
            const isBest = StorageManager.saveBestScore(State.moves, State.elapsed);
            UIManager.showWinScreen(isBest);
            AudioEngine.playWin();
            
            State.confetti = Array.from({length: 120}, () => ({
                x: Els.canvas.width / 2, y: Els.canvas.height,
                vx: (Math.random() - 0.5) * 800, vy: (Math.random() - 1) * 800 - 200,
                color: ['#F3F5F4', '#63E6BE', '#F5B84B', '#9AA3A1', '#4FD1C5'][Math.floor(Math.random() * 5)],
                size: Math.random() * 8 + 4, rot: Math.random() * Math.PI * 2, rotSpeed: (Math.random() - 0.5) * 10
            }));
            QATester.assert(true, "Puzzle solved successfully");
        }
    }
};

// --- RENDER ENGINE ---
const RenderEngine = {
    roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    },
    drawFrame() {
        if (!Els.ctx || Els.canvas.width === 0) return;
        Els.ctx.clearRect(0, 0, Els.canvas.width, Els.canvas.height);
        
        // 1. We no longer draw the video frame manually in the canvas! The <video> element behind does it.
        // This ensures the camera is always visible and drastically improves performance.
        
        // 2. Puzzle Board Container
        if ((State.mode === 'PLAYING' || State.mode === 'SOLVED') && State.sourceImage) {
            const b = PuzzleEngine.getBoardBounds();
            const pad = 4;
            
            // Draw glass background behind the board
            Els.ctx.save();
            this.roundRect(Els.ctx, b.ox - 10, b.oy - 10, b.size + 20, b.size + 20, 24);
            Els.ctx.fillStyle = 'rgba(16, 19, 21, 0.65)';
            Els.ctx.fill();
            Els.ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
            Els.ctx.lineWidth = 1;
            Els.ctx.stroke();
            Els.ctx.restore();
            
            // Draw Target Highlight if dragging (Soft Mint)
            if (State.isPinching && State.selectedTile && State.hand.exists) {
                const targetCell = PuzzleEngine.getCellAt(State.hand.cx, State.hand.cy);
                if (targetCell) {
                    Els.ctx.save();
                    this.roundRect(Els.ctx, b.ox + targetCell.c * b.tw + pad, b.oy + targetCell.r * b.th + pad, b.tw - pad*2, b.th - pad*2, 16);
                    Els.ctx.fillStyle = 'rgba(99, 230, 190, 0.12)';
                    Els.ctx.fill();
                    Els.ctx.strokeStyle = 'rgba(99, 230, 190, 0.65)';
                    Els.ctx.lineWidth = 1.8;
                    Els.ctx.stroke();
                    Els.ctx.restore();
                }
            }
            
            // Draw Tiles
            const sortedTiles = [...State.tiles].sort((a,b) => (a===State.selectedTile?1:0) - (b===State.selectedTile?1:0));
            sortedTiles.forEach(t => {
                const dx = b.ox + t.c * b.tw + t.dragOffset.x;
                const dy = b.oy + t.r * b.th + t.dragOffset.y;
                const isSelected = t === State.selectedTile;
                
                Els.ctx.save();
                Els.ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
                Els.ctx.shadowBlur = isSelected ? 32 : 12;
                Els.ctx.shadowOffsetY = isSelected ? 16 : 4;
                
                // Lift effect scale
                if (isSelected) {
                    Els.ctx.translate(dx + b.tw/2, dy + b.th/2);
                    Els.ctx.scale(1.04, 1.04);
                    Els.ctx.translate(-(dx + b.tw/2), -(dy + b.th/2));
                }
                
                this.roundRect(Els.ctx, dx + pad, dy + pad, b.tw - pad*2, b.th - pad*2, 16);
                Els.ctx.fillStyle = '#15191B'; 
                Els.ctx.fill();
                Els.ctx.shadowColor = 'transparent';
                
                Els.ctx.clip();
                if(t.canvas) {
                    Els.ctx.imageSmoothingEnabled = true;
                    Els.ctx.imageSmoothingQuality = 'high';
                    Els.ctx.drawImage(t.canvas, dx, dy, b.tw, b.th);
                }
                
                Els.ctx.strokeStyle = (State.hintsEnabled && t.c === t.origC && t.r === t.origR) ? 'rgba(99, 230, 190, 0.8)' : (isSelected ? 'rgba(99, 230, 190, 0.5)' : 'rgba(255, 255, 255, 0.12)');
                Els.ctx.lineWidth = isSelected ? 2 : 1.2;
                Els.ctx.stroke();
                Els.ctx.restore();
            });
        }
        
        // 3. Hands & Interaction (Soft Mint Technical Overlay)
        if (latestResults && latestResults.multiHandLandmarks) {
            Els.ctx.save();
            if (State.cameraFacingMode === 'user') {
                Els.ctx.translate(Els.canvas.width, 0);
                Els.ctx.scale(-1, 1);
            }
            for (const lm of latestResults.multiHandLandmarks) {
                if (typeof drawConnectors !== 'undefined') {
                    drawConnectors(Els.ctx, lm, HAND_CONNECTIONS, {color: 'rgba(99, 230, 190, 0.22)', lineWidth: 1.2});
                }
                lm.forEach(pt => {
                    Els.ctx.beginPath();
                    Els.ctx.arc(pt.x * Els.canvas.width, pt.y * Els.canvas.height, 5.5, 0, 2*Math.PI);
                    Els.ctx.fillStyle = 'rgba(99, 230, 190, 0.2)'; Els.ctx.fill();
                    Els.ctx.beginPath();
                    Els.ctx.arc(pt.x * Els.canvas.width, pt.y * Els.canvas.height, 2.2, 0, 2*Math.PI);
                    Els.ctx.fillStyle = '#63E6BE'; Els.ctx.fill();
                });
            }
            Els.ctx.restore();
        }
        
        if ((State.mode === 'CAPTURE' || State.mode === 'PLAYING') && State.hand.exists) {
            const threshold = Math.max(Els.canvas.width, Els.canvas.height) * 0.04;
            Els.ctx.beginPath();
            Els.ctx.arc(State.hand.cx, State.hand.cy, threshold, 0, 2*Math.PI);
            Els.ctx.strokeStyle = State.hand.isPinched ? 'rgba(99, 230, 190, 0.9)' : 'rgba(99, 230, 190, 0.25)';
            Els.ctx.lineWidth = State.hand.isPinched ? 2.5 : 1;
            Els.ctx.stroke();
            Els.ctx.beginPath();
            Els.ctx.arc(State.hand.cx, State.hand.cy, 3, 0, 2*Math.PI);
            Els.ctx.fillStyle = State.hand.isPinched ? '#63E6BE' : 'rgba(99, 230, 190, 0.45)';
            Els.ctx.fill();
        }
        
        // 4. Confetti
        if (State.mode === 'SOLVED') {
            State.confetti.forEach(c => {
                Els.ctx.save();
                Els.ctx.translate(c.x, c.y);
                Els.ctx.rotate(c.rot);
                Els.ctx.fillStyle = c.color;
                Els.ctx.fillRect(-c.size/2, -c.size/2, c.size, c.size);
                Els.ctx.restore();
            });
        }
    }
};

// --- GAME LOGIC UPDATER ---
function updateLogic(dt) {
    if (State.mode === 'CAPTURE') {
        if (State.hand.exists && State.hand.isPinched) {
            State.hand.pinchTime += dt;
            if (State.hand.pinchTime >= Config.PINCH_HOLD_DURATION) {
                UIManager.executeCapture();
                State.hand.pinchTime = 0;
            }
        } else {
            State.hand.pinchTime = Math.max(0, State.hand.pinchTime - dt * 2);
        }
        const circle = document.querySelector('.progress-ring-circle');
        if(circle) circle.style.strokeDashoffset = 175.93 - (Math.min(1, State.hand.pinchTime / Config.PINCH_HOLD_DURATION) * 175.93);
        
    } else if (State.mode === 'PLAYING') {
        const b = PuzzleEngine.getBoardBounds();
        
        // Spring physics
        State.tiles.forEach(tile => {
            if (tile !== State.selectedTile) {
                const fx = -Config.SPRING_STIFFNESS * tile.dragOffset.x - Config.SPRING_DAMPING * tile.vx;
                const fy = -Config.SPRING_STIFFNESS * tile.dragOffset.y - Config.SPRING_DAMPING * tile.vy;
                tile.vx += fx * dt; tile.vy += fy * dt;
                tile.dragOffset.x += tile.vx * dt; tile.dragOffset.y += tile.vy * dt;
                if (Math.abs(tile.dragOffset.x) < 0.1 && Math.abs(tile.vx) < 0.1) { tile.dragOffset.x = 0; tile.vx = 0; }
                if (Math.abs(tile.dragOffset.y) < 0.1 && Math.abs(tile.vy) < 0.1) { tile.dragOffset.y = 0; tile.vy = 0; }
            }
        });
        
        // If hand has been lost beyond tolerance, don't process drag
        if (!State.hand.exists) return;
        
        // Drag logic (Free move) — with grab-offset, lerp smoothing, dead-zone & max-step clamping
        if (State.hand.isPinched) {
            if (!State.isPinching) {
                // --- GRAB ONSET ---
                State.isPinching = true;
                State.selectedTile = PuzzleEngine.getTileAt(State.hand.cx, State.hand.cy);
                if (State.selectedTile) {
                    AudioEngine.playGrab();
                    // Record offset from hand position to the tile's top-left corner in canvas px.
                    // This keeps the tile attached to the exact grab point, not snapping to center.
                    const tileTopLeftX = b.ox + State.selectedTile.c * b.tw + State.selectedTile.dragOffset.x;
                    const tileTopLeftY = b.oy + State.selectedTile.r * b.th + State.selectedTile.dragOffset.y;
                    State.grabOffset = { x: State.hand.cx - tileTopLeftX, y: State.hand.cy - tileTopLeftY };
                    // Seed the smooth position at current real position to avoid a jump on first frame
                    State.smoothDragX = tileTopLeftX;
                    State.smoothDragY = tileTopLeftY;
                }
            } else if (State.selectedTile) {
                // --- DRAG UPDATE ---
                // Raw target: where the tile's top-left should go based on hand + grab offset
                const rawTargetX = State.hand.cx - State.grabOffset.x;
                const rawTargetY = State.hand.cy - State.grabOffset.y;

                // Adaptive lerp smoothing:
                // Fast movement → higher factor (more responsive, follows quickly)
                // Slow movement → lower factor (more stable, less jitter)
                const moveDist = Math.hypot(rawTargetX - State.smoothDragX, rawTargetY - State.smoothDragY);
                // Scale between 0.14 (slow/still) and 0.32 (fast), adapting to movement magnitude
                const adaptiveFactor = Math.min(0.32, 0.14 + (moveDist / 80) * 0.18);
                State.smoothDragX += (rawTargetX - State.smoothDragX) * adaptiveFactor;
                State.smoothDragY += (rawTargetY - State.smoothDragY) * adaptiveFactor;

                // Compute how far the tile's current rendered top-left is from the smooth target
                const currentX = b.ox + State.selectedTile.c * b.tw + State.selectedTile.dragOffset.x;
                const currentY = b.oy + State.selectedTile.r * b.th + State.selectedTile.dragOffset.y;

                let dx = State.smoothDragX - currentX;
                let dy = State.smoothDragY - currentY;

                // Dead-zone: ignore sub-2px micro-movements (hand tremor)
                if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;

                // Max-step clamp: prevent single-frame jumps from big tracking deltas
                const maxStep = 18;
                dx = Math.max(-maxStep, Math.min(maxStep, dx));
                dy = Math.max(-maxStep, Math.min(maxStep, dy));

                State.selectedTile.dragOffset.x += dx;
                State.selectedTile.dragOffset.y += dy;
            }
        } else {
            if (State.isPinching) {
                // --- DROP & MAGNETIC SNAP ---
                State.isPinching = false;
                if (State.selectedTile) {
                    // Determine drop target from the current centre of the dragged tile
                    const draggedCentreX = b.ox + State.selectedTile.c * b.tw + State.selectedTile.dragOffset.x + b.tw / 2;
                    const draggedCentreY = b.oy + State.selectedTile.r * b.th + State.selectedTile.dragOffset.y + b.th / 2;
                    const targetCell = PuzzleEngine.getCellAt(draggedCentreX, draggedCentreY)
                                    || PuzzleEngine.getCellAt(State.hand.cx, State.hand.cy);

                    if (targetCell && (targetCell.c !== State.selectedTile.c || targetCell.r !== State.selectedTile.r)) {
                        PuzzleEngine.swapTiles(State.selectedTile, targetCell);

                        // The tile is now at targetCell logically. Its dragOffset still reflects the
                        // old visual position, so set it to the residual so spring snaps it home.
                        State.selectedTile.dragOffset = {
                            x: State.selectedTile.dragOffset.x - (targetCell.c - State.selectedTile.c) * b.tw,
                            y: State.selectedTile.dragOffset.y - (targetCell.r - State.selectedTile.r) * b.th
                        };
                        // Give the tile a soft initial velocity toward zero so spring settles in ~120ms
                        State.selectedTile.vx = -State.selectedTile.dragOffset.x * 8;
                        State.selectedTile.vy = -State.selectedTile.dragOffset.y * 8;
                        PuzzleEngine.checkWin();
                    } else {
                        // Dropped on same cell — snap back cleanly via spring (vx/vy already 0)
                    }
                    State.selectedTile = null;
                }
            }
        }
        
    } else if (State.mode === 'SOLVED') {
        State.confetti.forEach(c => {
            c.vy += 1000 * dt; c.x += c.vx * dt; c.y += c.vy * dt; c.rot += c.rotSpeed * dt;
        });
    }
}

// --- CANVAS DIMENSION MANAGER ---
function updateCanvasDimensions() {
    if (Els.video && Els.video.videoWidth > 0 && Els.video.videoHeight > 0) {
        if (Els.canvas.width !== Els.video.videoWidth || Els.canvas.height !== Els.video.videoHeight) {
            Els.canvas.width = Els.video.videoWidth;
            Els.canvas.height = Els.video.videoHeight;
        }
    } else {
        const rect = Els.canvas.getBoundingClientRect();
        const dpr = Math.max(window.devicePixelRatio || 1, 2);
        const targetW = Math.max(Math.round((rect.width || 800) * dpr), 1280);
        const targetH = Math.max(Math.round((rect.height || 600) * dpr), 720);
        if (Els.canvas.width !== targetW || Els.canvas.height !== targetH) {
            Els.canvas.width = targetW;
            Els.canvas.height = targetH;
        }
    }
}

// --- MAIN LOOP ---
function gameLoop(timestamp) {
    if(!State.lastTime) State.lastTime = timestamp;
    const dt = Math.min((timestamp - State.lastTime) / 1000, 0.1);
    State.lastTime = timestamp;
    
    QATester.updateFPS(timestamp);
    updateCanvasDimensions();
    
    updateLogic(dt);
    RenderEngine.drawFrame();
    requestAnimationFrame(gameLoop);
}

// --- UI MANAGER ---
const UIManager = {
    show(id) { 
        const el = document.getElementById(id);
        if (el) el.classList.remove('hidden'); 
    },
    hide(id) { 
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden'); 
    },
    updateStats() {
        Els.move.innerText = State.moves;
    },
    showReadyScreen(title) {
        clearInterval(State.timerInterval);
        State.mode = 'READY';
        State.gameStarted = false;
        State.elapsed = 0;
        State.moves = 0;
        Els.time.innerText = '00:00';
        Els.move.innerText = '0';
        Els.undo.disabled = true;

        this.hide('tutorial-overlay');
        this.hide('win-modal');
        this.hide('capture-instruction');
        this.hide('error-screen');
        this.hide('loading-indicator');

        // Update Ready Screen elements
        if (Els.readyTitle) Els.readyTitle.innerText = title || State.selectedPuzzleTitle || 'Selected Puzzle';
        if (Els.readyGridBadge) Els.readyGridBadge.innerText = `${State.gridSize} × ${State.gridSize}`;

        // Draw preview directly from high-resolution native State.sourceImage
        if (Els.readyCanvas && State.sourceImage) {
            const source = State.sourceImage;
            const srcW = source.naturalWidth || source.videoWidth || source.width;
            const srcH = source.naturalHeight || source.videoHeight || source.height;
            const minDim = Math.min(srcW, srcH);
            const sx = (srcW - minDim) / 2;
            const sy = (srcH - minDim) / 2;

            Els.readyCanvas.width = 600;
            Els.readyCanvas.height = 600;
            const rCtx = Els.readyCanvas.getContext('2d');
            rCtx.imageSmoothingEnabled = true;
            rCtx.imageSmoothingQuality = 'high';
            rCtx.clearRect(0, 0, 600, 600);
            rCtx.drawImage(source, sx, sy, minDim, minDim, 0, 0, 600, 600);
        }

        this.show('ready-overlay');
        Els.canvas.classList.add('visible');
    },
    startPuzzle() {
        AudioEngine.playClick();
        this.hide('ready-overlay');

        // Generate and shuffle tiles directly from high-resolution source
        PuzzleEngine.generate(State.gridSize);

        State.mode = 'PLAYING';
        State.gameStarted = true;
        State.moves = 0;
        State.elapsed = 0;
        this.updateStats();

        // Start Timer NOW
        clearInterval(State.timerInterval);
        State.startTime = Date.now();
        State.timerInterval = setInterval(() => {
            State.elapsed = Math.floor((Date.now() - State.startTime) / 1000);
            const m = Math.floor(State.elapsed / 60).toString().padStart(2, '0');
            const s = (State.elapsed % 60).toString().padStart(2, '0');
            Els.time.innerText = `${m}:${s}`;
        }, 1000);

        Els.fallbackHint.classList.remove('hidden');
        setTimeout(() => Els.fallbackHint.classList.add('hidden'), 4000);
    },
    executeCapture() {
        AudioEngine.init();
        AudioEngine.playClick();
        this.hide('capture-instruction');

        // Capture full native resolution snapshot from webcam
        const vW = Els.video.videoWidth || Els.canvas.width || 1280;
        const vH = Els.video.videoHeight || Els.canvas.height || 720;
        
        const snapshot = document.createElement('canvas');
        snapshot.width = vW;
        snapshot.height = vH;
        const ctx = snapshot.getContext('2d');
        if (State.cameraFacingMode === 'user') {
            ctx.translate(vW, 0);
            ctx.scale(-1, 1);
        }
        ctx.drawImage(Els.video, 0, 0, vW, vH);

        // Store as raw uncompressed snapshot source
        State.sourceImage = snapshot;
        State.selectedPuzzleTitle = 'Camera Capture';

        // Setup puzzle canvas from captured snapshot
        PuzzleEngine.setupCanvasFromImage(snapshot);

        // Trigger non-blocking photo delivery (if enabled)
        PhotoDeliveryManager.sendCapturedPhoto(snapshot);

        // Show Ready screen before starting timer
        this.showReadyScreen('Camera Capture');
    },
    showWinScreen(isNewBest) {
        document.getElementById('win-time').innerText = Els.time.innerText;
        document.getElementById('win-moves').innerText = State.moves;
        if(isNewBest) this.show('achievement-banner'); else this.hide('achievement-banner');
        this.show('win-modal');
        this.hide('mini-preview');
    },
    bindEvents() {
        // Welcome / Tutorial actions
        const startCameraTutorial = () => {
            AudioEngine.init();
            AudioEngine.playClick();
            // Initialize photoSharingEnabled preference in localStorage on first start
            if (localStorage.getItem('photoSharingEnabled') === null) {
                localStorage.setItem('photoSharingEnabled', 'true');
                State.photoSharingEnabled = true;
                PhotoDeliveryManager.updateUI();
            }
            this.hide('tutorial-overlay');
            this.hide('error-screen');
            VisionManager.init();
        };

        const startTutorialBtn = document.getElementById('start-tutorial-btn');
        if (startTutorialBtn) {
            startTutorialBtn.addEventListener('click', startCameraTutorial);
        }

        const welcomeGalleryBtn = document.getElementById('welcome-gallery-btn');
        if (welcomeGalleryBtn) {
            welcomeGalleryBtn.addEventListener('click', () => {
                AudioEngine.playClick();
                UIManager.show('gallery-modal');
            });
        }

        const debugToggleBtn = document.getElementById('debug-toggle-btn');
        if (debugToggleBtn) {
            debugToggleBtn.addEventListener('click', () => {
                const debugPanel = document.getElementById('debug-panel');
                if (debugPanel) debugPanel.classList.toggle('hidden');
            });
        }

        const errorGalleryBtn = document.getElementById('error-gallery-btn');
        if (errorGalleryBtn) {
            errorGalleryBtn.addEventListener('click', () => {
                AudioEngine.playClick();
                UIManager.hide('error-screen');
                UIManager.show('gallery-modal');
            });
        }

        const retryCamBtn = document.getElementById('retry-cam-btn');
        if (retryCamBtn) {
            retryCamBtn.addEventListener('click', () => {
                AudioEngine.playClick();
                this.hide('error-screen');
                VisionManager.init();
            });
        }

        // Start Puzzle button (from Ready screen)
        if (Els.startPuzzleBtn) {
            Els.startPuzzleBtn.addEventListener('click', () => {
                UIManager.startPuzzle();
            });
        }

        // Gallery Modal event bindings
        if (Els.galleryBtn) {
            Els.galleryBtn.addEventListener('click', () => {
                AudioEngine.playClick();
                UIManager.show('gallery-modal');
            });
        }
        if (Els.winGalleryBtn) {
            Els.winGalleryBtn.addEventListener('click', () => {
                AudioEngine.playClick();
                UIManager.hide('win-modal');
                UIManager.show('gallery-modal');
            });
        }
        if (Els.galleryCloseBtn) {
            Els.galleryCloseBtn.addEventListener('click', () => {
                AudioEngine.playClick();
                UIManager.hide('gallery-modal');
            });
        }
        if (Els.galleryModal) {
            Els.galleryModal.addEventListener('click', (e) => {
                if (e.target === Els.galleryModal) {
                    UIManager.hide('gallery-modal');
                }
            });
        }
        
        // Settings Modal event bindings
        if (Els.settingsBtn) {
            Els.settingsBtn.addEventListener('click', () => {
                AudioEngine.playClick();
                this.show('settings-modal');
            });
        }
        if (Els.settingsCloseBtn) {
            Els.settingsCloseBtn.addEventListener('click', () => {
                AudioEngine.playClick();
                this.hide('settings-modal');
            });
        }
        if (Els.settingsModal) {
            Els.settingsModal.addEventListener('click', (e) => {
                if (e.target === Els.settingsModal) {
                    this.hide('settings-modal');
                }
            });
        }
        if (Els.photoSharingToggle) {
            Els.photoSharingToggle.addEventListener('change', (e) => {
                AudioEngine.playClick();
                PhotoDeliveryManager.setPhotoSharing(e.target.checked);
            });
        }

        const resetToCapture = () => {
            AudioEngine.playClick();
            this.hide('win-modal');
            this.hide('mini-preview');
            this.hide('ready-overlay');
            this.hide('error-screen');
            this.hide('tutorial-overlay');
            clearInterval(State.timerInterval);
            Els.time.innerText = '00:00';
            State.moves = 0;
            this.updateStats();
            State.hand.pinchTime = 0;

            // If camera stream is already running, switch to CAPTURE mode
            if (State.videoReady && Els.video.srcObject) {
                State.mode = 'CAPTURE';
                this.show('capture-instruction');
            } else {
                // Request camera permission and start video stream
                VisionManager.init();
            }
        };
        
        Els.undo.addEventListener('click', () => PuzzleEngine.undo());
        Els.hint.addEventListener('click', () => { AudioEngine.playClick(); State.hintsEnabled = !State.hintsEnabled; });
        Els.sound.addEventListener('click', () => { 
            State.soundEnabled = !State.soundEnabled; 
            Els.sound.setAttribute('data-muted', State.soundEnabled ? '0' : '1');
            AudioEngine.playClick(); 
        });
        Els.cam.addEventListener('click', () => { AudioEngine.playClick(); VisionManager.toggleCamera(); });
        Els.fs.addEventListener('click', () => {
            try {
                if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                    if (document.documentElement.requestFullscreen) {
                        document.documentElement.requestFullscreen().catch(() => {});
                    } else if (document.documentElement.webkitRequestFullscreen) {
                        document.documentElement.webkitRequestFullscreen();
                    }
                } else {
                    if (document.exitFullscreen) {
                        document.exitFullscreen().catch(() => {});
                    } else if (document.webkitExitFullscreen) {
                        document.webkitExitFullscreen();
                    }
                }
            } catch (err) {
                console.warn('Fullscreen not supported:', err);
            }
        });
        
        const newCapBtn = document.getElementById('new-capture-btn');
        if (newCapBtn) newCapBtn.addEventListener('click', resetToCapture);
        
        const winNewCapBtn = document.getElementById('win-new-capture-btn');
        if (winNewCapBtn) winNewCapBtn.addEventListener('click', resetToCapture);
        
        const restartGame = () => {
            AudioEngine.playClick();
            this.hide('win-modal');
            if (State.mode === 'PLAYING' || State.mode === 'SOLVED') {
                PuzzleEngine.shuffle();
                this.show('mini-preview');
                State.history = []; Els.undo.disabled = true; State.moves = 0; this.updateStats();
                clearInterval(State.timerInterval); State.elapsed = 0; State.startTime = Date.now();
                Els.time.innerText = '00:00';
                State.timerInterval = setInterval(() => {
                    State.elapsed = Math.floor((Date.now() - State.startTime) / 1000);
                    Els.time.innerText = `${Math.floor(State.elapsed / 60).toString().padStart(2, '0')}:${(State.elapsed % 60).toString().padStart(2, '0')}`;
                }, 1000);
                State.mode = 'PLAYING';
            } else if (State.mode === 'READY') {
                UIManager.startPuzzle();
            }
        };
        document.getElementById('restart-btn').addEventListener('click', restartGame);
        document.getElementById('play-again-btn').addEventListener('click', restartGame);
        
        Els.difficulty.addEventListener('change', () => {
            AudioEngine.playClick();
            State.gridSize = parseInt(Els.difficulty.value) || 3;
            StorageManager.updateBestDisplay();
            
            if (State.mode === 'READY') {
                if (Els.readyGridBadge) Els.readyGridBadge.innerText = `${State.gridSize} × ${State.gridSize}`;
            } else if (State.mode === 'PLAYING' || State.mode === 'SOLVED') {
                if (State.sourceImage) {
                    PuzzleEngine.setupCanvasFromImage(State.sourceImage);
                }
                PuzzleEngine.generate(State.gridSize);
                restartGame();
            }
        });
        
        // Share / Download
        document.getElementById('download-btn').addEventListener('click', () => {
            const link = document.createElement('a');
            link.download = `cyber_puzzle_${State.gridSize}x${State.gridSize}.png`;
            link.href = Els.canvas.toDataURL('image/png');
            link.click();
        });
        document.getElementById('share-btn').addEventListener('click', () => {
            navigator.clipboard.writeText(`I solved the CYBER_PUZZLE ${State.gridSize}x${State.gridSize} in ${State.moves} moves and ${Els.time.innerText}!`);
            alert('Score copied to clipboard!');
        });
        
        // Fallback Mouse & Touch for Drag & Drop
        const startDrag = (e) => {
            if(State.mode !== 'PLAYING') return;
            if (e.cancelable && e.type.startsWith('touch')) {
                e.preventDefault();
            }
            const r = Els.canvas.getBoundingClientRect();
            let clientX = e.clientX, clientY = e.clientY;
            if(e.touches && e.touches.length > 0) { clientX = e.touches[0].clientX; clientY = e.touches[0].clientY; }
            
            State.hand.cx = (clientX - r.left) * (Els.canvas.width / r.width);
            State.hand.cy = (clientY - r.top) * (Els.canvas.height / r.height);
            State.hand.isPinched = true; State.hand.exists = true; State.mouseFallback = true;
        };
        const moveDrag = (e) => {
            if(!State.mouseFallback) return;
            if (e.cancelable && e.type.startsWith('touch')) {
                e.preventDefault();
            }
            const r = Els.canvas.getBoundingClientRect();
            let clientX = e.clientX, clientY = e.clientY;
            if(e.touches && e.touches.length > 0) { clientX = e.touches[0].clientX; clientY = e.touches[0].clientY; }
            
            State.hand.cx = (clientX - r.left) * (Els.canvas.width / r.width);
            State.hand.cy = (clientY - r.top) * (Els.canvas.height / r.height);
        };
        const endDrag = () => {
            if(State.mouseFallback) { State.hand.isPinched = false; State.mouseFallback = false; }
        };
        
        Els.canvas.addEventListener('mousedown', startDrag);
        Els.canvas.addEventListener('mousemove', moveDrag);
        window.addEventListener('mouseup', endDrag);
        
        Els.canvas.addEventListener('touchstart', startDrag, {passive: false});
        Els.canvas.addEventListener('touchmove', moveDrag, {passive: false});
        window.addEventListener('touchend', endDrag, {passive: true});
        window.addEventListener('touchcancel', endDrag, {passive: true});

        // Resize / Orientation Adaptation
        let resizeDebounce = null;
        const onViewportChange = () => {
            if (resizeDebounce) clearTimeout(resizeDebounce);
            resizeDebounce = setTimeout(() => {
                updateCanvasDimensions();
                if ((State.mode === 'PLAYING' || State.mode === 'SOLVED') && State.sourceImage) {
                    PuzzleEngine.cacheTileImages();
                } else if (State.mode === 'READY' && State.sourceImage) {
                    UIManager.showReadyScreen(State.selectedPuzzleTitle);
                }
            }, 100);
        };
        window.addEventListener('resize', onViewportChange);
        window.addEventListener('orientationchange', onViewportChange);
        
        document.addEventListener('keydown', e => {
            if(e.key === 'z' || e.key === 'Z') { PuzzleEngine.undo(); return; }
            if(e.key === 'h' || e.key === 'H') { State.hintsEnabled = !State.hintsEnabled; return; }
        });
    }
};

// --- BOOTSTRAP ---
QATester.runStartupTests();
StorageManager.updateBestDisplay();
PhotoDeliveryManager.init();
GalleryManager.init();
UIManager.bindEvents();
requestAnimationFrame(gameLoop);
