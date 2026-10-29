export interface TextEdit { oldText: string; newText: string; replaceAll?: boolean }

/** Resolve every replacement against one immutable version, then commit once. */
export function applyTextEdits(original: string, edits: readonly TextEdit[]): string {
  if (!Array.isArray(edits) || !edits.length || edits.length > 100) throw new Error('Supply 1–100 edits.');
  const replacements: { start: number; end: number; text: string }[] = [];
  for (const [index, edit] of edits.entries()) {
    if (!edit || typeof edit.oldText !== 'string' || !edit.oldText || typeof edit.newText !== 'string'
      || edit.replaceAll !== undefined && typeof edit.replaceAll !== 'boolean') throw new Error(`Invalid edit ${index + 1}: oldText must be nonempty and newText a string.`);
    const hits: number[] = [];
    for (let at = original.indexOf(edit.oldText); at >= 0; at = original.indexOf(edit.oldText, at + (edit.replaceAll ? edit.oldText.length : 1))) hits.push(at);
    if (!hits.length) throw new Error(`Edit ${index + 1}: text not found in the original file. Read the file again.`);
    if (hits.length > 1 && !edit.replaceAll) throw new Error(`Edit ${index + 1}: text occurs more than once. Supply a unique passage or replaceAll.`);
    for (const start of hits) replacements.push({ start, end: start + edit.oldText.length, text: edit.newText });
  }
  replacements.sort((a, b) => a.start - b.start);
  for (let index = 1; index < replacements.length; index++) if (replacements[index].start < replacements[index - 1].end)
    throw new Error('Edits overlap in the original file; no changes were made.');
  let output = '', cursor = 0;
  for (const item of replacements) { output += original.slice(cursor, item.start) + item.text; cursor = item.end; }
  return output + original.slice(cursor);
}
