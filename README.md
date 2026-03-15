# milkvid

Render Milkdrop preset visualizations to MP4 video, synced to an audio file.

Uses [butterchurn](https://github.com/jberg/butterchurn) (WebGL2 Milkdrop), WebCodecs H.264 hardware encoding, and ffmpeg.

## Requirements

- [Node.js](https://nodejs.org/) 18+
- [ffmpeg](https://ffmpeg.org/download.html) in PATH
- Windows (uses ANGLE/D3D11 for GPU rendering)

## Setup

```bash
git clone https://github.com/AnEntrypoint/milkvid
cd milkvid
npm install
```

You also need presets. Download the butterchurn preset pack:

```bash
# ~16k pre-converted JSON presets from ansorre
# Place .json files into the presets/ folder
```

## Usage

```bash
node milkvid.js
```

Interactive menu:

```
[1] Pick preset (visual browser)   ← opens thumbnail grid in your browser
[2] Select audio                   ← drag-and-drop a .wav file
[3] Change output path
[4] Render
[5] Generate thumbnails
```

### Pick a preset

Press `1` — your browser opens a searchable grid of all preset thumbnails. Click one to select it, then return to the terminal.

### Select audio

Press `2` — paste or drag-and-drop a `.wav` file path.

### Render

Press `4` — renders the selected preset synced to the audio. Output is an MP4 in the `output/` folder.

Render runs at ~200 fps (6–7× realtime on an RTX 3060).

## Generate thumbnails

Press `5` in the menu to generate preview thumbnails for all presets (~16k presets, ~2–3 hours).

Or run directly:

```bash
node update-thumbnails.js
```

## Files

| File | Purpose |
|---|---|
| `milkvid.js` | Interactive CLI entrypoint |
| `render-preset.js` | Render engine (Puppeteer + ffmpeg) |
| `render-page.js` | Browser page with butterchurn + WebCodecs encoder |
| `update-thumbnails.js` | Batch thumbnail generator |
| `build-preview.js` | Builds a static preview HTML from thumbnails |

## How it works

1. Node.js starts a local HTTP server and launches Chromium via Puppeteer
2. The browser page runs butterchurn (WebGL2) and encodes frames with WebCodecs VideoEncoder (hardware H.264)
3. Encoded H.264 chunks are POSTed directly to the Node server → piped to ffmpeg stdin
4. ffmpeg muxes video + audio into MKV, then remuxes to MP4 with `+faststart`
