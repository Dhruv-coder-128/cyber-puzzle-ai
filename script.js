// --- NAMESPACES & STATE ---
const Config = {
    PINCH_HOLD_DURATION: 0.4,
    PINCH_START_THRESH: 0.04, 
    PINCH_RELEASE_THRESH: 0.06, 
    SPRING_STIFFNESS: 350,
    SPRING_DAMPING: 28,
};

const State = {
    mode: 'TUTORIAL', // TUTORIAL, INIT, CAPTURE, PLAYING, SOLVED, ERROR
    gridSize: 3,
    soundEnabled: true,
    cameraFacingMode: 'user',
    hintsEnabled: false,
    
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
    
    // Interaction
    isPinching: false,
    selectedTile: null,
    // grabOffset: distance from hand position to the tile's top-left corner in canvas px.
    // Using the exact grab point (not tile center) prevents the tile from snapping under the hand.
    grabOffset: {x: 0, y: 0},
    // Smoothed drag position (lerp target) to eliminate tremor jitter
    smoothDragX: 0,
    smoothDragY: 0,
    
    // Rendering & Metrics
    videoReady: false,
    capturedImageCanvas: null,
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
    fs: document.getElementById('fullscreen-btn'),
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
            document.getElementById('fps-display').innerText = `${State.fps} FPS`;
            State.frames = 0;
            State.fpsLastUpdate = timestamp;
        }
    },
    runStartupTests() {
        this.assert(typeof Hands !== 'undefined', "MediaPipe Hands loaded");
        this.assert(!!Els.ctx, "Canvas 2D API supported");
        this.assert(!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia), "getUserMedia API supported");
        this.assert(!!window.localStorage, "LocalStorage API supported");
    }
};

