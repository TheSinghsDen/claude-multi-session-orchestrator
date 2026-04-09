/**
 * ghostty-bridge.ts — Ghostty AppleScript interface
 *
 * Implements TerminalBridge interface for Ghostty via osascript.
 * Enumerates tabs, reads state, switches focus, sends targeted input.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

export interface TerminalTab {
  tabIndex: number;
  tabName: string;
  terminalId: string;
  workingDirectory: string;
}

export interface TerminalBridge {
  listTabs(): Promise<TerminalTab[]>;
  focusTab(terminalId: string): Promise<void>;
  sendInput(terminalId: string, text: string): Promise<void>;
  isAvailable(): Promise<boolean>;
}

const OSASCRIPT_TIMEOUT = 3000;

async function runAppleScript(script: string): Promise<string> {
  const { stdout } = await exec("osascript", ["-e", script], {
    timeout: OSASCRIPT_TIMEOUT,
  });
  return stdout.trim();
}

export class GhosttyBridge implements TerminalBridge {
  async isAvailable(): Promise<boolean> {
    try {
      await runAppleScript(
        'tell application "System Events" to return (name of processes) contains "Ghostty"'
      );
      return true;
    } catch {
      return false;
    }
  }

  async listTabs(): Promise<TerminalTab[]> {
    const script = `
tell application "Ghostty"
  set output to ""
  set windowList to every window
  repeat with w in windowList
    set tabList to every tab of w
    repeat with t in tabList
      set tabName to name of t
      set tabIdx to index of t
      set termList to every terminal of t
      repeat with term in termList
        set termId to id of term
        set termDir to working directory of term
        set output to output & tabIdx & "\\t" & tabName & "\\t" & termId & "\\t" & termDir & linefeed
      end repeat
    end repeat
  end repeat
  return output
end tell`;

    try {
      const result = await runAppleScript(script);
      if (!result) return [];

      return result
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          const [tabIndex, tabName, terminalId, workingDirectory] =
            line.split("\t");
          return {
            tabIndex: parseInt(tabIndex, 10),
            tabName: tabName || "",
            terminalId: terminalId || "",
            workingDirectory: workingDirectory || "",
          };
        });
    } catch {
      return [];
    }
  }

  async focusTab(terminalId: string): Promise<void> {
    const script = `
tell application "Ghostty"
  set termList to every terminal of every tab of every window
  repeat with w in every window
    repeat with t in every tab of w
      repeat with term in every terminal of t
        if id of term is "${terminalId}" then
          select t
          activate w
          focus term
          return
        end if
      end repeat
    end repeat
  end repeat
end tell`;
    await runAppleScript(script);
  }

  async sendInput(terminalId: string, text: string): Promise<void> {
    // Escape double quotes and backslashes in the text
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `
tell application "Ghostty"
  repeat with w in every window
    repeat with t in every tab of w
      repeat with term in every terminal of t
        if id of term is "${terminalId}" then
          input text "${escaped}" to term
          return
        end if
      end repeat
    end repeat
  end repeat
end tell`;
    await runAppleScript(script);
  }
}
