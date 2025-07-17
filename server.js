// server.js - גרסה מאוזנת עם תיקונים זהירים
const express = require('express');
const cors = require('cors');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

// הגדרות מאוזנות - לא קיצוניות
const CONFIG = {
    MAX_DURATION: 1200, // 20 דקות - ללא שינוי
    MAX_FILESIZE: '75M', // 75MB - פשרה בין 50 ל-100
    TIMEOUT: 240000, // 4 דקות - פשרה בין 2 ל-5
    TEMP_CLEANUP_DELAY: 60000, // דקה - ללא שינוי
    PROGRESS_TIMEOUT: 30000 // 30 שניות - פשרה בין 20 ל-45
};

// מעקב תהליכים - חשוב לטיפול ב-SIGTERM
let activeProcesses = new Set();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));

// טיפול באותות מערכת - חשוב לRailway
process.on('SIGTERM', () => {
    console.log('📡 Received SIGTERM, gracefully shutting down...');
    
    activeProcesses.forEach(proc => {
        try {
            proc.kill('SIGTERM');
        } catch (e) {
            console.warn('Failed to kill process:', e.message);
        }
    });
    
    setTimeout(() => {
        process.exit(0);
    }, 5000);
});

process.on('SIGINT', () => {
    console.log('📡 Received SIGINT, shutting down...');
    process.exit(0);
});

