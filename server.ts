import express from 'express';
import path from 'path';
import fs from 'fs';
import https from 'https';
import { spawn, exec } from 'child_process';
import * as archiverModule from 'archiver';
const archiver = ((archiverModule as any).default || archiverModule) as any;
import { createServer as createViteServer } from 'vite';

const app = express();
const PORT = 3000;

app.use(express.json());

const TMP_DIR = '/tmp/getnow';
const DOWNLOADS_DIR = path.join(TMP_DIR, 'downloads');
let YTDLP_PATH = 'yt-dlp'; // Fallback to system PATH

// Setup base tmp folders
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

interface DownloadJob {
  id: string;
  type: 'single' | 'playlist';
  url: string;
  format: string;
  status: 'analyzing' | 'processing' | 'downloading' | 'completed' | 'error';
  progress: number;
  speed: string;
  eta: string;
  error?: string;
  title: string;
  filePath?: string;
  fileName?: string;
  totalVideos?: number;
  completedVideos?: number;
  currentVideoTitle?: string;
  createdAt: number;
  cookiesFile?: string;
}

const jobs = new Map<string, DownloadJob>();
const sseClients = new Map<string, express.Response[]>();

/**
 * Utility to format video/playlist duration from seconds to MM:SS or HH:MM:SS
 */
function formatDuration(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mStr = m < 10 ? `0${m}` : `${m}`;
  const sStr = s < 10 ? `0${s}` : `${s}`;
  if (h > 0) {
    const hStr = h < 10 ? `0${h}` : `${h}`;
    return `${hStr}:${mStr}:${sStr}`;
  }
  return `${mStr}:${sStr}`;
}

/**
 * Proactively triggers downloading or verifying yt-dlp binary on the server startup
 */
function ensureYtdlp(): Promise<string> {
  return new Promise((resolve) => {
    // 1. Check if yt-dlp is available globally under custom system paths or path
    exec('which yt-dlp || command -v yt-dlp', (error, stdout) => {
      if (!error && stdout.trim()) {
        YTDLP_PATH = stdout.trim();
        console.log(`yt-dlp detected globally at: ${YTDLP_PATH}`);
        resolve(YTDLP_PATH);
      } else {
        // 2. Check if yt-dlp binary has already been loaded into our local /tmp folder
        const localPath = path.join(TMP_DIR, 'yt-dlp');
        if (fs.existsSync(localPath)) {
          YTDLP_PATH = localPath;
          console.log(`yt-dlp loaded locally from: ${YTDLP_PATH}`);
          resolve(YTDLP_PATH);
        } else {
          // 3. Download official standard Linux binary
          console.log('yt-dlp not found in system environment. Initiating dynamic download from GitHub Releases...');
          const file = fs.createWriteStream(localPath);
          
          const download = (url: string) => {
            https.get(url, (response) => {
              if (response.statusCode === 302 || response.statusCode === 301) {
                download(response.headers.location!);
                return;
              }
              if (response.statusCode !== 200) {
                console.error(`yt-dlp download failed with status: ${response.statusCode}`);
                resolve('yt-dlp');
                return;
              }
              response.pipe(file);
              
              file.on('finish', () => {
                file.close(() => {
                  try {
                    fs.chmodSync(localPath, '755');
                    YTDLP_PATH = localPath;
                    console.log(`Successfully downloaded yt-dlp and made executable at: ${YTDLP_PATH}`);
                    resolve(YTDLP_PATH);
                  } catch (chmodErr) {
                    console.error('Failed to adjust execution permissions on local binary:', chmodErr);
                    resolve('yt-dlp');
                  }
                });
              });
            }).on('error', (err) => {
              fs.unlink(localPath, () => {});
              console.error('Error occurred while downloading yt-dlp:', err);
              resolve('yt-dlp');
            });
          };
          
          download('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp');
        }
      }
    });
  });
}

/**
 * Cleans up job files on request or timeout
 */
