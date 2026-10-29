import { AgentError } from './errors';

/** Hold a suffix so a known credential split across stream chunks is never emitted. */
export class CredentialRedactor {
  private pending = '';
  constructor(private readonly credential: string | undefined, private readonly emit?: (text: string) => void) {}
  text(value: string): string {
    return this.credential ? value.split(this.credential).join('[credential redacted]') : value;
  }
  delta(value: string): void {
    this.pending = this.text(this.pending + value);
    const safeLength = this.credential ? Math.max(0, this.pending.length - this.credential.length + 1) : this.pending.length;
    if (safeLength) this.emit?.(this.pending.slice(0, safeLength));
    this.pending = this.pending.slice(safeLength);
  }
  finish(): void {
    if (this.pending) this.emit?.(this.text(this.pending));
    this.pending = '';
  }
  rejectEcho(value: unknown): void {
    if (this.credential && JSON.stringify(value)?.includes(this.credential))
      throw new AgentError('API вернул credential в структурированном ответе. Ответ отклонён; проверьте адрес API.');
  }
}
