import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

const MODEL = new URL('./models/pose_landmarker_full.task', document.baseURI).href;

let cached: Promise<PoseLandmarker> | null = null;

export function loadPose(): Promise<PoseLandmarker> {
  cached ??= (async () => {
    const fileset = await FilesetResolver.forVisionTasks(new URL('./wasm', document.baseURI).href);
    const make = (delegate: 'GPU' | 'CPU') => PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.4, minPosePresenceConfidence: 0.4, minTrackingConfidence: 0.4,
    });
    let pose: PoseLandmarker;
    try { pose = await make('GPU'); } catch { pose = await make('CPU'); }
    // The first inference is slow (shader/graph warm-up) – pay for it here, not on the first video frame.
    const blank = document.createElement('canvas'); blank.width = blank.height = 256;
    blank.getContext('2d')!.fillRect(0, 0, 256, 256);
    pose.detectForVideo(blank, performance.now());
    return pose;
  })();
  cached.catch(() => { cached = null; });
  return cached;
}
