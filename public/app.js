/* ═══════════════════════════════════════════════
   SaveTube — app.js (v1)
   ═══════════════════════════════════════════════ */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);

    const urlInput = $('urlInput');
    const fetchBtn = $('fetchBtn');
    const fText = fetchBtn.querySelector('.f-text');
    const fSpin = fetchBtn.querySelector('.f-spin');
    const errorBar = $('errorBar');
    const errorMsg = $('errorMsg');
    const results = $('results');
    const howTo = $('howTo');
    const vThumb = $('vThumb');
    const vTitle = $('vTitle');
    const vCh = $('vCh');
    const vStats = $('vStats');
    const vDur = $('vDur');
    const qGrid = $('qGrid');
    const toasts = $('toasts');
    const mp3Sub = $('mp3Sub');

    const tabs = document.querySelectorAll('.tab');
    const panes = document.querySelectorAll('.pane');

    let curUrl = '', curTitle = '', curDuration = 0;

    // ── Input ───────────────────────────────────────────────────────────────
    urlInput.addEventListener('input', () => {
        fetchBtn.disabled = !urlInput.value.trim();
    });
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !fetchBtn.disabled) fetchBtn.click();
    });
    urlInput.addEventListener('paste', () => {
        setTimeout(() => { fetchBtn.disabled = !urlInput.value.trim(); }, 50);
    });

    // ── Tabs ────────────────────────────────────────────────────────────────
    tabs.forEach((t) => {
        t.addEventListener('click', () => {
            tabs.forEach((x) => x.classList.remove('active'));
            panes.forEach((p) => p.classList.remove('active'));
            t.classList.add('active');
            $(`pane${t.dataset.t === 'video' ? 'Video' : 'Audio'}`).classList.add('active');
        });
    });

    // ── Fetch info ──────────────────────────────────────────────────────────
    fetchBtn.addEventListener('click', async () => {
        const url = urlInput.value.trim();
        if (!url) return;
        hideError();
        loading(true);
        results.hidden = true;
        if (howTo) howTo.hidden = false;

        try {
            const res = await fetch('/api/info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url }),
            });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                throw new Error(d.error || `Error ${res.status}`);
            }
            const data = await res.json();
            curUrl = url;
            curTitle = data.title || 'download';
            curDuration = data.duration || 0;
            renderInfo(data);
            renderQualities(data.qualities || []);
            bindMp3();
            // Show audio size
            if (data.audioSize && mp3Sub) {
                mp3Sub.textContent = `MP3 · ~${fmtBytes(data.audioSize)}`;
            } else if (mp3Sub) {
                mp3Sub.textContent = 'Works on phones, laptops, any media player';
            }
            results.hidden = false;
            // Hide instructions once results are shown
            if (howTo) howTo.hidden = true;
        } catch (err) {
            showError(err.message);
        } finally {
            loading(false);
        }
    });

    // ── Render ──────────────────────────────────────────────────────────────
    function renderInfo(d) {
        vThumb.src = d.thumbnail;
        vThumb.alt = d.title;
        vTitle.textContent = d.title;
        vCh.textContent = d.channel || '';
        vDur.textContent = fmtDur(d.duration);
        const v = d.viewCount ? fmtNum(d.viewCount) + ' views' : '';
        const dt = d.uploadDate ? fmtDate(d.uploadDate) : '';
        vStats.textContent = [v, dt].filter(Boolean).join(' · ');
    }

    function renderQualities(qs) {
        qGrid.innerHTML = '';
        if (!qs.length) {
            qGrid.innerHTML = '<p class="pane-hint" style="margin:0">No video qualities detected.</p>';
            return;
        }
        qs.forEach((q) => {
            const sizeLabel = q.filesize ? fmtBytes(q.filesize) : '';
            const row = document.createElement('div');
            row.className = 'q-row';
            row.innerHTML = `
        <div class="q-left">
          <span class="q-res">${q.height}p</span>
          <div>
            <span style="font-size:.84rem;font-weight:600">${q.label}</span>
            <div class="q-label">MP4${sizeLabel ? ' · ~' + sizeLabel : ''}</div>
          </div>
        </div>
        <button class="dl-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download
        </button>`;
            row.querySelector('.dl-btn').addEventListener('click', () => {
                dl('video', q.height);
            });
            qGrid.appendChild(row);
        });
    }

    function bindMp3() {
        const btn = $('mp3Btn');
        const fresh = btn.cloneNode(true);
        btn.parentNode.replaceChild(fresh, btn);
        fresh.addEventListener('click', () => {
            dl('audio');
        });
    }

    // ── Download — native browser download ─────────────────────────────────
    function dl(type, height) {
        const p = new URLSearchParams({ url: curUrl, type, title: curTitle });
        if (height) p.set('height', height);
        toast('Download starting… it will appear in your browser downloads shortly.', 'ok');
        const a = document.createElement('a');
        a.href = `/api/download?${p}`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    // ── Helpers ─────────────────────────────────────────────────────────────
    function fmtDur(s) {
        if (!s) return '';
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
        return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
            : `${m}:${String(sec).padStart(2, '0')}`;
    }
    function fmtNum(n) {
        if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return String(n);
    }
    function fmtBytes(b) {
        if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
        if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
        if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB';
        return b + ' B';
    }
    function fmtDate(d) {
        if (!d || d.length !== 8) return '';
        return new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`)
            .toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    }

    function loading(on) {
        fetchBtn.disabled = on;
        fText.hidden = on;
        fSpin.hidden = !on;
    }
    function showError(m) { errorMsg.textContent = m; errorBar.hidden = false; }
    function hideError() { errorBar.hidden = true; }

    function toast(msg, type) {
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.textContent = msg;
        toasts.appendChild(el);
        setTimeout(() => {
            el.classList.add('out');
            el.onanimationend = () => el.remove();
        }, 3500);
    }
})();

// ── PWA Service Worker ──
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => { });
    });
}
