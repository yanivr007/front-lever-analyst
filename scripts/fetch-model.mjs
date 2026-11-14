// Downloads the pose model once so the app is fully self-contained (no network needed at runtime).
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const out = 'public/models/pose_landmarker_full.task';
if (!existsSync(out)) {
  mkdirSync('public/models', { recursive: true });
  execFileSync('curl', ['-fsSL', '-o', out,
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task'], { stdio: 'inherit' });
}
