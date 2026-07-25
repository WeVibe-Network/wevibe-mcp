import type { IncomingMessage } from 'node:http';

export async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    req.on('data', (chunk: string) => chunks.push(chunk));
    req.on('end', () => resolve(chunks.join('')));
    req.on('error', reject);
  });
}
