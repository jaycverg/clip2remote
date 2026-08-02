import * as vscode from 'vscode';

/**
 * Types text into the focused terminal.
 *
 * Uses `workbench.action.terminal.sendSequence` rather than the `Terminal.sendText`
 * API on purpose. This extension runs on the local machine (`extensionKind: ui`)
 * while the terminal lives on the remote host; `sendSequence` is a core command
 * handled renderer-side, so it is indifferent to which extension host issued it.
 *
 * Measured on a live Remote-SSH window, `window.activeTerminal` *is* visible to the
 * local host, so `sendText` would probably work too — but that visibility is not
 * something the API contract promises, and the renderer-side command costs nothing.
 */
export async function insertIntoTerminal(text: string): Promise<boolean> {
  try {
    await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', { text });
    return true;
  } catch {
    return fallbackViaClipboard(text);
  }
}

/** Last resort: stage the text on the clipboard and trigger the terminal's own paste. */
async function fallbackViaClipboard(text: string): Promise<boolean> {
  try {
    await vscode.env.clipboard.writeText(text);
    await vscode.commands.executeCommand('workbench.action.terminal.paste');
    return true;
  } catch {
    return false;
  }
}

/** Hands the keystroke back to VS Code so a normal (text) paste behaves as usual. */
export async function passThroughPaste(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.terminal.paste');
}
