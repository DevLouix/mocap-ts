import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

export interface ExtractOptions {
  /** Frames per second to extract. Defaults to source fps. */
  fps?: number;
  /** Output directory for frames. Defaults to temp dir. */
  outDir?: string;
  /** Verbose logging to stderr. */
  verbose?: boolean;
}

export interface ExtractResult {
  /** Absolute paths to extracted frame PNGs, in order. */
  frames: string[];
  /** Directory containing the frames. */
  dir: string;
  /** Detected source FPS (if available). */
  sourceFps?: number;
  /** Title of the video (from yt-dlp metadata, if downloaded). */
  title?: string;
}

const YT_URL_RE = /^https?:\/\/(www\.)?(youtube\.com\/(watch|shorts|embed|live)|youtu\.be\/)/;

/** Check if a string looks like a YouTube URL. */
export function isYouTubeUrl(input: string): boolean {
  return YT_URL_RE.test(input);
}

/** More broadly, check if it looks like any video URL yt-dlp might handle. */
export function isVideoUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Download a video from a URL using yt-dlp.
 * Returns the path to the downloaded file and its title.
 */
export function downloadVideo(
  url: string,
  options: { outDir?: string; verbose?: boolean } = {},
): { videoPath: string; title: string } {
  const outDir = options.outDir ?? mkdtempSync(join(tmpdir(), 'mocap-dl-'));

  // Find yt-dlp binary
  const bin = findBinary('yt-dlp');
  if (!bin) {
    throw new Error(
      'yt-dlp not found. Install it:\n' +
      '  pip install yt-dlp\n' +
      '  brew install yt-dlp\n' +
      '  or download from https://github.com/yt-dlp/yt-dlp/releases',
    );
  }

  if (options.verbose) console.error(`[mocap-ts] Downloading: ${url}`);

  // Get title first (for output filename)
  let title = 'video';
  try {
    title = execFileSync(bin, [
      '--get-title',
      '--no-warnings',
      url,
    ], { encoding: 'utf-8', timeout: 30000 }).trim();
    // Sanitize for filesystem
    title = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
  } catch {
    // Fall back to generic name
  }

  const outTemplate = join(outDir, '%(title).80B.%(ext)s');

  const args = [
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--no-warnings',
    '-o', outTemplate,
    url,
  ];

  if (!options.verbose) {
    args.unshift('--quiet');
  }

  execFileSync(bin, args, {
    stdio: options.verbose ? 'inherit' : 'pipe',
    timeout: 300000, // 5 minutes max
  });

  // Find the downloaded file
  const files = readdirSync(outDir).filter(f =>
    f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.webm'),
  );

  if (files.length === 0) {
    throw new Error('yt-dlp completed but no video file found in output directory');
  }

  const videoPath = join(outDir, files[0]);
  if (options.verbose) console.error(`[mocap-ts] Downloaded: ${videoPath}`);

  return { videoPath, title };
}

/** Try to find a binary in PATH. */
function findBinary(name: string): string | null {
  try {
    const result = execFileSync('which', [name], { encoding: 'utf-8' }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Extract frames from a video file using ffmpeg.
 * Returns ordered list of PNG file paths.
 */
export function extractFrames(videoPath: string, options: ExtractOptions = {}): ExtractResult {
  const outDir = options.outDir ?? mkdtempSync(join(tmpdir(), 'mocap-'));

  // Probe source FPS
  let sourceFps: number | undefined;
  try {
    const probeOut = execFileSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate',
      '-of', 'csv=p=0',
      videoPath,
    ], { encoding: 'utf-8' }).trim();
    const [num, den] = probeOut.split('/').map(Number);
    if (num && den) sourceFps = num / den;
  } catch {
    // ffprobe not available or failed — continue without source fps
  }

  const args = [
    '-i', videoPath,
    '-vsync', 'vfr',
  ];

  if (options.fps) {
    args.push('-vf', `fps=${options.fps}`);
  }

  args.push(
    '-frame_pts', '1',
    join(outDir, 'frame_%06d.png'),
  );

  execFileSync('ffmpeg', args, { stdio: 'pipe' });

  const frames = readdirSync(outDir)
    .filter(f => f.startsWith('frame_') && f.endsWith('.png'))
    .sort()
    .map(f => join(outDir, f));

  return { frames, dir: outDir, sourceFps };
}

/**
 * Load a directory of pre-extracted frame images.
 * Supports PNG, JPG, JPEG.
 */
export function loadFrameDir(dir: string): string[] {
  const exts = new Set(['.png', '.jpg', '.jpeg']);
  return readdirSync(dir)
    .filter(f => exts.has(f.slice(f.lastIndexOf('.')).toLowerCase()))
    .sort()
    .map(f => join(dir, f));
}
