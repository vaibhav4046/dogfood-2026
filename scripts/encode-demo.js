"use strict";

/**
 * Transcode the recorded demo to H.264 MP4 and check the result is playable.
 *
 * The Playwright-bundled ffmpeg is a stripped VP8-only build — it has no
 * libx264, so it can write webm and nothing else. WebM VP8 plays in Chrome,
 * Firefox and Edge but not in Safari or in the default Windows player, and a
 * submission video a judge cannot open is worth nothing.
 *
 * `imageio-ffmpeg` ships a full static build and is already on this machine.
 * If neither is available the webm still ships, and the README says which file
 * is which rather than claiming a format it did not produce.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const OUT = path.join(__dirname, "..", "docs", "demo");
const WEBM = path.join(OUT, "demo.webm");
const MP4 = path.join(OUT, "demo.mp4");

function ffmpegPath() {
  if (process.env.DOGFOOD_FFMPEG && fs.existsSync(process.env.DOGFOOD_FFMPEG)) {
    return process.env.DOGFOOD_FFMPEG;
  }
  try {
    const p = execFileSync("python", ["-c", "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"], {
      encoding: "utf8",
    }).trim();
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* python or imageio_ffmpeg absent */
  }
  return null;
}

function main() {
  if (!fs.existsSync(WEBM)) {
    console.error(`no ${WEBM}. Run: node scripts/with-server.js node scripts/record-demo.js`);
    process.exit(1);
  }

  const ff = ffmpegPath();
  if (!ff) {
    console.warn(
      "no full ffmpeg found. demo.webm is written and playable in Chrome, Firefox\n" +
        "and Edge. To also produce demo.mp4:\n" +
        "  pip install imageio-ffmpeg\n" +
        "or set DOGFOOD_FFMPEG=/path/to/ffmpeg",
    );
    return;
  }
  console.log(`ffmpeg: ${ff}`);

  const run = spawnSync(
    ff,
    [
      "-y",
      "-i", WEBM,
      "-c:v", "libx264",
      "-preset", "slow",
      "-crf", "22",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      MP4,
    ],
    { encoding: "utf8" },
  );
  if (run.status !== 0 || !fs.existsSync(MP4)) {
    process.stderr.write(`${run.stderr || ""}\ntranscode failed\n`);
    process.exit(1);
  }

  // Verify rather than assume: probe the result for a video stream and a
  // duration, and fail if the file is truncated.
  const probe = spawnSync(ff, ["-i", MP4], { encoding: "utf8" });
  const info = `${probe.stderr || ""}`;
  const dur = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(info);
  const hasVideo = /Stream #0:0.*Video: h264/.test(info);
  if (!dur || !hasVideo) {
    process.stderr.write(`${info}\nthe mp4 does not look like a valid H.264 file\n`);
    process.exit(1);
  }

  const secs = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
  const size = fs.statSync(MP4).size;
  console.log(
    `demo.mp4  ${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s  h264  ${(size / 1e6).toFixed(2)} MB`,
  );
  console.log(`demo.webm ${(fs.statSync(WEBM).size / 1e6).toFixed(2)} MB  vp8`);
  if (secs > 300) {
    console.warn(`the spec caps the demo at five minutes; this is ${Math.round(secs)}s`);
  }
}

main();
