'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Camera, RefreshCw, UploadCloud } from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { useUploadThing } from '@/lib/uploadthing';

type AppState   = 'splash' | 'camera' | 'preview' | 'uploading' | 'error';
type FocusState = 'scanning' | 'locked' | 'snapping';

// ── Camera stream (try best constraints first) ────────────────────────────────
async function getCameraStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error('Camera not available. Use HTTPS.');
  for (const c of [
    { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
    { video: { facingMode: { ideal: 'environment' } } },
    { video: true },
  ] as MediaStreamConstraints[]) {
    try { return await navigator.mediaDevices.getUserMedia(c); } catch { /* try next */ }
  }
  throw new Error('Could not access camera. Check permission in Android Chrome site settings.');
}

// ── Sharpness detection (from PuzzleLens) ────────────────────────────────────
// Samples the center 50% of the video frame at 120×120, computes the variance
// of adjacent pixel luminance differences — higher = sharper image.
function sharpnessScore(video: HTMLVideoElement, scratch: HTMLCanvasElement): number {
  const SIZE = 120;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;
  scratch.width  = SIZE;
  scratch.height = SIZE;
  const vw = video.videoWidth  || video.clientWidth  || 1280;
  const vh = video.videoHeight || video.clientHeight || 720;
  const crop = Math.min(vw, vh) * 0.5;
  const sx = (vw - crop) / 2;
  const sy = (vh - crop) / 2;
  ctx.drawImage(video, sx, sy, crop, crop, 0, 0, SIZE, SIZE);
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
  let sum = 0, sumSq = 0, n = 0;
  for (let i = 0; i < SIZE * SIZE - 1; i++) {
    const p  = i * 4;
    const p1 = (i + 1) * 4;
    const g0 = 0.299 * data[p]  + 0.587 * data[p  + 1] + 0.114 * data[p  + 2];
    const g1 = 0.299 * data[p1] + 0.587 * data[p1 + 1] + 0.114 * data[p1 + 2];
    const d  = g0 - g1;
    sum   += d;
    sumSq += d * d;
    n++;
  }
  const mean = sum / n;
  return (sumSq / n) - mean * mean;
}

