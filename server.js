// server.js - Railway Express Server for WaveForce
const express = require('express');
const cors = require('cors');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express(); // Initialize Express app
const PORT = process.env.PORT || 8080; // Use 8080 as fallback, matching observed behavior

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'WaveForce is operational',
        message: 'May the Force be with your audio conversions',
        timestamp: new Date().toISOString()
    });
});

// Health check for services
app.get('/health', (req, res) => {
    try {
        execSync('yt-dlp --version', { stdio: 'pipe' });
        const ytdlpVersion = execSync('yt-dlp --version', { encoding: 'utf8' }).trim();
        
        execSync('ffmpeg -version', { stdio: 'pipe' });
        const ffmpegVersion = execSync('ffmpeg -version', { encoding: 'utf8' }).split('\n')[0];
        
        res.json({
            status: 'healthy',
            services: {
                ytdlp: ytdlpVersion,
                ffmpeg: ffmpegVersion
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(503).json({
            status: 'unhealthy',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Convert endpoint
app.post('/api/convert', async (req, res) => {
    const { url, filename } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'YouTube URL is required' });
    }

    const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/;
    if (!youtubeRegex.test(url)) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const timestamp = Date.now();
    const randomId = crypto.randomBytes(8).toString('hex');
    const outputName = filename ? 
        `${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}_${randomId}` : 
        `waveforce_${randomId}`;
    const tempDir = `/tmp/waveforce_${timestamp}_${randomId}`;
    const outputPath = path.join(tempDir, `${outputName}.wav`);

    let responded = false;

    try {
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        console.log(`🚀 Starting conversion for URL: ${url}`);
        console.log(`📁 Temp dir: ${tempDir}`);
        console.log(`📄 Output file: ${outputPath}`);

        const ytdlpProcess = spawn('yt-dlp', [
            '--extract-audio',
            '--audio-format', 'wav',
            '--audio-quality', '0',
            '--max-filesize', '50M',
            '--max-duration', '300',
            '--no-playlist',
            '--output', path.join(tempDir, `${outputName}.%(ext)s`),
            url
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' }
        });

        let stdout = '';
        let stderr = '';

        ytdlpProcess.stdout.on('data', (data) => {
            stdout += data.toString();
            console.log(`stdout: ${data}`);
        });

        ytdlpProcess.stderr.on('data', (data) => {
            stderr += data.toString();
            console.log(`stderr: ${data}`);
        });

        const timeout = set