// Health endpoints - ללא שינוי
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
        execSync('yt-dlp --version', { stdio: 'pipe', timeout: 5000 });
        const ytdlpVersion = execSync('yt-dlp --version', { encoding: 'utf8', timeout: 5000 }).trim();
        
        execSync('ffmpeg -version', { stdio: 'pipe', timeout: 5000 });
        const ffmpegVersion = execSync('ffmpeg -version', { encoding: 'utf8', timeout: 5000 }).split('\n')[0];
        
        res.json({
            status: 'healthy',
            services: {
                ytdlp: ytdlpVersion,
                ffmpeg: ffmpegVersion
            },
            config: CONFIG,
            activeProcesses: activeProcesses.size,
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

// בדיקת אורך - זהירה יותר
async function checkVideoDuration(url) {
    return new Promise((resolve) => {
        const checkProcess = spawn('yt-dlp', [
            '--print', 'duration',
            '--no-warnings',
            '--no-playlist',
            '--socket-timeout', '15',
            url
        ], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        activeProcesses.add(checkProcess);
        
        let output = '';
        
        checkProcess.stdout.on('data', (data) => {
            output += data.toString();
        });

        const cleanup = () => {
            activeProcesses.delete(checkProcess);
        };

        checkProcess.on('close', (code) => {
            cleanup();
            if (code === 0 && output.trim()) {
                const duration = parseInt(output.trim());
                resolve(isNaN(duration) ? null : duration);
            } else {
                resolve(null);
            }
        });

        checkProcess.on('error', () => {
            cleanup();
            resolve(null);
        });

        setTimeout(() => {
            try {
                checkProcess.kill('SIGTERM');
            } catch (e) {}
            cleanup();
            resolve(null);
        }, 20000); // 20 שניות למעבר לוודא
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
    let currentProcess = null;

    const cleanup = () => {
        if (currentProcess) {
            activeProcesses.delete(currentProcess);
            try {
                currentProcess.kill('SIGTERM');
            } catch (e) {}
        }
        cleanupDirectory(tempDir);
    };

    try {
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        console.log(`🚀 Starting conversion for URL: ${url}`);

        // בדיקת אורך זהירה
        console.log('🔍 Checking video duration...');
        const duration = await checkVideoDuration(url);
        if (duration && duration > CONFIG.MAX_DURATION) {
            cleanup();
            return res.status(400).json({ 
                error: `Video too long (${Math.round(duration/60)} minutes). Maximum: ${CONFIG.MAX_DURATION/60} minutes` 
            });
        }
        if (duration) {
            console.log(`✅ Duration OK: ${Math.round(duration/60)} minutes`);
        } else {
            console.log(`⚠️ Could not verify duration, proceeding carefully`);
        }

        // yt-dlp עם פרמטרים שמרניים יותר
        const ytdlpArgs = [
            '--extract-audio',
            '--audio-format', 'wav',
            '--audio-quality', '0',
            '--max-filesize', CONFIG.MAX_FILESIZE,
            '--no-playlist', // עדיין חשוב
            '--no-warnings',
            '--progress',
            '--socket-timeout', '30',
            '--retries', '2', // 2 במקום 3
            '--output', path.join(tempDir, `${outputName}.%(ext)s`)
        ];

        // השתמש ב-URL המקורי (ללא ניקוי קיצוני)
        // רק הסר list parameters אם הם קיימים
        let processUrl = url;
        if (url.includes('&list=') || url.includes('?list=')) {
            processUrl = url.split('&list=')[0].split('?list=')[0];
            console.log(`🧹 Cleaned playlist from URL: ${processUrl}`);
        }
        
        ytdlpArgs.push(processUrl);

        console.log(`🎬 Starting yt-dlp conversion...`);

        currentProcess = spawn('yt-dlp', ytdlpArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' }
        });

        activeProcesses.add(currentProcess);

        let stdout = '';
        let stderr = '';
        let downloadProgress = 0;
        let conversionPhase = false;

        currentProcess.stdout.on('data', (data) => {
            const output = data.toString();
            stdout += output;
            
            // מעקב אחר התקדמות ההורדה
            const progressMatch = output.match(/\[download\]\s+(\d+\.?\d*)%/);
            if (progressMatch) {
                downloadProgress = parseFloat(progressMatch[1]);
                lastProgressTime = Date.now();
                console.log(`📥 Download: ${downloadProgress}%`);
            }
            
            // מעקב אחר המרה
            if (output.includes('[ffmpeg]') || output.includes('Converting')) {
                if (!conversionPhase) {
                    console.log(`🔄 Starting conversion phase...`);
                    conversionPhase = true;
                }
                lastProgressTime = Date.now();
            }
            
            // סיום המרה
            if (output.includes('100%') && conversionPhase) {
                console.log(`✅ Conversion completed!`);
                lastProgressTime = Date.now();
            }
        });

        currentProcess.stderr.on('data', (data) => {
            const output = data.toString();
            stderr += output;
            
            if (output.trim().length > 0 && !output.includes('WARNING')) {
                console.log(`stderr: ${output}`);
                lastProgressTime = Date.now();
            }
        });

        // Timeout מאוזן
        const mainTimeout = setTimeout(() => {
            if (!responded) {
                console.log(`⏰ Main timeout after ${CONFIG.TIMEOUT/1000} seconds`);
                cleanup();
                res.status(504).json({ 
                    error: `Conversion timed out after ${CONFIG.TIMEOUT/1000} seconds. Try a shorter or different video.` 
                });
                responded = true;
            }
        }, CONFIG.TIMEOUT);

        // בדיקת התקדמות מאוזנת
        const progressCheck = setInterval(() => {
            const timeSinceProgress = Date.now() - lastProgressTime;
            if (timeSinceProgress > CONFIG.PROGRESS_TIMEOUT && !responded) {
                console.log(`⏰ No progress for ${CONFIG.PROGRESS_TIMEOUT/1000}s (Download: ${downloadProgress}%, Conversion: ${conversionPhase})`);
                clearTimeout(mainTimeout);
                clearInterval(progressCheck);
                cleanup();
                res.status(504).json({ 
                    error: `Process stuck at ${downloadProgress}%. Please try again.` 
                });
                responded = true;
            }
        }, 5000); // בדוק כל 5 שניות (לא 3)

        currentProcess.on('close', (code) => {
            clearTimeout(mainTimeout);
            clearInterval(progressCheck);
            activeProcesses.delete(currentProcess);
            
            if (!responded) {
                console.log(`🏁 Process finished with code: ${code}`);
                
                if (code !== 0) {
                    console.error(`❌ Process failed with code ${code}`);
                    cleanup();
                    
                    let errorMessage = 'Conversion failed';
                    if (stderr.includes('Video unavailable') || stderr.includes('Private video')) {
                        errorMessage = 'Video is unavailable, private, or restricted';
                    } else if (stderr.includes('too large') || stderr.includes('max-filesize')) {
                        errorMessage = `File too large (max ${CONFIG.MAX_FILESIZE})`;
                    } else if (stderr.includes('Sign in') || stderr.includes('age')) {
                        errorMessage = 'Video requires authentication or age verification';
                    } else if (stderr.includes('format') || stderr.includes('No video formats')) {
                        errorMessage = 'No suitable audio format available';
                    } else if (downloadProgress > 0) {
                        errorMessage = `Download failed at ${downloadProgress}% - please try again`;
                    }
                    
                    res.status(400).json({ error: errorMessage });
                } else {
                    // בדיקת קובץ עם retry (לא מהיר מדי)
                    let attempts = 0;
                    const maxAttempts = 3; // 3 במקום 5 או 1
                    
                    const checkFile = () => {
                        attempts++;
                        
                        if (fs.existsSync(outputPath)) {
                            const stats = fs.statSync(outputPath);
                            console.log(`✅ File ready: ${Math.round(stats.size / 1024 / 1024 * 100) / 100}MB`);
                            
                            if (stats.size === 0) {
                                cleanup();
                                res.status(500).json({ error: 'Generated file is empty. Please try again.' });
                            } else if (stats.size > 100 * 1024 * 1024) { // עדיין בדוק 100MB
                                cleanup();
                                res.status(400).json({ error: 'File exceeds 100MB limit' });
                            } else {
                                res.setHeader('Content-Type', 'audio/wav');
                                res.setHeader('Content-Disposition', `attachment; filename="${outputName}.wav"`);
                                res.setHeader('Content-Length', stats.size);
                                
                                const readStream = fs.createReadStream(outputPath);
                                readStream.pipe(res);
                                
                                setTimeout(() => cleanupDirectory(tempDir), CONFIG.TEMP_CLEANUP_DELAY);
                            }
                        } else if (attempts < maxAttempts) {
                            console.log(`⏳ File not ready, waiting... (${attempts}/${maxAttempts})`);
                            setTimeout(checkFile, 2000); // 2 שניות בין נסיונות
                        } else {
                            cleanup();
                            res.status(500).json({ error: 'Output file was not created. Please try again.' });
                        }
                    };
                    
                    checkFile();
                }
                responded = true;
            }
        });

        currentProcess.on('error', (error) => {
            clearTimeout(mainTimeout);
            clearInterval(progressCheck);
            activeProcesses.delete(currentProcess);
            
            if (!responded) {
                console.error(`❌ Process error: ${error.message}`);
                cleanup();
                res.status(500).json({ error: 'Conversion process failed to start. Please try again.' });
                responded = true;
            }
        });

    } catch (error) {
        if (!responded) {
            console.error(`❌ Error: ${error.message}`);
            cleanup();
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
});
