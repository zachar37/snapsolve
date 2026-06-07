import Anthropic from '@anthropic-ai/sdk';

export const runtime    = 'nodejs';
export const maxDuration = 60;

type ImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Fetch image from UploadThing ─────────────────────────────────────────────
async function getImage(fileKey: string): Promise<{ base64: string; mimeType: ImageMime }> {
  const urls = [
    `https://utfs.io/f/${fileKey}`,
    `https://aqtpcqyz9z.ufs.sh/f/${fileKey}`,
    `https://ufs.sh/f/${fileKey}`,
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
    model: 'claude-3-5-sonnet-latest',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          {
            type: 'text',
            text: `This image contains a crossword puzzle. Focus on the BLANK grid (small corner numbers only — no filled-in letters).

Draw the grid row by row as strings:
- '#' for every BLACK (filled/blocked) square
- '.' for every WHITE (open) square
- Every string must be exactly the same length (number of columns)
- Most newspaper crosswords are 15×15 — count carefully

Return ONLY this JSON (no prose, no markdown):
{"rows":15,"cols":15,"grid":["...#...#..#....","...............", ...]}

The "grid" array must have exactly "rows" strings, each exactly "cols" characters, using only '#' and '.'.`,
          },
        ],
      },
      { role: 'assistant', content: '{' },
    ],
  });

  const text = '{' + (res.content[0].type === 'text' ? res.content[0].text : '');
  console.log('[solve] grid raw response (first 500):', text.slice(0, 500));

  const raw = tryParseJson(text) as { rows: number; cols: number; grid: string[] };

  const rows = Number(raw.rows) || (raw.grid?.length ?? 15);
  const cols = Number(raw.cols) || (raw.grid?.[0]?.length ?? 15);
  const grid = raw.grid ?? [];

  // Build boolean cells — normalise row lengths in case Claude was inconsistent
  const cells: boolean[][] = Array.from({ length: rows }, (_, r) => {
    const rowStr = (grid[r] ?? '').padEnd(cols, '#');
    return Array.from({ length: cols }, (_, c) => rowStr[c] !== '#');
  });

  // Derive numbers algorithmically — don't trust Claude to count them
  const numbers = deriveNumbers(cells);

  console.log('[solve] grid ok — rows:', rows, 'cols:', cols,
    'black cells:', cells.flat().filter(v => !v).length,
    'numbers:', numbers.length);

  return { rows, cols, cells, numbers };
}

// ── Pass 2: clues + answers ───────────────────────────────────────────────────
async function extractClues(base64: string, mimeType: ImageMime) {
  console.log('[solve] calling Claude for clues...');
  const res = await client.messages.create({
    model: 'claude-3-5-sonnet-latest',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          {
            type: 'text',
            text: `Read every Across and Down clue in this crossword photo exactly as printed, then solve them.

Return ONLY JSON — no prose, no markdown:
{
  "across": [{"n": 1, "clue": "exact clue text", "answer": "ANSWER"}],
  "down":   [{"n": 1, "clue": "exact clue text", "answer": "ANSWER"}]
}

Rules:
- Copy clue text word for word.
- Answers uppercase, no spaces or punctuation.
- Include every clue you can read.`,
          },
        ],
      },
      { role: 'assistant', content: '{' },
    ],
  });

  const text = '{' + (res.content[0].type === 'text' ? res.content[0].text : '');
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
    console.log('[solve] POST received, fileKey:', fileKey);

    if (!fileKey) {
      return Response.json({ error: 'fileKey is required' }, { status: 400 });
    }

    const { base64, mimeType } = await getImage(fileKey);

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

    console.log('[solve] success — rows:', puzzle.rows, 'cols:', puzzle.cols,
      'across:', puzzle.across.length, 'down:', puzzle.down.length);
    return Response.json({ ok: true, puzzle });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[solve] error:', msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