export default function Home() {
  const [appState,    setAppState]    = useState<AppState>('splash');
  const [cameraError, setCameraError] = useState('');
  const [photo,       setPhoto]       = useState<string | null>(null);
  const [photoBlob,   setPhotoBlob]   = useState<File | null>(null);
  const [focusState,  setFocusState]  = useState<FocusState>('scanning');
  const [autoMode,    setAutoMode]    = useState(true);

  const videoRef        = useRef<HTMLVideoElement>(null);
  const canvasRef       = useRef<HTMLCanvasElement>(null);
  const scratchRef      = useRef<HTMLCanvasElement | null>(null);   // sharpness canvas
  const streamRef       = useRef<MediaStream | null>(null);
  const focusIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lockCounterRef  = useRef(0);
  const scoresRef       = useRef<number[]>([]);
  const didSnapRef      = useRef(false);
  const appStateRef     = useRef<AppState>('splash');
  const autoModeRef     = useRef(true);

  useEffect(() => { appStateRef.current = appState;  }, [appState]);
  useEffect(() => { autoModeRef.current = autoMode;  }, [autoMode]);

  // bfcache: Android back-button restores frozen JS — reset everything
  useEffect(() => {
    const handler = (e: PageTransitionEvent) => {
      if (e.persisted) {
        didSnapRef.current = false;
        appStateRef.current = 'splash';
        setAppState('splash');
        setPhoto(null);
        setPhotoBlob(null);
      }
    };
    window.addEventListener('pageshow', handler);
    return () => window.removeEventListener('pageshow', handler);
  }, []);

  // ── Stop camera + focus loop ────────────────────────────────────────────────
  const stopCamera = useCallback(() => {
    if (focusIntervalRef.current) {
      clearInterval(focusIntervalRef.current);
      focusIntervalRef.current = null;
    }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const { startUpload, isUploading } = useUploadThing('puzzleUploader', {
    onClientUploadComplete: (res) => {
      const key = res[0]?.key;
      const url = res[0]?.url;
      if (!key) { toast.error('No file key returned.'); setAppState('preview'); return; }
      // Store the direct CDN URL so the solve page can use it without guessing
      if (url) sessionStorage.setItem(`ut_url_${key}`, url);
      window.location.href = `/s/${key}`;
    },
    onUploadError: (err) => {
      toast.error(`Upload failed: ${err.message}`);
      appStateRef.current = 'preview';
      setAppState('preview');
    },
  });

  // ── Snap: draw frame → show photo → upload ─────────────────────────────────
  const snap = useCallback((mode: 'auto' | 'manual') => {
    if (didSnapRef.current) return;
    if (appStateRef.current !== 'camera') return;

    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) { toast.error('Camera not ready yet — try again.'); return; }

    didSnapRef.current = true;

    // ⚠️ Draw FIRST — stopCamera sets srcObject=null which blanks the video.
    // If we stop first we capture a black frame.
    canvas.width  = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);

    // Now safe to stop the stream
    stopCamera();

    // Show the actual captured photo immediately
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    setPhoto(dataUrl);
    appStateRef.current = 'preview';
    setAppState('preview');

    // Get blob for upload (canvas.toBlob is the correct async API)
    canvas.toBlob(blob => {
      if (!blob) {
        toast.error('Could not create image — tap Retake.');
        didSnapRef.current = false;
        return;
      }
      const file = new File([blob], `puzzle-${Date.now()}.jpg`, { type: 'image/jpeg' });
      setPhotoBlob(file);

      if (mode === 'auto') {
        setTimeout(() => {
          if (appStateRef.current === 'preview') {
            appStateRef.current = 'uploading';
            setAppState('uploading');
            startUpload([file]);
          }
        }, 1200);
      }
    }, 'image/jpeg', 0.92);
  }, [stopCamera, startUpload]);

  // ── Focus loop (sharpness-based auto-snap) ──────────────────────────────────
  // Adapted from PuzzleLens: samples every 300ms, requires 3 consecutive
  // sharp frames before locking, then snaps 400ms later.
  const startFocusLoop = useCallback(() => {
    if (!scratchRef.current) scratchRef.current = document.createElement('canvas');

    if (focusIntervalRef.current) clearInterval(focusIntervalRef.current);
    lockCounterRef.current = 0;
    scoresRef.current      = [];

    focusIntervalRef.current = setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;
      if (appStateRef.current !== 'camera')  return;
      if (didSnapRef.current)               return;

      const score  = sharpnessScore(video, scratchRef.current!);
      const scores = scoresRef.current;
      scores.push(score);
      if (scores.length > 6) scores.shift();
      if (scores.length < 3) return;

      const avg       = scores.reduce((a, b) => a + b, 0) / scores.length;
      const recentAvg = scores.slice(-3).reduce((a, b) => a + b, 0) / 3;
      // Floor of 12 (was 38) — printed paper indoors has low variance.
      // 1.05x multiplier (was 1.2) — less aggressive, locks faster.
      const isSharp   = recentAvg > Math.max(avg * 1.05, 12);

      if (isSharp) {
        lockCounterRef.current++;
      } else {
        lockCounterRef.current = Math.max(0, lockCounterRef.current - 1);
        if (lockCounterRef.current === 0) setFocusState('scanning');
      }

      if (lockCounterRef.current >= 3) {
        setFocusState('locked');
        if (autoModeRef.current && !didSnapRef.current) {
          setFocusState('snapping');
          if (focusIntervalRef.current) {
            clearInterval(focusIntervalRef.current);
            focusIntervalRef.current = null;
          }
          setTimeout(() => snap('auto'), 400);
        }
      }
    }, 300);
  }, [snap]);

  // ── Start camera ─────────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    setCameraError('');
    setPhoto(null);
    setPhotoBlob(null);
    setFocusState('scanning');
    stopCamera();
    didSnapRef.current  = false;
    lockCounterRef.current = 0;
    scoresRef.current   = [];
    appStateRef.current = 'camera';
    setAppState('camera');

    try {
      const stream = await getCameraStream();
      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;

      // Start focus loop once video has actual frames
      const onReady = () => {
        video.removeEventListener('loadeddata', onReady);
        video.removeEventListener('canplay',    onReady);
        startFocusLoop();
      };
      video.addEventListener('loadeddata', onReady);
      video.addEventListener('canplay',    onReady);
      await video.play().catch(() => undefined);

      // Fallback 1: start focus loop after 2s if video events never fired
      setTimeout(() => {
        if (appStateRef.current === 'camera' && !didSnapRef.current && !focusIntervalRef.current) {
          startFocusLoop();
        }
      }, 2000);

      // Fallback 2: hard snap at 7s — if sharpness never locks, snap anyway
      setTimeout(() => {
        if (appStateRef.current === 'camera' && !didSnapRef.current && autoModeRef.current) {
          snap('auto');
        }
      }, 7000);

    } catch (err) {
      setCameraError(err instanceof Error ? err.message : String(err));
      appStateRef.current = 'error';
      setAppState('error');
    }
  }, [startFocusLoop, stopCamera]);

  const handleUpload = async () => {
    if (!photoBlob || appState === 'uploading') return;
    appStateRef.current = 'uploading';
    setAppState('uploading');
    await startUpload([photoBlob]);
  };

  const retake = useCallback(() => {
    didSnapRef.current = false;
    setPhoto(null);
    setPhotoBlob(null);
    startCamera();
  }, [startCamera]);

  const reset = useCallback(() => {
    stopCamera();
    didSnapRef.current = false;
    setPhoto(null);
    setPhotoBlob(null);
    appStateRef.current = 'splash';
    setAppState('splash');
  }, [stopCamera]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const frameBorder =
    focusState === 'snapping' ? 'border-white shadow-white/40' :
    focusState === 'locked'   ? 'border-emerald-400 shadow-emerald-400/40' :
                                'border-white/40 shadow-transparent';

  // ── SPLASH ──────────────────────────────────────────────────────────────────
  if (appState === 'splash') return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col items-center justify-center px-6">
      <Toaster position="top-center" richColors />
      <div className="w-20 h-20 bg-violet-600 rounded-3xl flex items-center justify-center mb-6 shadow-lg shadow-violet-900/50">
        <Camera className="w-10 h-10" />
      </div>
      <h1 className="font-bold text-4xl tracking-tight mb-2">SnapSolve</h1>
      <p className="text-zinc-400 mb-12 text-center max-w-sm">Point your camera at a crossword and get instant AI solutions.</p>
      <button onClick={startCamera}
        className="w-full max-w-sm h-16 bg-white text-black rounded-3xl font-semibold text-xl flex items-center justify-center gap-3 active:scale-95 transition-all shadow-lg">
        <Camera className="w-7 h-7" /> Open Camera
      </button>
      <p className="text-zinc-600 text-xs mt-6">Your browser will ask for camera permission.</p>
    </div>
  );

  // ── ERROR ───────────────────────────────────────────────────────────────────
  if (appState === 'error') return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col items-center justify-center px-6">
      <Toaster position="top-center" richColors />
      <AlertCircle className="w-14 h-14 text-red-400 mb-4" />
      <h2 className="font-bold text-2xl mb-2">Camera Error</h2>
      <div className="w-full max-w-sm bg-zinc-900 rounded-2xl p-4 mb-8 border border-zinc-800">
        <pre className="text-red-300 text-xs whitespace-pre-wrap break-words">{cameraError || 'Unknown error'}</pre>
      </div>
      <button onClick={reset} className="h-12 px-8 bg-violet-600 rounded-2xl font-semibold">Try Again</button>
    </div>
  );

  // ── CAMERA / PREVIEW / UPLOADING ────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black text-white flex flex-col">
      <Toaster position="top-center" richColors />
      <div className="relative flex-1 overflow-hidden">

        {appState === 'camera' && (
          <video ref={videoRef} autoPlay playsInline muted
            className="absolute inset-0 w-full h-full object-cover" />
        )}
        {(appState === 'preview' || appState === 'uploading') && photo && (
          <img src={photo} alt="Captured puzzle" className="absolute inset-0 w-full h-full object-cover" />
        )}
        <canvas ref={canvasRef} className="hidden" />

        {/* Header */}
        <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-5 pt-12 pb-4 bg-gradient-to-b from-black/70 to-transparent">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-violet-600 rounded-xl flex items-center justify-center"><Camera className="w-4 h-4" /></div>
            <span className="font-bold text-lg">SnapSolve</span>
          </div>
          <button onClick={reset} className="p-2 text-white/75"><RefreshCw className="w-5 h-5" /></button>
        </div>

        {/* Focus frame */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className={`relative w-[80vw] h-[80vw] max-w-[340px] max-h-[340px] border-2 rounded-2xl transition-all duration-300 shadow-lg ${frameBorder}`}>
            {(['tl','tr','bl','br'] as const).map(c => (
              <div key={c} className={`absolute w-6 h-6 border-2 rounded-sm
                ${focusState === 'locked' || focusState === 'snapping' ? 'border-emerald-400' : 'border-white/70'}
                ${c==='tl'?'-top-px -left-px border-r-0 border-b-0':
                  c==='tr'?'-top-px -right-px border-l-0 border-b-0':
                  c==='bl'?'-bottom-px -left-px border-r-0 border-t-0':
                          '-bottom-px -right-px border-l-0 border-t-0'}`} />
            ))}
          </div>
        </div>

        {/* Focus status badge */}
        {appState === 'camera' && (
          <div className="absolute bottom-36 left-0 right-0 flex flex-col items-center gap-2">
            <div className={`px-4 py-1.5 rounded-full text-xs font-semibold tracking-wide backdrop-blur-sm
              ${focusState==='snapping'?'bg-white text-black':
                focusState==='locked'  ?'bg-emerald-500/90 text-white':
                                        'bg-black/55 text-white/70'}`}>
              {focusState==='snapping' ? '📸 Auto — snapping…' :
               focusState==='locked'   ? '✓ Focus locked' :
                                         '🔍 Scanning…'}
            </div>
            <button onClick={() => setAutoMode(m => !m)}
              className={`text-xs px-3 py-1 rounded-full border
                ${autoMode?'border-emerald-500 text-emerald-300 bg-black/35':'border-zinc-600 text-zinc-400 bg-black/35'}`}>
              {autoMode ? 'Auto-snap ON' : 'Auto-snap OFF'}
            </button>
          </div>
        )}

        {/* Uploading overlay — photo stays visible */}
        {appState === 'uploading' && (
          <div className="absolute inset-0 bg-black/65 flex items-center justify-center">
            <div className="text-center">
              <UploadCloud className="w-12 h-12 mx-auto mb-4 animate-bounce text-violet-400" />
              <p className="text-xl font-medium">{isUploading ? 'Uploading…' : 'Solving…'}</p>
              <p className="text-sm text-zinc-400 mt-2">Usually 5–10 seconds</p>
            </div>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div className="px-6 pt-5 pb-10 bg-gradient-to-t from-black to-transparent">
        {appState === 'camera' && (
          <button onClick={() => snap('manual')}
            className="w-full h-16 bg-white active:scale-95 text-black rounded-3xl font-bold text-xl flex items-center justify-center gap-3 transition-all shadow-xl">
            <Camera className="w-7 h-7" /> SNAP PUZZLE
          </button>
        )}
        {(appState === 'preview' || appState === 'uploading') && (
          <div className="flex gap-4">
            <button onClick={retake} disabled={appState==='uploading'}
              className="flex-1 h-14 border border-zinc-600 bg-black/40 disabled:opacity-40 rounded-3xl font-medium text-white">
              Retake
            </button>
            <button onClick={handleUpload} disabled={appState==='uploading'||!photoBlob}
              className="flex-1 h-14 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 rounded-3xl font-semibold">
              {appState==='uploading'?'Solving…':'Solve Puzzle'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
