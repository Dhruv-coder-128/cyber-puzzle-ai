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
    saveBestScore(moves, time) {
        return this.saveBest(State.gridSize, time, moves);
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
let latestResults = null;

const VisionManager = {
    hands: null,
    videoLoopId: null,
    isInitializing: false,
    updateStandbyUI(state, error) {
        const overlay = document.getElementById('camera-standby-overlay');
        const title = document.getElementById('camera-standby-title');
        const desc = document.getElementById('camera-standby-desc');
        const btnText = document.getElementById('enable-camera-btn-text');
        const metaText = document.getElementById('camera-meta-text');
        const statusText = document.getElementById('camera-status-text');
        const statusDot = document.getElementById('camera-status-dot');
        const btn = document.getElementById('enable-camera-btn');

        if (!overlay) return;

        overlay.classList.remove('state-error', 'state-loading');

        if (state === 'active') {
            overlay.classList.add('hidden');
            if (statusText) statusText.innerText = 'HAND TRACKING ACTIVE';
            if (statusDot) {
                statusDot.classList.remove('standby-dot');
                statusDot.style.background = 'var(--accent)';
            }
        } else if (state === 'requesting') {
            overlay.classList.remove('hidden');
            overlay.classList.add('state-loading');
            if (title) title.innerText = 'REQUESTING ACCESS...';
            if (desc) desc.innerText = 'Please allow camera permission in your browser prompt.';
            if (btnText) btnText.innerText = 'Connecting...';
            if (btn) btn.disabled = true;
            if (metaText) metaText.innerText = 'INITIALIZING SENSOR...';
            if (statusText) statusText.innerText = 'REQUESTING ACCESS';
            if (statusDot) {
                statusDot.classList.add('standby-dot');
                statusDot.style.background = 'var(--amber)';
            }
        } else if (state === 'denied') {
            overlay.classList.remove('hidden');
            overlay.classList.add('state-error');
            if (title) title.innerText = 'CAMERA ACCESS BLOCKED';
            if (desc) desc.innerText = 'Camera permission is required for gesture controls. Please check your browser address bar permissions.';
            if (btnText) btnText.innerText = 'Try Again';
            if (btn) btn.disabled = false;
            if (metaText) metaText.innerText = 'PERMISSION DENIED';
            if (statusText) statusText.innerText = 'ACCESS BLOCKED';
            if (statusDot) {
                statusDot.classList.add('standby-dot');
                statusDot.style.background = 'var(--error)';
            }
        } else if (state === 'error') {
            overlay.classList.remove('hidden');
            overlay.classList.add('state-error');
            if (title) title.innerText = 'CAMERA UNAVAILABLE';
            if (desc) desc.innerText = error && error.message ? error.message : 'Unable to access camera on this device.';
            if (btnText) btnText.innerText = 'Retry Camera';
            if (btn) btn.disabled = false;
            if (metaText) metaText.innerText = 'DEVICE OFFLINE';
            if (statusText) statusText.innerText = 'CAMERA ERROR';
            if (statusDot) {
                statusDot.classList.add('standby-dot');
                statusDot.style.background = 'var(--error)';
            }
        } else {
            overlay.classList.remove('hidden');
            if (title) title.innerText = 'CAMERA READY';
            if (desc) desc.innerText = 'Enable your camera to unlock gesture controls';
            if (btnText) btnText.innerText = 'Enable Camera';
            if (btn) btn.disabled = false;
            if (metaText) metaText.innerText = 'CAMERA OFF • HAND TRACKING STANDBY';
            if (statusText) statusText.innerText = 'CAMERA STANDBY';
            if (statusDot) {
                statusDot.classList.add('standby-dot');
                statusDot.style.background = 'var(--text-tertiary)';
            }
        }
    },
    async init() {
        console.log('[Camera] permission check / init');
        if (this.isInitializing) return;
        this.isInitializing = true;
        try {
            if (!this.hands) {
                console.log('[Tracking] initializing MediaPipe Hands');
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
        console.log('[Camera] requesting camera stream, facingMode:', State.cameraFacingMode);
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            this.updateStandbyUI('error', { message: 'Camera API not supported by this browser.' });
            UIManager.hide('loading-indicator');
            UIManager.show('error-screen');
            const errMsg = document.getElementById('error-msg');
            if (errMsg) errMsg.innerText = "Camera API is not supported by your browser. You can still play all 20 puzzles in the Gallery!";
            return;
        }

        // 1. Clean up any existing stream tracks first to release camera hardware
        if (Els.video && Els.video.srcObject) {
            const oldStream = Els.video.srcObject;
            try {
                oldStream.getTracks().forEach(track => track.stop());
            } catch(e) {}
            Els.video.srcObject = null;
        }
        if (this.videoLoopId) {
            cancelAnimationFrame(this.videoLoopId);
            this.videoLoopId = null;
        }

        this.updateStandbyUI('requesting');
        UIManager.show('loading-indicator');
        UIManager.hide('error-screen');

        let stream = null;
        const isRear = State.cameraFacingMode === 'environment';

        // Strategy 1: Ideal facingMode with ideal high resolution (Works universally on iOS & Android)
        const primaryConstraints = {
            video: { 
                facingMode: isRear ? { ideal: 'environment' } : { ideal: 'user' },
                width: { ideal: 1280 }, 
                height: { ideal: 720 } 
            },
            audio: false
        };

        try {
            stream = await navigator.mediaDevices.getUserMedia(primaryConstraints);
        } catch (err1) {
            console.warn('[Camera] primary constraints failed, trying basic facingMode...', err1);
            // Strategy 2: Basic string facingMode
            try {
                const fallbackConstraints = {
                    video: { 
                        facingMode: isRear ? 'environment' : 'user' 
                    },
                    audio: false
                };
                stream = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
            } catch (err2) {
                console.warn('[Camera] basic facingMode failed, checking device enumeration...', err2);
                // Strategy 3: Enumerate devices
                try {
                    let chosenDeviceId = null;
                    if (navigator.mediaDevices.enumerateDevices) {
                        const devices = await navigator.mediaDevices.enumerateDevices();
                        const videoDevices = devices.filter(d => d.kind === 'videoinput');
                        if (videoDevices.length > 0) {
                            const match = videoDevices.find(d => {
                                const label = (d.label || '').toLowerCase();
                                return isRear ? (label.includes('back') || label.includes('rear') || label.includes('environment'))
                                              : (label.includes('front') || label.includes('user') || label.includes('facing'));
                            });
                            chosenDeviceId = match ? match.deviceId : videoDevices[0].deviceId;
                        }
                    }
                    if (chosenDeviceId) {
                        stream = await navigator.mediaDevices.getUserMedia({
                            video: { deviceId: { exact: chosenDeviceId } },
                            audio: false
                        });
                    } else {
                        // Strategy 4: Generic video
                        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                    }
                } catch (err3) {
                    throw err3; // Escalate to main error handler
                }
            }
        }

        Els.video.srcObject = stream;
        console.log('[Camera] stream started successfully');
        
        // Wait for metadata to ensure video dimensions are known
        await new Promise((resolve) => {
            if (Els.video.readyState >= 2 && Els.video.videoWidth > 0) {
                resolve();
            } else {
                Els.video.onloadedmetadata = () => resolve();
            }
        });
        
        try {
            await Els.video.play();
        } catch (playErr) {
            console.warn('[Camera] play error:', playErr);
        }
        console.log('[Camera] video ready:', Els.video.videoWidth, 'x', Els.video.videoHeight);
        
        // Match canvas dimensions to video feed
        if (Els.video.videoWidth > 0 && Els.video.videoHeight > 0) {
            Els.canvas.width = Els.video.videoWidth;
            Els.canvas.height = Els.video.videoHeight;
        }
        
        let lastVideoTime = -1;
        const processFrame = async () => {
            if (Els.video && Els.video.currentTime !== lastVideoTime && !Els.video.paused && !Els.video.ended) {
                lastVideoTime = Els.video.currentTime;
                // Only send frames to MediaPipe Hands if on front camera or playing
                if (this.hands && (State.cameraFacingMode === 'user' || State.mode === 'PLAYING')) {
                    await this.hands.send({image: Els.video});
                }
            }
            if (Els.video && Els.video.srcObject) {
                this.videoLoopId = requestAnimationFrame(processFrame);
            }
        };
        this.videoLoopId = requestAnimationFrame(processFrame);
        
        this.updateStandbyUI('active');
        this.updateCameraModeUI();
        
        UIManager.hide('loading-indicator');
        UIManager.hide('error-screen');
        UIManager.hide('tutorial-overlay');
        Els.video.classList.remove('hidden');
        Els.canvas.classList.add('visible');
        State.videoReady = true;
        State.mode = 'CAPTURE';
        console.log('[Camera] active in mode CAPTURE, ready to capture snapshot');
        QATester.assert(true, `Camera started (${State.cameraFacingMode})`);
    },
    updateCameraModeUI() {
        const isRear = State.cameraFacingMode === 'environment';
        
        // 1. Mirroring
        if (Els.video) {
            Els.video.classList.toggle('is-mirrored', !isRear);
        }

        // 2. Camera status text & icons
        const statusText = document.getElementById('camera-status-text');
        const captureInstruction = document.getElementById('capture-instruction');
        const manualCaptureBar = document.getElementById('manual-capture-bar');
        const shutterLabel = document.getElementById('shutter-label-text');
        const camBtn = document.getElementById('cam-btn');

        if (camBtn) {
            camBtn.title = isRear ? 'Switch to Front Camera' : 'Switch to Rear Camera';
            camBtn.classList.toggle('active-rear', isRear);
        }

        if (State.mode === 'CAPTURE' && State.videoReady) {
            if (isRear) {
                if (statusText) statusText.innerText = 'REAR CAMERA • TAP TO CAPTURE';
                if (captureInstruction) captureInstruction.classList.add('hidden');
                if (manualCaptureBar) manualCaptureBar.classList.remove('hidden');
                if (shutterLabel) shutterLabel.innerText = 'CAPTURE PHOTO';
            } else {
                if (statusText) statusText.innerText = 'FRONT CAM • GESTURE ACTIVE';
                if (captureInstruction) captureInstruction.classList.remove('hidden');
                if (manualCaptureBar) manualCaptureBar.classList.remove('hidden');
                if (shutterLabel) shutterLabel.innerText = 'TAP OR PINCH';
            }
        }
    },
    onResults(results) {
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

            // --- ADAPTIVE EMA SMOOTHING & SPIKE REJECTION ---
            const spikeThresh = Math.max(Els.canvas.width, Els.canvas.height) * 0.28;
            if (!State.hand.exists) {
                State.hand.cx = rawCx;
                State.hand.cy = rawCy;
                State.handPrevCx = rawCx;
                State.handPrevCy = rawCy;
            } else {
                const delta = Math.hypot(rawCx - State.handPrevCx, rawCy - State.handPrevCy);
                if (delta <= spikeThresh) {
                    // Responsive dynamic alpha: 0.28 on still hover (zero jitter), 0.72 on fast sweeps
                    const alpha = Math.min(0.72, Math.max(0.28, delta / 65));
                    State.hand.cx += (rawCx - State.hand.cx) * alpha;
                    State.hand.cy += (rawCy - State.hand.cy) * alpha;
                    State.handPrevCx = State.hand.cx;
                    State.handPrevCy = State.hand.cy;
                }
            }

            State.hand.exists = true;
            State.handLostFrames = 0;
            
            // --- SCALE-INVARIANT PINCH DETECTION ---
            const palmScale = Math.hypot(lm[9].x - lm[0].x, lm[9].y - lm[0].y) || 0.24;
            const pinchRatio = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y) / palmScale;

            // Hysteresis threshold: 0.32 to engage pinch, 0.48 to disengage
            const isPinchedCandidate = pinchRatio < (State.hand.isPinched ? 0.48 : 0.32);

            // 2-frame confirmation to eliminate 1-frame tracking noise/flicker
            if (isPinchedCandidate) {
                State.pinchEngageCount = (State.pinchEngageCount || 0) + 1;
                State.pinchReleaseCount = 0;
                if (State.pinchEngageCount >= 2) {
                    State.hand.isPinched = true;
                }
            } else {
                State.pinchReleaseCount = (State.pinchReleaseCount || 0) + 1;
                State.pinchEngageCount = 0;
                if (State.pinchReleaseCount >= 2) {
                    State.hand.isPinched = false;
                }
            }
            
            latestResults = results;
        } else {
            // Hand not detected this frame
            State.handLostFrames++;
            if (State.handLostFrames > State.handLostTolerance) {
                State.hand.exists = false;
                State.hand.isPinched = false;
                State.pinchEngageCount = 0;
                State.pinchReleaseCount = 0;
                latestResults = null;
            }
        }
    },
    async toggleCamera() {
        AudioEngine.playClick();
        State.cameraFacingMode = State.cameraFacingMode === 'user' ? 'environment' : 'user';
        this.updateCameraModeUI();
        await this.startCamera();
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
        HintManager.invalidate();
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
        HintManager.invalidate();
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
        HintManager.invalidate();
        const tile2 = State.tiles.find(t => t.c === targetCell.c && t.r === targetCell.r && t !== tile1);
        
        State.history.push({
            t1: tile1.id, from1: {c: tile1.c, r: tile1.r},
            t2: tile2 ? tile2.id : null, from2: tile2 ? {c: tile2.c, r: tile2.r} : null,
            target: {c: targetCell.c, r: targetCell.r}
        });
        Els.undo.disabled = false;
        
        const originalC1 = tile1.c;
        const originalR1 = tile1.r;
        const b = this.getBoardBounds();
        
        // Update logical positions
        tile1.c = targetCell.c;
        tile1.r = targetCell.r;
        
        // Continuous visual offset for tile1 snapping into targetCell
        tile1.dragOffset.x += (originalC1 - targetCell.c) * b.tw;
        tile1.dragOffset.y += (originalR1 - targetCell.r) * b.th;
        tile1.vx = -tile1.dragOffset.x * 6;
        tile1.vy = -tile1.dragOffset.y * 6;
        
        if (tile2) {
            tile2.c = originalC1;
            tile2.r = originalR1;
            // Animate tile2 snapping to its new spot
            tile2.dragOffset = {
                x: (targetCell.c - originalC1) * b.tw,
                y: (targetCell.r - originalR1) * b.th
            };
            tile2.vx = -tile2.dragOffset.x * 6;
            tile2.vy = -tile2.dragOffset.y * 6;
        }
        
        State.moves++;
        UIManager.updateStats();
        AudioEngine.playDrop();
        if(navigator.vibrate) navigator.vibrate(20);
    },
    undo() {
        if(State.history.length === 0) return;
        HintManager.invalidate();
        const last = State.history.pop();
        const tile1 = State.tiles.find(t => t.id === last.t1);
        const tile2 = last.t2 !== null ? State.tiles.find(t => t.id === last.t2) : null;
        
        if (tile1) {
            tile1.c = last.from1.c;
            tile1.r = last.from1.r;
            const b = this.getBoardBounds();
            tile1.dragOffset = {x: (last.target.c - last.from1.c) * b.tw, y: (last.target.r - last.from1.r) * b.th};
            tile1.vx = -tile1.dragOffset.x * 6;
            tile1.vy = -tile1.dragOffset.y * 6;
        }
        
        if (tile2) {
            tile2.c = last.from2.c;
            tile2.r = last.from2.r;
            const b = this.getBoardBounds();
            tile2.dragOffset = {x: (last.target.c - last.from2.c) * b.tw, y: (last.target.r - last.from2.r) * b.th};
            tile2.vx = -tile2.dragOffset.x * 6;
            tile2.vy = -tile2.dragOffset.y * 6;
        }
        
        State.moves++;
        UIManager.updateStats();
        AudioEngine.playDrop();
        if(State.history.length === 0) Els.undo.disabled = true;
        this.checkWin();
    },
    isPuzzleSolved() {
        if (!State.tiles || State.tiles.length === 0) return false;
        const expectedCount = State.gridSize * State.gridSize;
        if (State.tiles.length !== expectedCount) return false;
        return State.tiles.every(t => t.c === t.origC && t.r === t.origR);
    },
    checkWin() {
        if (State.mode !== 'PLAYING') return;
        if (this.isPuzzleSolved()) {
            HintManager.dismiss();
            State.mode = 'SOLVED';
            clearInterval(State.timerInterval);
            
            // Release any lingering drag or selection state
            State.isPinching = false;
            State.selectedTile = null;
            
            const isBest = StorageManager.saveBest(State.gridSize, State.elapsed, State.moves);
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

// --- SMART UNIVERSAL HINT SYSTEM ---
const HintManager = {
    active: false,
    level: 0, // 0 = off, 1 = Visual Guidance, 2 = Action Guidance, 3 = Show The Move (Preview)
    sourceTile: null,
    targetCell: null,
    targetTile: null,
    isMutual: false,
    previewAnim: null, // { startTime, duration }

    invalidate() {
        this.active = false;
        this.level = 0;
        this.sourceTile = null;
        this.targetCell = null;
        this.targetTile = null;
        this.isMutual = false;
        this.previewAnim = null;
        this.updateButtonUI();
    },

    dismiss() {
        this.invalidate();
    },

    updateButtonUI() {
        if (!Els.hint) return;
        Els.hint.classList.remove('active', 'active-level-2', 'active-level-3');
        if (this.active) {
            if (this.level === 1) Els.hint.classList.add('active');
            else if (this.level === 2) Els.hint.classList.add('active-level-2');
            else if (this.level === 3) Els.hint.classList.add('active-level-3');
        }
    },

    solveNextMove() {
        if (State.mode !== 'PLAYING' || !State.tiles || State.tiles.length === 0) return null;
        if (PuzzleEngine.isPuzzleSolved()) return null;

        const size = State.gridSize;
        const total = size * size;
        
        // Build current board map: cellIndex -> tile
        const board = new Array(total);
        for (const tile of State.tiles) {
            const currentIdx = tile.r * size + tile.c;
            board[currentIdx] = tile;
        }

        // 1. Priority 1 — 2-Cycle Mutual Swaps (Swapping fixes 2 tiles at once)
        for (let i = 0; i < total; i++) {
            const tileA = board[i];
            if (!tileA) continue;
            const targetA = tileA.origR * size + tileA.origC;
            if (targetA !== i) {
                const tileB = board[targetA];
                if (tileB) {
                    const targetB = tileB.origR * size + tileB.origC;
                    if (targetB === i) {
                        return {
                            sourceTile: tileA,
                            targetCell: { c: tileA.origC, r: tileA.origR },
                            targetTile: tileB,
                            isMutual: true
                        };
                    }
                }
            }
        }

        // 2. Priority 2 — First misplaced cell in natural reading order
        // Move the tile belonging at this home cell into it
        for (let idx = 0; idx < total; idx++) {
            const currentTile = board[idx];
            if (!currentTile) continue;
            const currentTileHome = currentTile.origR * size + currentTile.origC;
            if (currentTileHome !== idx) {
                // Find the tile that belongs at `idx`
                const homeTile = State.tiles.find(t => t.origR * size + t.origC === idx);
                if (homeTile && (homeTile.c !== homeTile.origC || homeTile.r !== homeTile.origR)) {
                    return {
                        sourceTile: homeTile,
                        targetCell: { c: homeTile.origC, r: homeTile.origR },
                        targetTile: currentTile,
                        isMutual: false
                    };
                }

                // Or move currentTile to its own home cell
                const tileAtHome = board[currentTileHome] || null;
                return {
                    sourceTile: currentTile,
                    targetCell: { c: currentTile.origC, r: currentTile.origR },
                    targetTile: tileAtHome,
                    isMutual: false
                };
            }
        }

        return null;
    },

    triggerHint() {
        if (State.mode !== 'PLAYING') return;
        if (PuzzleEngine.isPuzzleSolved()) {
            this.dismiss();
            return;
        }

        AudioEngine.playClick();

        if (!this.active) {
            // Level 1: Visual Guidance
            const move = this.solveNextMove();
            if (!move || !move.sourceTile || !move.targetCell) {
                this.dismiss();
                return;
            }
            this.active = true;
            this.level = 1;
            this.sourceTile = move.sourceTile;
            this.targetCell = move.targetCell;
            this.targetTile = move.targetTile;
            this.isMutual = move.isMutual;
            this.previewAnim = null;

            // Small configurable hint penalty: +3 seconds to timer
            if (State.startTime && State.gameStarted) {
                State.startTime -= 3000;
                State.elapsed = Math.floor((Date.now() - State.startTime) / 1000);
                const m = Math.floor(State.elapsed / 60).toString().padStart(2, '0');
                const s = (State.elapsed % 60).toString().padStart(2, '0');
                Els.time.innerText = `${m}:${s}`;
            }
        } else if (this.level === 1) {
            // Level 2: Action Guidance
            this.level = 2;
        } else if (this.level === 2) {
            // Level 3: Show The Move (Preview Demonstration)
            this.level = 3;
            this.previewAnim = {
                startTime: performance.now(),
                duration: 1600 // 1.6s demonstration
            };
        } else {
            // Toggle off
            this.dismiss();
            return;
        }

        this.updateButtonUI();
    },

    render(ctx, b, timestamp) {
        if (!this.active || State.mode !== 'PLAYING' || !this.sourceTile || !this.targetCell) {
            return;
        }

        // Validate that source tile and target are still consistent with current board
        const curSourceCell = { c: this.sourceTile.c, r: this.sourceTile.r };
        if (curSourceCell.c === this.targetCell.c && curSourceCell.r === this.targetCell.r) {
            // Tile was already moved to target! Invalidate
            this.invalidate();
            return;
        }

        const t = (timestamp || performance.now()) * 0.001;
        const pulse = Math.sin(t * 5) * 0.5 + 0.5; // 0..1
        const pad = 4;

        // Source Cell coordinates
        const srcX = b.ox + this.sourceTile.c * b.tw;
        const srcY = b.oy + this.sourceTile.r * b.th;
        const srcCenterX = srcX + b.tw / 2;
        const srcCenterY = srcY + b.th / 2;

        // Target Cell coordinates
        const tgtX = b.ox + this.targetCell.c * b.tw;
        const tgtY = b.oy + this.targetCell.r * b.th;
        const tgtCenterX = tgtX + b.tw / 2;
        const tgtCenterY = tgtY + b.th / 2;

        // --- LEVEL 3 DEMO ANIMATION PROGRESSION ---
        if (this.level === 3 && this.previewAnim) {
            const elapsed = performance.now() - this.previewAnim.startTime;
            const p = Math.min(1, elapsed / this.previewAnim.duration);
            if (p >= 1) {
                // Animation finished: return to Level 2
                this.previewAnim = null;
                this.level = 2;
                this.updateButtonUI();
            } else {
                // Smooth sine bell curve: 0 -> 1 -> 0
                const demoFactor = Math.sin(p * Math.PI);
                const demoDx = (tgtX - srcX) * demoFactor;
                const demoDy = (tgtY - srcY) * demoFactor;

                // Draw floating ghost preview of the swap
                ctx.save();
                ctx.globalAlpha = 0.85;
                if (this.sourceTile.canvas) {
                    RenderEngine.roundRect(ctx, srcX + demoDx + pad, srcY + demoDy + pad, b.tw - pad * 2, b.th - pad * 2, 16);
                    ctx.clip();
                    ctx.drawImage(this.sourceTile.canvas, srcX + demoDx, srcY + demoDy, b.tw, b.th);
                }
                ctx.restore();
            }
        }

        ctx.save();

        // 1. Source Tile Highlight (Amber)
        const srcStrokeAlpha = 0.65 + pulse * 0.35;
        RenderEngine.roundRect(ctx, srcX + pad, srcY + pad, b.tw - pad * 2, b.th - pad * 2, 16);
        ctx.strokeStyle = `rgba(245, 184, 75, ${srcStrokeAlpha})`;
        ctx.lineWidth = this.level >= 2 ? 3.0 : 2.2;
        ctx.shadowColor = 'rgba(245, 184, 75, 0.6)';
        ctx.shadowBlur = 8 + pulse * 6;
        ctx.stroke();
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;

        ctx.fillStyle = 'rgba(245, 184, 75, 0.12)';
        ctx.fill();

        // 2. Target Cell Highlight (Mint / Cyan)
        const tgtStrokeAlpha = 0.65 + pulse * 0.35;
        RenderEngine.roundRect(ctx, tgtX + pad, tgtY + pad, b.tw - pad * 2, b.th - pad * 2, 16);
        ctx.strokeStyle = `rgba(99, 230, 190, ${tgtStrokeAlpha})`;
        ctx.lineWidth = this.level >= 2 ? 3.0 : 2.2;
        ctx.shadowColor = 'rgba(99, 230, 190, 0.6)';
        ctx.shadowBlur = 8 + pulse * 6;
        ctx.stroke();
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;

        ctx.fillStyle = 'rgba(99, 230, 190, 0.14)';
        ctx.fill();

        // Corner Brackets for Target Cell
        const bLen = Math.min(14, b.tw * 0.22);
        ctx.strokeStyle = '#63E6BE';
        ctx.lineWidth = 2.0;
        ctx.lineCap = 'round';

        // TL
        ctx.beginPath();
        ctx.moveTo(tgtX + pad, tgtY + pad + bLen);
        ctx.lineTo(tgtX + pad, tgtY + pad);
        ctx.lineTo(tgtX + pad + bLen, tgtY + pad);
        ctx.stroke();
        // TR
        ctx.beginPath();
        ctx.moveTo(tgtX + b.tw - pad - bLen, tgtY + pad);
        ctx.lineTo(tgtX + b.tw - pad, tgtY + pad);
        ctx.lineTo(tgtX + b.tw - pad, tgtY + pad + bLen);
        ctx.stroke();
        // BL
        ctx.beginPath();
        ctx.moveTo(tgtX + pad, tgtY + b.th - pad - bLen);
        ctx.lineTo(tgtX + pad, tgtY + b.th - pad);
        ctx.lineTo(tgtX + pad + bLen, tgtY + b.th - pad);
        ctx.stroke();
        // BR
        ctx.beginPath();
        ctx.moveTo(tgtX + b.tw - pad - bLen, tgtY + b.th - pad);
        ctx.lineTo(tgtX + b.tw - pad, tgtY + b.th - pad);
        ctx.lineTo(tgtX + b.tw - pad, tgtY + b.th - pad - bLen);
        ctx.stroke();

        // 3. Directional Connecting Arched Line with Animated Flow & Arrow
        const dx = tgtCenterX - srcCenterX;
        const dy = tgtCenterY - srcCenterY;
        const dist = Math.hypot(dx, dy);

        if (dist > 10) {
            // Arc curvature perpendicular to vector
            const midX = (srcCenterX + tgtCenterX) / 2;
            const midY = (srcCenterY + tgtCenterY) / 2;
            const normalX = -dy / dist;
            const normalY = dx / dist;
            const arcOffset = Math.min(35, dist * 0.18);
            const ctrlX = midX + normalX * arcOffset;
            const ctrlY = midY + normalY * arcOffset;

            // Gradient curve from Amber (source) to Mint (target)
            const grad = ctx.createLinearGradient(srcCenterX, srcCenterY, tgtCenterX, tgtCenterY);
            grad.addColorStop(0, 'rgba(245, 184, 75, 0.9)');
            grad.addColorStop(1, 'rgba(99, 230, 190, 0.95)');

            ctx.beginPath();
            ctx.moveTo(srcCenterX, srcCenterY);
            ctx.quadraticCurveTo(ctrlX, ctrlY, tgtCenterX, tgtCenterY);
            ctx.strokeStyle = grad;
            ctx.lineWidth = this.level >= 2 ? 3.0 : 2.2;
            ctx.setLineDash([8, 6]);
            ctx.lineDashOffset = -t * 30; // Animated moving dashes
            ctx.stroke();
            ctx.setLineDash([]);

            // Draw directional arrowhead at target
            const angle = Math.atan2(tgtCenterY - ctrlY, tgtCenterX - ctrlX);
            const arrowSize = this.level >= 2 ? 14 : 10;

            ctx.save();
            ctx.translate(tgtCenterX, tgtCenterY);
            ctx.rotate(angle);
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(-arrowSize, -arrowSize * 0.55);
            ctx.lineTo(-arrowSize * 0.65, 0);
            ctx.lineTo(-arrowSize, arrowSize * 0.55);
            ctx.closePath();
            ctx.fillStyle = '#63E6BE';
            ctx.shadowColor = '#63E6BE';
            ctx.shadowBlur = 8;
            ctx.fill();
            ctx.restore();
        }

        // 4. Compact Smart Badges / Labels
        const labelSize = Math.max(9, Math.min(11, b.tw * 0.12));
        ctx.font = `700 ${labelSize}px Inter, -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Source Label
        const srcText = (this.level >= 2) ? (this.isMutual ? "SWAP" : "MOVE") : "MOVE THIS";
        const srcTagW = ctx.measureText(srcText).width + 14;
        const srcTagH = labelSize + 8;
        const srcTagY = srcY + pad + srcTagH / 2 + 4;

        RenderEngine.roundRect(ctx, srcCenterX - srcTagW / 2, srcTagY - srcTagH / 2, srcTagW, srcTagH, 4);
        ctx.fillStyle = 'rgba(16, 20, 22, 0.92)';
        ctx.fill();
        ctx.strokeStyle = '#F5B84B';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        ctx.fillStyle = '#F5B84B';
        ctx.fillText(srcText, srcCenterX, srcTagY);

        // Target Label
        const tgtText = (this.level >= 2) ? (this.isMutual ? "SWAP HERE" : "HERE") : "TARGET";
        const tgtTagW = ctx.measureText(tgtText).width + 14;
        const tgtTagH = labelSize + 8;
        const tgtTagY = tgtY + b.th - pad - tgtTagH / 2 - 4;

        RenderEngine.roundRect(ctx, tgtCenterX - tgtTagW / 2, tgtTagY - tgtTagH / 2, tgtTagW, tgtTagH, 4);
        ctx.fillStyle = 'rgba(16, 20, 22, 0.92)';
        ctx.fill();
        ctx.strokeStyle = '#63E6BE';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        ctx.fillStyle = '#63E6BE';
        ctx.fillText(tgtText, tgtCenterX, tgtTagY);

        ctx.restore();
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
    drawIdleBoard(timestamp) {
        const b = PuzzleEngine.getBoardBounds();
        const t = (timestamp || performance.now()) * 0.001;
        const pulse = Math.sin(t * 1.5) * 0.5 + 0.5; // 0..1
        const floatY = Math.sin(t * 1.2) * 2;
        
        Els.ctx.save();
        
        // 1. Outer Board Substrate (Dark glass container)
        this.roundRect(Els.ctx, b.ox - 10, b.oy - 10, b.size + 20, b.size + 20, 24);
        Els.ctx.fillStyle = 'rgba(16, 19, 21, 0.7)';
        Els.ctx.fill();
        Els.ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
        Els.ctx.lineWidth = 1;
        Els.ctx.stroke();
        
        // Cyber Corner Brackets on the outer substrate
        const bracketLen = Math.min(24, b.size * 0.06);
        const bracketPad = 6;
        Els.ctx.strokeStyle = 'rgba(99, 230, 190, 0.45)';
        Els.ctx.lineWidth = 1.5;
        Els.ctx.lineCap = 'round';
        
        // Top-Left
        Els.ctx.beginPath();
        Els.ctx.moveTo(b.ox - bracketPad, b.oy - bracketPad + bracketLen);
        Els.ctx.lineTo(b.ox - bracketPad, b.oy - bracketPad);
        Els.ctx.lineTo(b.ox - bracketPad + bracketLen, b.oy - bracketPad);
        Els.ctx.stroke();
        
        // Top-Right
        Els.ctx.beginPath();
        Els.ctx.moveTo(b.ox + b.size + bracketPad - bracketLen, b.oy - bracketPad);
        Els.ctx.lineTo(b.ox + b.size + bracketPad, b.oy - bracketPad);
        Els.ctx.lineTo(b.ox + b.size + bracketPad, b.oy - bracketPad + bracketLen);
        Els.ctx.stroke();
        
        // Bottom-Left
        Els.ctx.beginPath();
        Els.ctx.moveTo(b.ox - bracketPad, b.oy + b.size + bracketPad - bracketLen);
        Els.ctx.lineTo(b.ox - bracketPad, b.oy + b.size + bracketPad);
        Els.ctx.lineTo(b.ox - bracketPad + bracketLen, b.oy + b.size + bracketPad);
        Els.ctx.stroke();
        
        // Bottom-Right
        Els.ctx.beginPath();
        Els.ctx.moveTo(b.ox + b.size + bracketPad - bracketLen, b.oy + b.size + bracketPad);
        Els.ctx.lineTo(b.ox + b.size + bracketPad, b.oy + b.size + bracketPad);
        Els.ctx.lineTo(b.ox + b.size + bracketPad, b.oy + b.size + bracketPad - bracketLen);
        Els.ctx.stroke();
        
        // 2. Subtle 3x3 Geometric Puzzle Grid Silhouette
        const gridN = 3;
        const cellSize = b.size / gridN;
        const pad = 6;
        
        for (let r = 0; r < gridN; r++) {
            for (let c = 0; c < gridN; c++) {
                const cellX = b.ox + c * cellSize + pad;
                const cellY = b.oy + r * cellSize + pad;
                const cellW = cellSize - pad * 2;
                const cellH = cellSize - pad * 2;
                
                const isCenter = (r === 1 && c === 1);
                const isCorner = ((r === 0 || r === 2) && (c === 0 || c === 2));
                const dy = isCenter ? floatY : 0;
                
                this.roundRect(Els.ctx, cellX, cellY + dy, cellW, cellH, 14);
                Els.ctx.fillStyle = isCenter ? 'rgba(24, 30, 33, 0.75)' : 'rgba(20, 24, 27, 0.55)';
                Els.ctx.fill();
                
                // Delicate border
                Els.ctx.strokeStyle = isCenter 
                    ? `rgba(99, 230, 190, ${0.18 + pulse * 0.12})` 
                    : (isCorner ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.03)');
                Els.ctx.lineWidth = isCenter ? 1.4 : 1;
                Els.ctx.stroke();
                
                // Micro technical accents in cells
                if (!isCenter) {
                    Els.ctx.beginPath();
                    Els.ctx.arc(cellX + cellW / 2, cellY + cellH / 2, 2, 0, Math.PI * 2);
                    Els.ctx.fillStyle = 'rgba(99, 230, 190, 0.18)';
                    Els.ctx.fill();
                }
            }
        }
        
        // 3. Center Ready-to-Play Content Presentation
        const centerX = b.ox + b.size / 2;
        const centerY = b.oy + b.size / 2;
        
        // Status Capsule Pill
        const pillW = Math.min(136, b.size * 0.42);
        const pillH = 26;
        const pillY = centerY - 38 + floatY;
        
        this.roundRect(Els.ctx, centerX - pillW / 2, pillY, pillW, pillH, 13);
        Els.ctx.fillStyle = 'rgba(16, 21, 23, 0.9)';
        Els.ctx.fill();
        Els.ctx.strokeStyle = `rgba(99, 230, 190, ${0.35 + pulse * 0.25})`;
        Els.ctx.lineWidth = 1.2;
        Els.ctx.stroke();
        
        // Pulsing Mint Status Indicator Dot
        Els.ctx.beginPath();
        Els.ctx.arc(centerX - pillW / 2 + 14, pillY + pillH / 2, 3.5, 0, Math.PI * 2);
        Els.ctx.fillStyle = '#63E6BE';
        Els.ctx.shadowColor = '#63E6BE';
        Els.ctx.shadowBlur = 6 * pulse + 2;
        Els.ctx.fill();
        Els.ctx.shadowColor = 'transparent';
        Els.ctx.shadowBlur = 0;
        
        // "READY TO PLAY" Text
        Els.ctx.font = '600 11px Inter, -apple-system, BlinkMacSystemFont, sans-serif';
        Els.ctx.fillStyle = '#E6ECE9';
        Els.ctx.textAlign = 'left';
        Els.ctx.textBaseline = 'middle';
        Els.ctx.fillText('READY TO PLAY', centerX - pillW / 2 + 24, pillY + pillH / 2 + 0.5);
        
        // Primary Instruction: "Choose a puzzle or capture a photo"
        Els.ctx.font = '500 13px Inter, -apple-system, BlinkMacSystemFont, sans-serif';
        Els.ctx.fillStyle = '#A4B3AE';
        Els.ctx.textAlign = 'center';
        Els.ctx.textBaseline = 'middle';
        Els.ctx.fillText('Choose a puzzle or capture a photo', centerX, centerY + 8 + floatY);
        
        // Secondary Hint: "Pinch to capture  •  Drag to solve"
        Els.ctx.font = '400 11px Inter, -apple-system, BlinkMacSystemFont, sans-serif';
        Els.ctx.fillStyle = 'rgba(99, 230, 190, 0.72)';
        Els.ctx.fillText('Pinch to capture  •  Drag to solve', centerX, centerY + 30 + floatY);
        
        Els.ctx.restore();
    },
    drawFrame(timestamp) {
        if (!Els.ctx || Els.canvas.width === 0) return;
        Els.ctx.clearRect(0, 0, Els.canvas.width, Els.canvas.height);
        
        // 1. Idle Ready Board State (Active when waiting for user to start puzzle)
        if (State.mode !== 'PLAYING' && State.mode !== 'SOLVED' && State.mode !== 'READY') {
            this.drawIdleBoard(timestamp);
        }
        
        // 2. Active Puzzle Board Container
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
                
                Els.ctx.strokeStyle = isSelected ? 'rgba(99, 230, 190, 0.65)' : 'rgba(255, 255, 255, 0.12)';
                Els.ctx.lineWidth = isSelected ? 2.2 : 1.2;
                Els.ctx.stroke();
                Els.ctx.restore();
            });

            // Draw Smart Universal Hint Overlay (Visual Guidance, Action Guidance, & Move Demo)
            HintManager.render(Els.ctx, b, timestamp);
        }
        
        // 3. Hands & Interaction (High-Visibility Futuristic Interface Overlay)
        if (latestResults && latestResults.multiHandLandmarks) {
            Els.ctx.save();
            if (State.cameraFacingMode === 'user') {
                Els.ctx.translate(Els.canvas.width, 0);
                Els.ctx.scale(-1, 1);
            }
            
            const isPinched = State.hand.isPinched;
            const isGrabbing = isPinched && State.selectedTile;
            const t = (timestamp || performance.now()) * 0.001;
            const pulse = Math.sin(t * 4) * 0.5 + 0.5;
            
            for (const lm of latestResults.multiHandLandmarks) {
                // Skeleton connector lines with rounded joins & subtle glowing stroke
                Els.ctx.lineCap = 'round';
                Els.ctx.lineJoin = 'round';
                
                // Outer glow stroke behind connectors
                Els.ctx.beginPath();
                if (typeof HAND_CONNECTIONS !== 'undefined') {
                    for (const [i, j] of HAND_CONNECTIONS) {
                        if (lm[i] && lm[j]) {
                            Els.ctx.moveTo(lm[i].x * Els.canvas.width, lm[i].y * Els.canvas.height);
                            Els.ctx.lineTo(lm[j].x * Els.canvas.width, lm[j].y * Els.canvas.height);
                        }
                    }
                }
                Els.ctx.strokeStyle = isGrabbing 
                    ? 'rgba(245, 184, 75, 0.25)' 
                    : (isPinched ? 'rgba(99, 230, 190, 0.35)' : 'rgba(99, 230, 190, 0.2)');
                Els.ctx.lineWidth = isPinched ? 3.5 : 2.6;
                Els.ctx.stroke();
                
                // Core crisp connector line
                Els.ctx.beginPath();
                if (typeof HAND_CONNECTIONS !== 'undefined') {
                    for (const [i, j] of HAND_CONNECTIONS) {
                        if (lm[i] && lm[j]) {
                            Els.ctx.moveTo(lm[i].x * Els.canvas.width, lm[i].y * Els.canvas.height);
                            Els.ctx.lineTo(lm[j].x * Els.canvas.width, lm[j].y * Els.canvas.height);
                        }
                    }
                }
                Els.ctx.strokeStyle = isGrabbing 
                    ? 'rgba(245, 184, 75, 0.85)' 
                    : (isPinched ? 'rgba(99, 230, 190, 0.9)' : 'rgba(99, 230, 190, 0.65)');
                Els.ctx.lineWidth = isPinched ? 2.0 : 1.5;
                Els.ctx.stroke();
                
                // Active Pinch Proximity Ray between Thumb Tip (4) and Index Tip (8)
                if (lm[4] && lm[8]) {
                    const p4x = lm[4].x * Els.canvas.width;
                    const p4y = lm[4].y * Els.canvas.height;
                    const p8x = lm[8].x * Els.canvas.width;
                    const p8y = lm[8].y * Els.canvas.height;
                    
                    Els.ctx.beginPath();
                    Els.ctx.moveTo(p4x, p4y);
                    Els.ctx.lineTo(p8x, p8y);
                    Els.ctx.strokeStyle = isGrabbing 
                        ? 'rgba(245, 184, 75, 0.95)' 
                        : (isPinched ? 'rgba(99, 230, 190, 0.95)' : `rgba(99, 230, 190, ${0.25 + pulse * 0.2})`);
                    Els.ctx.lineWidth = isPinched ? 2.8 : 1.4;
                    Els.ctx.stroke();
                }
                
                // Futuristic Joint Nodes with refined hierarchy
                lm.forEach((pt, idx) => {
                    const px = pt.x * Els.canvas.width;
                    const py = pt.y * Els.canvas.height;
                    const isFingertipPinch = (idx === 4 || idx === 8);
                    const isOtherFingertip = (idx === 12 || idx === 16 || idx === 20);
                    const isWrist = (idx === 0);
                    
                    if (isFingertipPinch) {
                        const haloR = isPinched ? 8.5 : 7.0;
                        const coreR = isPinched ? 4.2 : 3.4;
                        
                        Els.ctx.beginPath();
                        Els.ctx.arc(px, py, haloR, 0, 2 * Math.PI);
                        Els.ctx.fillStyle = isGrabbing 
                            ? 'rgba(245, 184, 75, 0.35)' 
                            : (isPinched ? 'rgba(99, 230, 190, 0.35)' : 'rgba(99, 230, 190, 0.22)');
                        Els.ctx.fill();
                        
                        Els.ctx.beginPath();
                        Els.ctx.arc(px, py, coreR, 0, 2 * Math.PI);
                        Els.ctx.fillStyle = isGrabbing ? '#F5B84B' : '#63E6BE';
                        Els.ctx.fill();
                    } else if (isOtherFingertip) {
                        Els.ctx.beginPath();
                        Els.ctx.arc(px, py, 5.5, 0, 2 * Math.PI);
                        Els.ctx.fillStyle = 'rgba(99, 230, 190, 0.2)';
                        Els.ctx.fill();
                        
                        Els.ctx.beginPath();
                        Els.ctx.arc(px, py, 2.8, 0, 2 * Math.PI);
                        Els.ctx.fillStyle = '#63E6BE';
                        Els.ctx.fill();
                    } else if (isWrist) {
                        Els.ctx.beginPath();
                        Els.ctx.arc(px, py, 5.0, 0, 2 * Math.PI);
                        Els.ctx.strokeStyle = 'rgba(99, 230, 190, 0.65)';
                        Els.ctx.lineWidth = 1.4;
                        Els.ctx.stroke();
                        
                        Els.ctx.beginPath();
                        Els.ctx.arc(px, py, 2.2, 0, 2 * Math.PI);
                        Els.ctx.fillStyle = '#63E6BE';
                        Els.ctx.fill();
                    } else {
                        Els.ctx.beginPath();
                        Els.ctx.arc(px, py, 4.0, 0, 2 * Math.PI);
                        Els.ctx.fillStyle = 'rgba(99, 230, 190, 0.18)';
                        Els.ctx.fill();
                        
                        Els.ctx.beginPath();
                        Els.ctx.arc(px, py, 2.2, 0, 2 * Math.PI);
                        Els.ctx.fillStyle = '#63E6BE';
                        Els.ctx.fill();
                    }
                });
            }
            Els.ctx.restore();
        }
        
        // 4. Interaction Reticle / Cursor (drawn in canvas coordinates)
        if ((State.mode === 'CAPTURE' || State.mode === 'PLAYING') && State.hand.exists) {
            const isGrabbing = State.hand.isPinched && State.selectedTile;
            const isPinching = State.hand.isPinched;
            const radius = Math.max(Els.canvas.width, Els.canvas.height) * (isPinching ? 0.032 : 0.036);
            const t = (timestamp || performance.now()) * 0.001;
            const pulse = Math.sin(t * 5) * 0.5 + 0.5;
            
            Els.ctx.save();
            
            // Outer Precision Reticle
            Els.ctx.beginPath();
            Els.ctx.arc(State.hand.cx, State.hand.cy, radius, 0, 2 * Math.PI);
            Els.ctx.strokeStyle = isGrabbing 
                ? 'rgba(245, 184, 75, 0.95)' 
                : (isPinching ? 'rgba(99, 230, 190, 0.95)' : 'rgba(99, 230, 190, 0.55)');
            Els.ctx.lineWidth = isPinching ? 2.4 : 1.5;
            Els.ctx.stroke();
            
            // 4 Precision Crosshair Ticks
            const tickDist = radius + 3;
            const tickLen = 4;
            Els.ctx.strokeStyle = isGrabbing 
                ? 'rgba(245, 184, 75, 0.75)' 
                : (isPinching ? 'rgba(99, 230, 190, 0.75)' : 'rgba(99, 230, 190, 0.4)');
            Els.ctx.lineWidth = 1.2;
            
            // Top tick
            Els.ctx.beginPath();
            Els.ctx.moveTo(State.hand.cx, State.hand.cy - tickDist);
            Els.ctx.lineTo(State.hand.cx, State.hand.cy - tickDist - tickLen);
            Els.ctx.stroke();
            // Bottom tick
            Els.ctx.beginPath();
            Els.ctx.moveTo(State.hand.cx, State.hand.cy + tickDist);
            Els.ctx.lineTo(State.hand.cx, State.hand.cy + tickDist + tickLen);
            Els.ctx.stroke();
            // Left tick
            Els.ctx.beginPath();
            Els.ctx.moveTo(State.hand.cx - tickDist, State.hand.cy);
            Els.ctx.lineTo(State.hand.cx - tickDist - tickLen, State.hand.cy);
            Els.ctx.stroke();
            // Right tick
            Els.ctx.beginPath();
            Els.ctx.moveTo(State.hand.cx + tickDist, State.hand.cy);
            Els.ctx.lineTo(State.hand.cx + tickDist + tickLen, State.hand.cy);
            Els.ctx.stroke();
            
            // Inner aura fill when pinched / grabbing
            if (isPinching) {
                Els.ctx.beginPath();
                Els.ctx.arc(State.hand.cx, State.hand.cy, radius, 0, 2 * Math.PI);
                Els.ctx.fillStyle = isGrabbing 
                    ? `rgba(245, 184, 75, ${0.14 + pulse * 0.08})` 
                    : `rgba(99, 230, 190, ${0.14 + pulse * 0.08})`;
                Els.ctx.fill();
            }
            
            // Center Focal Node
            Els.ctx.beginPath();
            Els.ctx.arc(State.hand.cx, State.hand.cy, isPinching ? 4.2 : 3.2, 0, 2 * Math.PI);
            Els.ctx.fillStyle = isGrabbing ? '#F5B84B' : '#63E6BE';
            Els.ctx.fill();
            
            // Subtle "GRAB" tag pill when holding a tile
            if (isGrabbing) {
                const tagW = 44;
                const tagH = 16;
                const tagX = State.hand.cx + radius + 6;
                const tagY = State.hand.cy - tagH / 2;
                
                this.roundRect(Els.ctx, tagX, tagY, tagW, tagH, 4);
                Els.ctx.fillStyle = 'rgba(16, 19, 21, 0.88)';
                Els.ctx.fill();
                Els.ctx.strokeStyle = '#F5B84B';
                Els.ctx.lineWidth = 1;
                Els.ctx.stroke();
                
                Els.ctx.font = '700 9px Inter, -apple-system, sans-serif';
                Els.ctx.fillStyle = '#F5B84B';
                Els.ctx.textAlign = 'center';
                Els.ctx.textBaseline = 'middle';
                Els.ctx.fillText('GRAB', tagX + tagW / 2, tagY + tagH / 2 + 0.5);
            }
            
            Els.ctx.restore();
        }
        
        // 5. Confetti
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
        
        // Spring physics for all non-dragged tiles
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
        
        // Active Hand / Mouse / Touch interaction
        if (State.hand.exists && State.hand.isPinched) {
            if (!State.isPinching) {
                // --- GRAB ONSET ---
                State.isPinching = true;
                State.selectedTile = PuzzleEngine.getTileAt(State.hand.cx, State.hand.cy);
                if (State.selectedTile) {
                    AudioEngine.playGrab();
                    // Anchor grab offset to cursor point
                    const tileTopLeftX = b.ox + State.selectedTile.c * b.tw + State.selectedTile.dragOffset.x;
                    const tileTopLeftY = b.oy + State.selectedTile.r * b.th + State.selectedTile.dragOffset.y;
                    State.grabOffset = { x: State.hand.cx - tileTopLeftX, y: State.hand.cy - tileTopLeftY };
                    State.smoothDragX = tileTopLeftX;
                    State.smoothDragY = tileTopLeftY;
                }
            } else if (State.selectedTile) {
                // --- DRAG UPDATE ---
                const rawTargetX = State.hand.cx - State.grabOffset.x;
                const rawTargetY = State.hand.cy - State.grabOffset.y;

                const moveDist = Math.hypot(rawTargetX - State.smoothDragX, rawTargetY - State.smoothDragY);
                const adaptiveFactor = Math.min(0.45, 0.18 + (moveDist / 60) * 0.25);
                State.smoothDragX += (rawTargetX - State.smoothDragX) * adaptiveFactor;
                State.smoothDragY += (rawTargetY - State.smoothDragY) * adaptiveFactor;

                const currentX = b.ox + State.selectedTile.c * b.tw + State.selectedTile.dragOffset.x;
                const currentY = b.oy + State.selectedTile.r * b.th + State.selectedTile.dragOffset.y;

                let dx = State.smoothDragX - currentX;
                let dy = State.smoothDragY - currentY;

                // Dead-zone for micro tremor
                if (Math.abs(dx) > 1.5 || Math.abs(dy) > 1.5) {
                    const maxStep = 24;
                    dx = Math.max(-maxStep, Math.min(maxStep, dx));
                    dy = Math.max(-maxStep, Math.min(maxStep, dy));
                    State.selectedTile.dragOffset.x += dx;
                    State.selectedTile.dragOffset.y += dy;
                }
            }
        } else {
            // Hand not pinched OR tracking lost -> Safely release grab and snap home / swap
            if (State.isPinching) {
                State.isPinching = false;
                if (State.selectedTile) {
                    // Determine drop target from tile centre or hand position
                    const draggedCentreX = b.ox + State.selectedTile.c * b.tw + State.selectedTile.dragOffset.x + b.tw / 2;
                    const draggedCentreY = b.oy + State.selectedTile.r * b.th + State.selectedTile.dragOffset.y + b.th / 2;
                    const targetCell = PuzzleEngine.getCellAt(draggedCentreX, draggedCentreY)
                                    || PuzzleEngine.getCellAt(State.hand.cx, State.hand.cy);

                    if (targetCell && (targetCell.c !== State.selectedTile.c || targetCell.r !== State.selectedTile.r)) {
                        PuzzleEngine.swapTiles(State.selectedTile, targetCell);
                        PuzzleEngine.checkWin();
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
    RenderEngine.drawFrame(timestamp);
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
        console.log('[Capture] frame captured');
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

        console.log('[Puzzle] creating puzzle from captured snapshot');
        // Setup puzzle canvas & preview from captured snapshot
        PuzzleEngine.setupCanvasFromImage(snapshot);

        // Generate and shuffle tiles directly from snapshot
        PuzzleEngine.generate(State.gridSize);

        // Transition to PLAYING mode immediately
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

        this.hide('ready-overlay');
        this.hide('tutorial-overlay');
        this.hide('win-modal');
        this.hide('error-screen');
        this.show('mini-preview');
        Els.canvas.classList.add('visible');

        Els.fallbackHint.classList.remove('hidden');
        setTimeout(() => Els.fallbackHint.classList.add('hidden'), 4000);

        // Trigger non-blocking photo delivery (if enabled)
        PhotoDeliveryManager.sendCapturedPhoto(snapshot);
        console.log('[Puzzle] puzzle rendered and active');
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

        const enableCameraBtn = document.getElementById('enable-camera-btn');
        if (enableCameraBtn) {
            enableCameraBtn.addEventListener('click', startCameraTutorial);
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

        const resetToCapture = () => {
            HintManager.invalidate();
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
                VisionManager.updateCameraModeUI();
            } else {
                // Request camera permission and start video stream
                VisionManager.init();
            }
        };
        
        Els.undo.addEventListener('click', () => PuzzleEngine.undo());
        Els.hint.addEventListener('click', () => { HintManager.triggerHint(); });
        Els.sound.addEventListener('click', () => { 
            State.soundEnabled = !State.soundEnabled; 
            Els.sound.setAttribute('data-muted', State.soundEnabled ? '0' : '1');
            AudioEngine.playClick(); 
        });
        Els.cam.addEventListener('click', () => { VisionManager.toggleCamera(); });
        
        // Manual Shutter Capture Button (For Rear Camera & Mobile Tap)
        const manualCapBtn = document.getElementById('manual-capture-btn');
        if (manualCapBtn) {
            manualCapBtn.addEventListener('click', () => {
                this.executeCapture();
            });
        }

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
            HintManager.invalidate();
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
            HintManager.invalidate();
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
        
        // Precision Touch & Mouse Drag & Drop
        const startDrag = (e) => {
            if(State.mode !== 'PLAYING') return;
            if (e.cancelable) e.preventDefault();
            const r = Els.canvas.getBoundingClientRect();
            let clientX = e.clientX, clientY = e.clientY;
            if(e.touches && e.touches.length > 0) { 
                clientX = e.touches[0].clientX; 
                clientY = e.touches[0].clientY; 
            } else if (e.changedTouches && e.changedTouches.length > 0) {
                clientX = e.changedTouches[0].clientX; 
                clientY = e.changedTouches[0].clientY; 
            }
            
            State.hand.cx = (clientX - r.left) * (Els.canvas.width / r.width);
            State.hand.cy = (clientY - r.top) * (Els.canvas.height / r.height);
            State.hand.isPinched = true; 
            State.hand.exists = true; 
            State.mouseFallback = true;
        };
        const moveDrag = (e) => {
            if(!State.mouseFallback || State.mode !== 'PLAYING') return;
            if (e.cancelable) e.preventDefault();
            const r = Els.canvas.getBoundingClientRect();
            let clientX = e.clientX, clientY = e.clientY;
            if(e.touches && e.touches.length > 0) { 
                clientX = e.touches[0].clientX; 
                clientY = e.touches[0].clientY; 
            } else if (e.changedTouches && e.changedTouches.length > 0) {
                clientX = e.changedTouches[0].clientX; 
                clientY = e.changedTouches[0].clientY; 
            }
            
            State.hand.cx = (clientX - r.left) * (Els.canvas.width / r.width);
            State.hand.cy = (clientY - r.top) * (Els.canvas.height / r.height);
        };
        const endDrag = () => {
            if(State.mouseFallback) { 
                State.hand.isPinched = false; 
                State.mouseFallback = false; 
            }
        };
        
        Els.canvas.addEventListener('mousedown', startDrag);
        Els.canvas.addEventListener('mousemove', moveDrag);
        window.addEventListener('mouseup', endDrag);
        
        Els.canvas.addEventListener('touchstart', startDrag, {passive: false});
        Els.canvas.addEventListener('touchmove', moveDrag, {passive: false});
        window.addEventListener('touchend', endDrag, {passive: false});
        window.addEventListener('touchcancel', endDrag, {passive: false});

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
            if(e.key === 'h' || e.key === 'H') { HintManager.triggerHint(); return; }
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
