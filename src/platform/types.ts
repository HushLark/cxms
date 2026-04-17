// ─────────────────────────────────────────────────────────────────────────────
// Platform Abstraction — Type Definitions
// ─────────────────────────────────────────────────────────────────────────────
//
// These interfaces decouple CxMS from Node.js-specific APIs (fs, path, os)
// so the same code can run on Node.js, React Native, or other runtimes.
// ─────────────────────────────────────────────────────────────────────────────

export interface StorageProvider {
    readFile(filePath: string, encoding?: string): Promise<string>;
    writeFile(filePath: string, content: string): Promise<void>;
    readdir(dirPath: string): Promise<string[]>;
    mkdir(dirPath: string, opts?: { recursive?: boolean }): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    access(filePath: string): Promise<void>;
    unlink(filePath: string): Promise<void>;
    appendFile(filePath: string, content: string): Promise<void>;
    stat(filePath: string): Promise<FileStat>;
    realpath?(filePath: string): Promise<string>;
}

export interface FileStat {
    isDirectory: boolean;
    isFile: boolean;
    mtime: Date;
    size: number;
}

export interface PathProvider {
    join(...parts: string[]): string;
    basename(p: string, ext?: string): string;
    dirname(p: string): string;
    resolve(...parts: string[]): string;
    extname(p: string): string;
    readonly sep: string;
}

export interface PlatformProvider {
    readonly storage: StorageProvider;
    readonly paths: PathProvider;
    homedir(): string;
    generateId(length: number): string;
}