function cleanupJob(jobId: string) {
  const job = jobs.get(jobId);
  if (!job) return;
  
  console.log(`Starting clean-up operation for job ID: ${jobId}`);
  try {
    const jobFolder = path.join(DOWNLOADS_DIR, jobId);
    if (fs.existsSync(jobFolder)) {
      fs.rmSync(jobFolder, { recursive: true, force: true });
    }
    
    const zipPath = path.join(DOWNLOADS_DIR, `${jobId}.zip`);
    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    if (job.cookiesFile && fs.existsSync(job.cookiesFile)) {
      fs.unlinkSync(job.cookiesFile);
      console.log(`Wiped download job cookies file: ${job.cookiesFile}`);
    }
  } catch (err) {
    console.error(`Failed to completely wipe directories for job ${jobId}:`, err);
  }
  
  jobs.delete(jobId);
  
  const clients = sseClients.get(jobId) || [];
  clients.forEach((res) => {
    try {
      res.write(`data: ${JSON.stringify({ status: 'expired', id: jobId })}\n\n`);
      res.end();
    } catch (_) {}
  });
  sseClients.delete(jobId);
}

/**
 * Broadcasts progress changes to any connected SSE event handlers
 */
function broadcastProgress(jobId: string) {
  const job = jobs.get(jobId);
  if (!job) return;
  
  const clients = sseClients.get(jobId) || [];
  const message = `data: ${JSON.stringify(job)}\n\n`;
  clients.forEach((res) => {
    try {
      res.write(message);
    } catch (err) {
      console.error(`Error streaming update to client of job ${jobId}:`, err);
    }
  });
}

/**
 * Periodic interval to sweep files that are older than 10 minutes (600,000ms)
 */
setInterval(() => {
  const now = Date.now();
  jobs.forEach((job, jobId) => {
    if (now - job.createdAt > 10 * 60 * 1000) {
      console.log(`Auto-expiring job ${jobId} after 10 minutes.`);
      cleanupJob(jobId);
    }
  });
}, 30 * 1000);

// Initialize yt-dlp status (Will be awaited in startServer)
const ytdlpInitPromise = ensureYtdlp();

// ==========================================
// API ROUTES
// ==========================================

/**
 * POST /api/analyze
 * Fetches youtube video metadata using yt-dlp using flat-playlist or full query options
 */
