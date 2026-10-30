import { createHash } from 'node:crypto';

/** Check the serialized request that will actually leave the agent runtime. */
export function verifyDomainRequest(body: any, common: string, tools: { name: string; description: string; parameters: unknown }[]) {
  // Compaction has a separate summarization prompt and no tool catalog.
  if (!body.tools?.length) return { kind: 'non-tool-request' as const };
  const system = body.messages.filter((m: any) => m.role === 'system').map((m: any) =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  if (!system.includes(common)) throw new Error('Benchmark pre-dispatch guard: full customer-service instructions and domain policy are missing');
  const catalog = new Map(body.tools.map((t: any) => [t.function?.name, t.function]));
  for (const tool of tools) {
    const wire: any = catalog.get(tool.name);
    if (!wire || wire.description !== tool.description || JSON.stringify(wire.parameters) !== JSON.stringify(tool.parameters))
      throw new Error(`Benchmark pre-dispatch guard: business tool contract changed: ${tool.name}`);
  }
  return { kind: 'agent-request' as const, fullPolicyPresent: true, businessTools: tools.length,
    policySha256: createHash('sha256').update(common).digest('hex'), systemChars: system.length };
}
