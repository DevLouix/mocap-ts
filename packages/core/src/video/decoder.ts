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
  options: { outDir?: string; verbose?: boolean; cookieFile?: string } = {},
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

  // Pass browser cookies when available. YouTube (and other sites) routinely
  // bot-check datacenter IPs; cookies from a logged-in browser session are
  // the standard workaround. Resolution order:
  //   1. explicit option, 2. YTDLP_COOKIES_FILE env, 3. <data root>/cookies.txt
  const cookieFile = options.cookieFile
    ?? process.env.YTDLP_COOKIES_FILE
    ?? join(process.env.MOCAP_DATA_DIR ?? join(process.cwd(), '.mocap'), 'cookies.txt');
  if (existsSync(cookieFile)) {
    args.unshift('--cookies', cookieFile);
    if (options.verbose) console.error(`[mocap-ts] Using cookies: ${cookieFile}`);
  }

  try {
    execFileSync(bin, args, {
      encoding: 'utf-8',
      timeout: 300000, // 5 minutes max
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw explainYtDlpError(err, url);
  }

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

/**
 * Translate a raw yt-dlp failure into an actionable error message.
 *
 * The most common case by far: YouTube's bot check on datacenter IPs
 * ("Sign in to confirm you're not a bot"), which is fixed by supplying
 * cookies — not by retrying.
 */
function explainYtDlpError(err: unknown, url: string): Error {
  const e = err as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
  const stderr = [e.stderr, e.stdout, e.message]
    .map(p => (typeof p === 'string' ? p : Buffer.isBuffer(p) ? p.toString('utf-8') : ''))
    .join('\n');
  const tail = stderr.trim().split('\n').slice(-6).join('\n');

  if (/sign in to confirm|not a bot/i.test(stderr)) {
    return new Error(
      'The video host is asking this server to sign in (bot check). This is ' +
      'typical for datacenter/cloud IPs on YouTube.\n' +
      'Fix: export cookies from a browser logged into YouTube and point the ' +
      'app at them:\n' +
      '  1. In a logged-in browser, save cookies.txt (Netscape format), e.g. with ' +
      'the "Get cookies.txt" extension.\n' +
      '  2. Set YTDLP_COOKIES_FILE=/path/to/cookies.txt for the server ' +
      '(or place it at <data dir>/cookies.txt, e.g. .mocap/cookies.txt).\n' +
      '  3. Re-submit the job.\n' +
      'See https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp',
    );
  }
  if (/sign in to confirm your age|age.?restricted/i.test(stderr)) {
    return new Error(
      'This video is age-restricted, which requires authenticated cookies.\n' +
      'Set YTDLP_COOKIES_FILE (see README) with a logged-in account and retry.',
    );
  }
  if (/private video|video unavailable|members-only/i.test(stderr)) {
    return new Error(`The video at ${url} is private, unavailable, or members-only.`);
  }
  if (/http error 429|too many requests/i.test(stderr)) {
    return new Error(
      'The video host is rate-limiting this server (HTTP 429). Wait and retry, ' +
      'or use cookies (YTDLP_COOKIES_FILE).',
    );
  }
  return new Error(`yt-dlp failed for ${url}.\n${tail}`);
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
