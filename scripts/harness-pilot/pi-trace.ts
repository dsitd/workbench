import { StringDecoder } from 'node:string_decoder';

/** Count terminal events while streaming; repeated progress snapshots must not hide the final response. */
export class PiTraceCapture {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private ended = false;
  private bytes = 0;
  private readonly lines: string[] = [];
  steps = 0;
  toolCalls = 0;
  toolErrors = 0;
  droppedProgress = 0;
  truncated = false;
  lastAssistant?: { stopReason?: string; errorMessage?: string };

  constructor(private readonly archiveLimit = 32 * 1024 * 1024) {}

  write(chunk: Buffer) {
    this.pending += this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newline); this.pending = this.pending.slice(newline + 1);
      this.line(line);
    }
  }

  end() {
    if (this.ended) return;
    this.ended = true; this.pending += this.decoder.end();
    if (this.pending.trim()) this.line(this.pending);
    this.pending = '';
  }

  private line(line: string) {
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'tool_execution_end') {
      this.toolCalls++; if (event.isError) this.toolErrors++;
    } else if (event.type === 'message_end') {
      if (event.message?.role === 'assistant') {
        this.steps++; this.lastAssistant = { stopReason: event.message.stopReason, errorMessage: event.message.errorMessage };
      }
    } else { this.droppedProgress++; return; }
    const size = Buffer.byteLength(line) + 1;
    if (this.bytes + size <= this.archiveLimit) { this.lines.push(line); this.bytes += size; }
    else this.truncated = true;
  }

  text() { return this.lines.join('\n') + '\n'; }
}
