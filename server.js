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

app.post('/api/convert', (req, res) => {
    const { url, filename } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    const randomId = crypto.randomBytes(4).toString('hex');
    const outputName = filename ? `${filename}_${randomId}` : `waveforce_${randomId}`;
    const tempDir = `/tmp/temp_${randomId}`;

    console.log('Converting: ' + url);

    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    const ytdlp = spawn('yt-dlp', [
        '--extract-audio',
        '--audio-format', 'wav',
        '--audio-quality', '0',
        '--no-playlist',
        '--max-filesize', '100m',
        '--socket-timeout', '180',  // ← תיקון כאן!
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        '--extractor-args', 'youtube:player_client=ios',  // שינוי קל: 'ios' במקום 'default' – יותר יציב ל-Music
        '--output', path.join(tempDir, outputName + '.%(ext)s'),
        url
    ]);

    let hasResponse = false;

    const timeout = setTimeout(() => {
        if (!hasResponse) {
            console.log('Overall timeout');
            ytdlp.kill();
            cleanup();
            res.status(504).json({ error: 'Conversion timed out (3 min limit)' });
            hasResponse = true;
        }
    }, 180000); // 3 דקות כולל

    ytdlp.stdout.on('data', (data) => {
        console.log('STDOUT: ' + data.toString().trim());
    });

    ytdlp.stderr.on('data', (data) => {
        console.log('STDERR: ' + data.toString().trim());
    });

    ytdlp.on('close', (code) => {
        clearTimeout(timeout);

        if (hasResponse) return;

        console.log('Process exited with code: ' + code);

        if (code !== 0) {
            cleanup();
            res.status(400).json({ error: 'Conversion failed – check video length or availability' });
            hasResponse = true;
            return;
        }

        const wavFile = path.join(tempDir, outputName + '.wav');

        if (fs.existsSync(wavFile)) {
            console.log('File ready, sending...');

            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('Content-Disposition', `attachment; filename="${outputName}.wav"`);

            const fileStream = fs.createReadStream(wavFile);
            fileStream.pipe(res);

            fileStream.on('end', () => {
                cleanup();
            });

            hasResponse = true;
        } else {
            console.log('WAV file not found');
            cleanup();
            res.status(500).json({ error: 'Audio file not created – try another video' });
            hasResponse = true;
        }
    });

    ytdlp.on('error', (error) => {
        clearTimeout(timeout);
        if (!hasResponse) {
            console.log('Process error: ' + error.message);
            cleanup();
            res.status(500).json({ error: 'yt-dlp failed to start' });
            hasResponse = true;
        }
    });

    function cleanup() {
        try {
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
                console.log('Cleaned up:', tempDir);
            }
        } catch (e) {
            console.log('Cleanup warning: ' + e.message);
        }
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('WaveForce running on port ' + PORT);
});
