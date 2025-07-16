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
            '--max-filesize', '50M', // Reduced to 50MB for Railway free tier
            '--max-duration', '300', // Reduced to 5 minutes
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

        const timeout = setTimeout(() => {
            if (!responded) {
                ytdlpProcess.kill('SIGTERM');
                console.log('⏰ Timed out after 15 seconds');
                cleanupDirectory(tempDir);
                res.status(504).json({ error: 'Conversion timed out after 15 seconds' });
                responded = true;
            }
        }, 15000); // 15-second timeout

        ytdlpProcess.on('close', (code) => {
            clearTimeout(timeout);
            if (!responded) {
                if (code !== 0) {
                    console.error(`❌ Exited with code ${code}, stderr: ${stderr}`);
                    cleanupDirectory(tempDir);
                    if (stderr.includes('Video unavailable')) {
                        res.status(400).json({ error: 'Video is unavailable or private' });
                    } else if (stderr.includes('max-filesize')) {
                        res.status(400).json({ error: 'Video file too large (max 50MB)' });
                    } else if (stderr.includes('max-duration')) {
                        res.status(400).json({ error: 'Video too long (max 5 minutes)' });
                    } else {
                        res.status(500).json({ error: 'Conversion failed' });
                    }
                } else {
                    const stats = fs.statSync(outputPath);
                    if (stats.size > 50 * 1024 * 1024) {
                        cleanupDirectory(tempDir);
                        res.status(400).json({ error: 'File exceeds 50MB limit' });
                    } else {
                        res.setHeader('Content-Type', 'audio/wav');
                        res.setHeader('Content-Disposition', `attachment; filename="${outputName}.wav"`);
                        fs.createReadStream(outputPath).pipe(res);
                        res.on('finish', () => cleanupDirectory(tempDir));
                    }
                }
                responded = true;
            }
        });

        ytdlpProcess.on('error', (error) => {
            clearTimeout(timeout);
            if (!responded) {
                console.error(`❌ Process error: ${error.message}`);
                cleanupDirectory(tempDir);
                res.status(500).json({ error: 'Conversion process failed to start' });
                responded = true;
            }
        });

    } catch (error) {
        if (!responded) {
            console.error(`❌ Catch error: ${error.message}`);
            cleanupDirectory(tempDir);
            res.status(500).json({ error: 'Internal server error' });
            responded = true;
        }
    }
});
