export interface SandboxOptions {
  roots: { path: string; access: 'read' | 'write' }[];
  temporary: string;
  internet: boolean;
  privateRoot?: string;
  skillRoots?: string[];
  metadataReadRoots?: string[];
  readFiles?: string[];
  deniedFiles?: string[];
  /** Benchmark gateway only. Linux uses a socket relay, never host networking. */
  localhostPort?: number;
}

export interface SandboxLaunch {
  executable: string;
  args: string[];
  cleanup(): Promise<void>;
}
