import Anthropic from '@anthropic-ai/sdk';

export const runtime    = 'nodejs';
export const maxDuration = 60;

type ImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Fetch image from UploadThing ─────────────────────────────────────────────
async function getImage(fileKey: string, fileUrl?: string): Promise<{ base64: string; mimeType: ImageMime }> {
  const urls = [
    // Use the direct URL from UploadThing upload response first (most reliable)
    ...(fileUrl ? [fileUrl] : []),
    `https://utfs.io/f/${fileKey}`,
    `https://aqtpcqyz9z.ufs.sh/f/${fileKey}`,
  ];
  for (const url of urls) {
    try {
      console.log('[solve] fetching image from', url);
      const res = await fetch(url);
      if (!res.ok) { console.log('[solve] fetch not ok:', res.status, url); continue; }
      const buf      = await res.arrayBuffer();
      const raw      = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0];
      const mimeType = (['image/jpeg','image/png','image/gif','image/webp'].includes(raw)
        ? raw : 'image/jpeg') as ImageMime;
      console.log('[solve] image fetched ok, mime:', mimeType, 'bytes:', buf.byteLength);
      return { base64: Buffer.from(buf).toString('base64'), mimeType };
    } catch (e) {
      console.log('[solve] fetch error:', url, e);
    }
  }
  throw new Error(`Could not fetch image for key: ${fileKey}`);
}

// ── JSON cleaning ────────────────────────────────────────────────────────────
function tryParseJson(raw: string): unknown {
  const attempts = [
    raw.trim(),
    raw.trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim(),
    raw.trim().replace(/^\(+/, '').replace(/\)+$/, '').trim(),
    raw.trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').replace(/^\(+/, '').replace(/\)+$/, '').trim(),
    raw.trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').replace(/,\s*([\]}])/g, '$1').trim(),
  ];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try { return JSON.parse(attempt); } catch { /* next */ }
  }
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { /* fall through */ }
  }
  throw new Error(`Unparseable JSON. Raw (first 300 chars): ${raw.slice(0, 300)}`);
}

// ── Symmetry enforcement ─────────────────────────────────────────────────────
// Standard American crosswords have 180° rotational symmetry.
// If (r,c) and its mirror disagree, make BOTH black — Claude more often
// misses black cells than adds phantom ones.
function enforceSymmetry(cells: boolean[][]): { cells: boolean[][]; fixes: number } {
  const rows = cells.length;
  const cols = cells[0]?.length ?? 0;
  const result = cells.map(row => [...row]);
  let fixes = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const mr = rows - 1 - r;
      const mc = cols - 1 - c;
      if (result[r][c] !== result[mr][mc]) {
        result[r][c] = false;   // black
        result[mr][mc] = false; // black (mirror)
        fixes++;
      }
    }
  }
  return { cells: result, fixes: Math.floor(fixes / 2) };
}

// ── Auto-number: derive clue numbers from cells grid ────────────────────────
// A white cell gets a number if it starts an across word (leftmost in a run)
// or a down word (topmost in a run). Run length must be ≥ 2.
function deriveNumbers(cells: boolean[][]): { row: number; col: number; n: number }[] {
  const rows = cells.length;
  const cols = cells[0]?.length ?? 0;
  const numbers: { row: number; col: number; n: number }[] = [];
  let n = 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!cells[r][c]) continue;
      const startsAcross = (c === 0 || !cells[r][c - 1]) && c + 1 < cols && cells[r][c + 1];
      const startsDown   = (r === 0 || !cells[r - 1][c]) && r + 1 < rows && cells[r + 1][c];
      if (startsAcross || startsDown) numbers.push({ row: r, col: c, n: n++ });
    }
  }
  return numbers;
}

