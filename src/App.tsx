/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { 
  Compass, 
  Award, 
  AlertTriangle, 
  Info, 
  Crosshair, 
  Shield, 
  RefreshCw 
} from 'lucide-react';
import { GameApp } from './game/app';
import { NoaEngineAdapter } from './engine/noa-adapter';
import { gameState } from './game/game-state';
import { BlockDefinition } from './types';
import { ModLoader } from './modding/mod-loader';
import { ModRegistry } from './modding/mod-registry';
import { AudioService } from './audio/audio-service';
import VisualTuningConsole from './components/VisualTuningConsole';
import { PolygonWorldService, POLYGON_STATIONS } from './world/polygon-world-service';
import { WorldService } from './world/world-service';

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameAppRef = useRef<GameApp | null>(null);
  const adapterRef = useRef<NoaEngineAdapter | null>(null);

  // Game mode: 'menu' | 'play' | 'polygon'
  const [gameMode, setGameMode] = useState<'menu' | 'play' | 'polygon'>('menu');

  // Core visual state bindings
  const [playerPos, setPlayerPos] = useState<[number, number, number]>([0, 15, 0]);
  const [playerYaw, setPlayerYaw] = useState<number>(0);
  const [targetedBlockInfo, setTargetedBlockInfo] = useState<string>('None');

  // Initialize GameApp singleton
  if (!gameAppRef.current) {
    gameAppRef.current = new GameApp();
  }

  const gameApp = gameAppRef.current;

  const [selectedBlockId, setSelectedBlockId] = useState<number>(() => gameApp.playerService.getSelectedBlockId());
  const [hotbar, setHotbar] = useState<number[]>(() => gameApp.playerService.getHotbar());
  const [isArtifactRecovered, setIsArtifactRecovered] = useState<boolean>(false);
  const [isExtracted, setIsExtracted] = useState<boolean>(false);
  const [hudAlerts, setHudAlerts] = useState<{ id: string; msg: string; status: string }[]>([]);
  const [isControlsLocked, setIsControlsLocked] = useState<boolean>(false);
  // UI state — split from controlsLocked so the world renders regardless of pointer lock.
  const [pauseMenuOpen, setPauseMenuOpen] = useState<boolean>(false);
  const [debugMenuOpen, setDebugMenuOpen] = useState<boolean>(false);
  const [helpOpen, setHelpOpen] = useState<boolean>(false);
  const [engineReady, setEngineReady] = useState<boolean>(false);
  // QA mode: ?qa=1 starts with debug overlay open and no blocking activation card.
  const [qaMode] = useState<boolean>(() => {
    try {
      return new URLSearchParams(window.location.search).get('qa') === '1';
    } catch {
      return false;
    }
  });
  // Visual sanity mode: ?visualSanity=1 starts with debug open + fog/glow minimized.
  const [visualSanityMode] = useState<boolean>(() => {
    try {
      return new URLSearchParams(window.location.search).get('visualSanity') === '1';
    } catch {
      return false;
    }
  });

  // Mod loading state bindings
  const [isModsLoaded, setIsModsLoaded] = useState<boolean>(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<{ message: string; stack?: string } | null>(null);
  const [activeTheme, setActiveTheme] = useState<{ accentColor?: string; panelOpacity?: number; fontScale?: number }>({});

  // Global Error Handlers for visible crash diagnostics
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      console.error("[Global Error Handled]:", event.error);
      setRuntimeError({
        message: event.message || "An unexpected runtime error occurred.",
        stack: event.error?.stack
      });
    };

    const handleRejection = (event: PromiseRejectionEvent) => {
      console.error("[Global Promise Rejection Handled]:", event.reason);
      const reason = event.reason;
      setRuntimeError({
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined
      });
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);

    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, []);

  // Load Creator Mods on Mount
  useEffect(() => {
    const bootstrapMods = async () => {
      try {
        const loader = new ModLoader();
        await loader.loadAllActiveMods();
        setActiveTheme({ ...ModRegistry.getInstance().getActiveUiTheme() });
      } catch (e) {
        console.warn('[App] Error during creator mod compounding layout:', e);
      } finally {
        setIsModsLoaded(true);
      }
    };
    bootstrapMods();
  }, []);

  // Real-time throttled polling (12.5 Hz) for compass angle + targeted bounds
  useEffect(() => {
    let intervalId: number;
    let lastYaw = -999;
    let lastBlockInfo = '';

    const updateUIState = () => {
      const currentYaw = gameState.playerYaw;
      const currentBlockInfo = gameState.targetedBlockInfo;

      const yawDiff = Math.abs(currentYaw - lastYaw);
      const blockChanged = currentBlockInfo !== lastBlockInfo;

      if (yawDiff > 1.0 || blockChanged) {
        setPlayerYaw(currentYaw);
        lastYaw = currentYaw;
      }
      if (blockChanged) {
        setTargetedBlockInfo(currentBlockInfo);
        lastBlockInfo = currentBlockInfo;
      }

      // Sync pointer lock state dynamically inside loop as fallback heartbeat
      const isLocked = !!document.pointerLockElement;
      setIsControlsLocked((prev) => {
        if (prev !== isLocked) {
          console.log(`[UI] Controls sync fallback: locked=${isLocked}`);
          return isLocked;
        }
        return prev;
      });
    };

    intervalId = window.setInterval(updateUIState, 80);
    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  // Main game lifecycle — runs when gameMode changes to 'play' or 'polygon'
  useEffect(() => {
    if (!isModsLoaded) return;
    if (gameMode === 'menu') return;

    console.log("[App] Mods loaded, starting GameApp...");

    // 1. Start GameApp lifecycle loop
    try {
      gameApp.start();
    } catch (e) {
      console.error("[App] Failed to start GameApp lifecycle loop:", e);
      setBootError(e instanceof Error ? `${e.message}\n${e.stack || ""}` : String(e));
      return;
    }

    // 2. Mount Noa Engine
    if (containerRef.current && !adapterRef.current) {
      try {
        console.log(`[App] Mounting NoaEngineAdapter (mode=${gameMode})...`);
        // For polygon mode, create a PolygonWorldService
        const ws = gameMode === 'polygon'
          ? new PolygonWorldService() as unknown as WorldService
          : gameApp.worldService;
        adapterRef.current = new NoaEngineAdapter(
          containerRef.current,
          gameApp.playerService,
          ws,
          gameApp.blockService,
          gameApp.missionService,
          gameApp.uiService,
          gameMode === 'polygon' ? 'polygon' : 'play'
        );
        console.log("[App] NoaEngineAdapter mounted successfully.");
        setBootError(null);
        setEngineReady(true);
        if (qaMode || visualSanityMode) {
          setDebugMenuOpen(true);
          console.log("[App] QA/visualSanity mode active — debug overlay open, no activation blocker.");
        }
      } catch (error) {
        console.error("[App] Engine boot failed:", error);
        setBootError(error instanceof Error ? `${error.message}\n${error.stack || ""}` : String(error));
      }
    }

    // 3. Register state sync listeners
    const unsubPlayer = gameApp.playerService.registerOnUpdate(() => {
      setPlayerPos([...gameApp.playerService.getPosition()]);
      setSelectedBlockId(gameApp.playerService.getSelectedBlockId());
      setHotbar([...gameApp.playerService.getHotbar()]);
    });

    const unsubMission = gameApp.missionService.registerOnStateChange(() => {
      setIsArtifactRecovered(gameApp.missionService.isArtifactRecovered());
      setIsExtracted(gameApp.missionService.isExtracted());
    });

    const unsubUi = gameApp.uiService.registerAlertHandler((msg, status) => {
      const id = Math.random().toString(36).substring(2, 9);
      setHudAlerts((prev) => [{ id, msg, status }, ...prev.slice(0, 4)]);

      // Auto dismiss alert
      setTimeout(() => {
        setHudAlerts((prev) => prev.filter((a) => a.id !== id));
      }, 4000);
    });

    // 4. Track pointer lock states with robust feedback logging
    const handlePointerLockChange = () => {
      const isLocked = !!document.pointerLockElement;
      console.log(`[UI] Controls ${isLocked ? 'locked' : 'unlocked'}`);
      setIsControlsLocked(isLocked);
      // When pointer lock is released, open the pause menu (unless QA mode).
      if (!isLocked && !qaMode && !visualSanityMode) {
        setPauseMenuOpen(true);
      }
      // When pointer lock engages, close pause menu.
      if (isLocked) {
        setPauseMenuOpen(false);
      }
    };

    document.addEventListener('pointerlockchange', handlePointerLockChange);

    // 5. Global keyboard shortcuts: Esc=menu, F1=help, F3=debug.
    // These work WITHOUT pointer lock so the player can inspect the world
    // before clicking to capture the mouse.
    const handleGlobalKeys = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (document.pointerLockElement) {
          // Release pointer lock — pointerlockchange handler will open the menu.
          document.exitPointerLock();
        } else {
          setPauseMenuOpen((prev) => !prev);
        }
      } else if (e.key === 'F1') {
        e.preventDefault();
        setHelpOpen((prev) => !prev);
      } else if (e.key === 'F3') {
        e.preventDefault();
        setDebugMenuOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleGlobalKeys);

    return () => {
      gameApp.stop();
      if (adapterRef.current) {
        adapterRef.current.destroy();
        adapterRef.current = null;
      }
      unsubPlayer();
      unsubMission();
      unsubUi();
      document.removeEventListener('pointerlockchange', handlePointerLockChange);
      window.removeEventListener('keydown', handleGlobalKeys);
    };
  }, [isModsLoaded, gameApp, qaMode, visualSanityMode, gameMode]);

  // Request Pointer Lock safely
  const requestLock = () => {
    // Unlock and start synthesized sounds upon user interaction gesture
    try {
      AudioService.getInstance().unlock();
    } catch (e) {
      console.warn('[App] Audio unlock error:', e);
    }

    const canvas = adapterRef.current?.getEngine()?.container?.canvas;
    if (canvas) {
      try {
        const promise = canvas.requestPointerLock() as any;
        if (promise && typeof promise.catch === "function") {
          promise.catch((err: any) => {
            console.warn("[App] Pointer lock request rejected safely:", err);
          });
        }
      } catch (err) {
        console.warn("[App] Pointer lock failed with synchronous exception:", err);
      }
    }
  };

  const handleDeployAgain = () => {
    gameApp.restartRaid();
    
    // Teleport player back to spawn
    const engine = adapterRef.current?.getEngine();
    if (engine) {
      engine.entities.setPosition(engine.playerEntity, [0, 15, 0]);
    }
    
    // Re-lock mouse
    setTimeout(requestLock, 100);
  };

  // Helper selectors
  const getBlockById = (id: number): BlockDefinition | undefined => {
    return gameApp.blockService.getBlock(id);
  };

  const currentBlockDef = getBlockById(selectedBlockId);

  // COMPASS CALCULATIONS (Priority 7)
  const getCardinalDirection = (yaw: number): string => {
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const index = Math.round(((yaw % 360) / 45)) % 8;
    return directions[index < 0 ? index + 8 : index];
  };

  const cardinal = getCardinalDirection(playerYaw);
  const formattedYaw = Math.floor(playerYaw);

  // Bearing bearing and target marker to Ruins ancient artifacts at [-20, 14, -20]
  const rx = -20;
  const rz = -20;
  const px = playerPos[0];
  const pz = playerPos[2];
  
  const dx = rx - px;
  const dz = rz - pz;
  const distToRuin = Math.floor(Math.sqrt(dx * dx + dz * dz));
  const rad = Math.atan2(dx, dz);
  let bearing = (rad * 180 / Math.PI);
  if (bearing < 0) bearing += 360;
  
  const relativeAngle = (bearing - playerYaw + 360) % 360;

  let ruinIndicator = '▲ RUIN';
  if (relativeAngle > 15 && relativeAngle <= 165) ruinIndicator = 'RUIN ▶';
  else if (relativeAngle > 165 && relativeAngle <= 195) ruinIndicator = '▼ RUIN (BEHIND)';
  else if (relativeAngle > 195 && relativeAngle < 345) ruinIndicator = '◀ RUIN';

  // Dynamic biome detector matching world-service equations
  const isBlackGlassZone = gameApp.worldService.isBlackGlassZone(px, pz);
  const currentBiome = isBlackGlassZone ? 'Black Glass Canyon' : 'Red Wasteland';

  // Extract modding active UI themes
  const uiAccent = activeTheme.accentColor || '#00f2ff';
  const uiOpacity = activeTheme.panelOpacity !== undefined ? activeTheme.panelOpacity : 0.6;
  const uiFontScale = activeTheme.fontScale !== undefined ? activeTheme.fontScale : 1.0;

  // Return to main menu — destroys engine, resets state
  const returnToMenu = () => {
    if (adapterRef.current) {
      adapterRef.current.destroy();
      adapterRef.current = null;
    }
    setEngineReady(false);
    setPauseMenuOpen(false);
    setDebugMenuOpen(false);
    setHelpOpen(false);
    setGameMode('menu');
  };

  // ---- MAIN MENU ----
  if (gameMode === 'menu' && !bootError) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#0a0a0c] text-white font-sans select-none">
        <div className="text-center space-y-8">
          <div>
            <h1 className="text-5xl font-black tracking-tight uppercase">
              FRONTIER <span className="text-[#00f2ff]">PLANET</span>
            </h1>
            <p className="text-xs font-mono text-white/40 tracking-widest uppercase mt-2">
              Voxel Sci-Fi Extraction Survival RPG
            </p>
          </div>
          <div className="flex flex-col gap-3 w-64">
            <button
              onClick={() => setGameMode('play')}
              className="bg-[#ff6600] hover:bg-[#ff8533] active:scale-95 border border-orange-400 px-8 py-3 rounded text-sm font-black tracking-widest text-slate-950 shadow-[0_0_20px_rgba(255,102,0,0.3)] flex items-center justify-center gap-2 cursor-pointer transition-all uppercase"
            >
              <Crosshair className="w-4 h-4" />
              Play Game
            </button>
            <button
              onClick={() => setGameMode('polygon')}
              className="bg-[#00f2ff]/20 hover:bg-[#00f2ff]/30 active:scale-95 border border-[#00f2ff]/40 px-8 py-3 rounded text-sm font-black tracking-widest text-[#00f2ff] shadow-[0_0_15px_rgba(0,242,255,0.2)] flex items-center justify-center gap-2 cursor-pointer transition-all uppercase"
            >
              <Shield className="w-4 h-4" />
              Polygon (Test Mode)
            </button>
            <button
              disabled
              className="bg-white/5 border border-white/10 px-8 py-3 rounded text-sm font-black tracking-widest text-white/30 cursor-not-allowed uppercase"
            >
              Creator Mode (Coming Later)
            </button>
            <button
              onClick={() => {
                // In Electron, this would quit. In browser, just show a message.
                if (typeof require !== 'undefined') {
                  try { require('electron').remote.app.quit(); } catch { /* ignore */ }
                }
                alert('Quit unavailable in browser. Close the tab to exit.');
              }}
              className="bg-white/5 hover:bg-white/10 border border-white/10 px-8 py-2 rounded text-xs font-bold tracking-widest text-white/50 cursor-pointer transition-all uppercase"
            >
              Quit
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-zinc-950 p-6 text-white font-mono select-text">
        <div className="max-w-2xl w-full bg-red-950/40 border border-red-500/30 p-6 rounded-lg shadow-2xl space-y-4">
          <div className="flex items-center gap-3 border-b border-red-500/20 pb-3">
            <span className="w-3 h-3 bg-red-500 rounded-full animate-ping" />
            <h2 className="text-lg font-black text-red-400 uppercase tracking-wider">CRITICAL SYSTEM BOOT CRASH</h2>
          </div>
          <div className="space-y-2">
            <p className="text-zinc-300 text-sm font-semibold">The voxel engine failed to initialize with the following diagnostic trace:</p>
            <pre className="bg-black/60 p-4 rounded border border-white/5 text-[11px] text-red-200 overflow-auto max-h-60 whitespace-pre-wrap leading-relaxed select-text">
              {bootError}
            </pre>
          </div>
          <div className="pt-2 flex justify-end">
            <button 
              id="retry-boot-button"
              onClick={() => {
                setBootError(null);
                setIsModsLoaded(false);
                setTimeout(() => setIsModsLoaded(true), 100);
              }}
              className="bg-red-600 hover:bg-red-500 text-white text-xs px-5 py-2.5 rounded font-black tracking-widest uppercase transition-colors outline-none cursor-pointer"
            >
              Retry Boot Sequence
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div id="frontier-planet-root" className="relative w-screen h-screen overflow-hidden bg-[#0a0a0c] text-[#e0e0e0] font-sans select-none" style={{ fontSize: `${uiFontScale}rem` }}>
      
      {/* 3D Game Canvas mount point */}
      <div ref={containerRef} className="absolute inset-0 w-full h-full z-0" />

      {/* Futuristic CRT Atmospheric Scanlines Overlay */}
      <div 
        className="absolute inset-0 pointer-events-none z-10 opacity-10" 
        style={{
          background: 'linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.25) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.05), rgba(0, 255, 0, 0.02), rgba(0, 0, 255, 0.05))',
          backgroundSize: '100% 2px, 3px 100%'
        }} 
      />

      {/* --- STATIC PERFECTLY CENTERED CROSSHAIR (Priority 2) --- */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-30 flex items-center justify-center w-10 h-10 opacity-70">
        <div className="w-3.5 h-[1px] bg-[#00f2ff] absolute -left-4 top-1/2 -translate-y-1/2" />
        <div className="w-3.5 h-[1px] bg-[#00f2ff] absolute -right-4 top-1/2 -translate-y-1/2" />
        <div className="h-3.5 w-[1px] bg-[#00f2ff] absolute top-[-14px] left-1/2 -translate-x-1/2" />
        <div className="h-3.5 w-[1px] bg-[#00f2ff] absolute bottom-[-14px] left-1/2 -translate-x-1/2" />
        <div className="w-1.5 h-1.5 rounded-full bg-[#00f2ff]" />
      </div>

      {/* --- SMALL NON-BLOCKING MOUSE-CAPTURE PROMPT (Pass 3) ---
          The world renders behind this. Clicking only captures the mouse /
          unlocks audio — it does NOT start or restart the engine. */}
      {engineReady && !isControlsLocked && !pauseMenuOpen && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center gap-2 pointer-events-auto">
          <button
            onClick={requestLock}
            className="bg-[#ff6600]/90 hover:bg-[#ff8533] active:scale-95 border border-orange-400/60 px-4 py-2 rounded text-[10px] font-black tracking-widest text-slate-950 shadow-[0_0_15px_rgba(255,102,0,0.3)] flex items-center gap-1.5 cursor-pointer transition-all uppercase"
          >
            <Crosshair className="w-3 h-3" />
            Click to capture mouse
          </button>
          <div className="text-[8px] font-mono text-white/40 tracking-wider flex gap-3">
            <span>ESC: menu</span>
            <span>F1: controls</span>
            <span>F3: debug</span>
          </div>
        </div>
      )}

      {/* --- HELP / CONTROLS OVERLAY (F1) --- */}
      {helpOpen && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm pointer-events-auto" onClick={() => setHelpOpen(false)}>
          <div className="bg-zinc-950/95 border border-white/15 p-6 rounded-lg shadow-2xl max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-white/10 pb-3 mb-3">
              <h2 className="text-sm font-black tracking-widest text-[#00f2ff] uppercase">Movement Control Manual</h2>
              <button onClick={() => setHelpOpen(false)} className="text-white/40 hover:text-white text-xs">✕</button>
            </div>
            <div className="text-[10px] font-mono text-white/70 space-y-1.5">
              <p className="flex justify-between"><span className="text-white/40">HELM:</span><span className="text-white">W A S D Keys</span></p>
              <p className="flex justify-between"><span className="text-white/40">SPRINT:</span><span className="text-white">SHIFT Key</span></p>
              <p className="flex justify-between"><span className="text-white/40">JUMP:</span><span className="text-white">SPACE (Double Jump)</span></p>
              <p className="flex justify-between"><span className="text-white/40">EXCAVATE:</span><span className="text-[#00f2ff]">LMB Click</span></p>
              <p className="flex justify-between"><span className="text-white/40">PLACE BLOCK:</span><span className="text-orange-400">RMB Click</span></p>
              <p className="flex justify-between"><span className="text-white/40">SLOTS [1 - 8]:</span><span className="text-yellow-400">Select block</span></p>
              <div className="border-t border-white/10 mt-3 pt-3 space-y-1.5">
                <p className="flex justify-between"><span className="text-white/40">MOUSE CAPTURE:</span><span className="text-white">Click canvas</span></p>
                <p className="flex justify-between"><span className="text-white/40">PAUSE MENU:</span><span className="text-white">ESC</span></p>
                <p className="flex justify-between"><span className="text-white/40">CONTROLS HELP:</span><span className="text-white">F1</span></p>
                <p className="flex justify-between"><span className="text-white/40">DEBUG OVERLAY:</span><span className="text-white">F3</span></p>
                <p className="flex justify-between"><span className="text-white/40">TIME (dawn/noon/dusk/midnight):</span><span className="text-white">F6/F7/F8/F9</span></p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- DEBUG TUNING CONSOLE (F3) --- */}
      {debugMenuOpen && engineReady && (
        <div className="absolute top-16 right-4 z-40 bg-black/90 border border-[#00f2ff]/30 p-3 rounded backdrop-blur-md shadow-2xl pointer-events-auto">
          <div className="flex items-center justify-between border-b border-white/10 pb-2 mb-2">
            <span className="text-[#00f2ff] font-black tracking-widest uppercase text-[10px]">Debug Console (F3)</span>
            <button onClick={() => setDebugMenuOpen(false)} className="text-white/40 hover:text-white text-xs">✕</button>
          </div>
          <VisualTuningConsole />
        </div>
      )}

      {/* --- PAUSE MENU (ESC) --- */}
      {pauseMenuOpen && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm pointer-events-auto">
          <div className="bg-zinc-950/95 border border-white/15 p-8 rounded-lg shadow-2xl max-w-sm w-full mx-4 text-center">
            <h2 className="text-2xl font-black tracking-tight text-white uppercase mb-1">Frontier Planet</h2>
            <p className="text-[10px] font-mono text-[#00f2ff]/70 tracking-widest uppercase mb-6">Sector 7-G // Paused</p>
            <button
              onClick={requestLock}
              className="w-full bg-[#ff6600] hover:bg-[#ff8533] active:scale-95 border border-orange-400 px-6 py-3 rounded text-xs font-black tracking-widest text-slate-950 shadow-[0_0_20px_rgba(255,102,0,0.4)] flex items-center justify-center gap-2 cursor-pointer transition-all uppercase mb-3"
            >
              <Crosshair className="w-4 h-4" />
              Resume Operation
            </button>
            <button
              onClick={() => { setPauseMenuOpen(false); setHelpOpen(true); }}
              className="w-full bg-white/5 hover:bg-white/10 border border-white/15 px-6 py-2.5 rounded text-[10px] font-black tracking-widest text-white/80 uppercase mb-3 cursor-pointer transition-all"
            >
              Controls (F1)
            </button>
            <button
              onClick={handleDeployAgain}
              className="w-full bg-white/5 hover:bg-white/10 border border-white/15 px-6 py-2.5 rounded text-[10px] font-black tracking-widest text-white/80 uppercase flex items-center justify-center gap-2 cursor-pointer transition-all"
            >
              <RefreshCw className="w-3 h-3" />
              Redeploy
            </button>
            <button
              onClick={returnToMenu}
              className="w-full bg-white/5 hover:bg-white/10 border border-white/15 px-6 py-2.5 rounded text-[10px] font-black tracking-widest text-white/80 uppercase cursor-pointer transition-all"
            >
              Return to Menu
            </button>
            <p className="text-[8px] font-mono text-white/30 mt-4">World remains rendered behind this menu.</p>
          </div>
        </div>
      )}

      {/* --- HUD OVERLAYS (Priority 8 - Streamlined design) --- */}
      <div className="absolute inset-0 flex flex-col justify-between p-5 pointer-events-none z-20">
        
        {/* TOP INTERFACE ROW */}
        <div className="flex justify-between items-start w-full gap-4">
          
          {/* Top Left: Minimal Planetary Sector Branding */}
          <div className="backdrop-blur-md border border-white/10 p-4 rounded-lg flex items-center gap-3.5 shadow-2xl pointer-events-auto"
            style={{ backgroundColor: `rgba(0,0,0,${uiOpacity})` }}>
            <div className="relative flex items-center justify-center w-11 h-11 rounded border"
              style={{ backgroundColor: `${uiAccent}15`, borderColor: `${uiAccent}30`, color: uiAccent }}>
              <Compass className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h1 className="text-xl font-black tracking-tight text-white uppercase leading-none">
                FRONTIER <span style={{ color: uiAccent }}>PLANET</span>
              </h1>
              <p className="text-[9px] font-mono tracking-wider uppercase mt-1" style={{ color: `${uiAccent}cc` }}>
                Sector 7-G // <span className="text-white font-bold">{currentBiome}</span>
              </p>
            </div>
          </div>

          {/* Top Center: Immersive Real-time Compass widget (Priority 7) */}
          <div className="hidden md:flex flex-col items-center gap-1 backdrop-blur-md px-6 py-2.5 border border-white/10 rounded-xl pointer-events-auto shadow-lg"
            style={{ backgroundColor: `rgba(0,0,0,${uiOpacity})` }}>
            <div className="flex items-center gap-3">
              <span className="text-white/35 text-[9px] font-mono">NW</span>
              <div className="w-12 h-[1px] bg-white/15" />
              <span className="text-white/35 text-xs font-mono font-bold">N</span>
              <span className="text-xs font-mono font-black tracking-tight min-w-[35px] text-center animate-pulse" style={{ color: uiAccent }}>
                {formattedYaw}° {cardinal}
              </span>
              <span className="text-white/35 text-xs font-mono font-bold">S</span>
              <div className="w-12 h-[1px] bg-white/15" />
              <span className="text-white/35 text-[9px] font-mono">NE</span>
            </div>
            {/* Ruin Objective Guideline Pointer */}
            <div className="text-[8px] font-mono tracking-wider font-black uppercase flex items-center gap-1 pt-0.5 border-t border-white/5 w-full justify-center"
              style={{ color: uiAccent }}>
              <span>Artifact Signal:</span>
              <span className="text-white font-bold">{ruinIndicator} ({distToRuin}m)</span>
            </div>
          </div>

          {/* Top Right: Real-time Block Target Debugging (Priority 1) */}
          <div className="border p-3.5 rounded-lg shadow-2xl pointer-events-auto font-mono text-xs w-64"
            style={{ backgroundColor: `rgba(0,0,0,${uiOpacity})`, borderColor: `${uiAccent}30` }}>
            <div className="text-[9px] font-black tracking-widest uppercase mb-1 flex items-center gap-1" style={{ color: uiAccent }}>
              <span className="w-1 h-1 rounded-full animate-ping" style={{ backgroundColor: uiAccent }} /> SCANNER TARGET
            </div>
            <p className="text-white/80 text-[10px] truncate">
              {targetedBlockInfo}
            </p>
          </div>
        </div>

        {/* MIDDLE INTERFACE MODULE: Click triggers & Mission tracker */}
        <div className="flex h-full items-center justify-between relative w-full my-3">
          
          {/* Mission Tracker (Left margin dock) */}
          <div className="absolute left-0 top-3 border-l-2 space-y-3 pointer-events-auto backdrop-blur-md p-4 shadow-2xl w-64"
            style={{ borderLeftColor: uiAccent, backgroundColor: `rgba(0,0,0,${uiOpacity})` }}>
            <h2 className="text-[9px] font-bold uppercase tracking-widest" style={{ color: uiAccent }}>Active Directives</h2>
            
            <div className="space-y-3 font-mono text-xs text-white/90">
              <div className="flex items-start gap-2">
                <div className="mt-0.5 w-3.5 h-3.5 flex items-center justify-center rounded border text-[9px]"
                  style={{ 
                    backgroundColor: isArtifactRecovered ? `${uiAccent}20` : 'transparent',
                    borderColor: isArtifactRecovered ? uiAccent : 'rgba(255,255,255,0.2)',
                    color: isArtifactRecovered ? uiAccent : 'rgba(255,255,255,0.4)' 
                  }}>
                  {isArtifactRecovered ? '✓' : '▪'}
                </div>
                <div className="leading-tight">
                  <p className={isArtifactRecovered ? 'text-white/40 line-through' : 'text-white/90'}>
                    Retrieve <span className="font-bold" style={{ color: uiAccent }}>PULSE CORE</span>
                  </p>
                  <p className="text-[9px] italic" style={{ color: uiAccent }}>Ruins: [-20, 14, -20]</p>
                </div>
              </div>

              <div className="flex items-start gap-2">
                <div className={`mt-0.5 w-3.5 h-3.5 flex items-center justify-center rounded border text-[9px] ${
                  isExtracted 
                    ? 'bg-emerald-500/20 border-emerald-400 text-emerald-400' 
                    : 'border-white/20 text-white/40'
                }`}>
                  {isExtracted ? '✓' : '▪'}
                </div>
                <div className="leading-tight">
                  <p className={isExtracted ? 'text-white/40 line-through' : 'text-white/90'}>
                    Extract core at Spawn
                  </p>
                  <p className="text-[9px] text-white/50 italic">Radius 8m around [0, 12, 0]</p>
                </div>
              </div>
            </div>
          </div>

          {/* Active Notifications Log (Right margin dock) */}
          <div className="absolute right-0 top-3 space-y-2 pointer-events-none w-64">
            {hudAlerts.map((alert) => (
              <div
                key={alert.id}
                className={`animate-fade-in flex items-start gap-2 p-2.5 rounded bg-black/85 border-l-4 text-[10px] font-mono shadow-xl transition-all duration-300 ${
                  alert.status === 'success'
                    ? 'border-emerald-500 text-emerald-200'
                    : alert.status === 'warning'
                    ? 'border-[#ff6600] text-orange-200'
                    : 'border-[#00f2ff] text-[#00f2ff]'
                }`}
              >
                {alert.status === 'success' ? (
                  <Award className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                ) : alert.status === 'warning' ? (
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 animate-pulse" />
                ) : (
                  <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                )}
                <span className="leading-tight">{alert.msg}</span>
              </div>
            ))}
          </div>

          {/* Center spacing spacer */}
          <div className="flex-1 mx-auto" />
        </div>

        {/* BOTTOM INTERFACE ROW */}
        <div className="space-y-3.5 w-full">
          
          <div className="flex justify-between items-end w-full gap-5">
            
            {/* Bottom Left: Coordinates Readout Card */}
            <div className="border p-4 rounded-lg w-64 shadow-2xl pointer-events-auto backdrop-blur-md space-y-3"
              style={{ backgroundColor: `rgba(0,0,0,${uiOpacity})`, borderColor: `${uiAccent}30` }}>
              <div className="w-full">
                <div className="flex justify-between text-[9px] uppercase font-bold mb-1">
                  <span className="text-[#ff4444] tracking-widest flex items-center gap-1">
                    <Shield className="w-3 h-3" /> LIFE SYSTEMS
                  </span>
                  <span className="text-white/80">100% NOMINAL</span>
                </div>
                <div className="h-1 w-full bg-white/10 rounded-full overflow-hidden">
                  <div className="h-full bg-[#ff4444]" style={{ width: '100%' }} />
                </div>
              </div>

              <div className="w-full">
                <div className="flex justify-between text-[9px] uppercase font-bold mb-1">
                  <span className="tracking-widest flex items-center gap-1" style={{ color: uiAccent }}>
                    <Compass className="w-3 h-3" /> GPS TELEMETRY
                  </span>
                  <span className="font-mono" style={{ color: uiAccent }}>
                    X:{Math.floor(playerPos[0])} Y:{Math.floor(playerPos[1])} Z:{Math.floor(playerPos[2])}
                  </span>
                </div>
                <div className="h-1 w-full bg-white/10 rounded-full overflow-hidden">
                  <div className="h-full" style={{ width: '100%', backgroundColor: uiAccent }} />
                </div>
              </div>
            </div>

            {/* Bottom Right: Selected material detailed specs */}
            <div className="p-4 border rounded-lg w-64 shadow-2xl font-mono pointer-events-auto backdrop-blur-md"
              style={{ backgroundColor: `rgba(0,0,0,${uiOpacity})`, borderColor: `${uiAccent}30` }}>
              <div className="text-[9px] font-black uppercase tracking-widest mb-1.5" style={{ color: uiAccent }}>
                Active Material
              </div>
              {currentBlockDef ? (
                <div className="space-y-1.5">
                  <div className="text-base font-bold uppercase tracking-tight text-white leading-none">
                    {currentBlockDef.name}
                  </div>
                  <p className="text-[10px] text-white/50 leading-relaxed truncate">
                    {currentBlockDef.description}
                  </p>
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="text-base font-bold uppercase tracking-tight text-white/35 leading-none">
                    DISARMED
                  </div>
                  <p className="text-[10px] text-white/35 italic">No material selected.</p>
                </div>
              )}
            </div>
          </div>

          {/* Bottom Center: Hotbar matrix (Clean mapped from playerService hotbar) */}
          <div className="flex flex-col items-center gap-2 w-full">
            <div className="flex gap-2 p-1.5 border backdrop-blur-lg rounded-lg pointer-events-auto shadow-2xl"
              style={{ backgroundColor: `rgba(0,0,0,${uiOpacity})`, borderColor: `${uiAccent}25` }}>
              {hotbar.map((id, index) => {
                const b = getBlockById(id);
                const isActive = id === selectedBlockId;
                if (!b) return null;

                const [r, g, bColor] = b.color;
                const inlineColor = `rgb(${Math.floor(r * 255)}, ${Math.floor(g * 255)}, ${Math.floor(bColor * 255)})`;

                return (
                  <div
                    key={id}
                    onClick={() => {
                      gameApp.playerService.setSelectedBlockId(id);
                      // UI Interaction feedback:
                      AudioService.getInstance().playUiClick();
                    }}
                    className="relative w-12 h-12 border flex flex-col items-center justify-center cursor-pointer transition-all"
                    style={{
                      borderColor: isActive ? uiAccent : 'rgba(255,255,255,0.1)',
                      backgroundColor: isActive ? `${uiAccent}20` : 'rgba(0,0,0,0.4)',
                      transform: isActive ? 'scale(1.05)' : 'none',
                      boxShadow: isActive ? `0 0 10px ${uiAccent}44` : 'none'
                    }}
                  >
                    <div 
                      className="w-5 h-5 shadow-inner border border-black/30 rounded-sm"
                      style={{ backgroundColor: inlineColor }}
                    />
                    
                    <span className="absolute top-0.5 right-1 text-[8px] font-mono font-bold"
                      style={{ color: isActive ? uiAccent : 'rgba(255,255,255,0.4)' }}>
                      {index + 1}
                    </span>

                    {isActive && (
                      <div className="absolute -bottom-1 w-1 h-1 rounded-sm shadow-[0_0_4px_currentColor]"
                        style={{ backgroundColor: uiAccent, color: uiAccent }} />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Bottom Movement Tip (Priority 2) */}
            <div className="px-4 py-1 border rounded-full text-[9px] font-mono tracking-widest font-bold uppercase pointer-events-auto backdrop-blur-md flex items-center gap-2.5 shadow-md"
              style={{ backgroundColor: `rgba(0,0,0,${uiOpacity})`, borderColor: `${uiAccent}20`, color: uiAccent }}>
              <span className="text-white/45 font-semibold">CONTROLS:</span>
              <span>[Shift] Sprint</span>
              <span className="text-white/20">|</span>
              <span>[Space x2] Double Jump</span>
            </div>
          </div>
        </div>
      </div>

      {/* FULL SCREEN WIN MODULE (Raid Success) */}
      {isExtracted && (
        <div className="absolute inset-0 z-50 bg-[#0a0a0c]/95 flex flex-col items-center justify-center p-6 text-center animate-fade-in pointer-events-auto">
          <div className="max-w-md bg-black border-2 border-[#00f2ff] p-7 rounded-xl shadow-[0_0_30px_rgba(0,242,255,0.15)] relative overflow-hidden space-y-5">
            <div className="absolute top-0 inset-x-0 h-1 bg-[#00f2ff] animate-pulse" />
            <div className="flex justify-center">
              <div className="w-14 h-14 rounded-full bg-[#00f2ff]/20 border-2 border-[#00f2ff] text-[#00f2ff] flex items-center justify-center animate-bounce shadow">
                <Award className="w-7 h-7" />
              </div>
            </div>

            <div className="space-y-1">
              <h1 className="text-2xl font-black text-white tracking-widest font-sans uppercase">
                CONTRACT SECURED
              </h1>
              <p className="text-[10px] font-mono text-[#00f2ff] font-bold tracking-widest uppercase animate-pulse">
                EXTRACTED PULSE ARTIFACT // CODENAME: EPSILON
              </p>
            </div>

            <div className="bg-black/55 p-4 rounded border border-white/10 font-mono text-left text-[11px] text-white/70 space-y-2">
              <div className="flex justify-between border-b border-white/5 pb-1.5 text-white">
                <span>Raid Status:</span>
                <span className="text-[#00f2ff] font-bold uppercase">SUCCESSFUL ESCAPE</span>
              </div>
              <div className="flex justify-between">
                <span>Core Artifact:</span>
                <span className="text-white font-bold uppercase">PULSE ARTIFACT CORE (+500 Value)</span>
              </div>
              <div className="flex justify-between">
                <span>Contract Paycheck:</span>
                <span className="text-white font-bold">7,500 Credits</span>
              </div>
              <div className="flex justify-between border-t border-white/10 pt-1.5 font-bold text-white/90">
                <span>Sol-Credits balance:</span>
                <span className="text-emerald-400 font-bold">10,000 Credits</span>
              </div>
            </div>

            <div className="flex justify-center pt-1">
              <button
                onClick={handleDeployAgain}
                className="bg-[#ff6600] text-slate-950 hover:bg-[#ff8533] border border-orange-300 px-5 py-2.5 rounded text-xs font-mono font-black tracking-widest flex items-center justify-center gap-1.5 cursor-pointer transition-all shadow-[0_0_12px_rgba(255,102,0,0.15)]"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                DEPLOY NEXT CONTRACT
              </button>
            </div>
            <p className="text-[9px] text-white/30 font-mono">
              SOL-CORP EXTRACTION SHIP TELEMETRY STABLE // DR-23 REPLICATOR ENGAGED
            </p>
          </div>
        </div>
      )}

      {runtimeError && (
        <div id="runtime-error-toast" className="fixed bottom-4 right-4 z-50 max-w-sm w-full bg-red-950/90 border border-red-500/60 p-4 rounded-lg shadow-[0_0_15px_rgba(239,68,68,0.2)] text-white font-mono flex flex-col gap-2 backdrop-blur-md pointer-events-auto select-text">
          <div className="flex justify-between items-center border-b border-red-500/30 pb-1.5">
            <span className="text-[10px] font-black text-red-400 tracking-wider flex items-center gap-1.5 select-none">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /> DIAGNOSTIC WARN
            </span>
            <button 
              onClick={() => setRuntimeError(null)}
              className="text-[10px] text-zinc-400 hover:text-white uppercase px-1.5 py-0.5 border border-white/10 hover:border-white/30 rounded cursor-pointer select-none"
            >
              Dismiss
            </button>
          </div>
          <p className="text-[11px] text-red-200 leading-normal break-words font-semibold select-text">
            {runtimeError.message}
          </p>
          {runtimeError.stack && (
            <pre className="text-[9px] text-zinc-400 overflow-auto max-h-24 bg-black/40 p-1.5 rounded whitespace-pre-wrap select-text selection:bg-red-900 leading-tight">
              {runtimeError.stack.split("\n").slice(0, 4).join("\n")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