// --- AUDIO ENGINE (Procedural Web Audio) ---
const AudioEngine = {
    ctx: null,
    init() {
        if (!this.ctx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if(AudioContext) this.ctx = new AudioContext();
        }
        if(this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },
    playTone(freq, type, duration, vol=0.1) {
        if (!State.soundEnabled || !this.ctx) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        gain.gain.setValueAtTime(vol, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start();
        osc.stop(this.ctx.currentTime + duration);
    },
    playClick() { this.playTone(800, 'sine', 0.1, 0.1); },
    playGrab() { this.playTone(300, 'square', 0.1, 0.05); },
    playDrop() { this.playTone(400, 'sine', 0.15, 0.1); },
    playError() { this.playTone(150, 'sawtooth', 0.2, 0.1); },
    playWin() { 
        this.playTone(523.25, 'sine', 0.2, 0.2); // C5
        setTimeout(() => this.playTone(659.25, 'sine', 0.2, 0.2), 100); // E5
        setTimeout(() => this.playTone(783.99, 'sine', 0.4, 0.2), 200); // G5
    }
};

// --- STORAGE MANAGER ---
const StorageManager = {
    updateBestDisplay() {
        const best = State.bestScores[State.gridSize];
        Els.best.innerText = best ? `${best.moves}m` : '--';
    },
    saveBestScore(moves, time) {
        const current = State.bestScores[State.gridSize];
        let isNewBest = false;
        if (!current || moves < current.moves || (moves === current.moves && time < current.time)) {
            State.bestScores[State.gridSize] = { moves, time };
            localStorage.setItem('cyberPuzzle_best', JSON.stringify(State.bestScores));
            isNewBest = true;
        }
        this.updateBestDisplay();
        return isNewBest;
    }
};

// --- CAMERA & VISION MANAGER ---
let latestResults = null;
const VisionManager = {
    hands: null,
    videoLoopId: null,
    async init() {
        // locateFile: pinned to the same version as the <script> tag in index.html
        // so WASM binaries and the JS wrapper always come from the exact same package.
        this.hands = new Hands({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/${f}` });
        this.hands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.7, minTrackingConfidence: 0.7 });
        this.hands.onResults(results => this.onResults(results));
        await this.startCamera();
    },
    async startCamera() {
        if (Els.video.srcObject) {
            Els.video.srcObject.getTracks().forEach(t => t.stop());
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: 1280, height: 720, facingMode: State.cameraFacingMode }
            });
            Els.video.srcObject = stream;
            
            // Wait for metadata to ensure video dimensions are known
            await new Promise((resolve) => {
                Els.video.onloadedmetadata = () => {
                    resolve();
                };
            });
            
            Els.video.play();
            
            // Ensure canvas is resized to match video perfectly
            Els.canvas.width = Els.video.videoWidth;
            Els.canvas.height = Els.video.videoHeight;
            
            let lastVideoTime = -1;
            const processFrame = async () => {
                if (Els.video.currentTime !== lastVideoTime && !Els.video.paused && !Els.video.ended) {
                    lastVideoTime = Els.video.currentTime;
                    await this.hands.send({image: Els.video});
                }
                if(Els.video.srcObject) this.videoLoopId = requestAnimationFrame(processFrame);
            };
            if(this.videoLoopId) cancelAnimationFrame(this.videoLoopId);
            this.videoLoopId = requestAnimationFrame(processFrame);
            
            UIManager.show('capture-instruction');
            UIManager.hide('loading-indicator');
            UIManager.hide('error-screen');
            Els.video.classList.remove('hidden'); // Fix 1: Ensure video is visible immediately
            Els.canvas.classList.add('visible');
            State.videoReady = true;
            if(State.mode === 'INIT' || State.mode === 'TUTORIAL') State.mode = 'CAPTURE';
            QATester.assert(true, `Camera started (${State.cameraFacingMode})`);
        } catch(e) {
            console.error(e);
            UIManager.hide('loading-indicator');
            UIManager.show('error-screen');
            document.getElementById('error-msg').innerText = e.message;
            QATester.assert(false, "Camera permissions denied");
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

// --- PUZZLE ENGINE (Drag & Drop Swap) ---
const PuzzleEngine = {
    getBoardBounds() {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        // Board width 70vmin desktop, 92vw mobile
        let size = Math.min(vw, vh) * 0.7;
        if (vw < 768) size = vw * 0.92;
        
        // ensure canvas has the correct coordinate space mapped to css
        const rect = Els.canvas.getBoundingClientRect();
        
        // Map the CSS size into the Canvas logical space
        const scaleX = Els.canvas.width / rect.width;
        const sizeInCanvas = size * scaleX;
        
        const ox = (Els.canvas.width - sizeInCanvas) / 2;
        const oy = (Els.canvas.height - sizeInCanvas) / 2;
        
        return { size: sizeInCanvas, ox, oy, tw: sizeInCanvas / State.gridSize, th: sizeInCanvas / State.gridSize };
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
        if(!State.capturedImageCanvas) return;
        const b = this.getBoardBounds();
        
        State.tiles.forEach(tile => {
            tile.canvas = document.createElement('canvas');
            tile.canvas.width = b.tw; tile.canvas.height = b.th;
            const ctx = tile.canvas.getContext('2d');
            const sx = b.ox + tile.origC * b.tw;
            const sy = b.oy + tile.origR * b.th;
            ctx.drawImage(State.capturedImageCanvas, sx, sy, b.tw, b.th, 0, 0, b.tw, b.th);
        });
    },
    shuffle() {
        // Free swap puzzle doesn't need to step backwards for solvability. Any permutation is solvable.
        for (let i = State.tiles.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tempC = State.tiles[i].c;
            const tempR = State.tiles[i].r;
            State.tiles[i].c = State.tiles[j].c;
            State.tiles[i].r = State.tiles[j].r;
            State.tiles[j].c = tempC;
            State.tiles[j].r = tempR;
        }
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
                color: ['#FFFFFF', '#7DD3FC', '#E2E8F0', '#94A3B8'][Math.floor(Math.random() * 4)],
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
        if ((State.mode === 'PLAYING' || State.mode === 'SOLVED') && State.capturedImageCanvas) {
            const b = PuzzleEngine.getBoardBounds();
            const pad = 4;
            
            // Draw glass background behind the board
            Els.ctx.save();
            this.roundRect(Els.ctx, b.ox - 10, b.oy - 10, b.size + 20, b.size + 20, 24);
            Els.ctx.fillStyle = 'rgba(11, 13, 16, 0.4)';
            Els.ctx.fill();
            Els.ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
            Els.ctx.lineWidth = 1;
            Els.ctx.stroke();
            Els.ctx.restore();
            
            // Draw Target Highlight if dragging
            if (State.isPinching && State.selectedTile && State.hand.exists) {
                const targetCell = PuzzleEngine.getCellAt(State.hand.cx, State.hand.cy);
                if (targetCell) {
                    Els.ctx.save();
                    this.roundRect(Els.ctx, b.ox + targetCell.c * b.tw + pad, b.oy + targetCell.r * b.th + pad, b.tw - pad*2, b.th - pad*2, 16);
                    Els.ctx.fillStyle = 'rgba(125, 211, 252, 0.2)';
                    Els.ctx.fill();
                    Els.ctx.strokeStyle = '#7DD3FC';
                    Els.ctx.lineWidth = 2;
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
                Els.ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
                Els.ctx.shadowBlur = isSelected ? 32 : 12;
                Els.ctx.shadowOffsetY = isSelected ? 16 : 4;
                
                // Lift effect scale
                if (isSelected) {
                    Els.ctx.translate(dx + b.tw/2, dy + b.th/2);
                    Els.ctx.scale(1.05, 1.05);
                    Els.ctx.translate(-(dx + b.tw/2), -(dy + b.th/2));
                }
                
                this.roundRect(Els.ctx, dx + pad, dy + pad, b.tw - pad*2, b.th - pad*2, 16);
                Els.ctx.fillStyle = '#0B0D10'; 
                Els.ctx.fill();
                Els.ctx.shadowColor = 'transparent';
                
                Els.ctx.clip();
                if(t.canvas) {
                    Els.ctx.drawImage(t.canvas, dx, dy, b.tw, b.th);
                }
                
                Els.ctx.strokeStyle = (State.hintsEnabled && t.c === t.origC && t.r === t.origR) ? 'rgba(125, 211, 252, 0.6)' : 'rgba(255, 255, 255, 0.15)';
                Els.ctx.lineWidth = 1.5; Els.ctx.stroke();
                Els.ctx.restore();
            });
        }
        
        // 3. Hands & Interaction
        if (latestResults && latestResults.multiHandLandmarks) {
            Els.ctx.save();
            if (State.cameraFacingMode === 'user') {
                Els.ctx.translate(Els.canvas.width, 0);
                Els.ctx.scale(-1, 1);
            }
            for (const lm of latestResults.multiHandLandmarks) {
                if (typeof drawConnectors !== 'undefined') {
                    drawConnectors(Els.ctx, lm, HAND_CONNECTIONS, {color: 'rgba(255, 255, 255, 0.2)', lineWidth: 1});
                }
                lm.forEach(pt => {
                    Els.ctx.beginPath();
                    Els.ctx.arc(pt.x * Els.canvas.width, pt.y * Els.canvas.height, 6, 0, 2*Math.PI);
                    Els.ctx.fillStyle = 'rgba(125, 211, 252, 0.2)'; Els.ctx.fill();
                    Els.ctx.beginPath();
                    Els.ctx.arc(pt.x * Els.canvas.width, pt.y * Els.canvas.height, 2.5, 0, 2*Math.PI);
                    Els.ctx.fillStyle = '#FFFFFF'; Els.ctx.fill();
                });
            }
            Els.ctx.restore();
        }
        
        if ((State.mode === 'CAPTURE' || State.mode === 'PLAYING') && State.hand.exists) {
            const threshold = Math.max(Els.canvas.width, Els.canvas.height) * 0.04;
            Els.ctx.beginPath();
            Els.ctx.arc(State.hand.cx, State.hand.cy, threshold, 0, 2*Math.PI);
            Els.ctx.strokeStyle = State.hand.isPinched ? 'rgba(255, 255, 255, 0.9)' : 'rgba(255, 255, 255, 0.2)';
            Els.ctx.lineWidth = State.hand.isPinched ? 3 : 1;
            Els.ctx.stroke();
            Els.ctx.beginPath();
            Els.ctx.arc(State.hand.cx, State.hand.cy, 3, 0, 2*Math.PI);
            Els.ctx.fillStyle = State.hand.isPinched ? '#F5F5F3' : 'rgba(255, 255, 255, 0.4)';
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

// --- MAIN LOOP ---
function gameLoop(timestamp) {
    if(!State.lastTime) State.lastTime = timestamp;
    const dt = Math.min((timestamp - State.lastTime) / 1000, 0.1);
    State.lastTime = timestamp;
    
    QATester.updateFPS(timestamp);
    
    if (Els.video.videoWidth && (Els.canvas.width !== Els.video.videoWidth || Els.canvas.height !== Els.video.videoHeight)) {
        Els.canvas.width = Els.video.videoWidth;
        Els.canvas.height = Els.video.videoHeight;
    }
    
    updateLogic(dt);
    RenderEngine.drawFrame();
    requestAnimationFrame(gameLoop);
}

// --- UI MANAGER ---
const UIManager = {
    show(id) { document.getElementById(id).classList.remove('hidden'); },
    hide(id) { document.getElementById(id).classList.add('hidden'); },
    updateStats() {
        Els.move.innerText = State.moves;
    },
    executeCapture() {
        AudioEngine.init();
        AudioEngine.playClick();
        this.hide('capture-instruction');
        
        // Capture snapshot
        State.capturedImageCanvas = document.createElement('canvas');
        State.capturedImageCanvas.width = Els.canvas.width; State.capturedImageCanvas.height = Els.canvas.height;
        const ctx = State.capturedImageCanvas.getContext('2d');
        if (State.cameraFacingMode === 'user') { ctx.translate(Els.canvas.width, 0); ctx.scale(-1, 1); }
        ctx.drawImage(Els.video, 0, 0, Els.canvas.width, Els.canvas.height);
        
        // Setup Mini Preview
        Els.previewCanvas.width = State.capturedImageCanvas.width;
        Els.previewCanvas.height = State.capturedImageCanvas.height;
        Els.previewCanvas.getContext('2d').drawImage(State.capturedImageCanvas, 0, 0);
        this.show('mini-preview');
        
        PuzzleEngine.generate(parseInt(Els.difficulty.value) || 3);
        Els.fallbackHint.classList.remove('hidden');
        setTimeout(() => Els.fallbackHint.classList.add('hidden'), 4000);
        
        State.elapsed = 0;
        clearInterval(State.timerInterval);
        State.startTime = Date.now();
        State.timerInterval = setInterval(() => {
            State.elapsed = Math.floor((Date.now() - State.startTime) / 1000);
            const m = Math.floor(State.elapsed / 60).toString().padStart(2, '0');
            const s = (State.elapsed % 60).toString().padStart(2, '0');
            Els.time.innerText = `${m}:${s}`;
        }, 1000);
        
        State.mode = 'PLAYING';
    },
    showWinScreen(isNewBest) {
        document.getElementById('win-time').innerText = Els.time.innerText;
        document.getElementById('win-moves').innerText = State.moves;
        if(isNewBest) this.show('achievement-banner'); else this.hide('achievement-banner');
        this.show('win-modal');
        this.hide('mini-preview');
    },
    bindEvents() {
        document.getElementById('start-tutorial-btn').addEventListener('click', () => {
            AudioEngine.init(); AudioEngine.playClick();
            this.hide('tutorial-overlay'); this.show('loading-indicator');
            VisionManager.init();
        });
        document.getElementById('debug-toggle-btn').addEventListener('click', () => {
            document.getElementById('debug-panel').classList.toggle('hidden');
        });
        document.getElementById('retry-cam-btn').addEventListener('click', () => {
            this.show('loading-indicator'); VisionManager.init();
        });
        
        const resetToCapture = () => {
            AudioEngine.playClick();
            this.hide('win-modal'); this.hide('mini-preview'); this.show('capture-instruction');
            State.mode = 'CAPTURE'; clearInterval(State.timerInterval); Els.time.innerText = '00:00';
            State.moves = 0; this.updateStats(); State.hand.pinchTime = 0;
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
            if(!document.fullscreenElement) document.documentElement.requestFullscreen();
            else document.exitFullscreen();
        });
        
        document.getElementById('new-capture-btn').addEventListener('click', resetToCapture);
        document.getElementById('win-new-capture-btn').addEventListener('click', resetToCapture);
        
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
            }
        };
        document.getElementById('restart-btn').addEventListener('click', restartGame);
        document.getElementById('play-again-btn').addEventListener('click', restartGame);
        Els.difficulty.addEventListener('change', () => {
            AudioEngine.playClick();
            StorageManager.updateBestDisplay();
            if(State.mode === 'PLAYING' || State.mode === 'SOLVED') {
                PuzzleEngine.generate(parseInt(Els.difficulty.value) || 3);
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
            const r = Els.canvas.getBoundingClientRect();
            let clientX = e.clientX, clientY = e.clientY;
            if(e.touches && e.touches.length > 0) { clientX = e.touches[0].clientX; clientY = e.touches[0].clientY; }
            
            State.hand.cx = (clientX - r.left) * (Els.canvas.width / r.width);
            State.hand.cy = (clientY - r.top) * (Els.canvas.height / r.height);
            State.hand.isPinched = true; State.hand.exists = true; State.mouseFallback = true;
        };
        const moveDrag = (e) => {
            if(!State.mouseFallback) return;
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
        
        Els.canvas.addEventListener('touchstart', startDrag, {passive: true});
        Els.canvas.addEventListener('touchmove', moveDrag, {passive: true});
        window.addEventListener('touchend', endDrag);
        
        document.addEventListener('keydown', e => {
            if(e.key === 'z' || e.key === 'Z') { PuzzleEngine.undo(); return; }
            if(e.key === 'h' || e.key === 'H') { State.hintsEnabled = !State.hintsEnabled; return; }
        });
    }
};

// --- BOOTSTRAP ---
QATester.runStartupTests();
StorageManager.updateBestDisplay();
UIManager.bindEvents();
requestAnimationFrame(gameLoop);
