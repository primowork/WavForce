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

    try {
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        console.log(`🚀 Starting WaveForce conversion for: ${url}`);
        console.log(`📁 Temp directory: ${tempDir}`);
        console.log(`📄 Output file: ${outputPath}`);

        const ytdlpProcess = spawn('yt-dlp', [
            '--extract-audio',
            '--audio-format', 'wav',
            '--audio-quality', '0',
            '--max-filesize', '100M',
            '--max-duration', '1200',
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
            console.log(`yt-dlp stdout: ${data}`);
        });

        ytdlpProcess.stderr.on('data', (data) => {
            stderr += data.toString();
            console.log(`yt-dlp stderr: ${data}`);
        });

        const timeout = setTimeout(() => {
            ytdlpProcess.kill('SIGTERM');
            console.log('⏰ Process timed out after 10 minutes');
            cleanupDirectory(tempDir);
            res.status(500).json({ error: 'Conversion timed out' });
        }, 600000);

        ytdlpProcess.on('close', (code) => {
            clearTimeout(timeout);
            if (code !== 0) {
                console.error(`❌ yt-dlp process exited with code ${code}`);
                console.error(`stderr: ${stderr}`);
                cleanupDirectory(tempDir);
                if (stderr.includes('Video unavailable')) {
                    return res.status(400).json({ error: 'Video is unavailable or private' });
                } else if (stderr.includes('max-filesize')) {
                    return res.status(400).json({ error: 'Video file is too large (max 100MB)' });
                } else if (stderr.includes('max-duration')) {
                    return res.status(400).json({ error: 'Video is too long (max 20 minutes)' });
                } else {
                    return res.status(500).json({ error: 'Conversion failed. Please check the URL and try again.' });
                }
            }
            // ... (rest of the close handler remains the same)
        });

        ytdlpProcess.on('error', (error) => {
            clearTimeout(timeout);
            console.error(`❌ Process error: ${error.message} (Command: yt-dlp)`);
            cleanupDirectory(tempDir);
            res.status(500).json({ error: 'Conversion process failed to start' });
        });

    } catch (error) {
        console.error(`❌ Conversion error: ${error.message}`);
        cleanupDirectory(tempDir);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});