app.post('/api/analyze', async (req, res) => {
  const { url, cookies } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'É necessário fornecer um URL do YouTube.' });
  }
  
  const youtubeUrlRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;
  if (!youtubeUrlRegex.test(url)) {
    return res.status(400).json({ error: 'URL inválido. Insira um link válido do YouTube.' });
  }
  
  // Conditionally write cookies txt file
  let cookiesPath = '';
  if (cookies && typeof cookies === 'string' && cookies.trim()) {
    try {
      if (!fs.existsSync(TMP_DIR)) {
        fs.mkdirSync(TMP_DIR, { recursive: true });
      }
      cookiesPath = path.join(TMP_DIR, `cookies_analyze_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.txt`);
      fs.writeFileSync(cookiesPath, cookies.trim(), 'utf8');
      console.log(`Temporary cookies written to ${cookiesPath} for analysis`);
    } catch (cookieErr) {
      console.error('Failed to write temporary cookies file:', cookieErr);
    }
  }

  try {
    console.log(`Analyzing YouTube link: ${url}`);
    
    // Using spawn to pass arguments securely and avoid shell command injections
    const args = [
      '--dump-single-json',
      '--flat-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--no-cache-dir',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--extractor-args', 'youtube:player_client=android,ios',
    ];

    if (cookiesPath) {
      args.push('--cookies', cookiesPath);
    }

    args.push(url);

    console.log(`[LOGGER-SERVER] Prepared yt-dlp arguments:`, args.map(a => a.includes('cookies') ? '"<hidden-cookies-path>"' : a).join(' '));

    // Dynamic clean-up callback
    const cleanupCookies = () => {
      if (cookiesPath && fs.existsSync(cookiesPath)) {
        try {
          fs.unlinkSync(cookiesPath);
          console.log(`[LOGGER-SERVER] Temporary cookies file wiped: ${cookiesPath}`);
        } catch (cErr: any) {
          console.error(`[LOGGER-SERVER] Could not remove temporary cookies file:`, cErr.message);
        }
      }
    };
    
    const child = spawn(YTDLP_PATH, args);
    let stdout = '';
    let stderr = '';
    let completed = false;
    
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      console.log(`[LOGGER-SERVER] yt-dlp STDOUT chunk (${text.length} chars)`);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      console.warn(`[LOGGER-SERVER] yt-dlp STDERR chunk: ${text.trim()}`);
    });
    
    child.on('error', (err) => {
      console.error('[LOGGER-SERVER] Critical error starting yt-dlp child process:', err);
      completed = true;
      cleanupCookies();
      if (!res.headersSent) {
        return res.status(500).json({ 
          error: `Não foi possível iniciar o motor de download (yt-dlp). Detalhes: ${err.message}. Certifique-se de que o Python está instalado e configurado no servidor.` 
        });
      }
    });
    
    child.on('close', (code) => {
      cleanupCookies();
      if (completed) return;
      completed = true;
      
      console.log(`[LOGGER-SERVER] yt-dlp analysis closed with exit code: ${code}`);
      console.log(`[LOGGER-SERVER] Combined STDOUT length: ${stdout.length} chars`);
      console.log(`[LOGGER-SERVER] Combined STDERR length: ${stderr.length} chars`);
      
      if (code !== 0) {
        console.error(`[LOGGER-SERVER] yt-dlp exited with non-zero code ${code}. Stderr content: ${stderr}`);
        
        let userMessage = 'Ocorreu um erro ao tentar obter informações deste link.';
        if (stderr.includes('Incomplete connection') || stderr.includes('HTTP Error')) {
          userMessage = 'Erro de rede ou conexão com o YouTube recusada.';
        } else if (stderr.includes('Private video') || stderr.includes('Sign in to confirm your age')) {
          userMessage = 'Este vídeo é privado ou requer restrição de idade.';
        } else if (stderr.includes('Video unavailable')) {
          userMessage = 'Vídeo indisponível ou excluído do YouTube.';
        } else if (stderr.includes('playlist does not exist')) {
          userMessage = 'A playlist fornecida não existe ou é privada.';
        } else if (stderr.includes('confirm you are not a bot') || stderr.includes('Sign in to confirm you’re not a bot')) {
          userMessage = 'O YouTube bloqueou este pedido devido a deteção de bot. Use a opção "Bypass / Cookies" abaixo para resolver.';
        }
        
        return res.status(500).json({ 
          error: `${userMessage} (Código de Saída: ${code}. Erro: ${stderr.trim() || 'Desconhecido'})`, 
          details: stderr.trim() 
        });
      }
      
      try {
        if (!stdout.trim()) {
          throw new Error('O yt-dlp fechou sem erros, mas obteve uma saída em branco.');
        }
        
        console.log(`[LOGGER-SERVER] Attempting to parse JSON output (First 150 chars): "${stdout.trim().substring(0, 150)}..."`);
        const rawJson = JSON.parse(stdout);
        const type = rawJson._type === 'playlist' ? 'playlist' : 'single';
        console.log(`[LOGGER-SERVER] Successfully parsed meta-JSON. Asset detected Type: "${type}", Title: "${rawJson.title || 'Untitled'}"`);
        
        if (type === 'playlist') {
          const playlistEntries = (rawJson.entries || []).map((entry: any) => ({
            id: entry.id,
            title: entry.title || 'Título Indisponível',
            duration: formatDuration(entry.duration),
            durationSec: entry.duration || 0,
            url: entry.url || `https://www.youtube.com/watch?v=${entry.id}`,
            thumbnail: `https://img.youtube.com/vi/${entry.id}/mqdefault.jpg`
          }));
          
          console.log(`[LOGGER-SERVER] Returning playlist meta-response containing ${playlistEntries.length} items`);
          return res.json({
            type: 'playlist',
            id: rawJson.id,
            title: rawJson.title || 'Playlist do YouTube',
            totalVideos: playlistEntries.length,
            thumbnail: playlistEntries[0]?.thumbnail || 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=120&auto=format&fit=crop',
            entries: playlistEntries
          });
        } else {
          console.log(`[LOGGER-SERVER] Returning single video meta-response for video ID: ${rawJson.id}`);
          return res.json({
            type: 'single',
            id: rawJson.id,
            title: rawJson.title || 'Vídeo do YouTube',
            channel: rawJson.uploader || rawJson.channel || 'Canal Desconhecido',
            duration: formatDuration(rawJson.duration),
            durationSec: rawJson.duration || 0,
            thumbnail: rawJson.thumbnail || `https://img.youtube.com/vi/${rawJson.id}/maxresdefault.jpg` || `https://img.youtube.com/vi/${rawJson.id}/mqdefault.jpg`,
            url: url
          });
        }
      } catch (parseError: any) {
        console.error('[LOGGER-SERVER] Failed to parse metadata JSON output:', parseError.message);
        console.error('[LOGGER-SERVER] Raw stdout stdout text content was:', stdout);
        return res.status(500).json({ 
          error: 'Falha ao processar os metadados do vídeo. Resposta do yt-dlp não pôde ser interpretada como JSON.',
          details: parseError.message,
          rawOutput: stdout.substring(0, 1000)
        });
      }
    });
  } catch (error: any) {
    console.error('Spawning yt-dlp error:', error);
    return res.status(500).json({ error: 'Erro inesperado do servidor.', details: error.message });
  }
});