// ── Pass 1: grid structure ─────────────────────────────────────────────────────
// Row-string method: ask Claude to draw the grid as '#' (black) / '.' (white)
// strings — much less error-prone than listing coordinates.
// Numbers are derived algorithmically, not from Claude.
async function extractGrid(base64: string, mimeType: ImageMime) {
  console.log('[solve] calling Claude for grid (row-string method)...');
  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          {
            type: 'text',
            text: `This image contains a crossword puzzle grid (13 columns wide, 14 rows tall).

Your ONLY job: identify every BLACK (filled/solid dark) square.

Use 0-based coordinates: row 0 = top row, col 0 = leftmost column.

Scan each row from top to bottom, left to right. For each solid black square you see, record its [row, col].

Return ONLY this JSON (no prose, no markdown):
{"rows":14,"cols":13,"black":[[0,3],[0,6],[1,0], ...]}

Where "black" is the array of [row,col] pairs for every black square.
White squares (open/numbered) are NOT listed — only black ones.`,
          },
        ],
      },
    ],
  });

  const text = res.content[0].type === 'text' ? res.content[0].text : '';
  console.log('[solve] grid raw response (first 500):', text.slice(0, 500));

  const raw = tryParseJson(text) as { rows: number; cols: number; black?: [number,number][]; grid?: string[] };

  const rows = Number(raw.rows) || 14;
  const cols = Number(raw.cols) || 13;

  // Build cells — all white by default, then mark black squares
  const cells: boolean[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => true)
  );

  if (Array.isArray(raw.black)) {
    // Coordinate-based format
    for (const [r, c] of raw.black) {
      if (r >= 0 && r < rows && c >= 0 && c < cols) cells[r][c] = false;
    }
    console.log('[solve] black cells from coordinates:', raw.black.length);
  } else if (Array.isArray(raw.grid)) {
    // Fallback: row-string format
    for (let r = 0; r < rows; r++) {
      const rowStr = (raw.grid[r] ?? '').padEnd(cols, '#');
      for (let c = 0; c < cols; c++) {
        if (rowStr[c] === '#') cells[r][c] = false;
      }
    }
  }

  // Enforce 180° rotational symmetry — catches missed black cells
  const { cells: symCells, fixes } = enforceSymmetry(cells);
  if (fixes > 0) console.log('[solve] symmetry fixed', fixes, 'cell pairs');

  // Derive numbers algorithmically — don't trust Claude to count them
  const numbers = deriveNumbers(symCells);

  console.log('[solve] grid ok — rows:', rows, 'cols:', cols,
    'black cells:', symCells.flat().filter(v => !v).length,
    'numbers:', numbers.length);

  return { rows, cols, cells: symCells, numbers };
}

// ── Pass 2: clues + answers ───────────────────────────────────────────────────
async function extractClues(base64: string, mimeType: ImageMime) {
  console.log('[solve] calling Claude for clues...');
  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          {
            type: 'text',
            text: `Read every Across and Down clue visible in this crossword photo, then solve them.

Return ONLY JSON — no prose, no markdown:
{
  "across": [{"n": 1, "clue": "clue text", "answer": "ANSWER"}],
  "down":   [{"n": 1, "clue": "clue text", "answer": "ANSWER"}]
}

Rules:
- Copy clue text as accurately as you can. If a word is unclear, make your best guess.
- Answers uppercase, no spaces or punctuation.
- Include EVERY clue you can partially or fully read — do not skip clues because the image is blurry.
- If you cannot read a clue at all, omit it. Never refuse to return JSON.
- Return empty arrays if nothing is readable: {"across":[],"down":[]}`,
          },
        ],
      },
    ],
  });

  const text = res.content[0].type === 'text' ? res.content[0].text : '';
  console.log('[solve] clues raw response (first 300):', text.slice(0, 300));
  const parsed = tryParseJson(text) as Record<string, unknown>;
  console.log('[solve] clues parsed ok');
  return parsed;
}

// ── Route handler ─────────────────────────────────────────────────────────────
export async function POST(req: Request) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('[solve] ANTHROPIC_API_KEY not set');
      return Response.json({ error: 'ANTHROPIC_API_KEY is not set.' }, { status: 500 });
    }

    const body    = await req.json();
    const fileKey = (body.fileKey ?? '') as string;
    const fileUrl = (body.fileUrl ?? '') as string;
    console.log('[solve] POST received, fileKey:', fileKey, 'fileUrl:', fileUrl ? 'provided' : 'none');

    if (!fileKey) {
      return Response.json({ error: 'fileKey is required' }, { status: 400 });
    }

    const { base64, mimeType } = await getImage(fileKey, fileUrl || undefined);

    const [gridData, clueData] = await Promise.all([
      extractGrid(base64, mimeType),
      extractClues(base64, mimeType),
    ]);

    const puzzle = {
      rows:    gridData.rows,
      cols:    gridData.cols,
      cells:   gridData.cells,
      numbers: gridData.numbers,
      across:  Array.isArray(clueData.across) ? clueData.across : [],
      down:    Array.isArray(clueData.down)   ? clueData.down   : [],
    };

    const ratio = puzzle.across.length / Math.max(puzzle.down.length, 1);
    if (ratio > 3 || ratio < 0.33) {
      console.warn('[solve] WARNING: clue ratio suspicious —',
        'across:', puzzle.across.length, 'down:', puzzle.down.length,
        '— grid may be misread');
    }
    console.log('[solve] success — rows:', puzzle.rows, 'cols:', puzzle.cols,
      'across:', puzzle.across.length, 'down:', puzzle.down.length);
    return Response.json({ ok: true, puzzle });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[solve] error:', msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
