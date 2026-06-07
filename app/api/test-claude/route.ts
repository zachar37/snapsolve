import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function GET() {
  try {
    const res = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Reply with: OK' }],
    });
    const text = res.content[0].type === 'text' ? res.content[0].text : '';
    return Response.json({ ok: true, model: res.model, reply: text });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
