/** Presentation of literal search hits. File access remains owned by FileService. */
export async function searchExcerpts(
  files: string[], query: string, maxResults: number, contextLines: number,
  read: (file: string) => Promise<string>,
): Promise<string> {
  if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 20) throw new Error('contextLines must be an integer from 0 to 20.');
  const needle = query.toLowerCase();
  const output: string[] = [];
  let count = 0, limited = false, clipped = false;
  for (const file of files) {
    let text: string;
    try { text = await read(file); } catch { continue; } // Same binary/size/access exclusions as normal search.
    const lines = text.split('\n');
    const hits: number[] = [];
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].toLowerCase().includes(needle)) continue;
      if (count === maxResults) { limited = true; break; }
      hits.push(index); count++;
    }
    if (hits.length) {
      const groups: { start: number; end: number }[] = [];
      for (const hit of hits) {
        const start = Math.max(0, hit - contextLines), end = Math.min(lines.length - 1, hit + contextLines);
        const previous = groups.at(-1);
        if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end);
        else groups.push({ start, end });
      }
      output.push(file);
      const selected = new Set(hits);
      for (const group of groups) {
        output.push(`[lines ${group.start + 1}-${group.end + 1} of ${lines.length}]`);
        for (let index = group.start; index <= group.end; index++) {
          const long = lines[index].length > 500;
          clipped ||= long;
          output.push(`${selected.has(index) ? '>' : ' '} ${index + 1}: ${lines[index].slice(0, 500)}${long ? ' [line truncated]' : ''}`);
        }
      }
    }
    if (limited) break;
  }
  if (!count) return 'No matching text found in permitted files.';
  if (limited) output.push('[Result limit reached; narrow query/path or increase maxResults.]');
  if (clipped) output.push('[Use read_file with path/startLine/endLine to read complete lines.]');
  return output.join('\n');
}
