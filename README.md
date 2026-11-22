# CodeCity

Turn any codebase into an explorable 3D city. Every folder is a district and every file is a building:
taller buildings have more lines of code, and the color shows the language.

- **Paste a GitHub repo** (`facebook/react`, or any GitHub URL). The app uses GitHub's public API,
  so public repos need no account. To load a private repo or raise the limit, add a token.
- **Open a local folder or a .zip.** The browser reads the files on your computer and never uploads them.
- **Explore:** orbit, zoom, hover for details, click a building to open the file, search by file name,
  click a language to isolate it, and switch between day and night.
- **Change hotspots** (GitHub repos only): colors the files changed most in recent commits.
- **Record video:** records the fly-through straight to MP4 (4:5, 1:1, 9:16 or 16:9) for social posts.
- **Share links:** `?repo=owner/name` opens that repo's city directly.
- **Export for Blender:** saves the city as JSON so `blender/build_city.py` can render a cinematic version.

No build step and no backend: it's plain HTML, CSS and JS modules, with Three.js loaded from a CDN.

## Run locally

From this folder:

```powershell
python -m http.server 5173
```

Then open http://localhost:5173. (ES modules need a server; opening `index.html` directly won't work.)

## Deploy (GitHub Pages)

Push the contents of `codecity/` to a repo and turn on **Settings → Pages → Deploy from branch**.
Any static host works (Vercel, Netlify, Cloudflare Pages).

## GitHub API limits

Without a token, GitHub allows 60 requests an hour per visitor IP. Loading a repo costs 2 requests,
and reloads in the same tab are cached. Change hotspots cost 1 request per commit (30 without a token,
100 with one). GitHub truncates repos larger than about 100k files, and the app tells you when that happens.

## Cinematic render in Blender

1. In the app, click **Export for Blender** to save `codecity-<repo>.json`.
2. Render. A test frame comes first, then the full 12-second move:

```powershell
& "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b --factory-startup --python blender\build_city.py -- codecity-react.json --out renders\react --still 0.5
& "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b --factory-startup --python blender\build_city.py -- codecity-react.json --out renders\react --seconds 12 --res 1080x1350
```

3. Encode the frames:

```powershell
ffmpeg -framerate 30 -i renders\react\frames\%04d.png -c:v libx264 -pix_fmt yuv420p -crf 18 react-city.mp4
```

Options: `--res 1920x1080`, `--fps 60`, `--samples 64` (smoother, slower), and `--save-blend scene.blend`
to open and tweak the scene by hand. Re-running a render continues from the frames already saved.
Tested with Blender 5.2.

## How the layout works

Files are grouped into a folder tree. Single-child folder chains such as `src/main/java/com/acme` collapse into one
district, then a squarified treemap packs folders and files so blocks stay close to square. Building height is
`1 + 0.9·√lines`, and footprint grows with `√lines` (capped), so very large files become towers without
taking over the map.
