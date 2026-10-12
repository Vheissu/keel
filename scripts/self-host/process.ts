import { spawn } from 'node:child_process';

export function start(command: string, args: string[], env = process.env) {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let failure = '';

  child.stderr.on('data', (data: Buffer) => {
    // Keep a bounded diagnostic buffer; callers only use it for local Docker/tool failures.
    failure = (failure + data.toString('utf8')).slice(-8192);
  });

  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);

    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${code}. ${failure.trim()}`));
      }
    });
  });

  // A pipeline may still be starting when the process fails.
  void done.catch(() => {});

  return { child, done };
}

export async function run(command: string, args: string[], env = process.env) {
  const { child, done } = start(command, args, env);
  const chunks: Buffer[] = [];
  let size = 0;

  child.stdin.end();

  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length;

    if (size > 8 * 1024 * 1024) {
      child.kill();
    } else {
      chunks.push(chunk);
    }
  });

  try {
    await done;
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : 'Command failed.'}\n${Buffer.concat(chunks).toString('utf8').slice(-8192)}`,
    );
  }

  return Buffer.concat(chunks).toString('utf8');
}
