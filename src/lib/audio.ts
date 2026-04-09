/**
 * audio.ts — Differentiated alert sounds via macOS afplay
 *
 * Four distinct sounds for four agent states.
 * Volume levels per type. No dependencies beyond macOS built-in afplay.
 */

import { execFile } from "child_process";

export type SoundType =
  | "needs-input"
  | "needs-approval"
  | "destructive"
  | "done";

const SOUND_MAP: Record<SoundType, string> = {
  "needs-input": "/System/Library/Sounds/Glass.aiff",
  "needs-approval": "/System/Library/Sounds/Submarine.aiff",
  destructive: "/System/Library/Sounds/Basso.aiff",
  done: "/System/Library/Sounds/Purr.aiff",
};

const VOLUME_MAP: Record<SoundType, number> = {
  "needs-input": 0.6,
  "needs-approval": 0.8,
  destructive: 1.0,
  done: 0.3,
};

export function playSound(type: SoundType): void {
  const sound = SOUND_MAP[type];
  const volume = VOLUME_MAP[type];

  execFile("afplay", ["-v", String(volume), sound], (err) => {
    if (err) {
      // Silent failure — audio is non-critical
    }
  });
}
