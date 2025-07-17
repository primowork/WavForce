// server.js - עם תיקון לגרסת yt-dlp חדשה
const express = require('express');
const cors = require('cors');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

// הגדרות מותאמות
const CONFIG = {
    MAX_DURATION: 1200, // 20 דקות בשניות
    MAX_FILESIZE: '100M',
    TIMEOUT: 300000, // 5 דקות timeout
    TEMP_CLEANUP_DELAY: 60000,
    PROGRESS_TIMEOUT: 45000 // 45 שניות ללא התקדמות
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

// פונקציה לבדיקת אורך ווידאו
async function checkVideoDuration(url) {
    return new Promise((resolve, reject) => {
        const checkProcess = spawn('yt-dlp', [
            '--print', 'duration',
            '--no-warnings',
            '--no-playlist',
            url
        ], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let output = '';
        let errorOutput = '';

        checkProcess.stdout.on('data', (data) => {
            output += data.toString();
        });

        checkProcess.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        checkProcess.on('close', (code) => {
            if (code === 0 && output.trim()) {
                const duration = parseInt(output.trim());
                resolve(isNaN(duration) ? null : duration);
            } else {
                console.log(`Duration check failed: ${errorOutput}`);
                resolve(null); // אם לא מצליח לבדוק, המשך בלי בדיקה
            }
        });

        setTimeout(() => {
            checkProcess.kill();
            resolve(null);
        }, 15000); // timeout של 15 שניות לבדיקה
    });
}

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
    let lastProgressTime = Date.now();

    try {
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        console.log(`🚀 Starting conversion for URL: ${url}`);
        console.log(`📁 Temp dir: ${tempDir}`);
        console.log(`📄 Output file: ${outputPath}`);

        // בדיקת אורך הווידאו (אופציונלית)
        console.log('🔍 Checking video duration...');
        const duration = await checkVideoDuration(url);
        if (duration && duration > CONFIG.MAX_DURATION) {
            console.log(`❌ Video too long: ${duration}s (max: ${CONFIG.MAX_DURATION}s)`);
            cleanupDirectory(tempDir);
            return res.status(400).json({ 
                error: `Video too long (${Math.round(duration/60)} minutes). Maximum allowed: ${CONFIG.MAX_DURATION/60} minutes` 
            });
        }
        if (duration) {
            console.log(`✅ Video duration OK: ${duration}s (${Math.round(duration/60)} minutes)`);
        } else {
            console.log(`⚠️ Could not check duration, proceeding with conversion`);
        }

        // הרצת yt-dlp ללא --max-duration
        const ytdlpArgs = [
            '--extract-audio',
            '--audio-format', 'wav',
            '--audio-quality', '0',
            '--max-filesize', CONFIG.MAX_FILESIZE,
            '--no-playlist',
            '--no-warnings',
            '--progress',
            '--newline',
            '--output', path.join(tempDir, `${outputName}.%(ext)s`)
        ];

        // הוסף --playlist-end 1 כדי לוודא שזה לא playlist
        ytdlpArgs.push('--playlist-end', '1');
        ytdlpArgs.push(url);

        console.log(`🎬 Starting yt-dlp with args: ${ytdlpArgs.join(' ')}`);

        const ytdlpProcess = spawn('yt-dlp', ytdlpArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' }
        });

        let stdout = '';
        let stderr = '';
        let downloadProgress = 0;

        ytdlpProcess.stdout.on('data', (data) => {
            const output = data.toString();
            stdout += output;
            
            // מעקב אחר התקדמות
            const progressMatch = output.match(/\[download\]\s+(\d+\.?\d*)%/);
            if (progressMatch) {
                downloadProgress = parseFloat(progressMatch[1]);
                lastProgressTime = Date.now();
                console.log(`📊 Download progress: ${downloadProgress}%`);
            }
            
            if (output.includes('[ffmpeg]')) {
                console.log(`🔄 FFmpeg processing: ${output.trim()}`);
                lastProgressTime = Date.now();
            }
            
            console.log(`stdout: ${output}`);
        });

        ytdlpProcess.stderr.on('data', (data) => {
            const output = data.toString();
            stderr += output;
            console.log(`stderr: ${output}`);
            
            if (output.trim().length > 0) {
                lastProgressTime = Date.now();
            }
        });

        // Timeout עיקרי
        const mainTimeout = setTimeout(() => {
            if (!responded) {
                ytdlpProcess.kill('SIGTERM');
                console.log(`⏰ Main timeout after ${CONFIG.TIMEOUT/1000} seconds`);
                cleanupDirectory(tempDir);
                res.status(504).json({ 
                    error: `Conversion timed out after ${CONFIG.TIMEOUT/1000} seconds. Try a shorter video.` 
                });
                responded = true;
            }
        }, CONFIG.TIMEOUT);

        // בדיקת התקדמות
        const progressCheck = setInterval(() => {
            const timeSinceProgress = Date.now() - lastProgressTime;
            if (timeSinceProgress > CONFIG.PROGRESS_TIMEOUT && !responded) {
                ytdlpProcess.kill('SIGTERM');
                console.log(`⏰ Progress timeout - no activity for ${CONFIG.PROGRESS_TIMEOUT/1000} seconds`);
                clearTimeout(mainTimeout);
                clearInterval(progressCheck);
                cleanupDirectory(tempDir);
                res.status(504).json({ 
                    error: `Process stuck - no progress for ${CONFIG.PROGRESS_TIMEOUT/1000} seconds. Please try again.` 
                });
                responded = true;
            }
        }, 5000);

        ytdlpProcess.on('close', (code) => {
            clearTimeout(mainTimeout);
            clearInterval(progressCheck);
            
            if (!responded) {
                console.log(`🏁 Process finished with code: ${code}`);
                console.log(`📊 Final download progress: ${downloadProgress}%`);
                
                if (code !== 0) {
                    console.error(`❌ Exited with code ${code}`);
                    console.error(`📝 Stderr: ${stderr}`);
                    cleanupDirectory(tempDir);
                    
                    let errorMessage = 'Conversion failed';
                    
                    if (stderr.includes('Video unavailable') || stderr.includes('Private video')) {
                        errorMessage = 'Video is unavailable, private, or restricted';
                    } else if (stderr.includes('max-filesize') || stderr.includes('too large')) {
                        errorMessage = `Video file too large (max ${CONFIG.MAX_FILESIZE})`;
                    } else if (stderr.includes('Sign in to confirm') || stderr.includes('age')) {
                        errorMessage = 'Video requires authentication or age verification';
                    } else if (stderr.includes('No video formats') || stderr.includes('format not available')) {
                        errorMessage = 'No suitable audio/video format available';
                    } else if (stderr.includes('network') || stderr.includes('timeout') || stderr.includes('connection')) {
                        errorMessage = 'Network error - please check the URL and try again';
                    } else if (stderr.includes('Unsupported URL')) {
                        errorMessage = 'Unsupported video URL or platform';
                    }
                    
                    res.status(400).json({ error: errorMessage });
                } else {
                    // בדיקת קובץ
                    let attempts = 0;
                    const maxAttempts = 5;
                    
                    const checkFile = () => {
                        attempts++;
                        
                        if (fs.existsSync(outputPath)) {
                            const stats = fs.statSync(outputPath);
                            console.log(`✅ Output file found: ${Math.round(stats.size / 1024 / 1024 * 100) / 100}MB`);
                            
                            if (stats.size === 0) {
                                console.error('❌ Output file is empty');
                                cleanupDirectory(tempDir);
                                res.status(500).json({ error: 'Generated file is empty. Please try again.' });
                            } else if (stats.size > 100 * 1024 * 1024) {
                                cleanupDirectory(tempDir);
                                res.status(400).json({ error: 'File exceeds 100MB limit' });
                            } else {
                                console.log('✅ Conversion successful, sending file...');
                                res.setHeader('Content-Type', 'audio/wav');
                                res.setHeader('Content-Disposition', `attachment; filename="${outputName}.wav"`);
                                res.setHeader('Content-Length', stats.size);
                                
                                const readStream = fs.createReadStream(outputPath);
                                readStream.pipe(res);
                                
                                setTimeout(() => {
                                    cleanupDirectory(tempDir);
                                }, CONFIG.TEMP_CLEANUP_DELAY);
                            }
                        } else if (attempts < maxAttempts) {
                            console.log(`⏳ File not ready yet, waiting... (attempt ${attempts}/${maxAttempts})`);
                            setTimeout(checkFile, 2000);
                        } else {
                            console.error('❌ Output file not found after multiple attempts');
                            cleanupDirectory(tempDir);
                            res.status(500).json({ error: 'Output file was not created. Please try again.' });
                        }
                    };
                    
                    checkFile();
                }
                responded = true;
            }
        });

        ytdlpProcess.on('error', (error) => {
            clearTimeout(mainTimeout);
            clearInterval(progressCheck);
            
            if (!responded) {
                console.error(`❌ Process error: ${error.message}`);
                cleanupDirectory(tempDir);
                res.status(500).json({ error: 'Conversion process failed to start. Please try again.' });
                responded = true;
            }
        });

    } catch (error) {
        if (!responded) {
            console.error(`❌ Catch error: ${error.message}`);
            cleanupDirectory(tempDir);
            res.status(500).json({ error: 'Internal server error. Please try again.' });
            responded = true;
        }
    }
});

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

app.use((error, req, res, next) => {
    console.error('Express error:', error);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌟 WaveForce server is operational on port ${PORT}`);
    console.log(`🚀 Configuration:`);
    console.log(`   - Max duration: ${CONFIG.MAX_DURATION} seconds (${CONFIG.MAX_DURATION/60} minutes)`);
    console.log(`   - Max filesize: ${CONFIG.MAX_FILESIZE}`);
    console.log(`   - Main timeout: ${CONFIG.TIMEOUT/1000} seconds`);
    console.log(`   - Progress timeout: ${CONFIG.PROGRESS_TIMEOUT/1000} seconds`);
    
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
