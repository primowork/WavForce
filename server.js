// server.js - עם מגבלות אורך מותאמות
const express = require('express');
const cors = require('cors');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

// הגדרות מותאמות אישית
const CONFIG = {
    MAX_DURATION: 1200, // 20 דקות במקום 5
    MAX_FILESIZE: '100M', // 100MB במקום 50MB
    TIMEOUT: 180000, // 3 דקות timeout במקום 15 שניות
    TEMP_CLEANUP_DELAY: 60000 // דקה לפני מחיקת קבצים זמניים
};

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'WaveForce is operational',
        message: 'May the Force be with your audio conversions',
        limits: {
            maxDuration: `${CONFIG.MAX_DURATION} seconds (${CONFIG.MAX_DURATION/60} minutes)`,
            maxFilesize: CONFIG.MAX_FILESIZE,
            timeout: `${CONFIG.TIMEOUT/1000} seconds`
        },
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
            config: CONFIG,
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
        console.log(`⏱️ Max duration: ${CONFIG.MAX_DURATION} seconds`);
        console.log(`📦 Max filesize: ${CONFIG.MAX_FILESIZE}`);

        // בדיקה מוקדמת של אורך הווידאו
        console.log('🔍 Checking video info...');
        const infoProcess = spawn('yt-dlp', [
            '--print', 'duration',
            '--no-warnings',
            url
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' }
        });

        let infoDuration = '';
        infoProcess.stdout.on('data', (data) => {
            infoDuration += data.toString().trim();
        });

        infoProcess.on('close', (code) => {
            if (code === 0 && infoDuration) {
                const duration = parseInt(infoDuration);
                if (duration > CONFIG.MAX_DURATION) {
                    console.log(`❌ Video too long: ${duration}s (max: ${CONFIG.MAX_DURATION}s)`);
                    cleanupDirectory(tempDir);
                    if (!responded) {
                        res.status(400).json({ 
                            error: `Video too long (${Math.round(duration/60)} minutes). Maximum allowed: ${CONFIG.MAX_DURATION/60} minutes` 
                        });
                        responded = true;
                    }
                    return;
                }
                console.log(`✅ Video duration OK: ${duration}s`);
            }
            
            // המשך עם ההמרה
            startConversion();
        });

        function startConversion() {
            if (responded) return;

            const ytdlpProcess = spawn('yt-dlp', [
                '--extract-audio',
                '--audio-format', 'wav',
                '--audio-quality', '0',
                '--max-filesize', CONFIG.MAX_FILESIZE,
                '--max-duration', CONFIG.MAX_DURATION.toString(),
                '--no-playlist',
                '--output', path.join(tempDir, `${outputName}.%(ext)s`),
                '--verbose', // הוסף verbose לדיבוג
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
                    console.log(`⏰ Timed out after ${CONFIG.TIMEOUT/1000} seconds`);
                    cleanupDirectory(tempDir);
                    res.status(504).json({ 
                        error: `Conversion timed out after ${CONFIG.TIMEOUT/1000} seconds` 
                    });
                    responded = true;
                }
            }, CONFIG.TIMEOUT);

            ytdlpProcess.on('close', (code) => {
                clearTimeout(timeout);
                if (!responded) {
                    if (code !== 0) {
                        console.error(`❌ Exited with code ${code}, stderr: ${stderr}`);
                        cleanupDirectory(tempDir);
                        
                        // טיפול משופר בשגיאות
                        if (stderr.includes('Video unavailable') || stderr.includes('Private video')) {
                            res.status(400).json({ error: 'Video is unavailable or private' });
                        } else if (stderr.includes('max-filesize') || stderr.includes('too large')) {
                            res.status(400).json({ error: `Video file too large (max ${CONFIG.MAX_FILESIZE})` });
                        } else if (stderr.includes('max-duration') || stderr.includes('too long')) {
                            res.status(400).json({ error: `Video too long (max ${CONFIG.MAX_DURATION/60} minutes)` });
                        } else if (stderr.includes('Sign in to confirm')) {
                            res.status(403).json({ error: 'Video requires authentication or age verification' });
                        } else if (stderr.includes('No video formats found')) {
                            res.status(400).json({ error: 'No audio/video formats available for this URL' });
                        } else {
                            res.status(500).json({ 
                                error: 'Conversion failed',
                                details: stderr.split('\n').slice(-5).join('\n') // חמש השורות האחרונות
                            });
                        }
                    } else {
                        // בדיקת קיום הקובץ
                        if (!fs.existsSync(outputPath)) {
                            console.error('❌ Output file not found');
                            cleanupDirectory(tempDir);
                            res.status(500).json({ error: 'Output file was not created' });
                        } else {
                            const stats = fs.statSync(outputPath);
                            console.log(`📊 Output file size: ${Math.round(stats.size / 1024 / 1024)}MB`);
                            
                            if (stats.size > 100 * 1024 * 1024) { // 100MB
                                cleanupDirectory(tempDir);
                                res.status(400).json({ error: 'File exceeds 100MB limit' });
                            } else {
                                console.log('✅ Conversion successful, sending file...');
                                res.setHeader('Content-Type', 'audio/wav');
                                res.setHeader('Content-Disposition', `attachment; filename="${outputName}.wav"`);
                                res.setHeader('Content-Length', stats.size);
                                
                                const readStream = fs.createReadStream(outputPath);
                                readStream.pipe(res);
                                
                                // מחיקה מושהית של קבצים זמניים
                                setTimeout(() => {
                                    cleanupDirectory(tempDir);
                                }, CONFIG.TEMP_CLEANUP_DELAY);
                            }
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
        }

    } catch (error) {
        if (!responded) {
            console.error(`❌ Catch error: ${error.message}`);
            cleanupDirectory(tempDir);
            res.status(500).json({ error: 'Internal server error' });
            responded = true;
        }
    }
});

// Cleanup function
function cleanupDirectory(dirPath) {
    try {
        if (fs.existsSync(dirPath)) {
            fs.rmSync(dirPath, { recursive: true, force: true });
            console.log(`🧹 Cleaned up directory: ${dirPath}`);
        }
    } catch (cleanupError) {
        console.warn(`⚠️ Cleanup warning: ${cleanupError.message}`);
    }
}

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Express error:', error);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌟 WaveForce server is operational on port ${PORT}`);
    console.log(`🚀 May the Force be with your audio conversions!`);
    console.log(`📊 Configuration:`);
    console.log(`   - Max duration: ${CONFIG.MAX_DURATION} seconds (${CONFIG.MAX_DURATION/60} minutes)`);
    console.log(`   - Max filesize: ${CONFIG.MAX_FILESIZE}`);
    console.log(`   - Timeout: ${CONFIG.TIMEOUT/1000} seconds`);
    
    try {
        execSync('yt-dlp --version', { stdio: 'pipe' });
        console.log('✅ yt-dlp is available');
    } catch (error) {
        console.error('❌ yt-dlp is not available');
    }
    
    try {
        execSync('ffmpeg -version', { stdio: 'pipe' });
        console.log('✅ ffmpeg is available');
    } catch (error) {
        console.error('❌ ffmpeg is not available');
    }
});
