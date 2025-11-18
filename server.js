const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

// Update yt-dlp on startup to ensure latest version
console.log('Updating yt-dlp to latest version...');
const updateYtDlp = spawn('pip', ['install', '--upgrade', '--force-reinstall', 'yt-dlp', '--break-system-packages']);

updateYtDlp.stdout.on('data', (data) => {
    console.log('pip: ' + data.toString().trim());
});

updateYtDlp.stderr.on('data', (data) => {
    console.log('pip: ' + data.toString().trim());
});

updateYtDlp.on('close', (code) => {
    if (code === 0) {
        console.log('✅ yt-dlp updated successfully');
    } else {
        console.log('⚠️ yt-dlp update had issues, but continuing...');
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});

// Helper function to clean filename
function cleanFilename(filename) {
    // Remove or replace invalid characters for filenames
    return filename
        .replace(/[<>:"/\\|?*]/g, '_')  // Replace invalid chars with underscore
        .replace(/\s+/g, '_')            // Replace spaces with underscore
        .substring(0, 200);              // Limit length
}

// Helper function to get video title
function getVideoTitle(url) {
    return new Promise((resolve, reject) => {
        const args = [
            '--print', 'title',
            '--no-playlist',
            '--extractor-args', 'youtube:player_client=ios,web',
            '--user-agent', 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
            '--no-check-certificates'
        ];
        
        // Add cookies if file exists
        const cookiesPath = path.join(__dirname, 'youtube_cookies.txt');
        if (fs.existsSync(cookiesPath)) {
            args.push('--cookies', cookiesPath);
            console.log('Using cookies for title extraction');
        }
        
        args.push(url);
        
        const ytdlp = spawn('yt-dlp', args);

        let title = '';
        
        ytdlp.stdout.on('data', (data) => {
            title += data.toString().trim();
        });

        ytdlp.on('close', (code) => {
            if (code === 0 && title) {
                resolve(cleanFilename(title));
            } else {
                reject(new Error('Failed to get video title'));
            }
        });

        ytdlp.on('error', (error) => {
            reject(error);
        });
    });
}

app.post('/api/convert', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'YouTube URL is required' });
    }

    const randomId = crypto.randomBytes(4).toString('hex');
    const tempDir = '/tmp/temp_' + randomId;
    
    console.log('Converting: ' + url);

    let videoTitle;
    try {
        // Get video title first
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

    const args = [
        '--extract-audio',
        '--audio-format', 'wav',
        '--audio-quality', '0',
        '--no-playlist',
        '--extractor-args', 'youtube:player_client=ios,web',
        '--user-agent', 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
        '--no-check-certificates',
        '--no-warnings'
    ];
    
    // Add cookies if file exists
    const cookiesPath = path.join(__dirname, 'youtube_cookies.txt');
    if (fs.existsSync(cookiesPath)) {
        args.push('--cookies', cookiesPath);
        console.log('Using cookies for download');
    }
    
    args.push('--output', path.join(tempDir, outputName + '.%(ext)s'));
    args.push(url);
    
    const ytdlp = spawn('yt-dlp', args);

    let hasResponse = false;
    let errorOutput = '';

    const timeout = setTimeout(() => {
        if (!hasResponse) {
            console.log('Timeout');
            ytdlp.kill();
            cleanup();
            res.status(504).json({ error: 'Timeout - try a shorter video' });
            hasResponse = true;
        }
    }, 90000);

    ytdlp.stdout.on('data', (data) => {
        console.log(data.toString());
    });

    ytdlp.stderr.on('data', (data) => {
        const output = data.toString();
        console.log(output);
        errorOutput += output;
    });

    ytdlp.on('close', (code) => {
        clearTimeout(timeout);
        
        if (hasResponse) return;
        
        console.log('Process exited with code: ' + code);
        
        if (code !== 0) {
            cleanup();
            
            // Provide more specific error messages
            let errorMessage = 'Conversion failed';
            if (errorOutput.includes('Private video') || errorOutput.includes('unavailable')) {
                errorMessage = 'Video is private or unavailable';
            } else if (errorOutput.includes('Sign in') || errorOutput.includes('members-only')) {
                errorMessage = 'Video requires authentication';
            } else if (errorOutput.includes('n challenge')) {
                errorMessage = 'YouTube protection detected - trying alternative method';
            } else if (errorOutput.includes('requested format')) {
                errorMessage = 'Audio format not available for this video';
            }
            
            res.status(400).json({ error: errorMessage });
            hasResponse = true;
            return;
        }

        const wavFile = path.join(tempDir, outputName + '.wav');
        
        if (fs.existsSync(wavFile)) {
            console.log('File ready, sending...');
            
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('Content-Disposition', 'attachment; filename="' + outputName + '.wav"');
            
            const fileStream = fs.createReadStream(wavFile);
            fileStream.pipe(res);
            
            fileStream.on('end', () => {
                cleanup();
            });
            
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
