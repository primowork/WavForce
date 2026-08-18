# WavForce
Power of the wav

YouTube to WAV/MP4 converter. Node + Express front end, `yt-dlp` + `ffmpeg` doing the work.

## Running

```
npm install
npm start        # listens on $PORT, default 8080
```

`yt-dlp`, `ffmpeg` and a JavaScript runtime must be on `PATH`. The Dockerfile installs all three.

## Why a JavaScript runtime is required

`yt-dlp` needs a JS runtime (Deno by default) to solve YouTube's player challenges. Without one,
extraction drops formats and downloads fail with `HTTP Error 403: Forbidden`. The image installs
Deno; the server detects `deno`/`node`/`bun` at startup and passes it via `--js-runtimes`.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | Listen port (default `8080`). |
| `YTDLP_JS_RUNTIME` | Override runtime detection, e.g. `deno:/usr/local/bin/deno`. |
| `YTDLP_COOKIES_B64` | Base64 of a Netscape-format `cookies.txt` from a signed-in browser. Written to `/tmp` at startup and passed as `--cookies`. |
| `YTDLP_COOKIES_FILE` | Path to an existing cookies file, instead of `YTDLP_COOKIES_B64`. |
| `YTDLP_PROXY` | Proxy URL passed as `--proxy`, e.g. `http://user:pass@host:port`. |

## Troubleshooting 403 errors

YouTube blocks datacenter IPs (Railway and most cloud hosts) far harder than home connections, so a
download that works locally can still be refused in production. The server already retries each
conversion across several player clients (`default` → `tv` → `web_safari` → `android_vr`) before
giving up, and the failing response lists which ones it tried.

If every client is refused, the server's IP is the problem, not the code. In order of effectiveness:

1. Set `YTDLP_COOKIES_B64` with cookies exported from a signed-in YouTube session. Use a throwaway
   account — the cookies grant access to it, and YouTube may rate limit or ban an account used this
   way. Cookies expire, so they need refreshing periodically.
2. Set `YTDLP_PROXY` to route requests through a residential proxy.
3. Deploy somewhere with a less-blocked egress IP.
