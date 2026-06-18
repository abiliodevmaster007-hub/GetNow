import React, { useState, useEffect } from 'react';
import { 
  Download, 
  Youtube, 
  Search, 
  Check, 
  Trash2, 
  RefreshCw, 
  Sparkles, 
  Sun, 
  Moon, 
  FileVideo, 
  FileAudio, 
  Layers, 
  CheckSquare, 
  Square, 
  AlertCircle, 
  ExternalLink,
  Github,
  Play,
  CheckCircle2,
  ListRestart
} from 'lucide-react';

interface PlaylistItem {
  id: string;
  title: string;
  duration: string;
  durationSec: number;
  url: string;
  thumbnail: string;
}

interface MetadataResult {
  type: 'single' | 'playlist';
  id: string;
  title: string;
  channel?: string;
  duration?: string;
  durationSec?: number;
  thumbnail: string;
  url: string;
  totalVideos?: number;
  entries?: PlaylistItem[];
}

interface HistoryItem {
  id: string;
  title: string;
  format: string;
  type: 'single' | 'playlist';
  status: 'analyzing' | 'processing' | 'downloading' | 'completed' | 'error';
  progress: number;
  fileName?: string;
  timestamp: number;
}

export default function App() {
  // Theme state: dark mode default as requested
  const [isDarkMode, setIsDarkMode] = useState(true);
  
  // URL Input states
  const [urlInput, setUrlInput] = useState('');
  const [urlError, setUrlError] = useState('');
  
  // YouTube Cookies and advanced drawer settings
  const [youtubeCookies, setYoutubeCookies] = useState<string>(() => {
    try {
      return localStorage.getItem('getnow_youtube_cookies2') || '';
    } catch {
      return '';
    }
  });
  const [showCookies, setShowCookies] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem('getnow_youtube_cookies2', youtubeCookies);
    } catch (err) {
      console.error('Failed to keep cookies in local storage:', err);
    }
  }, [youtubeCookies]);

  // App primary loading states
  const [step, setStep] = useState<'idle' | 'analyzing' | 'ready'>('idle');
  const [loadingMsg, setLoadingMsg] = useState('');
  const [metadata, setMetadata] = useState<MetadataResult | null>(null);
  
  // Checklist for playlists
  const [selectedVideoIds, setSelectedVideoIds] = useState<string[]>([]);
  
  // Global selected format: default to standard 'mp4-720p'
  const [selectedFormat, setSelectedFormat] = useState<string>('mp4-720p');

  // Job tracker states
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJobProgress, setActiveJobProgress] = useState<{
    status: 'analyzing' | 'processing' | 'downloading' | 'completed' | 'error';
    progress: number;
    speed: string;
    eta: string;
    currentVideoTitle?: string;
    completedVideos?: number;
    totalVideos?: number;
    error?: string;
    fileName?: string;
  } | null>(null);

  // Local storage download history
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    try {
      const stored = localStorage.getItem('getnow_history');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('getnow_history', JSON.stringify(history));
    } catch (err) {
      console.error('Failed to preserve history storage:', err);
    }
  }, [history]);

  // Real-time Input URL Validation helper
  useEffect(() => {
    if (!urlInput) {
      setUrlError('');
      return;
    }
    const cleanUrl = urlInput.trim();
    const youtubeUrlRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;
    if (!youtubeUrlRegex.test(cleanUrl)) {
      setUrlError('URL inválido. Insira um link válido do YouTube (vídeo ou playlist).');
    } else {
      setUrlError('');
    }
  }, [urlInput]);

  // SSE Dynamic job updates mapping
  useEffect(() => {
    if (!activeJobId) return;

    console.log(`Setting up Server-Sent Events stream listener for job ${activeJobId}`);
    const eventSource = new EventSource(`/api/progress/${activeJobId}`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('SSE message payload:', data);

        if (data.status === 'expired') {
          eventSource.close();
          setActiveJobId(null);
          setActiveJobProgress(null);
          return;
        }

        setActiveJobProgress({
          status: data.status,
          progress: data.progress || 0,
          speed: data.speed || '---',
          eta: data.eta || '---',
          currentVideoTitle: data.currentVideoTitle,
          completedVideos: data.completedVideos,
          totalVideos: data.totalVideos,
          error: data.error,
          fileName: data.fileName
        });

        // Add dynamically into session history if completed
        if (data.status === 'completed') {
          setHistory(prev => {
            // Avoid inserting duplicates
            if (prev.some(item => item.id === activeJobId)) {
              return prev.map(item => item.id === activeJobId ? {
                ...item,
                status: 'completed',
                progress: 100,
                fileName: data.fileName
              } : item);
            }
            return [{
              id: activeJobId,
              title: data.title,
              format: data.format,
              type: data.type,
              status: 'completed',
              progress: 100,
              fileName: data.fileName,
              timestamp: Date.now()
            }, ...prev];
          });
          eventSource.close();
        } else if (data.status === 'error') {
          setHistory(prev => {
            if (prev.some(item => item.id === activeJobId)) {
              return prev.map(item => item.id === activeJobId ? {
                ...item,
                status: 'error',
                progress: 0
              } : item);
            }
            return [{
              id: activeJobId,
              title: data.title,
              format: data.format,
              type: data.type,
              status: 'error',
              progress: 0,
              timestamp: Date.now()
            }, ...prev];
          });
          eventSource.close();
        }
      } catch (err) {
        console.error('SSE JSON parsing error:', err);
      }
    };

    eventSource.onerror = (err) => {
      console.error('SSE system socket error:', err);
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [activeJobId]);

  // Clean state to return to start
  const handleReset = () => {
    setStep('idle');
    setMetadata(null);
    setSelectedVideoIds([]);
    setUrlInput('');
  };

  // URL extraction action
  const handleAnalyze = async () => {
    if (!urlInput.trim()) {
      setUrlError('Insira um link do YouTube antes de prosseguir.');
      return;
    }
    if (urlError) return;

    setStep('analyzing');
    setLoadingMsg('A analisar o link do YouTube...');
    setMetadata(null);

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlInput.trim(), cookies: youtubeCookies })
      });

      let data: any;
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        try {
          data = await response.json();
        } catch (_) {
          data = { error: 'O servidor retornou um JSON incompleto ou corrompido.' };
        }
      } else {
        const text = await response.text();
        const cleanText = (text.includes('<html') || text.includes('<!DOCTYPE') || text.includes('<div'))
          ? `O servidor retornou uma resposta HTML em vez de JSON (Status: ${response.status}). O serviço no Render poderá estar temporariamente sobrecarregado ou a reiniciar. Por favor, tente novamente.`
          : text;
        data = { error: cleanText || `Resposta inválida do servidor (Código: ${response.status})` };
      }

      if (!response.ok) {
        throw new Error(data.error || 'Não foi possível analisar o URL do YouTube.');
      }

      setMetadata(data);
      setStep('ready');

      // If playlist type, select all entries by default
      if (data.type === 'playlist' && Array.isArray(data.entries)) {
        setSelectedVideoIds(data.entries.map((item: PlaylistItem) => item.id));
      }
    } catch (err: any) {
      console.error(err);
      setUrlError(err.message || 'Ocorreu um erro ao comunicar com o servidor.');
      setStep('idle');
    }
  };

  // Triggers downloading stream from metadata content
  const handleDownload = async () => {
    if (!metadata) return;

    let payload: any = {
      url: metadata.url,
      format: selectedFormat,
      title: metadata.title,
      cookies: youtubeCookies
    };

    if (metadata.type === 'playlist') {
      const selectedCollection = (metadata.entries || []).filter(item => selectedVideoIds.includes(item.id));
      if (selectedCollection.length === 0) {
        alert('Selecione pelo menos um vídeo para download.');
        return;
      }
      payload.selectedVideos = selectedCollection;
    }

    try {
      const response = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      let data: any;
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        try {
          data = await response.json();
        } catch (_) {
          data = { error: 'O servidor retornou uma resposta de download corrompida.' };
        }
      } else {
        const text = await response.text();
        const cleanText = (text.includes('<html') || text.includes('<!DOCTYPE') || text.includes('<div'))
          ? `O servidor retornou uma resposta de erro HTML em vez de JSON (Status: ${response.status}). O serviço no Render poderá estar a reiniciar ou ocupado. Recarregue a página antes de tentar de novo.`
          : text;
        data = { error: cleanText || `Resposta inválida do servidor (Código: ${response.status})` };
      }

      if (!response.ok) {
        throw new Error(data.error || 'Falha ao processar o seu pedido de download.');
      }

      const newId = data.jobId;
      setActiveJobId(newId);
      setActiveJobProgress({
        status: 'analyzing',
        progress: 0,
        speed: '---',
        eta: '---'
      });

      // Insert fresh entry into session history stack in pending mode
      setHistory(prev => [
        {
          id: newId,
          title: metadata.title,
          format: selectedFormat,
          type: metadata.type,
          status: 'analyzing',
          progress: 0,
          timestamp: Date.now()
        },
        ...prev
      ]);
    } catch (err: any) {
      alert(err.message || 'Erro ao iniciar o processo de download.');
    }
  };

  // Deletes single job files
  const handleDeleteHistory = async (jobId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      await fetch(`/api/file/${jobId}`, { method: 'DELETE' });
    } catch (err) {
      console.error('Delete cleanup request failed:', err);
    }
    setHistory(prev => prev.filter(item => item.id !== jobId));
    if (activeJobId === jobId) {
      setActiveJobId(null);
      setActiveJobProgress(null);
    }
  };

  // Calculates contextual size estimations based on user selection
  const estimateSize = (durationSec?: number, format?: string): string => {
    const safeDuration = durationSec || 180; // default to 3 minutes
    const form = format || selectedFormat;
    
    let mbPerMin = 10;
    if (form === 'mp4-1080p') mbPerMin = 18;
    else if (form === 'mp4-720p') mbPerMin = 10;
    else if (form === 'mp4-480p') mbPerMin = 6;
    else if (form === 'mp4-360p') mbPerMin = 3.5;
    else if (form === 'mp3-320kbps') mbPerMin = 2.4;
    else if (form === 'mp3-128kbps') mbPerMin = 0.95;
    else if (form === 'webm') mbPerMin = 13;
    
    const calculatedMb = (safeDuration / 60) * mbPerMin;
    return `${calculatedMb.toFixed(1)} MB`;
  };

  // Multi-checkbox state management updates
  const togglePlaylistItemSelection = (id: string) => {
    setSelectedVideoIds(prev => 
      prev.includes(id) ? prev.filter(vId => vId !== id) : [...prev, id]
    );
  };

  const handleSelectAllVideos = () => {
    if (metadata && metadata.entries) {
      setSelectedVideoIds(metadata.entries.map(item => item.id));
    }
  };

  const handleClearSelectionVideo = () => {
    setSelectedVideoIds([]);
  };

  // Formats and qualities map definition
  const formatsList = [
    { value: 'mp4-1080p', label: 'MP4 – 1080p', type: 'video', desc: 'Vídeo HD com áudio' },
    { value: 'mp4-720p', label: 'MP4 – 720p', type: 'video', desc: 'Vídeo HD com áudio' },
    { value: 'mp4-480p', label: 'MP4 – 480p', type: 'video', desc: 'Vídeo SD com áudio' },
    { value: 'mp4-360p', label: 'MP4 – 360p', type: 'video', desc: 'Vídeo baixa qualidade' },
    { value: 'mp3-320kbps', label: 'MP3 – 320kbps', type: 'audio', desc: 'Apenas áudio alta qualidade' },
    { value: 'mp3-128kbps', label: 'MP3 – 128kbps', type: 'audio', desc: 'Apenas áudio standard' },
    { value: 'webm', label: 'WEBM', type: 'webm', desc: 'Formato original do YouTube' }
  ];

  return (
    <div className={`min-h-screen font-sans transition-colors duration-300 flex flex-col justify-between ${
      isDarkMode ? 'bg-[#0f0f0f] text-white' : 'bg-[#f7f7f7] text-gray-800'
    }`} id="getnow-root">
      
      {/* Header Bar */}
      <header className={`h-16 border-b transition-colors px-6 flex items-center justify-between ${
        isDarkMode ? 'bg-[#151515] border-white/10' : 'bg-white border-gray-200 shadow-sm'
      }`} id="getnow-header">
        <div className="flex items-center gap-3" id="getnow-brand">
          <div className="w-9 h-9 bg-[#FF0000] rounded-xl flex items-center justify-center shadow-[0_0_12px_rgba(255,0,0,0.4)]" id="getnow-logo">
            <Download className="w-5 h-5 text-white animate-pulse" />
          </div>
          <div>
            <span className="text-2xl font-black tracking-tighter text-transparent bg-clip-text bg-gradient-to-r from-white via-red-500 to-[#FF0000]" id="getnow-title">
              GetNow
            </span>
            <span className={`text-[10px] ml-1 uppercase py-0.5 px-2 rounded-full font-bold tracking-widest ${
              isDarkMode ? 'bg-white/10 text-gray-400' : 'bg-gray-100 text-gray-600'
            }`}>
              v2.5
            </span>
          </div>
        </div>

        <div className="flex items-center gap-6 text-sm font-medium" id="getnow-controls">
          <span className="text-red-500 border-b-2 border-[#FF0000] pb-1 h-14 flex items-center uppercase tracking-widest text-xs font-bold leading-none cursor-pointer">
            Downloader
          </span>
          <a href="#recent-section" className="text-xs tracking-wider uppercase opacity-75 hover:opacity-100 transition-opacity">
            Histórico
          </a>
          
          {/* Light / Dark Mode Toggle */}
          <button 
            onClick={() => setIsDarkMode(!isDarkMode)}
            className={`p-2 rounded-xl border transition-all ${
              isDarkMode ? 'bg-white/5 border-white/10 hover:bg-white/10 text-yellow-400' : 'bg-gray-100 border-gray-200 hover:bg-gray-200 text-violet-700'
            }`}
            title={isDarkMode ? "Ativar Modo Claro" : "Ativar Modo Escuro"}
            id="getnow-theme-toggle"
          >
            {isDarkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* Main Grid View */}
      <main className="flex-1 w-full max-w-7xl mx-auto p-4 md:p-8 grid grid-cols-1 lg:grid-cols-12 gap-8" id="getnow-main-content">
        
        {/* Left column: input form and current process monitor */}
        <section className="lg:col-span-5 space-y-6 flex flex-col justify-start" id="getnow-left-section">
          
          {/* Form Box */}
          <div className={`p-6 rounded-2xl border transition-all ${
            isDarkMode ? 'bg-[#1a1a1a] border-white/10' : 'bg-white border-gray-200 shadow-sm'
          }`} id="getnow-uploader-card">
            <h2 className="text-xs font-bold text-[#FF0000] uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
              <Youtube className="w-4 h-4" /> Descarregar do YouTube
            </h2>
            
            <p className={`text-sm mb-4 ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Cole o link de um vídeo individual ou de uma playlist completa para iniciar o processo.
            </p>

            <div className="space-y-4" id="getnow-input-form">
              <div className="relative">
                <input 
                  type="text" 
                  placeholder="Ex: youtube.com/watch?v=... ou /playlist?list=..."
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  disabled={step === 'analyzing'}
                  className={`w-full border rounded-xl pl-5 pr-12 py-4 focus:outline-none focus:ring-2 focus:ring-red-600 text-sm transition-all focus:border-transparent ${
                    isDarkMode 
                      ? 'bg-[#111] border-white/10 text-gray-100 placeholder-gray-600' 
                      : 'bg-gray-50 border-gray-300 text-gray-800 placeholder-gray-400'
                  }`}
                  id="getnow-url-input"
                />
                <button 
                  onClick={handleAnalyze}
                  disabled={step === 'analyzing' || !urlInput.trim() || !!urlError}
                  className={`absolute right-2 top-2 bottom-2 px-4 rounded-lg text-sm font-bold transition-all transition-colors duration-200 flex items-center justify-center gap-2 ${
                    !urlInput.trim() || !!urlError
                      ? 'bg-gray-500/10 text-gray-400 cursor-not-allowed'
                      : 'bg-[#FF0000] text-white hover:bg-red-700 hover:scale-105 active:scale-95'
                  }`}
                  id="getnow-analyze-button"
                >
                  {step === 'analyzing' ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Search className="w-4 h-4" />
                  )}
                  <span>Analisar</span>
                </button>
              </div>

              {/* Error messages box */}
              {urlError && (
                <div className="flex gap-2 items-start p-3.5 rounded-lg border border-red-500/30 bg-red-500/10 text-red-500 text-xs animate-fade-in" id="getnow-error-box">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>{urlError}</span>
                </div>
              )}

              {/* Reset interface button when loaded */}
              {step === 'ready' && (
                <button 
                  onClick={handleReset}
                  className={`w-full py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition-all ${
                    isDarkMode ? 'bg-white/5 border border-white/10 hover:bg-white/10 text-gray-300' : 'bg-gray-100 border border-gray-200 hover:bg-gray-200 text-gray-700'
                  }`}
                >
                  <ListRestart className="w-4 h-4" />
                  <span>Analisar Outro Link</span>
                </button>
              )}
            </div>

            <p className="text-[11px] text-gray-400 mt-4 italic flex items-center justify-between">
              <span>* yt-dlp compatível com canais e downloads</span>
              {metadata && (
                <span className="text-[#FF0000] font-medium flex items-center gap-1">
                  <Sparkles className="w-3 h-3 text-red-500 animate-bounce" /> Link Analisado!
                </span>
              )}
            </p>
          </div>

          {/* Bypassing & YouTube Cookies Setup Card */}
          <div className={`p-5 rounded-2xl border transition-all ${
            isDarkMode ? 'bg-[#1a1a1a] border-white/10' : 'bg-white border-gray-200 shadow-sm'
          }`} id="getnow-cookies-settings">
            <button
              onClick={() => setShowCookies(!showCookies)}
              className="w-full flex items-center justify-between text-left focus:outline-none"
            >
              <div className="flex items-center gap-3">
                <Youtube className="w-5 h-5 text-[#FF0000]" />
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-widest text-[#FF0000]">
                    Bypass / Cookies do YouTube
                  </h3>
                  <p className="text-[10px] text-gray-400 mt-0.5">
                    {youtubeCookies.trim() ? "🟢 Cookies carregados e ativos" : "⚪ Opcional - Evita bloqueio do YouTube"}
                  </p>
                </div>
              </div>
              <span className={`text-xs px-2.5 py-1 rounded bg-black/20 hover:text-white transition-colors font-mono ${
                isDarkMode ? 'text-gray-400' : 'text-gray-600'
              }`}>
                {showCookies ? 'Fechar' : 'Configurar'}
              </span>
            </button>

            {showCookies && (
              <div className="mt-4 pt-4 border-t border-white/5 space-y-3 animate-fade-in">
                <p className={`text-[11px] leading-relaxed ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  Caso se depare com o erro <strong>"Sign in to confirm you’re not a bot"</strong>, cole aqui os seus cookies em formato <strong>Netscape (cookies.txt)</strong>. Eles serão guardados localmente no seu navegador e enviados com segurança.
                </p>
                <div className="text-[11px] space-y-1 text-gray-400">
                  <span className="font-bold underline text-gray-300 block">Como obter os cookies:</span>
                  <ol className="list-decimal pl-4 space-y-0.5 leading-snug">
                    <li>Instale a extensão <a href="https://chromewebstore.google.com/detail/get-cookiestxt-locally/ccmclcmhboolgcheofeponpcgfghgjon" target="_blank" rel="noreferrer" className="text-red-500 hover:underline inline-flex items-center gap-0.5">Get cookies.txt LOCALLY<ExternalLink className="w-2.5 h-2.5" /></a> ou similar no Chrome/Firefox.</li>
                    <li>Aceda ao <a href="https://youtube.com" target="_blank" rel="noreferrer" className="text-red-500 hover:underline inline-flex items-center gap-0.5">youtube.com<ExternalLink className="w-2.5 h-2.5" /></a> no seu navegador e faça login (se necessário).</li>
                    <li>Abra a extensão, copie todo o texto e cole no campo abaixo.</li>
                  </ol>
                </div>
                <textarea
                  placeholder="# Netscape HTTP Cookie File&#10;# http://curl.haxx.se/rfc/cookie_spec.html&#10;.youtube.com	TRUE	/	TRUE	1718731331	__Secure-3PSID	..."
                  value={youtubeCookies}
                  onChange={(e) => setYoutubeCookies(e.target.value)}
                  rows={4}
                  className={`w-full border rounded-xl p-3 focus:outline-none focus:ring-1 focus:ring-red-600 text-[11px] font-mono transition-all ${
                    isDarkMode 
                      ? 'bg-[#111] border-white/10 text-gray-300 placeholder-gray-700' 
                      : 'bg-gray-50 border-gray-300 text-gray-800 placeholder-gray-400'
                  }`}
                />
                
                <div className="flex gap-2">
                  {youtubeCookies.trim() && (
                    <button
                      onClick={() => {
                        setYoutubeCookies('');
                        alert('Cookies removidos com sucesso.');
                      }}
                      className="px-3 py-2 rounded-xl border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-500 text-[10px] font-semibold transition-all"
                    >
                      Limpar Cookies
                    </button>
                  )}
                  <button
                    onClick={() => {
                      alert('Cookies guardados localmente com sucesso! Serão fornecidos de forma segura no próximo download.');
                      setShowCookies(false);
                    }}
                    className="flex-1 px-3 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-[10px] font-bold text-center transition-all"
                  >
                    Guardar e Aplicar
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Active Download Progress Monitor card */}
          {activeJobId && activeJobProgress && (
            <div className={`p-6 rounded-2xl border transition-all ${
              isDarkMode ? 'bg-[#1a1a1a]/95 border-red-500/30 shadow-[0_0_20px_rgba(255,0,0,0.15)] bg-gradient-to-br from-[#1c1212] to-[#1a1a1a]' : 'bg-white border-red-200 shadow-md'
            }`} id="getnow-active-loader">
              
              <div className="flex justify-between items-start mb-4">
                <div className="space-y-1">
                  <h3 className="text-xs font-bold uppercase tracking-widest text-[#FF0000]">
                    Download em Progresso
                  </h3>
                  <p className="text-xs font-mono font-bold text-gray-400">ID: {activeJobId}</p>
                </div>
                
                <span className={`px-2.5 py-1 rounded text-[10px] uppercase font-bold tracking-widest animate-pulse ${
                  activeJobProgress.status === 'downloading' ? 'bg-green-500/20 text-green-500' :
                  activeJobProgress.status === 'processing' ? 'bg-amber-500/20 text-amber-500' :
                  activeJobProgress.status === 'completed' ? 'bg-blue-500/20 text-blue-500' : 'bg-gray-500/20 text-gray-400'
                }`}>
                  {activeJobProgress.status === 'analyzing' ? 'A Analisar…' :
                   activeJobProgress.status === 'processing' ? 'A Processar…' :
                   activeJobProgress.status === 'downloading' ? 'A Baixar…' :
                   activeJobProgress.status === 'completed' ? 'Concluído' : 'Erro'}
                </span>
              </div>

              {/* Title & info list */}
              <div className="mb-4 text-xs space-y-1.5 p-3 rounded-xl bg-black/20 border border-white/5">
                <div className="font-semibold text-gray-200 line-clamp-2">
                  {metadata?.title || "Ficheiro YouTube"}
                </div>
                {activeJobProgress.currentVideoTitle && (
                  <div className="text-[11px] text-gray-400 font-mono italic truncate">
                    Ativo: {activeJobProgress.currentVideoTitle}
                  </div>
                )}
                {activeJobProgress.totalVideos && activeJobProgress.totalVideos > 1 && (
                  <div className="text-[11px] text-amber-500 font-bold flex justify-between">
                    <span>Progresso Sequencial da Playlist:</span>
                    <span>{activeJobProgress.completedVideos} de {activeJobProgress.totalVideos} vídeos</span>
                  </div>
                )}
              </div>

              {/* Action progress bar */}
              <div className="space-y-2">
                <div className="flex justify-between text-xs font-mono">
                  <span>Velocidade: <strong className="text-green-500">{activeJobProgress.speed || '---'}</strong></span>
                  <span>Restante: <strong className="text-red-500">{activeJobProgress.eta || '---'}</strong></span>
                </div>

                <div className="relative w-full h-3 bg-black/40 rounded-full overflow-hidden border border-white/5">
                  <div 
                    className="h-full bg-gradient-to-r from-red-600 to-[#FF0000] rounded-full transition-all duration-300 relative shadow-[0_0_8px_#ff0000]" 
                    style={{ width: `${activeJobProgress.progress || 0}%` }}
                  />
                </div>
                
                <div className="flex justify-between text-[11px] text-gray-400 font-mono">
                  <span>Est. Peso: {estimateSize(metadata?.durationSec, selectedFormat)}</span>
                  <span className="font-bold text-gray-200">{activeJobProgress.progress || 0}%</span>
                </div>
              </div>

              {/* Completed action item */}
              {activeJobProgress.status === 'completed' && (
                <div className="mt-5 p-3 rounded-xl bg-green-500/10 border border-green-500/20 space-y-3">
                  <div className="flex items-center gap-2 text-xs text-green-500 font-medium">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>O download foi processado e concluído com sucesso!</span>
                  </div>
                  <a 
                    href={`/api/file/${activeJobId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-center gap-2 w-full py-3 bg-green-600 hover:bg-green-700 text-white rounded-xl text-sm font-bold tracking-wider hover:scale-[1.02] transition-all duration-200"
                  >
                    <Download className="w-4 h-4 animate-bounce" />
                    <span>Descarregar Ficheiro</span>
                  </a>
                </div>
              )}

              {/* Job Error output */}
              {activeJobProgress.status === 'error' && (
                <div className="mt-5 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-500 space-y-2">
                  <span className="font-bold block">Ocorreu uma falha no processamento:</span>
                  <p className="font-mono leading-relaxed bg-black/40 p-2 rounded border border-red-500/20 text-[11px] overflow-x-auto">
                    {activeJobProgress.error || 'Erro desconhecido. O vídeo pode estar protegido por restrições ou região.'}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Download History list box */}
          <div className={`p-6 rounded-2xl border flex-1 flex flex-col transition-all min-h-[300px] ${
            isDarkMode ? 'bg-[#1a1a1a] border-white/10' : 'bg-white border-gray-200 shadow-sm'
          }`} id="recent-section">
            
            <div className="flex justify-between items-center mb-4 pb-2 border-b border-white/5">
              <h3 className="text-xs font-bold uppercase tracking-wider flex items-center gap-2">
                <Layers className="w-4 h-4 text-gray-400" /> Histórico da Sessão
              </h3>
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${
                isDarkMode ? 'bg-white/10 text-gray-400' : 'bg-gray-100 text-gray-600'
              }`}>
                {history.length} {history.length === 1 ? 'ficheiro' : 'ficheiros'}
              </span>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 max-h-[350px] pr-1" id="getnow-history-list">
              {history.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-8 opacity-60">
                  <div className="w-12 h-12 rounded-full border-2 border-dashed border-gray-500 flex items-center justify-center mb-3">
                    <Download className="w-5 h-5 text-gray-500" />
                  </div>
                  <p className="text-xs font-medium">Nenhum download registado nesta sessão.</p>
                  <p className="text-[11px] text-gray-500 mt-1">Os links que transferir serão mantidos na sua lista de downloads rápidos temporariamente.</p>
                </div>
              ) : (
                history.map((item) => {
                  const formatDetails = formatsList.find(f => f.value === item.format);
                  return (
                    <div 
                      key={item.id}
                      className={`p-3.5 rounded-xl border flex items-center gap-3 transition-all ${
                        isDarkMode 
                          ? 'bg-black/20 border-white/5 hover:bg-black/40' 
                          : 'bg-gray-50 border-gray-100 hover:bg-gray-100'
                      }`}
                    >
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                        item.status === 'completed' 
                          ? 'bg-green-500/10 text-green-500' 
                          : item.status === 'error' 
                            ? 'bg-red-500/10 text-red-500' 
                            : 'bg-amber-500/10 text-amber-500'
                      }`}>
                        {item.type === 'playlist' ? <Layers className="w-4 h-4" /> : <FileVideo className="w-4 h-4" />}
                      </div>

                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold truncate text-gray-200" title={item.title}>
                          {item.title}
                        </p>
                        <p className="text-[10px] text-gray-500 flex items-center gap-1.5 mt-0.5">
                          <span className="uppercase text-red-500 font-bold">{item.format}</span>
                          <span>•</span>
                          <span>{new Date(item.timestamp).toLocaleTimeString()}</span>
                        </p>
                      </div>

                      <div className="flex items-center gap-1">
                        {item.status === 'completed' ? (
                          <a 
                            href={`/api/file/${item.id}`}
                            className="p-1.5 hover:bg-green-500/10 text-green-500 rounded-lg transition-colors"
                            title="Descarregar ficheiro"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </a>
                        ) : item.status === 'error' ? (
                          <span className="p-1.5 text-red-500" title="Falha ao baixar">
                            <AlertCircle className="w-3.5 h-3.5" />
                          </span>
                        ) : (
                          <RefreshCw className="w-3.5 h-3.5 text-amber-500 animate-spin" />
                        )}

                        <button 
                          onClick={(e) => handleDeleteHistory(item.id, e)}
                          className="p-1.5 hover:bg-red-500/10 text-gray-400 hover:text-red-500 rounded-lg transition-colors"
                          title="Remover do histórico"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {history.length > 0 && (
              <button 
                onClick={() => {
                  setHistory([]);
                  localStorage.removeItem('getnow_history');
                }}
                className={`text-center mt-3 text-[10px] uppercase font-bold text-gray-400 hover:text-red-500 transition-colors py-2 flex items-center justify-center gap-1.5 ${
                  isDarkMode ? 'hover:bg-white/5' : 'hover:bg-gray-100'
                } rounded-lg`}
              >
                <Trash2 className="w-3 h-3" /> Limpar Histórico de Downloads
              </button>
            )}

          </div>
        </section>

        {/* Right column: YouTube analysis content options, choices & format download properties */}
        <section className="lg:col-span-7 space-y-6 flex flex-col justify-start" id="getnow-right-section">
          
          {step === 'idle' ? (
            <div className={`p-10 rounded-2xl border border-dashed flex-1 flex flex-col items-center justify-center text-center p-8 min-h-[500px] ${
              isDarkMode ? 'bg-[#1a1a1a]/50 border-white/10 text-gray-400' : 'bg-white border-gray-200 text-gray-500'
            }`} id="getnow-empty-welcome">
              <div className="w-16 h-16 rounded-full bg-red-600/10 flex items-center justify-center text-[#FF0000] mb-4">
                <Youtube className="w-8 h-8" />
              </div>
              <h3 className="text-lg font-bold text-gray-200 mb-2">Configure o Download para Iniciar</h3>
              <p className="text-sm max-w-md mx-auto leading-relaxed">
                Insira o link de qualquer vídeo ou playlist do YouTube na caixa de entrada à esquerda e clique em <strong>"Analisar"</strong> para indexar seus formatos disponíveis e tamanho do ficheiro.
              </p>
              
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 w-full max-w-lg mt-8 text-xs">
                <div className={`p-4 rounded-xl border text-center ${isDarkMode ? 'bg-white/5 border-white/5' : 'bg-gray-50 border-gray-100'}`}>
                  <span className="font-bold text-red-500 uppercase tracking-widest block mb-1">Passo 1</span>
                  Coletar URL
                </div>
                <div className={`p-4 rounded-xl border text-center ${isDarkMode ? 'bg-white/5 border-white/5' : 'bg-gray-50 border-gray-100'}`}>
                  <span className="font-bold text-red-500 uppercase tracking-widest block mb-1">Passo 2</span>
                  Escolher Formato
                </div>
                <div className={`p-4 rounded-xl border text-center col-span-2 md:col-span-1 ${isDarkMode ? 'bg-white/5 border-white/5' : 'bg-gray-50 border-gray-100'}`}>
                  <span className="font-bold text-red-500 uppercase tracking-widest block mb-1">Passo 3</span>
                  Baixar & Converter
                </div>
              </div>
            </div>
          ) : step === 'analyzing' ? (
            <div className={`p-10 rounded-2xl border flex-1 flex flex-col items-center justify-center text-center min-h-[500px] ${
              isDarkMode ? 'bg-[#1a1a1a] border-white/10' : 'bg-white border-gray-200 shadow-sm'
            }`} id="getnow-active-loader">
              <div className="relative mb-6">
                <div className="w-16 h-16 rounded-full border-4 border-red-600/20 border-t-red-600 animate-spin" />
                <Download className="w-6 h-6 text-red-600 absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 animate-bounce" />
              </div>
              <h3 className="text-lg font-bold mb-1">A Analisar Conteúdo</h3>
              <p className="text-sm text-gray-400 max-w-sm font-medium animate-pulse">{loadingMsg}</p>
              
              <div className="w-64 h-1 bg-black/20 rounded-full mt-6 overflow-hidden">
                <div className="h-full bg-red-600 animate-pulse w-2/3 rounded-full" />
              </div>
            </div>
          ) : (
            metadata && (
              <div className="space-y-6 animate-fade-in" id="getnow-metadata-viewer">
                
                {/* Metadados Principal Content */}
                <div className={`p-6 rounded-2xl border overflow-hidden flex flex-col transition-all ${
                  isDarkMode ? 'bg-[#1a1a1a] border-white/10' : 'bg-white border-gray-200 shadow-sm'
                }`}>
                  
                  {/* Content Header Grid */}
                  <div className="flex flex-col md:flex-row gap-6">
                    <div className="relative flex-shrink-0 mx-auto md:mx-0 w-full md:w-[240px]">
                      <div className="w-full aspect-video bg-black rounded-xl border border-white/10 overflow-hidden relative group shadow-lg">
                        <img 
                          src={metadata.thumbnail} 
                          alt="Thumbnail" 
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                          <Play className="w-8 h-20 text-white fill-white" />
                        </div>
                      </div>
                      
                      {metadata.duration && (
                        <span className="absolute bottom-2 right-2 bg-black/80 text-[10px] px-2 py-0.5 rounded-md font-mono text-white font-bold tracking-wider">
                          {metadata.duration}
                        </span>
                      )}
                    </div>

                    <div className="flex-1 space-y-3 py-1 text-center md:text-left">
                      <div className="flex flex-col md:flex-row items-center md:items-start justify-between gap-2">
                        <h1 className="text-lg font-extrabold leading-tight line-clamp-2 text-gray-100 hover:text-white transition-colors">
                          {metadata.title}
                        </h1>
                        <span className={`px-2.5 py-1 rounded text-[10px] uppercase font-bold tracking-widest ${
                          metadata.type === 'playlist' ? 'bg-amber-500/20 text-amber-500' : 'bg-red-500/20 text-red-500'
                        }`}>
                          {metadata.type === 'playlist' ? 'Playlist' : 'Vídeo'}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center justify-center md:justify-start gap-3 text-xs text-gray-400">
                        {metadata.channel && (
                          <span className="flex items-center gap-1.5 font-medium text-gray-300">
                            <span className="w-2 h-2 rounded-full bg-red-600 inline-block"></span>
                            {metadata.channel}
                          </span>
                        )}
                        {metadata.channel && <span>•</span>}
                        {metadata.type === 'playlist' ? (
                          <span className="font-semibold text-amber-500">{metadata.totalVideos} Vídeos Indicados</span>
                        ) : (
                          <span>Duração: <strong className="text-gray-200">{metadata.duration}</strong></span>
                        )}
                      </div>

                      {/* Select / Deselect elements for playlists selection */}
                      {metadata.type === 'playlist' && (
                        <div className="flex flex-wrap items-center justify-center md:justify-start gap-2 pt-2">
                          <button 
                            onClick={handleSelectAllVideos}
                            className={`px-3 py-1.5 text-[11px] font-bold rounded-lg border flex items-center gap-1.5 hover:scale-[1.02] active:scale-95 transition-all ${
                              isDarkMode ? 'bg-white/5 border-white/10 hover:bg-white/10 text-white' : 'bg-gray-100 border-gray-200 hover:bg-gray-200 text-gray-800'
                            }`}
                          >
                            <CheckSquare className="w-3.5 h-3.5 text-red-500" />
                            <span>Selecionar Tudo</span>
                          </button>
                          <button 
                            onClick={handleClearSelectionVideo}
                            className={`px-3 py-1.5 text-[11px] font-bold rounded-lg border flex items-center gap-1.5 hover:scale-[1.02] active:scale-95 transition-all ${
                              isDarkMode ? 'bg-white/5 border-white/10 hover:bg-white/10 text-red-500' : 'bg-gray-100 border-gray-200 hover:bg-red-100 text-red-600'
                            }`}
                          >
                            <Square className="w-3.5 h-3.5" />
                            <span>Limpar Seleção</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Playlist Entries selection panel - scrolling lists */}
                  {metadata.type === 'playlist' && metadata.entries && (
                    <div className="mt-6 border-t border-white/10 bg-black/10 rounded-xl overflow-hidden shadow-inner">
                      <div className={`p-3 text-xs font-bold uppercase tracking-wider border-b ${
                        isDarkMode ? 'border-white/10 bg-white/5' : 'border-gray-200 bg-gray-50 text-gray-700'
                      }`}>
                        Lista de Reprodução ({selectedVideoIds.length} selecionados para download)
                      </div>
                      
                      <div className="max-h-[220px] overflow-y-auto px-4 divide-y divide-white/5" id="playlist-scroller">
                        {metadata.entries.map((item, idx) => {
                          const isChecked = selectedVideoIds.includes(item.id);
                          return (
                            <div 
                              key={item.id}
                              onClick={() => togglePlaylistItemSelection(item.id)}
                              className={`py-3 flex items-center justify-between gap-4 cursor-pointer hover:bg-white/5 transition-all ${
                                isChecked ? 'opacity-100' : 'opacity-40 hover:opacity-75'
                              }`}
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="flex-shrink-0">
                                  {isChecked ? (
                                    <CheckSquare className="w-4 h-4 text-red-600" />
                                  ) : (
                                    <Square className="w-4 h-4 text-gray-500" />
                                  )}
                                </div>
                                <span className="text-[10px] text-gray-500 font-mono">
                                  {(idx + 1).toString().padStart(2, '0')}
                                </span>
                                <span className={`text-xs truncate font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                                  {item.title}
                                </span>
                              </div>
                              <span className="text-[10px] font-mono text-gray-500">
                                {item.duration}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                </div>

                {/* Qualities / Format Selection Container */}
                <div className={`p-6 rounded-2xl border transition-all ${
                  isDarkMode ? 'bg-[#1a1a1a] border-white/10' : 'bg-white border-gray-200 shadow-sm'
                }`} id="getnow-format-selection-card">
                  
                  <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-2">
                    <FileVideo className="w-4 h-4 text-[#FF0000]" /> Seleção do Formato & Qualidade
                  </h3>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {formatsList.map((format) => {
                      const isSelected = selectedFormat === format.value;
                      const sizePreview = estimateSize(
                        metadata.type === 'playlist' 
                          ? (metadata.entries || [])
                              .filter(item => selectedVideoIds.includes(item.id))
                              .reduce((acc, current) => acc + current.durationSec, 0)
                          : metadata.durationSec,
                        format.value
                      );

                      return (
                        <button
                          key={format.value}
                          onClick={() => setSelectedFormat(format.value)}
                          className={`p-4 rounded-xl border text-left flex flex-col justify-between transition-all hover:scale-[1.01] active:scale-[0.99] cursor-pointer ${
                            isSelected 
                              ? isDarkMode 
                                ? 'bg-[#FF0000]/10 border-[#FF0000] text-white shadow-[0_0_12px_rgba(255,0,0,0.2)]'
                                : 'bg-red-50 border-red-500 text-red-900 shadow-sm'
                              : isDarkMode
                                ? 'bg-white/5 border-white/10 hover:border-red-500/50 text-gray-300'
                                : 'bg-gray-50 border-gray-200 hover:border-red-300 text-gray-700'
                          }`}
                        >
                          <div className="space-y-1">
                            <span className="text-xs font-extrabold uppercase font-mono block">
                              {format.label}
                            </span>
                            <span className="text-[10px] text-gray-400 block leading-tight">
                              {format.desc}
                            </span>
                          </div>

                          <div className="mt-4 pt-2 border-t border-white/5 flex justify-between items-center text-[10px]">
                            <span className="text-gray-500 uppercase font-bold text-[9px] tracking-widest">Est. Peso</span>
                            <span className="font-mono text-red-500 font-bold">{sizePreview}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {/* Order execution panel block */}
                  <div className="mt-6 pt-6 border-t border-white/10 flex flex-col md:flex-row items-center justify-between gap-6">
                    <div className="text-center md:text-left space-y-1">
                      <p className="text-xs text-gray-500 uppercase font-bold tracking-wider">
                        Peso Total Estimado
                      </p>
                      <p className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-red-500">
                        {estimateSize(
                          metadata.type === 'playlist' 
                            ? (metadata.entries || [])
                                .filter(item => selectedVideoIds.includes(item.id))
                                .reduce((acc, current) => acc + current.durationSec, 0)
                            : metadata.durationSec,
                          selectedFormat
                        )}
                      </p>
                    </div>

                    <button 
                      onClick={handleDownload}
                      disabled={activeJobId !== null && activeJobProgress?.status !== 'completed' && activeJobProgress?.status !== 'error'}
                      className={`w-full md:w-auto px-8 py-4 bg-[#FF0000] text-white rounded-xl text-sm font-extrabold uppercase tracking-widest shadow-[0_4px_20px_rgba(255,0,0,0.35)] hover:scale-[1.03] active:scale-[0.97] transition-all hover:bg-red-700 duration-200 flex items-center justify-center gap-3 disabled:bg-gray-600 disabled:shadow-none disabled:cursor-not-allowed`}
                    >
                      <Download className="w-5 h-5" />
                      <span>Baixar Agora</span>
                    </button>
                  </div>

                </div>

              </div>
            )
          )}

        </section>

      </main>

      {/* Footer / Status bar elements */}
      <footer className={`h-11 flex items-center justify-between px-6 border-t text-[10px] transition-colors ${
        isDarkMode ? 'bg-[#0a0a0a] border-white/5 text-gray-500' : 'bg-white border-gray-200 text-gray-600 shadow-sm'
      }`} id="getnow-footer">
        <div className="flex items-center gap-4">
          <span>GetNow Downloader Engine</span>
          <span className="w-px h-3 bg-white/10" />
          <span>Formato: HTML5 & Node.JS</span>
          <span className="w-px h-3 bg-white/10" />
          <span>Local Limit: 2GB / 30m</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-500 inline-block animate-pulse shadow-[0_0_8px_#22c55e]" />
            Status: Servidor Online
          </span>
          <span className="hidden md:inline-block">•</span>
          <span className="hidden md:flex items-center gap-1">
            Feito com <span className="text-red-500">♥</span> em Portugal
          </span>
        </div>
      </footer>

    </div>
  );
}
