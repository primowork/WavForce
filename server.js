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

// Simple bearer-token auth so WaveForce can be deployed on a public domain
// while remaining accessible only to authorized users. The token can be
// supplied via the Authorization header ("Bearer <token>") or a ?token=
// query parameter. "/" and "/health" stay public for status checks.
function requireAuth(req, res, next) {
    if (req.path === '/' || req.path === '/health') return next();

    const authHeader = req.headers.authorization || '';
    let token = null;

    if (authHeader.startsWith('Bearer ')) {
        token = authHeader.slice('Bearer '.length).trim();
    } else if (req.query.token) {
        token = req.query.token;
    }

    if (!token || token !== process.env.AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
}

app.use(requireAuth);

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

// Arguments shared by every yt-dlp invocation.
function baseArgs() {
    const args = [];
    if (JS_RUNTIME) args.push('--js-runtimes', JS_RUNTIME);
    args.push('--retries', '3', '--extractor-retries', '3');
    return args;
}

function spawnYtdlp(args) {
    return spawn('yt-dlp', [...baseArgs(), ...args]);
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
    const { formatArgs, ext, mimeType, timeoutMs, defaultTitle } = opts;

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

    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    const ytdlp = spawnYtdlp([
        ...formatArgs,
        '--no-playlist',
        '--output', path.join(tempDir, diskName + '.%(ext)s'),
        url
    ]);

    let hasResponse = false;
    let stderrTail = '';

    const timeout = setTimeout(() => {
        if (!hasResponse) {
            console.log('Timeout');
            ytdlp.kill();
            cleanup();
            res.status(504).json({ error: 'Timeout - try a shorter video' });
            hasResponse = true;
        }
    }, timeoutMs);

    ytdlp.stdout.setEncoding('utf8');
    ytdlp.stderr.setEncoding('utf8');
    ytdlp.stdout.on('data', (data) => { console.log(data); });
    ytdlp.stderr.on('data', (data) => {
        console.log(data);
        stderrTail = (stderrTail + data).slice(-1000);
    });

    ytdlp.on('close', (code) => {
        clearTimeout(timeout);

        if (hasResponse) return;

        console.log('Process exited with code: ' + code);

        if (code !== 0) {
            cleanup();
            res.status(400).json({ error: 'Conversion failed', detail: stderrTail.trim().slice(-400) });
            hasResponse = true;
            return;
        }

        let wavFile = path.join(tempDir, diskName + '.wav');
        if (!fs.existsSync(wavFile)) {
            try {
                const found = fs.readdirSync(tempDir).find(f => f.toLowerCase().endsWith('.wav'));
                if (found) wavFile = path.join(tempDir, found);
            } catch (e) { /* ignore */ }
        }

        if (wavFile && fs.existsSync(wavFile)) {
            console.log('File ready, sending...');
            res.setHeader('Content-Type', 'audio/wav');
            const asciiName = videoTitle.replace(/[^\x20-\x7E]/g, '_');
            const utf8Name = encodeURIComponent(videoTitle + '.wav');
            res.setHeader('Content-Disposition',
                `attachment; filename="${asciiName}.wav"; filename*=UTF-8''${utf8Name}`);
            res.setHeader('X-Song-Title', encodeURIComponent(videoTitle));

            const fileStream = fs.createReadStream(wavFile);
            fileStream.pipe(res);
            fileStream.on('end', () => { cleanup(); });
            hasResponse = true;
        } else {
            console.log('File not found');
            cleanup();
            res.status(500).json({ error: 'File not created' });
            hasResponse = true;
        }
    });

    ytdlp.on('error', (error) => {
        clearTimeout(timeout);
        if (!hasResponse) {
            console.log('Process error: ' + error);
            cleanup();
            res.status(500).json({ error: 'Process failed' });
            hasResponse = true;
        }
    });

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