/**
 * POST /api/download
 * Launches download background job
 */
app.post('/api/download', (req, res) => {
  const { url, format, selectedVideos, title, cookies } = req.body;
  
  console.log(`[LOGGER-SERVER] New download job requested -> format: "${format}", isPlaylist: ${Array.isArray(selectedVideos) && selectedVideos.length > 0}, URL: "${url}"`);
  
  if (!url || !format) {
    return res.status(400).json({ error: 'URL e formato de download são obrigatórios.' });
  }
  
  // Concurrency Guard: Maximum 5 concurrent running downloads
  const activeJobs = Array.from(jobs.values()).filter(
    (j) => j.status === 'downloading' || j.status === 'processing'
  );
  if (activeJobs.length >= 5) {
    return res.status(429).json({
      error: 'Limite de 5 downloads simultâneos atingido no servidor. Aguarde a conclusão de outros downloads.'
    });
  }
  
  const jobId = Math.random().toString(36).substring(2, 11);
  const isPlaylist = Array.isArray(selectedVideos) && selectedVideos.length > 0;

  // Conditionally write cookies txt file for downloads
  let cookiesPath = '';
  if (cookies && typeof cookies === 'string' && cookies.trim()) {
    try {
      if (!fs.existsSync(TMP_DIR)) {
        fs.mkdirSync(TMP_DIR, { recursive: true });
      }
      cookiesPath = path.join(TMP_DIR, `cookies_download_${jobId}.txt`);
      fs.writeFileSync(cookiesPath, cookies.trim(), 'utf8');
      console.log(`Job ${jobId} temporary download cookies stored at ${cookiesPath}`);
    } catch (cookieErr) {
      console.error('Failed to write download job cookies file:', cookieErr);
    }
  }
  
  const job: DownloadJob = {
    id: jobId,
    type: isPlaylist ? 'playlist' : 'single',
    url,
    format,
    status: 'analyzing',
    progress: 0,
    speed: '---',
    eta: '---',
    title: title || (isPlaylist ? 'Download de Playlist' : 'Download de Vídeo'),
    createdAt: Date.now(),
    cookiesFile: cookiesPath || undefined
  };
  
  if (isPlaylist) {
    job.totalVideos = selectedVideos.length;
    job.completedVideos = 0;
    job.currentVideoTitle = 'Aguardando início...';
  }
  
  jobs.set(jobId, job);
  
  // Initiate actual download process asynchronously in the background
  processDownload(job, selectedVideos).catch((err) => {
    console.error(`Background job failure for ${jobId}:`, err);
    job.status = 'error';
    job.error = err.message || 'Falha desconhecida no download.';
    broadcastProgress(jobId);
  });
  
  return res.json({ jobId });
});

/**
 * GET /api/progress/:id
 * Establishes real-time SSE stream for progress reports
 */
