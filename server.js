const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

// Cache for visitor_data to simulate persistent browser
let visitorDataCache = {
    data: null,
    timestamp: null
};

console.log('🔄 Updating yt-dlp...');
const updateYtDlp = spawn('pip', ['install', '--upgrade', '--force-reinstall', 'yt-dlp', '--break-system-packages']);

updateYtDlp.on('close', (code) => {
    console.log(code === 0 ? '✅ yt-dlp updated' : '⚠️ Update had issues');
});

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.json({ status: 'healthy' }));

function cleanFilename(filename) {
    return filename
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, '_')
        .substring(0, 200);
}

// Generate visitor_data programmatically (simulates YouTube browser session)
function generateVisitorData() {
    if (visitorDataCache.data && visitorDataCache.timestamp && 
        (Date.now() - visitorDataCache.timestamp < 3600000)) {
        return visitorDataCache.data;
    }
    
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let result = 'Cgt';
    for (let i = 0; i < 21; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    visitorDataCache = {
        data: result,
        timestamp: Date.now()
    };
    
    return result;
}

function getVideoTitle(url) {
    return new Promise((resolve, reject) => {
        const args = [
            '--print', 'title',
            '--no-playlist',
            '--extractor-args', 'youtube:player_client=android',
            '--no-check-certificates'
        ];
        
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
                reject(new Error('Failed'));
            }
        });
    });
}

async function downloadWithMethods(url, tempDir, outputName) {
    const visitorData = generateVisitorData();
    
    const methods = [
        {
            name: '🤖 Android',
            args: ['--extractor-args', 'youtube:player_client=android']
        },
        {
            name: '🎵 Android Music',
            args: ['--extractor-args', 'youtube:player_client=android_music']
        },
        {
            name: '📱 iOS',
            args: ['--extractor-args', 'youtube:player_client=ios']
        },
        {
            name: '🧪 Android VR',
            args: ['--extractor-args', 'youtube:player_client=android_vr']
        },
        {
            name: '📺 TV Embedded',
            args: ['--extractor-args', 'youtube:player_client=tv_embedded']
        },
        {
            name: '🌐 Web + Visitor',
            args: [
                '--extractor-args', 'youtube:player_client=web',
                '--extractor-args', `youtube:visitor_data=${visitorData}`
            ]
        },
        {
            name: '🎮 MediaConnect',
            args: ['--extractor-args', 'youtube:player_client=mediaconnect']
        },
        {
            name: '🔧 Android Creator',
            args: ['--extractor-args', 'youtube:player_client=android_creator']
        }
    ];

    for (let i = 0; i < methods.length; i++) {
        const method = methods[i];
        console.log(`${method.name} [${i + 1}/${methods.length}]`);
        
        try {
            const result = await attemptDownload(url, tempDir, outputName, method.args);
            if (result.success) {
                console.log(`✅ SUCCESS`);
                return result;
            }
        } catch (error) {
            console.log(`❌ ${error.message}`);
            if (i < methods.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }
    
    throw new Error('All methods failed');
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
            '--socket-timeout', '20',
            '--retries', '2',
            ...extraArgs,
            '--output', path.join(tempDir, outputName + '.%(ext)s'),
            url
        ];
        
        const ytdlp = spawn('yt-dlp', args);
        let errorOutput = '';
        let hasEnded = false;

        const timeout = setTimeout(() => {
            if (!hasEnded) {
                ytdlp.kill();
                reject(new Error('Timeout'));
                hasEnded = true;
            }
        }, 40000);

        ytdlp.stdout.on('data', () => process.stdout.write('.'));
        ytdlp.stderr.on('data', (data) => errorOutput += data.toString());

        ytdlp.on('close', (code) => {
            clearTimeout(timeout);
            if (hasEnded) return;
            hasEnded = true;
            
            if (code === 0) {
                const wavFile = path.join(tempDir, outputName + '.wav');
                if (fs.existsSync(wavFile)) {
                    resolve({ success: true, file: wavFile });
                } else {
                    reject(new Error('No file'));
                }
            } else {
                let msg = 'Failed';
                if (errorOutput.includes('Sign in') || errorOutput.includes('bot')) msg = 'Bot detected';
                else if (errorOutput.includes('unavailable')) msg = 'Unavailable';
                reject(new Error(msg));
            }
        });

        ytdlp.on('error', () => {
            clearTimeout(timeout);
            if (!hasEnded) {
                hasEnded = true;
                reject(new Error('Process error'));
            }
        });
    });
}

app.post('/api/convert', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL required' });
    }

    const randomId = crypto.randomBytes(4).toString('hex');
    const tempDir = '/tmp/temp_' + randomId;
    
    console.log('\n🎬', url);

    let videoTitle;
    try {
        videoTitle = await getVideoTitle(url);
        console.log('📝', videoTitle);
    } catch {
        videoTitle = 'waveforce_audio';
    }

    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    let hasResponse = false;

    try {
        const result = await downloadWithMethods(url, tempDir, videoTitle);
        
        if (hasResponse) return;
        
        if (result.success && fs.existsSync(result.file)) {
            const stats = fs.statSync(result.file);
            console.log(`✅ ${(stats.size / 1024 / 1024).toFixed(2)}MB\n`);
            
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('Content-Disposition', `attachment; filename="${videoTitle}.wav"`);
            
            const fileStream = fs.createReadStream(result.file);
            fileStream.pipe(res);
            fileStream.on('end', cleanup);
            
            hasResponse = true;
        } else {
            cleanup();
            res.status(500).json({ error: 'File not created' });
            hasResponse = true;
        }
    } catch (error) {
        if (!hasResponse) {
            console.log('❌', error.message, '\n');
            cleanup();
            
            let msg = error.message;
            if (msg.includes('Bot')) {
                msg = 'YouTube blocking datacenter IPs. Solutions: 1) Try different video 2) Wait 5 min 3) Switch to Render.com/Fly.io';
            }
            
            res.status(400).json({ error: msg });
            hasResponse = true;
        }
    }

    function cleanup() {
        try {
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        } catch (e) {}
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('⚡ WaveForce v2.0 - Port', PORT);
    console.log('🚀 8 fallback methods + programmatic visitor_data');
});
