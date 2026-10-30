import { rename, writeFile } from 'node:fs/promises';

/** Replace complete snapshots atomically, including the pre-dispatch reservation. */
export async function durableJson(file: string, value: unknown) {
  const temporary = `${file}.next`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}
