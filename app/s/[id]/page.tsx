'use client';

import { useEffect, useState } from 'react';
import { Camera, ArrowLeft, Eye, EyeOff } from 'lucide-react';
import { Toaster } from 'sonner';

interface ClueDef  { n: number; clue: string; answer: string; }
interface NumberDef { row: number; col: number; n: number; }

interface Puzzle {
  rows: number;
  cols: number;
  cells: boolean[][];
  numbers: NumberDef[];
  across: ClueDef[];
  down: ClueDef[];
}

// Fix #6: Compute actual slot length before placing letters.
// Prevents answers with wrong length (e.g. "NEW YORK" stripped to "NEWYORK")
// from being placed in the wrong cells.
function slotLength(puzzle: Puzzle, startRow: number, startCol: number, dir: 'across' | 'down'): number {
  let len = 0, r = startRow, c = startCol;
  while (r < puzzle.rows && c < puzzle.cols && puzzle.cells[r]?.[c]) {
    len++;
    dir === 'across' ? c++ : r++;
  }
  return len;
}

function buildLetterMap(puzzle: Puzzle): Map<string, string> {
  const map      = new Map<string, string>();
  const numToPos = new Map<number, { row: number; col: number }>();
  puzzle.numbers.forEach(({ row, col, n }) => numToPos.set(n, { row, col }));

  puzzle.across.forEach(({ n, answer }) => {
    const pos   = numToPos.get(n);
    if (!pos) return;
    const clean = answer.replace(/[\s\-]/g, '');
    if (clean.length !== slotLength(puzzle, pos.row, pos.col, 'across')) return;
    for (let i = 0; i < clean.length; i++) map.set(`${pos.row},${pos.col + i}`, clean[i]);
  });

  puzzle.down.forEach(({ n, answer }) => {
    const pos   = numToPos.get(n);
    if (!pos) return;
    const clean = answer.replace(/[\s\-]/g, '');
    if (clean.length !== slotLength(puzzle, pos.row, pos.col, 'down')) return;
    for (let i = 0; i < clean.length; i++) map.set(`${pos.row + i},${pos.col}`, clean[i]);
  });

  return map;
}

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const [status, setStatus]   = useState<'loading' | 'done' | 'error'>('loading');
  const [puzzle, setPuzzle]   = useState<Puzzle | null>(null);
  const [errorMsg, setError]  = useState('');
  const [fileKey, setFileKey] = useState('');

  // Reveal state — each cell independently toggled, plus a show-all switch
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [showAll, setShowAll]   = useState(false);

  useEffect(() => { params.then(({ id }) => setFileKey(id)); }, [params]);

  useEffect(() => {
    if (!fileKey) return;
    (async () => {
      try {
        // Fix #7: Check client-side cache first — skip API call on refresh.
        const cacheKey = `solved_${fileKey}`;
        const cached   = sessionStorage.getItem(cacheKey);
        if (cached) {
          setPuzzle(JSON.parse(cached));
          setStatus('done');
          return;
        }

        // Fix #3: Send only fileKey — no base64 dataUrl in sessionStorage.
        // Use the direct URL stored at upload time if available
        const fileUrl = sessionStorage.getItem(`ut_url_${fileKey}`) ?? undefined;
        const res  = await fetch('/api/solve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileKey, fileUrl }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? 'Solve failed');

        // Cache the solved puzzle JSON (tiny compared to base64 photo)
        try { sessionStorage.setItem(cacheKey, JSON.stringify(data.puzzle)); } catch { /* quota */ }

        setPuzzle(data.puzzle);
        setStatus('done');
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    })();
  }, [fileKey]);

  // Tap a cell: reveal it. Tap again: hide it.
  // Works whether showAll is on or off.
  const toggleCell = (key: string) => {
    if (showAll) {
      // In show-all mode, tap hides that one cell
      setRevealed(prev => {
        const next = new Set(prev);
        next.has(key) ? next.delete(key) : next.add(key);
        return next;
      });
    } else {
      setRevealed(prev => {
        const next = new Set(prev);
        next.has(key) ? next.delete(key) : next.add(key);
        return next;
      });
    }
  };

  // Show all / hide all toggle
  const toggleAll = () => {
    setShowAll(prev => !prev);
    setRevealed(new Set()); // clear individual overrides when toggling all
  };

  const numberMap = new Map<string, number>();
  puzzle?.numbers.forEach(({ row, col, n }) => numberMap.set(`${row},${col}`, n));
  const letterMap = puzzle ? buildLetterMap(puzzle) : new Map<string, string>();

  const cols     = puzzle?.cols ?? 15;
  const screenW  = typeof window !== 'undefined' ? window.innerWidth : 375;
  const cellSize = Math.floor(Math.min(480, screenW - 32) / cols);

  return (
    <div className="min-h-screen bg-zinc-950 text-white pb-24">
      <Toaster position="top-center" richColors />

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-zinc-800 sticky top-0 bg-zinc-950/95 backdrop-blur z-10">
        <button onClick={() => (window.location.href = '/')} className="flex items-center gap-2 text-zinc-400 hover:text-white">
          <ArrowLeft className="w-5 h-5" /> Back
        </button>
        <span className="text-sm font-semibold">SnapSolve</span>
        <div className="w-14" />
      </div>

      <div className="max-w-lg mx-auto px-4 pt-5 space-y-5">

        {/* Loading */}
        {status === 'loading' && (
          <div className="flex flex-col items-center justify-center gap-6 py-24">
            <div className="w-12 h-12 border-4 border-violet-500 border-t-transparent rounded-full animate-spin" />
            <div className="text-center">
              <p className="text-lg font-medium">Reading your puzzle…</p>
              <p className="text-sm text-zinc-400 mt-1">Mapping grid · Solving clues</p>
            </div>
          </div>
        )}

        {/* Error */}
        {status === 'error' && (
          <div className="text-center py-16">
            <p className="text-red-400 font-semibold mb-2">Could not read puzzle</p>
            <p className="text-sm text-zinc-400 mb-8">{errorMsg}</p>
            <button onClick={() => (window.location.href = '/')} className="h-12 px-8 bg-violet-600 rounded-2xl font-semibold flex items-center gap-2 mx-auto">
              <Camera className="w-5 h-5" /> Try Again
            </button>
          </div>
        )}

        {/* Done */}
        {status === 'done' && puzzle && (
          <>
            {/* Reveal all toggle */}
            <div className="flex items-center justify-between bg-zinc-900 border border-zinc-800 rounded-2xl px-5 h-14">
              <div className="flex items-center gap-2">
                {showAll ? <Eye className="w-4 h-4 text-violet-400" /> : <EyeOff className="w-4 h-4 text-zinc-500" />}
                <span className="text-sm font-medium">{showAll ? 'Answers showing' : 'Answers hidden'}</span>
              </div>
              <button
                onClick={toggleAll}
                className={`relative w-14 h-8 rounded-full transition-colors duration-200
                  ${showAll ? 'bg-violet-600' : 'bg-zinc-700'}`}
              >
                <span className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-transform duration-200
                  ${showAll ? 'translate-x-7' : 'translate-x-1'}`}
                />
              </button>
            </div>

            {/* Interactive grid */}
            <div className="flex flex-col items-center">
              <p className="text-xs text-zinc-500 self-start mb-2">
                Tap any square to reveal or hide its letter
              </p>
              <div
                className="border border-zinc-600 rounded-lg overflow-hidden"
                style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${cols}, ${cellSize}px)`,
                  width: cellSize * cols,
                }}
              >
                {puzzle.cells.map((row, r) =>
                  row.map((isWhite, c) => {
                    const key    = `${r},${c}`;
                    const num    = numberMap.get(key);
                    const letter = letterMap.get(key) ?? '';
                    // In show-all mode, revealed set acts as HIDE overrides
                    const shown  = showAll
                      ? !revealed.has(key)
                      : revealed.has(key);

                    return isWhite ? (
                      <button
                        key={key}
                        onClick={() => toggleCell(key)}
                        style={{ width: cellSize, height: cellSize }}
                        className="relative border border-zinc-400 bg-white flex items-center justify-center active:opacity-60"
                      >
                        {num !== undefined && (
                          <span
                            className="absolute top-px left-px text-zinc-600 font-medium leading-none"
                            style={{ fontSize: Math.max(6, Math.floor(cellSize * 0.28)) }}
                          >
                            {num}
                          </span>
                        )}
                        {shown && letter && (
                          <span
                            className="font-bold text-black leading-none"
                            style={{ fontSize: Math.max(10, Math.floor(cellSize * 0.5)) }}
                          >
                            {letter}
                          </span>
                        )}
                      </button>
                    ) : (
                      <div key={key} style={{ width: cellSize, height: cellSize }} className="bg-zinc-900 border border-zinc-800" />
                    );
                  })
                )}
              </div>
            </div>

            {/* Clue lists */}
            <div className="grid grid-cols-2 gap-4">
              {/* Across */}
              <div>
                <p className="text-xs text-zinc-500 uppercase tracking-widest mb-2">Across</p>
                <div className="space-y-1.5">
                  {puzzle.across.map(({ n, clue, answer }) => (
                    <div key={n} className="bg-zinc-900 rounded-xl px-3 py-2">
                      <p className="text-xs font-bold text-violet-400 mb-0.5">{n}.</p>
                      <p className="text-xs text-zinc-300 leading-snug">{clue}</p>
                      {showAll && <p className="text-xs font-bold text-white mt-1">{answer}</p>}
                    </div>
                  ))}
                </div>
              </div>
              {/* Down */}
              <div>
                <p className="text-xs text-zinc-500 uppercase tracking-widest mb-2">Down</p>
                <div className="space-y-1.5">
                  {puzzle.down.map(({ n, clue, answer }) => (
                    <div key={n} className="bg-zinc-900 rounded-xl px-3 py-2">
                      <p className="text-xs font-bold text-violet-400 mb-0.5">{n}.</p>
                      <p className="text-xs text-zinc-300 leading-snug">{clue}</p>
                      {showAll && <p className="text-xs font-bold text-white mt-1">{answer}</p>}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <button
              onClick={() => (window.location.href = '/')}
              className="w-full h-12 bg-white text-black rounded-2xl font-semibold flex items-center justify-center gap-2"
            >
              <Camera className="w-5 h-5" /> Scan Another Puzzle
            </button>
          </>
        )}
      </div>
    </div>
  );
}