app.get('/api/progress/:id', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  
  console.log(`[LOGGER-SERVER] Client initiating Server-Sent Events (SSE) connection for process: ${jobId}`);
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering on Nginx/Render/proxies
  res.flushHeaders();
  
  if (!job) {
    res.write(`data: ${JSON.stringify({ status: 'error', error: 'O ID do processo não foi encontrado.' })}\n\n`);
    res.end();
    return;
  }
  
  // Register client response object
  if (!sseClients.has(jobId)) {
    sseClients.set(jobId, []);
  }
  sseClients.get(jobId)!.push(res);
  
  // Stream initial payload immediately
  res.write(`data: ${JSON.stringify(job)}\n\n`);
  
  req.on('close', () => {
    const clients = sseClients.get(jobId) || [];
    const index = clients.indexOf(res);
    if (index !== -1) {
      clients.splice(index, 1);
    }
    if (clients.length === 0) {
      sseClients.delete(jobId);
    }
  });
});

/**
 * GET /api/file/:id
 * Serves completed download file or `.zip` file
 */
app.get('/api/file/:id', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  
  console.log(`[LOGGER-SERVER] File retrieval request for jobId: "${jobId}"`);
  
  if (!job) {
    console.error(`[LOGGER-SERVER] Job "${jobId}" was not found in active in-memory tracker.`);
    return res.status(404).json({ error: 'Processo de download não encontrado no servidor.' });
  }

  console.log(`[LOGGER-SERVER] Job details resolved -> title: "${job.title}", status: "${job.status}", filePath: "${job.filePath || 'none'}", fileName: "${job.fileName || 'none'}"`);

  if (!job.filePath) {
    console.error(`[LOGGER-SERVER] Job "${jobId}" has no valid filePath defined.`);
    return res.status(404).json({ error: 'Caminho de ficheiro inválido para este download.' });
  }

  const fileExists = fs.existsSync(job.filePath);
  console.log(`[LOGGER-SERVER] Checking file on disc at "${job.filePath}" -> Exists: ${fileExists}`);

  if (!fileExists) {
    console.error(`[LOGGER-SERVER] File not found on disc at "${job.filePath}". Checking directory contents...`);
    try {
      const parentDir = path.dirname(job.filePath);
      if (fs.existsSync(parentDir)) {
        const files = fs.readdirSync(parentDir);
        console.warn(`[LOGGER-SERVER] Contents of directory "${parentDir}":`, files);
      } else {
        console.warn(`[LOGGER-SERVER] Parent directory "${parentDir}" does not exist either.`);
      }
    } catch (dirErr: any) {
      console.error(`[LOGGER-SERVER] Failed to read directory contents:`, dirErr.message);
    }
    return res.status(404).json({ error: 'Ficheiro não encontrado ou expirou no servidor.' });
  }

  try {
    const stats = fs.statSync(job.filePath);
    const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
    console.log(`[LOGGER-SERVER] Serving physical file: "${job.filePath}" (${sizeMb} MB) as dynamic download name: "${job.fileName}"`);
    
    // Explicitly set headers to avoid buffering or caching during download
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Cache-Control', 'no-cache');
  } catch (statErr: any) {
    console.error(`[LOGGER-SERVER] Could not resolve stats for file:`, statErr.message);
  }

  res.download(job.filePath, job.fileName, (err) => {
    if (err) {
      console.error(`[LOGGER-SERVER] Failed or interrupted inside Express stream for file "${job.filePath}":`, err);
    } else {
      console.log(`[LOGGER-SERVER] File transfer completed successfully for jobId: "${jobId}"`);
    }
  });
});

/**
 * DELETE /api/file/:id
 * Manual cleanup of download records and physical files
 */
app.delete('/api/file/:id', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  if (job) {
    cleanupJob(jobId);
    return res.json({ success: true, message: 'Ficheiro removido com sucesso.' });
  }
  return res.status(404).json({ error: 'Processo não encontrado.' });
});

// ==========================================
// BACKGROUND PROCESS TASK RUNNER
// ==========================================

