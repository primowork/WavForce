const express = require('express');
const cors = require('cors');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

app.get('/', (req, res) => {
    res.json({ status: 'WaveForce is operational' });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});

// yt-dlp needs a JavaScript runtime to solve YouTube's player challenges.
// Without one, extraction fails with "HTTP Error 403: Forbidden" or silently
// drops formats. Deno is the runtime yt-dlp enables by default; anything else
// has to be passed explicitly with --js-runtimes.
function detectJsRuntime() {
    if (process.env.YTDLP_JS_RUNTIME) return process.env.YTDLP_JS_RUNTIME;

    for (const runtime of ['deno', 'node', 'bun']) {
        const found = spawnSync('which', [runtime], { encoding: 'utf8' });
        if (found.status === 0 && found.stdout.trim()) {
            return runtime + ':' + found.stdout.trim();
        }
    }
    return null;
}

const JS_RUNTIME = detectJsRuntime();

if (JS_RUNTIME) {
    console.log('yt-dlp JavaScript runtime: ' + JS_RUNTIME);
} else {
    console.warn('No JavaScript runtime found (deno/node/bun). YouTube extraction will likely fail with 403 errors.');
}

// YouTube blocks datacenter IPs (Railway, most cloud hosts) far more
// aggressively than home connections. Cookies exported from a signed-in
// browser session are the single most effective workaround; set either
// YTDLP_COOKIES_FILE (path inside the container) or YTDLP_COOKIES_B64
// (base64 of a Netscape-format cookies.txt) to enable them.
function resolveCookieFile() {
    if (process.env.YTDLP_COOKIES_FILE) {
        if (fs.existsSync(process.env.YTDLP_COOKIES_FILE)) {
            return process.env.YTDLP_COOKIES_FILE;
        }
        console.warn('YTDLP_COOKIES_FILE is set but the file does not exist: ' + process.env.YTDLP_COOKIES_FILE);
        return null;
    }

    if (process.env.YTDLP_COOKIES_B64) {
        try {
            const target = '/tmp/yt-dlp-cookies.txt';
            fs.writeFileSync(target, Buffer.from(process.env.YTDLP_COOKIES_B64, 'base64'), { mode: 0o600 });
            return target;
        } catch (e) {
            console.warn('Could not write cookies from YTDLP_COOKIES_B64: ' + e.message);
        }
    }

    return null;
}

const COOKIE_FILE = resolveCookieFile();
const PROXY = process.env.YTDLP_PROXY || null;

if (COOKIE_FILE) console.log('Using yt-dlp cookies from ' + COOKIE_FILE);
if (PROXY) console.log('Using yt-dlp proxy');

// Arguments shared by every yt-dlp invocation.
function baseArgs() {
    const args = [];
    if (JS_RUNTIME) args.push('--js-runtimes', JS_RUNTIME);
    if (COOKIE_FILE) args.push('--cookies', COOKIE_FILE);
    if (PROXY) args.push('--proxy', PROXY);
    args.push('--retries', '3', '--extractor-retries', '3');
    return args;
}

function spawnYtdlp(args) {
    return spawn('yt-dlp', [...baseArgs(), ...args]);
}

// YouTube serves different player clients different format URLs, and which
// clients survive a datacenter IP changes over time. When a download is
// refused we walk this ladder rather than giving up on the first 403.
const CLIENT_PROFILES = [
    { name: 'default', args: [] },
    { name: 'tv', args: ['--extractor-args', 'youtube:player_client=tv,default'] },
    { name: 'web_safari', args: ['--extractor-args', 'youtube:player_client=web_safari,mweb'] },
    { name: 'android_vr', args: ['--extractor-args', 'youtube:player_client=android_vr,tv_embedded'] }
];

// Failures worth retrying with a different player client. Anything else
// (private video, removed video, bad URL) fails the same way every time.
const RETRYABLE = /403|Forbidden|Requested format is not available|Sign in to confirm|unable to download video data|nsig|player response|precondition check failed/i;

