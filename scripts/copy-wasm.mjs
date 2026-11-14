// Copies the MediaPipe WASM runtime into public/ so the app is self-hosted (works offline).
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('public/wasm', { recursive: true });
cpSync('node_modules/@mediapipe/tasks-vision/wasm', 'public/wasm', { recursive: true });