async function processDownload(job: DownloadJob, selectedVideos?: any[]) {
  const jobId = job.id;
  const jobFolder = path.join(DOWNLOADS_DIR, jobId);
  
  if (!fs.existsSync(jobFolder)) {
    fs.mkdirSync(jobFolder, { recursive: true });
  }

  // Map requested formats to proper yt-dlp flags
  let formatArgs: string[] = [];
  switch (job.format) {
    case 'webm':
      formatArgs = ['-f', 'bv+ba/b', '--merge-output-format', 'webm'];
      break;
    case 'mp4-1080p':
      formatArgs = ['-f', 'bv*[height<=1080]+ba/b[height<=1080]', '--merge-output-format', 'mp4'];
      break;
    case 'mp4-720p':
      formatArgs = ['-f', 'bv*[height<=720]+ba/b[height<=720]', '--merge-output-format', 'mp4'];
      break;
    case 'mp4-480p':
      formatArgs = ['-f', 'bv*[height<=480]+ba/b[height<=480]', '--merge-output-format', 'mp4'];
      break;
    case 'mp4-360p':
      formatArgs = ['-f', 'bv*[height<=360]+ba/b[height<=360]', '--merge-output-format', 'mp4'];
      break;
    case 'mp3-320kbps':
      formatArgs = ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '320K'];
      break;
    case 'mp3-128kbps':
      formatArgs = ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '128K'];
      break;
    default:
      formatArgs = ['-f', 'bv*[height<=1080]+ba/b/b', '--merge-output-format', 'mp4'];
  }

  // Adding max filesize check (2GB Limit per specification)
  formatArgs.push('--max-filesize', '2G');

  const bypassFlags = [
    '--no-check-certificates',
    '--no-cache-dir',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '--extractor-args', 'youtube:player_client=android,ios',
    '--no-warnings'
  ];

  if (job.cookiesFile) {
    bypassFlags.push('--cookies', job.cookiesFile);
  }
  
  if (job.type === 'single') {
    job.status = 'downloading';
    broadcastProgress(jobId);
    
    const outputTemplate = path.join(jobFolder, '%(title)s.%(ext)s');
    const args = [
      ...bypassFlags,
      ...formatArgs,
      '--no-playlist',
      '-o',
      outputTemplate,
      job.url
    ];
    
    console.log(`Spawning yt-dlp single download with flags: ${args.join(' ')}`);
    
    await executeSingleDownload(args, job);
  } else {
    // Playlist Sequencer
    const total = selectedVideos ? selectedVideos.length : 0;
    if (total === 0) {
      throw new Error('Nenhum vídeo selecionado para o download da playlist.');
    }
    
    console.log(`Starting sequencer loop for playlist of total ${total} videos.`);
    let completedCount = 0;
    
    for (let i = 0; i < total; i++) {
      const item = selectedVideos![i];
      job.currentVideoTitle = `[${i + 1}/${total}] ${item.title}`;
      job.status = 'downloading';
      broadcastProgress(jobId);
      
      const outputTemplate = path.join(jobFolder, '%(title)s.%(ext)s');
      const args = [
        ...bypassFlags,
        ...formatArgs,
        '--no-playlist',
        '-o',
        outputTemplate,
        item.url || `https://www.youtube.com/watch?v=${item.id}`
      ];
      
      try {
        await executeSingleDownload(args, job, (p) => {
          // Callback to scale local progress into global progress
          const currentStage = i;
          const percentage = Math.min(
            99,
            Math.round(((currentStage + p / 100) / total) * 100)
          );
          job.progress = percentage;
        });
        
        completedCount++;
        job.completedVideos = completedCount;
        job.progress = Math.round((completedCount / total) * 100);
        broadcastProgress(jobId);
      } catch (err) {
        console.error(`Failed to download sequence item: "${item.title}". Continuing sequentially.`, err);
        // Note: We bypass single track failures in a playlist so remaining items don't fail!
      }
    }
    
    if (completedCount === 0) {
      throw new Error('Todos os vídeos desta playlist falharam no download.');
    }
    
    // Step 2: Zipping all completed downloaded tracks
    job.status = 'processing';
    job.currentVideoTitle = 'Agrupando ficheiros num arquivo zip...';
    broadcastProgress(jobId);
    
    const zipPath = path.join(DOWNLOADS_DIR, `${jobId}.zip`);
    await createZipArchive(jobFolder, zipPath);
    
    job.filePath = zipPath;
    job.fileName = `${job.title.replace(/[\\\/:\*\?"<>\|]/g, '') || 'GetNow-Playlist'}.zip`;
    job.status = 'completed';
    job.progress = 100;
    broadcastProgress(jobId);
  }
}

/**
 * Execute standard spawning of yt-dlp download block with progress monitoring
 */
