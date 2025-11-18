const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

// Install bleeding-edge yt-dlp directly from GitHub master
console.log('🔄 Installing yt-dlp from GitHub master branch...');
const updateYtDlp = spawn('pip', [
    'install', 
    '--upgrade', 
    '--force-reinstall',
    'git+https://github.com/yt-dlp/yt-dlp.git@master',
    '--break-system-packages'
]);

updateYtDlp.stdout.on('data', (data) => console.log('pip:', data.toString().trim()));
updateYtDlp.stderr.on('data', (data) => console.log('pip:', data.toString().trim()));
updateYtDlp.on('close', (code) => {
    console.log(code === 0 ? '✅ Bleeding-edge yt-dlp installed' : '⚠️ Install issues');
});

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.json({ status: 'healthy' }));

function cleanFilename(filename) {
    return filename.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').substring(0, 200);
}

function getVideoTitle(url) {
    return new Promise((resolve) => {
        const args = [
            '--print', 'title',
            '--no-playlist',
            '--extractor-args', 'youtube:player_client=android_testsuite',
            url
        ];
        
        const ytdlp = spawn('yt-dlp', args);
        let title = '';
        
        ytdlp.stdout.on('data', (data) => title += data.toString().trim());
        ytdlp.on('close', (code) => {
            resolve(code === 0 && title ? cleanFilename(title) : 'waveforce_audio');
        });
    });
}

async function downloadWithLatestMethods(url, tempDir, outputName) {
    // Methods that worked well in late 2024
    const methods = [
        {
            name: '🧪 Android TestSuite',
            args: [
                '--extractor-args', 'youtube:player_client=android_testsuite',
                '--extractor-args', 'youtube:skip=dash,hls'
            ]
        },
        {
            name: '🤖 Android',
            args: [
                '--extractor-args', 'youtube:player_client=android',
                '--extractor-args', 'youtube:skip=dash'
            ]
        },
        {
            name: '🎵 Android Music',
            args: ['--extractor-args', 'youtube:player_client=android_music']
        },
        {
            name: '🔧 Android Creator',
            args: ['--extractor-args', 'youtube:player_client=android_creator']
        },
        {
            name: '🧪 Android VR',
            args: ['--extractor-args', 'youtube:player_client=android_vr']
        },
        {
            name: '📱 iOS',
            args: [
                '--extractor-args', 'youtube:player_client=ios',
                '--extractor-args', 'youtube:skip=dash'
            ]
        },
        {
            name: '🎮 MediaConnect',
            args: ['--extractor-args', 'youtube:player_client=mediaconnect']
        },
        {
            name: '📺 TV Embedded',
            args: ['--extractor-args', 'youtube:player_client=tv_embedded']
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
                await new Promise(resolve => setTimeout(resolve, 1500));
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
            '--socket-timeout', '30',
            '--retries', '3',
            '--fragment-retries', '3',
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
        }, 45000);

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
                else if (errorOutput.includes('format')) msg = 'Format issue';
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
        const result = await downloadWithLatestMethods(url, tempDir, videoTitle);
        
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
            if (msg.includes('Bot detected')) {
                msg = 'YouTube blocking - was working last month. Try: different video or wait 10 min';
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
    console.log('⚡ WaveForce - Port', PORT);
    console.log('🔥 Using bleeding-edge yt-dlp from GitHub');
});
