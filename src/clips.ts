// Video of recent sets, kept in memory only – nothing is written to storage, and every clip is
// gone when the app is closed. Only the last few sets are kept so memory stays bounded.

const MAX_CLIPS = 10;
const clips = new Map<string, string>(); // set id → blob URL

export function getClip(id: string): string | undefined { return clips.get(id); }

export function putClip(id: string, blob: Blob): string {
  deleteClip(id);
  const url = URL.createObjectURL(blob);
  clips.set(id, url);
  while (clips.size > MAX_CLIPS) deleteClip(clips.keys().next().value!);
  return url;
}

export function deleteClip(id: string) {
  const url = clips.get(id);
  if (url) { URL.revokeObjectURL(url); clips.delete(id); }
}

const MIME = ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'];

export const canRecord = () =>
  typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';

/** Records one set from a media stream. */
export class SetRecorder {
  private rec: MediaRecorder;
  private chunks: Blob[] = [];
  private cancelled = false;
  private done: Promise<Blob | null>;

  constructor(stream: MediaStream) {
    const mimeType = MIME.find(m => MediaRecorder.isTypeSupported(m));
    this.rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });
    this.rec.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
    this.done = new Promise(res => {
      this.rec.onstop = () => res(!this.cancelled && this.chunks.length ? new Blob(this.chunks, { type: this.rec.mimeType || 'video/webm' }) : null);
      this.rec.onerror = () => res(null);
    });
    this.rec.start(1000);
  }

  /** Stop after `tailMs` more milliseconds (so the moment the form broke is on video). */
  finish(tailMs = 0): Promise<Blob | null> {
    const stop = () => { if (this.rec.state !== 'inactive') this.rec.stop(); };
    if (tailMs > 0) setTimeout(stop, tailMs); else stop();
    return this.done;
  }

  cancel() { this.cancelled = true; if (this.rec.state !== 'inactive') this.rec.stop(); }
}

/** Chrome writes WebM without a duration, which breaks the seek bar. Force it to be computed. */
export function fixDuration(v: HTMLVideoElement) {
  v.addEventListener('loadedmetadata', () => {
    if (v.duration !== Infinity) return;
    v.currentTime = 1e101;
    v.addEventListener('timeupdate', () => { v.currentTime = 0; }, { once: true });
  }, { once: true });
}