function runYtdlp(args, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawnYtdlp(args);

        let stderrTail = '';
        let settled = false;
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, Math.max(timeoutMs, 1000));

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (data) => { console.log(data); });
        child.stderr.on('data', (data) => {
            console.log(data);
            stderrTail = (stderrTail + data).slice(-2000);
        });

        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };

        child.on('error', (error) => {
            finish({ ok: false, spawnError: error, timedOut, stderrTail });
        });

        child.on('close', (code) => {
            finish({ ok: code === 0 && !timedOut, code, timedOut, stderrTail });
        });
    });
}

function cleanFilename(filename) {
    let cleaned = filename
        .replace(/[<>:"/\\|?*%]/g, '_')
        .replace(/[\x00-\x1F\x7F]/g, '')
        .replace(/\s+/g, '_');

    // Truncate by UTF-8 byte length to stay under the 255-byte filesystem
    // limit (non-ASCII characters such as Hebrew take 2+ bytes each).
    const MAX_BYTES = 150;
    while (Buffer.byteLength(cleaned, 'utf8') > MAX_BYTES) {
        cleaned = cleaned.slice(0, -1);
    }
    return cleaned;
}

function getVideoTitle(url) {
    return new Promise((resolve, reject) => {
        const ytdlp = spawnYtdlp([
            '--print', 'title',
            '--no-playlist',
            url
        ]);

        let title = '';
        ytdlp.stdout.setEncoding('utf8');
        ytdlp.stdout.on('data', (data) => { title += data; });

        ytdlp.on('close', (code) => {
            title = title.trim();
            if (code === 0 && title) resolve(cleanFilename(title));
            else reject(new Error('Failed to get video title'));
        });

        ytdlp.on('error', (error) => { reject(error); });
    });
}

// Playlist info endpoint
app.post('/api/playlist-info', (req, res) => {
    const { url } = req.body;

    if (!url) return res.status(400).json({ error: 'URL is required' });

    console.log('Fetching playlist info: ' + url);

    const ytdlp = spawnYtdlp([
        '--flat-playlist',
        '--print', '%(title)s|||%(id)s|||%(duration)s',
        '--no-warnings',
        url
    ]);

    let output = '';
    let errOutput = '';

    ytdlp.stdout.setEncoding('utf8');
    ytdlp.stdout.on('data', (d) => { output += d; });
    ytdlp.stderr.on('data', (d) => { errOutput += d.toString(); });

    const timeout = setTimeout(() => {
        ytdlp.kill();
        res.status(504).json({ error: 'Timeout fetching playlist' });
    }, 30000);

    ytdlp.on('close', (code) => {
        clearTimeout(timeout);

        if (res.headersSent) return;

        if (code !== 0 || !output.trim()) {
            console.log('Playlist fetch error: ' + errOutput);
            return res.status(400).json({ error: 'Could not fetch playlist. Make sure it\'s a valid public playlist URL.' });
        }

        const videos = output.trim().split('\n')
            .filter(line => line.includes('|||'))
            .map((line, index) => {
                const parts = line.split('|||');
                const rawTitle = (parts[0] || '').trim();
                const id = (parts[1] || '').trim();
                const duration = parseInt(parts[2]) || 0;

                const mins = Math.floor(duration / 60);
                const secs = duration % 60;
                const durationStr = duration > 0
                    ? `${mins}:${secs.toString().padStart(2, '0')}`
                    : '--:--';

                return {
                    index: index + 1,
                    displayTitle: rawTitle || 'Unknown Title',
                    title: cleanFilename(rawTitle || 'track_' + (index + 1)),
                    id: id,
                    url: `https://www.youtube.com/watch?v=${id}`,
                    duration: duration,
                    durationStr: durationStr
                };
            })
            .filter(v => v.id && v.id.length > 0);

        console.log(`Found ${videos.length} videos in playlist`);
        res.json({ videos, count: videos.length });
    });

    ytdlp.on('error', (error) => {
        clearTimeout(timeout);
        if (!res.headersSent) {
            res.status(500).json({ error: 'yt-dlp error: ' + error.message });
        }
    });
});

async function runConversion(req, res, opts) {
    const { url } = req.body;
    const { formatArgs, ext, timeoutMs, defaultTitle } = opts;

    if (!url) return res.status(400).json({ error: 'YouTube URL is required' });

    const randomId = crypto.randomBytes(4).toString('hex');
    const tempDir = '/tmp/temp_' + randomId;

    console.log(`Converting (${ext}): ` + url);

    let videoTitle;
    try {
        videoTitle = await getVideoTitle(url);
        console.log('Video title: ' + videoTitle);
    } catch (error) {
        console.log('Could not get video title, using default name');
        videoTitle = defaultTitle;
    }

    const diskName = 'audio';

    function cleanup() {
        try {
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
                console.log('Cleaned up');
            }
        } catch (e) {
            console.log('Cleanup warning: ' + e.message);
        }
    }

    // The whole request shares one time budget, split across attempts.
    const deadline = Date.now() + timeoutMs;
    let result = null;
    const tried = [];

    for (const profile of CLIENT_PROFILES) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            if (result) result.timedOut = true;
            break;
        }

        cleanup();
        fs.mkdirSync(tempDir, { recursive: true });

        console.log(`Attempt with player client profile: ${profile.name}`);
        tried.push(profile.name);

        result = await runYtdlp([
            ...profile.args,
            ...formatArgs,
            '--no-playlist',
            '--output', path.join(tempDir, diskName + '.%(ext)s'),
            url
        ], remaining);

        if (result.ok) break;

        if (result.spawnError) {
            console.log('Process error: ' + result.spawnError.message);
            break;
        }

        if (result.timedOut) {
            console.log('Timeout');
            break;
        }

        if (!RETRYABLE.test(result.stderrTail)) {
            console.log('Failure is not retryable, giving up');
            break;
        }

        console.log(`Profile ${profile.name} was refused, trying the next player client`);
    }

    if (!result || result.spawnError) {
        cleanup();
        return res.status(500).json({ error: 'Process failed' });
    }

    if (result.timedOut) {
        cleanup();
        return res.status(504).json({ error: 'Timeout - try a shorter video' });
    }

    if (!result.ok) {
        cleanup();
        const detail = result.stderrTail.trim().slice(-400);
        const blocked = /403|Forbidden|Sign in to confirm/i.test(result.stderrTail);
        return res.status(400).json({
            error: blocked
                ? 'YouTube refused the download from this server. This usually means the server IP is rate limited - configuring YTDLP_COOKIES_B64 or YTDLP_PROXY normally fixes it.'
                : 'Conversion failed',
            detail,
            triedClients: tried
        });
    }

    let outFile = path.join(tempDir, diskName + '.' + ext);
    if (!fs.existsSync(outFile)) {
        try {
            const found = fs.readdirSync(tempDir).find(f => f.toLowerCase().endsWith('.' + ext));
            if (found) outFile = path.join(tempDir, found);
        } catch (e) { /* ignore */ }
    }

    if (!fs.existsSync(outFile)) {
        console.log('File not found');
        cleanup();
        return res.status(500).json({ error: 'File not created' });
    }

    console.log('File ready, sending...');
    res.setHeader('Content-Type', opts.mimeType);
    const asciiName = videoTitle.replace(/[^\x20-\x7E]/g, '_');
    const utf8Name = encodeURIComponent(videoTitle + '.' + ext);
    res.setHeader('Content-Disposition',
        `attachment; filename="${asciiName}.${ext}"; filename*=UTF-8''${utf8Name}`);
    res.setHeader('X-Song-Title', encodeURIComponent(videoTitle));

    const fileStream = fs.createReadStream(outFile);
    fileStream.pipe(res);
    fileStream.on('close', () => { cleanup(); });
    fileStream.on('error', () => { cleanup(); });
}

app.post('/api/convert', (req, res) => runConversion(req, res, {
    formatArgs: ['--extract-audio', '--audio-format', 'wav'],
    ext: 'wav',
    mimeType: 'audio/wav',
    timeoutMs: 90000,
    defaultTitle: 'waveforce_audio'
}));

app.post('/api/convert-mp4', (req, res) => runConversion(req, res, {
    formatArgs: [
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
        '--merge-output-format', 'mp4'
    ],
    ext: 'mp4',
    mimeType: 'video/mp4',
    timeoutMs: 300000,
    defaultTitle: 'waveforce_video'
}));

app.listen(PORT, '0.0.0.0', () => {
    console.log('WaveForce running on port ' + PORT);
});
