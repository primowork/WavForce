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
            '--extractor-args', 'youtube:player_client=android',
            '--no-check-certificates',
            '--extractor-retries', '5',
            '--sleep-interval', '1',
            '--max-sleep-interval', '3'
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

// Try multiple extraction methods
async function downloadWithFallback(url, tempDir, outputName) {
    const methods = [
        {
            name: 'Android client',
            args: ['--extractor-args', 'youtube:player_client=android']
        },
        {
            name: 'Android Music client',
            args: ['--extractor-args', 'youtube:player_client=android_music']
        },
        {
            name: 'iOS client',
            args: ['--extractor-args', 'youtube:player_client=ios']
        },
        {
            name: 'Web client',
            args: ['--extractor-args', 'youtube:player_client=web']
        },
        {
            name: 'TV embedded client',
            args: ['--extractor-args', 'youtube:player_client=tv_embedded']
        }
    ];

    for (let i = 0; i < methods.length; i++) {
        const method = methods[i];
        console.log(`Trying method ${i + 1}/${methods.length}: ${method.name}`);
        
        try {
            const result = await attemptDownload(url, tempDir, outputName, method.args);
            if (result.success) {
                console.log(`✅ Success with ${method.name}`);
                return result;
            }
        } catch (error) {
            console.log(`❌ Failed with ${method.name}: ${error.message}`);
            if (i === methods.length - 1) {
                throw error;
            }
        }
    }
    
    throw new Error('All extraction methods failed');
}

function attemptDownload(url, tempDir, outputName, extraArgs = []) {
    return new Promise((resolve, reject) => {
        const args = [
            '--extract-audio',
            '--audio-format', 'wav',
            '--audio-quality', '0',
            '--no-playlist',
            '--no-check-certificates',
            '--no-warnings',
            '--extractor-retries', '3',
            '--sleep-interval', '1',
            '--max-sleep-interval', '2',
            ...extraArgs
        ];
        
        // Add cookies if file exists
        const cookiesPath = path.join(__dirname, 'youtube_cookies.txt');
        if (fs.existsSync(cookiesPath)) {
            args.push('--cookies', cookiesPath);
        }
        
        args.push('--output', path.join(tempDir, outputName + '.%(ext)s'));
        args.push(url);
        
        const ytdlp = spawn('yt-dlp', args);
        let errorOutput = '';
        let hasEnded = false;

        const timeout = setTimeout(() => {
            if (!hasEnded) {
                ytdlp.kill();
                reject(new Error('Timeout'));
                hasEnded = true;
            }
        }, 60000); // 60 second timeout per attempt

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
            if (hasEnded) return;
            hasEnded = true;
            
            if (code === 0) {
                const wavFile = path.join(tempDir, outputName + '.wav');
                if (fs.existsSync(wavFile)) {
                    resolve({ success: true, file: wavFile });
                } else {
                    reject(new Error('File not created'));
                }
            } else {
                let errorMessage = 'Download failed';
                if (errorOutput.includes('Sign in') || errorOutput.includes('not a bot')) {
                    errorMessage = 'Bot detection - trying alternative method';
                } else if (errorOutput.includes('Private video') || errorOutput.includes('unavailable')) {
                    errorMessage = 'Video is private or unavailable';
                } else if (errorOutput.includes('requested format')) {
                    errorMessage = 'Audio format not available';
                }
                reject(new Error(errorMessage));
            }
        });

        ytdlp.on('error', (error) => {
            clearTimeout(timeout);
            if (!hasEnded) {
                hasEnded = true;
                reject(error);
            }
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

    let hasResponse = false;

    try {
        const result = await downloadWithFallback(url, tempDir, outputName);
        
        if (hasResponse) return;
        
        if (result.success && fs.existsSync(result.file)) {
            console.log('File ready, sending...');
            
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('Content-Disposition', 'attachment; filename="' + outputName + '.wav"');
            
            const fileStream = fs.createReadStream(result.file);
            fileStream.pipe(res);
            
            fileStream.on('end', () => {
                cleanup();
            });
            
            hasResponse = true;
        } else {
            cleanup();
            res.status(500).json({ error: 'File not created' });
            hasResponse = true;
        }
    } catch (error) {
        if (!hasResponse) {
            console.log('All methods failed: ' + error.message);
            cleanup();
            
            let errorMessage = error.message;
            if (errorMessage.includes('Bot detection') || errorMessage.includes('Sign in')) {
                errorMessage = 'YouTube bot detection - please try again in a few moments or try a different video';
            }
            
            res.status(400).json({ error: errorMessage });
            hasResponse = true;
        }
    }

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
