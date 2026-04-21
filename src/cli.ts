#!/usr/bin/env node

import { parseArgs } from 'node:util';

export interface CliOptions {
  input: string;
  output: string;
  fps?: number;
  hands: boolean;
  smoothing: number;
  verbose: boolean;
}

export function parseCli(argv: string[] = process.argv.slice(2)): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: 'string', short: 'i' },
      output: { type: 'string', short: 'o' },
      fps: { type: 'string', short: 'f' },
      hands: { type: 'boolean', default: true },
      'no-hands': { type: 'boolean' },
      smoothing: { type: 'string', short: 's' },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  if (!values.input) {
    console.error('Error: --input is required');
    printUsage();
    process.exit(1);
  }

  // For URLs, default output to 'output.bvh' (pipeline will rename from video title)
  const isUrl = /^https?:\/\//.test(values.input);
  const output = values.output ?? (isUrl ? 'output.bvh' : values.input.replace(/\.[^.]+$/, '.bvh'));
  const fps = values.fps ? Number(values.fps) : undefined;
  const smoothing = values.smoothing ? Number(values.smoothing) : 0.7;
  const hands = values['no-hands'] ? false : (values.hands ?? true);

  if (fps !== undefined && (isNaN(fps) || fps <= 0 || fps > 240)) {
    console.error('Error: --fps must be between 1 and 240');
    process.exit(1);
  }

  if (isNaN(smoothing) || smoothing < 0 || smoothing > 1) {
    console.error('Error: --smoothing must be between 0 and 1');
    process.exit(1);
  }

  return {
    input: values.input,
    output,
    fps,
    hands,
    smoothing,
    verbose: values.verbose ?? false,
  };
}

function printUsage(): void {
  console.log(`
mocap-ts — Video to BVH motion capture

Usage:
  mocap-ts --input video.mp4 [--output anim.bvh] [options]
  mocap-ts -i https://youtube.com/watch?v=... -o dance.bvh
  mocap-ts -i video.mp4 -o anim.bvh --fps 30 --no-hands

Input:
  Local video file, directory of frame images, or a URL (YouTube, etc).
  URLs are downloaded via yt-dlp (must be installed separately).

Options:
  -i, --input <path|url>  Input video, frame dir, or URL (required)
  -o, --output <path>     Output BVH file (default: <title>.bvh)
  -f, --fps <number>      Frame extraction rate (default: source fps)
  --hands / --no-hands    Include hand tracking (default: --hands)
  -s, --smoothing <0-1>   EMA smoothing alpha (default: 0.7)
  -v, --verbose           Verbose output
  -h, --help              Show this help

Examples:
  mocap-ts -i dance.mp4
  mocap-ts -i https://www.youtube.com/watch?v=dQw4w9WgXcQ
  mocap-ts -i dance.mp4 -o dance.bvh --fps 30
  mocap-ts -i dance.mp4 --no-hands --smoothing 0.5
  mocap-ts -i ./frames/ -o anim.bvh
`.trim());
}

// Entry point — only runs when executed directly
async function main(): Promise<void> {
  const opts = parseCli();
  // Pipeline integration will be wired in Phase 7
  const { runPipeline } = await import('./pipeline.js');
  await runPipeline(opts);
}

// Detect if running as the main module
const isMain = process.argv[1]?.endsWith('cli.js') || process.argv[1]?.endsWith('cli.ts');
if (isMain) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : 'Unknown error');
    process.exit(1);
  });
}