function executeSingleDownload(args: string[], job: DownloadJob, onPercentScale?: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_PATH, args);
    let errorOutput = '';
    
    // Terminate single video downloads if they exceed 30 minutes (1,800,000 ms)
    const timeout = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch (_) {}
      reject(new Error('Download cancelado: Excedeu o limite máximo de tempo de 30 minutos.'));
    }, 30 * 60 * 1000);
    
    child.stdout.on('data', (chunk) => {
      const line = chunk.toString();
      
      // Parse standard yt-dlp output percent: [download]  12.5% of  15.22MiB at  3.45MiB/s ETA 00:03
      const downloadMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+(\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)/);
      if (downloadMatch) {
        const percent = parseFloat(downloadMatch[1]);
        const speed = downloadMatch[3];
        const eta = downloadMatch[4];
        
        job.status = 'downloading';
        job.speed = speed;
        job.eta = eta;
        
        if (onPercentScale) {
          onPercentScale(percent);
        } else {
          job.progress = percent;
        }
        broadcastProgress(job.id);
      } else if (line.includes('[ExtractAudio]') || line.includes('[Merger]') || line.includes('[VideoConvertor]') || line.includes('[ffmpeg]')) {
        job.status = 'processing';
        broadcastProgress(job.id);
      }
    });
    
    child.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString();
    });
    
    child.on('close', (code) => {
      clearTimeout(timeout);
      
      if (code === 0) {
        if (job.type === 'single') {
          // Identify output filename
          try {
            const files = fs.readdirSync(path.join(DOWNLOADS_DIR, job.id))
              .filter(f => !f.endsWith('.part') && !f.endsWith('.temp') && !f.endsWith('.ytdl'));
            
            if (files.length > 0) {
              const file = files[0];
              job.filePath = path.join(DOWNLOADS_DIR, job.id, file);
              job.fileName = file;
              job.status = 'completed';
              job.progress = 100;
              broadcastProgress(job.id);
              resolve();
            } else {
              reject(new Error('Ficheiro baixado não foi encontrado na pasta temporária.'));
            }
          } catch (err: any) {
            reject(new Error(`Erro ao verificar ficheiro baixado: ${err.message}`));
          }
        } else {
          resolve();
        }
      } else {
        console.error(`yt-dlp child execution logged non-zero code ${code}. Stderr: ${errorOutput}`);
        let message = `O yt-dlp falhou com o código de status: ${code}.`;
        if (errorOutput.includes('Unsupported URL')) {
          message = 'Este URL não é suportado pelo yt-dlp.';
        } else if (errorOutput.includes('Private video')) {
          message = 'Este vídeo é privado e inacessível.';
        } else if (errorOutput.includes('max-filesize')) {
          message = 'O download excedeu a capacidade de ficheiro permitida de 2GB.';
        } else if (errorOutput.includes('ERROR:')) {
          const lines = errorOutput.split('\n');
          const errorLine = lines.find(l => l.startsWith('ERROR:'));
          if (errorLine) message = errorLine.replace('ERROR:', '').trim();
        }
        reject(new Error(message));
      }
    });
  });
}

/**
 * Packs multiple items into a ZIP using node archiver stream patterns
 */
function createZipArchive(sourceFolder: string, destZipPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(destZipPath);
    const archive = archiver('zip', { zlib: { level: 5 } });
    
    fileStream.on('close', () => resolve());
    archive.on('error', (err) => reject(err));
    
    archive.pipe(fileStream);
    archive.directory(sourceFolder, false);
    archive.finalize();
  });
}

// ==========================================
// STATIC VITE FRONTEND INTEGRATION
// ==========================================

async function startServer() {
  console.log('Aguardando a inicialização do yt-dlp...');
  try {
    const resolvedPath = await ytdlpInitPromise;
    console.log(`yt-dlp pronto em: ${resolvedPath}`);
  } catch (err) {
    console.error('Erro na inicialização do yt-dlp:', err);
  }

  if (process.env.NODE_ENV !== 'production') {
    console.log('Running server in development mode. Mounting Vite middleware.');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    console.log('Running server in production mode. Serving compiled static assets.');
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`GetNow web applet running successfully at: http://localhost:${PORT}`);
  });
}

startServer();
