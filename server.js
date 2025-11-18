const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Original /download endpoint (for direct downloads)
app.get('/download', (req, res) => {
  const url = req.query.url;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  convertAndSend(url, null, res);
});

// New /api/convert endpoint (for the web interface)
app.post('/api/convert', (req, res) => {
  const { url, filename } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  convertAndSend(url, filename, res);
});

// Shared conversion function
function convertAndSend(url, customFilename, res) {
  const outputTemplate = `/tmp/%(title)s.%(ext)s`;
  
  const ytDlpArgs = [
    '-f', 'bestaudio',
    '--extract-audio',
    '--audio-format', 'wav',
    '-o', outputTemplate,
    url
  ];

  const ytDlpProcess = spawn('yt-dlp', ytDlpArgs);
  let filename = null;
  let errorOutput = '';

  ytDlpProcess.stderr.on('data', (data) => {
    const output = data.toString();
    errorOutput += output;
    console.error('STDERR:', output);
  });

  ytDlpProcess.stdout.on('data', (data) => {
    const output = data.toString();
    console.log('STDOUT:', output);
    
    const match = output.match(/\[download\] Destination: (.+)/);
    if (match) {
      // Clean the filename immediately when capturing it
      filename = match[1].trim().replace(/[\r\n\t]/g, '');
    }
  });

  ytDlpProcess.on('close', (code) => {
    if (code !== 0) {
      console.error('yt-dlp failed with code:', code);
      console.error('Error output:', errorOutput);
      return res.status(500).json({ 
        error: 'Download failed', 
        details: errorOutput 
      });
    }

    if (!filename || !fs.existsSync(filename)) {
      console.error('File not found:', filename);
      return res.status(500).json({ error: 'Could not find downloaded file' });
    }

    // Get just the basename and sanitize it aggressively
    const baseFilename = path.basename(filename);
    
    // Create a completely safe filename
    let sanitizedFilename;
    try {
      if (customFilename) {
        // Use custom filename if provided
        sanitizedFilename = customFilename
          .split('')
          .map(char => {
            const code = char.charCodeAt(0);
            if (code >= 32 && code <= 126 && char !== '"' && char !== '\\') {
              return char;
            }
            return '_';
          })
          .join('') + '.wav';
      } else {
        // Sanitize the original filename
        sanitizedFilename = baseFilename
          .split('')
          .map(char => {
            const code = char.charCodeAt(0);
            if (code >= 32 && code <= 126 && char !== '"' && char !== '\\') {
              return char;
            }
            return '_';
          })
          .join('');
      }
      
      // If the filename is now empty or too short, use a default
      if (sanitizedFilename.length < 3) {
        sanitizedFilename = 'audio_' + Date.now() + '.wav';
      }
    } catch (err) {
      console.error('Error sanitizing filename:', err);
      sanitizedFilename = 'audio_' + Date.now() + '.wav';
    }

    console.log('Original filename:', baseFilename);
    console.log('Sanitized filename:', sanitizedFilename);

    // Set headers with sanitized filename
    try {
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Disposition', `attachment; filename="${sanitizedFilename}"`);
    } catch (headerError) {
      console.error('Error setting headers:', headerError);
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Disposition', `attachment; filename="audio_${Date.now()}.wav"`);
    }
    
    const fileStream = fs.createReadStream(filename);
    
    fileStream.on('error', (err) => {
      console.error('Error reading file:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error reading file' });
      }
    });
    
    fileStream.pipe(res);
    
    fileStream.on('end', () => {
      fs.unlink(filename, (err) => {
        if (err) {
          console.error('Error deleting file:', err);
        } else {
          console.log('File deleted:', filename);
        }
      });
    });

    res.on('error', (err) => {
      console.error('Response error:', err);
      if (fs.existsSync(filename)) {
        fs.unlink(filename, () => {});
      }
    });
  });

  ytDlpProcess.on('error', (err) => {
    console.error('Failed to start yt-dlp:', err);
    res.status(500).json({ error: 'Failed to start download process' });
  });
}

app.listen(PORT, () => {
  console.log(`WaveForce running on port ${PORT}`);
});
