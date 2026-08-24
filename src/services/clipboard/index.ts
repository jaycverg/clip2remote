import { ClipboardContent } from './contract';
import { describeLinuxBackend, readLinuxClipboard } from './linux';
import { describeMacBackend, readMacClipboard } from './macos';

export { ClipboardContent, STAGING_DIR } from './contract';

/** Client platforms with a clipboard backend. Anywhere else, paste is left to VS Code. */
export function isSupportedPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'linux';
}

/**
 * Reads the local clipboard using the backend for the client platform.
 *
 * Every backend answers with the same {@link ClipboardContent} shape, so the caller
 * never branches on platform — adding one is a matter of adding a case here.
 */
export function readClipboard(extensionPath: string): Promise<ClipboardContent> {
  switch (process.platform) {
    case 'darwin':
      return readMacClipboard(extensionPath);
    case 'linux':
      return readLinuxClipboard();
    default:
      return Promise.resolve({
        kind: 'unavailable',
        message: `no clipboard backend for platform "${process.platform}"`,
      });
  }
}

/** One-line description of the active backend, for the diagnostics report. */
export function describeBackend(): string {
  switch (process.platform) {
    case 'darwin':
      return describeMacBackend();
    case 'linux':
      return describeLinuxBackend();
    default:
      return `unsupported platform "${process.platform}"`;
  }
}
