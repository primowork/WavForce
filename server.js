const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
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

function cleanFilename(filename) {
    return filename
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, '_')
        .substring(0, 200);
}

function getVideoTitle(url) {
    return new Promise((resolve, reject) => {
        const ytdlp = spawn('yt-dlp', [
            '--print', 'title',
            '--no-playlist',
            url
        ]);

        let title = '';
        ytdlp.stdout.on('data', (data) => { title += data.toString().trim(); });

        ytdlp.on('close', (code) => {
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

    const ytdlp = spawn('yt-dlp', [
        '--flat-playlist',
        '--print', '%(title)s|||%(id)s|||%(duration)s',
        '--no-warnings',
        url
    ]);

    let output = '';
    let errOutput = '';

    ytdlp.stdout.on('data', (d) => { output += d.toString(); });
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

app.post('/api/convert', async (req, res) => {
    const { url } = req.body;

    if (!url) return res.status(400).json({ error: 'YouTube URL is required' });

    const randomId = crypto.randomBytes(4).toString('hex');
    const tempDir = '/tmp/temp_' + randomId;

    console.log('Converting: ' + url);

    let videoTitle;
    try {
        videoTitle = await getVideoTitle(url);
        console.log('Video title: ' + videoTitle);
    } catch (error) {
        console.log('Could not get video title, using default name');
        videoTitle = 'waveforce_audio';
    }

    const outputName = videoTitle;

    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    const ytdlp = spawn('yt-dlp', [
        '--extract-audio',
        '--audio-format', 'wav',
        '--no-playlist',
        '--output', path.join(tempDir, outputName + '.%(ext)s'),
        url
    ]);

    let hasResponse = false;

    const timeout = setTimeout(() => {
        if (!hasResponse) {
            console.log('Timeout');
            ytdlp.kill();
            cleanup();
            res.status(504).json({ error: 'Timeout - try a shorter video' });
            hasResponse = true;
        }
    }, 90000);

    ytdlp.stdout.on('data', (data) => { console.log(data.toString()); });
    ytdlp.stderr.on('data', (data) => { console.log(data.toString()); });

    ytdlp.on('close', (code) => {
        clearTimeout(timeout);

        if (hasResponse) return;

        console.log('Process exited with code: ' + code);

        if (code !== 0) {
            cleanup();
            res.status(400).json({ error: 'Conversion failed' });
            hasResponse = true;
            return;
        }

        const wavFile = path.join(tempDir, outputName + '.wav');

        if (fs.existsSync(wavFile)) {
            console.log('File ready, sending...');
            res.setHeader('Content-Type', 'audio/wav');
            const safeFilename = outputName.replace(/[^\x00-\x7F]/g, '_');
            res.setHeader('Content-Disposition', 'attachment; filename="' + safeFilename + '.wav"');

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
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('WaveForce running on port ' + PORT);
});
