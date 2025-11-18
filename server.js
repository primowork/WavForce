const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

app.get('/download', (req, res) => {
  const url = req.query.url;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

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
      filename = match[1].trim();
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

    // Sanitize filename for Content-Disposition header
    // Remove non-ASCII characters and special characters that might cause issues
    const baseFilename = path.basename(filename);
    const sanitizedFilename = baseFilename
      .replace(/[^\x20-\x7E]/g, '_')  // Replace non-ASCII with underscore
      .replace(/["\\]/g, '_')          // Replace quotes and backslashes
      .replace(/[\r\n]/g, '_')         // Replace newlines
      .replace(/[<>:"|?*]/g, '_');     // Replace other problematic characters

    console.log('Original filename:', baseFilename);
    console.log('Sanitized filename:', sanitizedFilename);

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizedFilename}"`);
    
    const fileStream = fs.createReadStream(filename);
    
    fileStream.on('error', (err) => {
      console.error('Error reading file:', err);
      res.status(500).json({ error: 'Error reading file' });
    });
    
    fileStream.pipe(res);
    
    fileStream.on('end', () => {
      // Clean up the file after sending
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
      // Try to clean up the file even if there was an error
      if (fs.existsSync(filename)) {
        fs.unlink(filename, () => {});
      }
    });
  });

  ytDlpProcess.on('error', (err) => {
    console.error('Failed to start yt-dlp:', err);
    res.status(500).json({ error: 'Failed to start download process' });
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
