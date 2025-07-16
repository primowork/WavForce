// server.js - Railway Express Server for WaveForce
const express = require('express');
const cors = require('cors');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

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
        // Check if yt-dlp is available
        execSync('yt-dlp --version', { stdio: 'pipe' });
        const ytdlpVersion = execSync('yt-dlp --version', { encoding: 'utf8' }).trim();
        
        // Check if ffmpeg is available
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
    
    // Validate input
    if (!url) {
        return res.status(400).json({ error: 'YouTube URL is required' });
    }

    // Validate YouTube URL
    const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/;
    if (!youtubeRegex.test(url)) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    // Generate unique identifiers
    const timestamp = Date.now();
    const randomId = crypto.randomBytes(8).toString('hex');
    const outputName = filename ? 
        `${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}_${randomId}` : 
        `waveforce_${randomId}`;
    
    const tempDir = `/tmp/waveforce_${timestamp}_${randomId}`;
    const outputPath = path.join(tempDir, `${outputName}.wav`);

    try {
        // Create temp directory
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        console.log(`🚀 Starting WaveForce conversion for: ${url}`);
        console.log(`📁 Temp directory: ${tempDir}`);
        console.log(`📄 Output file: ${outputPath}`);

        // Download and convert using yt-dlp
        const ytdlpProcess = spawn('yt-dlp', [
            '--extract-audio',
            '--audio-format', 'wav',
            '--audio-quality', '0',
            '--max-filesize', '100M',
            '--max-duration', '1200', // 20 minutes max
            '--no-playlist',
            '--output', path.join(tempDir, `${outputName}.%(ext)s`),
            url
        ], {
            stdio: ['pipe', 'pipe', 'pipe']
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

        // Set timeout for the process
        const timeout = setTimeout(() => {
            ytdlpProcess.kill('SIGTERM');
            console.log('⏰ Process timed out after 10 minutes');
        }, 600000); // 10 minutes timeout

        ytdlpProcess.on('close', (code) => {
            clearTimeout(timeout);
            
            if (code !== 0) {
                console.error(`❌ yt-dlp process exited with code ${code}`);
                console.error(`stderr: ${stderr}`);
                
                // Clean up temp directory
                cleanupDirectory(tempDir);
                
                // Handle specific errors
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

            // Check if file was created
            if (!fs.existsSync(outputPath)) {
                console.error(`❌ Output file not found: ${outputPath}`);
                cleanupDirectory(tempDir);
                return res.status(500).json({ error: 'Conversion completed but output file not found' });
            }

            try {
                // Get file stats
                const stats = fs.statSync(outputPath);
                console.log(`✅ File created successfully: ${outputPath}, size: ${stats.size} bytes`);

                // Check file size limit (50MB for Railway)
                const maxSize = 50 * 1024 * 1024; // 50MB
                if (stats.size > maxSize) {
                    cleanupDirectory(tempDir);
                    return res.status(400).json({ error: 'Converted file is too large. Please try a shorter video.' });
                }

                // Read file and send as binary
                const audioBuffer = fs.readFileSync(outputPath);
                
                // Clean up temp directory
                cleanupDirectory(tempDir);

                // Set headers for file download
                res.setHeader('Content-Type', 'audio/wav');
                res.setHeader('Content-Disposition', `attachment; filename="${outputName}.wav"`);
                res.setHeader('Content-Length', audioBuffer.length);
                
                console.log(`🎵 Sending WAV file: ${outputName}.wav (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
                res.send(audioBuffer);

            } catch (fileError) {
                console.error(`❌ File processing error: ${fileError.message}`);
                cleanupDirectory(tempDir);
                res.status(500).json({ error: 'Error processing converted file' });
            }
        });

        ytdlpProcess.on('error', (error) => {
            clearTimeout(timeout);
            console.error(`❌ Process error: ${error.message}`);
            cleanupDirectory(tempDir);
            res.status(500).json({ error: 'Conversion process failed to start' });
        });

    } catch (error) {
        console.error(`❌ Conversion error: ${error.message}`);
        cleanupDirectory(tempDir);
        res.status(500).json({ error: error.message || 'Internal server error' });
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
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌟 WaveForce server is operational on port ${PORT}`);
    console.log(`🚀 May the Force be with your audio conversions!`);
    
    // Check if required tools are available
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
