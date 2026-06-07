export const runtime = 'edge';

export async function GET() {
  const token = process.env.UPLOADTHING_TOKEN ?? 'NOT SET';
  return Response.json({
    length: token.length,
    first10: token.substring(0, 10),
    last10: token.substring(token.length - 10),
    hasQuotes: token.startsWith("'") || token.startsWith('"'),
  });
}
