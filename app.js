'use strict';

/* ═══════════════════════════════════════════════
   SNAPRECIPE · app.js
   AI: Gemini 2.0 Flash (free) + Tesseract OCR fallback
═══════════════════════════════════════════════ */

// ── Seed Data ─────────────────────────────────────────────────
const SEED_RECIPES = [];

// ── Recipe Extraction Prompt ──────────────────────────────────
const RECIPE_PROMPT = `You are a Korean recipe extraction assistant. Analyze the provided content and extract all recipe information.

Return ONLY valid JSON with this exact structure:
{
  "title": "레시피 제목",
  "category": "한식|일식|중식|양식|디저트|음료|간식|채식|기타",
  "ingredients": [{"name": "재료명", "amount": "수량 및 단위"}],
  "steps": ["조리 단계 1", "조리 단계 2"],
  "source": {"type": "instagram|youtube|blog|other", "handle": "@계정명 또는 채널명"},
  "tags": ["태그1", "태그2"],
  "summary": "레시피 한 줄 요약"
}

Rules:
- Extract all visible ingredients with their exact amounts
- Write each cooking step as a clear, complete sentence in Korean
- If text is in Korean, keep it in Korean
- If information is not visible, use empty string or empty array
- Do NOT make up information not visible in the content`;

// ── OCR Fallback Corrections ──────────────────────────────────
const CORRECTIONS = {
  '스파게띠': '스파게티', '명난': '명란', '양과': '양파',
  '복는다': '볶는다', '끊인다': '끓인다', '설팅': '설탕',
  '마알': '마늘', '된창': '된장', '김치찌게': '김치찌개',
  '까르보나라': '카르보나라', 'Tbsp': '큰술', 'tbsp': '큰술',
  'tsp': '작은술', '올리브유': '올리브오일',
  '소힘': '소금', '간잔': '간장', '생크임': '생크림',
};

// ── State ─────────────────────────────────────────────────────
const state = {
  user: null,
  recipes: [],
  screenshots: [],
  fridgeItems: [],
  weeklyPlan: {},
  currentRecipeId: null,
  pendingResult: null,
  currentScreenshotId: null,
  plannerTarget: null,
  filters: { category: 'all', search: '', sort: 'newest' },
  previousScreen: 'home',
};

// ── Persistence ───────────────────────────────────────────────
function loadDB() {
  // Force-clear all seed data on first load after v2
  if (!localStorage.getItem('sr_v2')) {
    ['sr_recipes','sr_screenshots','sr_fridge','sr_plan'].forEach(k => localStorage.removeItem(k));
    localStorage.setItem('sr_v2', '1');
  }
  try {
    const u = localStorage.getItem('sr_user');       if (u)  state.user = JSON.parse(u);
    const r = localStorage.getItem('sr_recipes');
    const all = r ? JSON.parse(r) : [];
    state.recipes = all.filter(x => !String(x.id).startsWith('seed-'));
    const ss = localStorage.getItem('sr_screenshots'); state.screenshots = ss ? JSON.parse(ss) : [];
    const fi = localStorage.getItem('sr_fridge');    state.fridgeItems = fi ? JSON.parse(fi) : [];
    const pl = localStorage.getItem('sr_plan');      state.weeklyPlan = pl ? JSON.parse(pl) : {};
  } catch { state.recipes = []; }
}

function saveDB() {
  try {
    localStorage.setItem('sr_recipes', JSON.stringify(state.recipes));
    localStorage.setItem('sr_screenshots', JSON.stringify(state.screenshots));
    localStorage.setItem('sr_fridge', JSON.stringify(state.fridgeItems));
    localStorage.setItem('sr_plan', JSON.stringify(state.weeklyPlan));
    if (state.user) localStorage.setItem('sr_user', JSON.stringify(state.user));
  } catch (e) { console.error('save error', e); }
}


// ── Gemini API ────────────────────────────────────────────────
function getGeminiKey() { return localStorage.getItem('sr_gemini_key') || ''; }
function saveGeminiKey(k) { localStorage.setItem('sr_gemini_key', k.trim()); }

const GEMINI_URL = key =>
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;

async function callGemini(key, parts) {
  const res = await fetch(GEMINI_URL(key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }] }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini 오류 (${res.status})`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error('Gemini 응답이 비어있습니다');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('레시피 JSON을 찾을 수 없습니다');
  return JSON.parse(match[0]);
}

async function analyzeImageWithGemini(imageDataUrl, onProgress) {
  const key = getGeminiKey();
  if (!key) throw new Error('no_key');
  onProgress(20, 'Gemini에 이미지 전송 중...');
  const [meta, b64] = imageDataUrl.split(',');
  const mimeType = meta.match(/:(.*?);/)?.[1] || 'image/jpeg';
  const result = await callGemini(key, [
    { inlineData: { mimeType, data: b64 } },
    { text: RECIPE_PROMPT + '\n\nReturn ONLY the raw JSON object, no markdown, no code blocks.' },
  ]);
  onProgress(85, '레시피 정리 중...');
  return result;
}

async function analyzeYouTubeWithGemini(url, videoTitle, onProgress) {
  const key = getGeminiKey();
  if (!key) throw new Error('no_key');
  onProgress(40, 'Gemini로 레시피 추출 중...');
  const result = await callGemini(key, [{
    text: `다음 YouTube 요리 영상을 보고 레시피를 추출하세요.\n영상 제목: "${videoTitle}"\n영상 URL: ${url}\n\n${RECIPE_PROMPT}\n\n확실하지 않은 수량은 "적당량"으로 표기하세요.\nReturn ONLY the raw JSON object, no markdown, no code blocks.`,
  }]);
  onProgress(90, '정리 중...');
  return result;
}

// ── Screen Management ─────────────────────────────────────────
const NAV_SCREENS = ['home', 'screenshots', 'fridge', 'planner'];

function showScreen(id, direction = 'forward') {
  const current = document.querySelector('.screen.active');
  const next = document.getElementById(`screen-${id}`);
  if (!next || current === next) return;

  if (current) {
    current.classList.remove('active');
    if (direction === 'forward') {
      current.classList.add('push-out');
      setTimeout(() => current.classList.remove('push-out'), 360);
    }
  }
  next.classList.add('active');
  if (direction === 'forward') {
    next.classList.add('push-in');
    setTimeout(() => next.classList.remove('push-in'), 360);
  } else if (direction === 'back') {
    next.classList.add('pop-in');
    setTimeout(() => next.classList.remove('pop-in'), 360);
  } else {
    next.classList.add('fade-up');
    setTimeout(() => next.classList.remove('fade-up'), 300);
  }

  // Tab bar & FAB
  const nav = document.getElementById('bottom-nav');
  const fab = document.getElementById('fab');
  if (NAV_SCREENS.includes(id)) {
    nav?.classList.add('visible');
    fab?.classList.add('visible');
    document.querySelectorAll('.tab-item').forEach(item =>
      item.classList.toggle('active', item.dataset.screen === id)
    );
  } else {
    nav?.classList.remove('visible');
    fab?.classList.remove('visible');
  }

  // Close menus (no-op if elements removed)

  if (id === 'home')        renderHome();
  if (id === 'screenshots') renderScreenshots();
  if (id === 'planner')     renderPlanner();
  if (id === 'fridge')      renderFridgeTags();
  if (id === 'sources')     renderSourcesScreen();
  if (id === 'upload')      resetUploadScreen();
}

function switchTab(id) {
  state.previousScreen = id;
  showScreen(id, 'none');
}

function goBack() { showScreen(state.previousScreen || 'home', 'back'); }

// ── Auth ──────────────────────────────────────────────────────
const DEMO_USERS = {
  kakao:  { name: '카카오 유저', email: 'user@kakao.com',  provider: 'kakao',  emoji: '💬' },
  google: { name: 'Google 유저', email: 'user@gmail.com',  provider: 'google', emoji: 'G' },
  guest:  { name: '게스트',       email: '',               provider: 'guest',  emoji: '👤' },
};

function handleLogin(provider) {
  state.user = { ...DEMO_USERS[provider], id: `demo-${provider}-${Date.now()}` };
  saveDB();
  updateProfileUI();
  showScreen('home', 'forward');
  if (!getGeminiKey()) {
    setTimeout(() => showGeminiKeyPrompt(() => {}), 700);
  }
}

function handleLogout() {
  closeProfile();
  state.user = null;
  localStorage.removeItem('sr_user');
  setTimeout(() => showScreen('login', 'back'), 200);
}

function updateProfileUI() {
  if (!state.user) return;
  const av = document.getElementById('profile-avatar');
  if (av) av.textContent = state.user.emoji;
  const lg = document.getElementById('profile-avatar-lg');
  if (lg) lg.textContent = state.user.emoji;
  document.getElementById('profile-name-text').textContent = state.user.name;
  document.getElementById('profile-email-text').textContent = state.user.email || '로그인됨';
}

// ── Profile Sheet ─────────────────────────────────────────────
function showProfile() {
  document.getElementById('modal-profile').classList.remove('hidden');
  document.getElementById('stat-recipes').textContent = state.recipes.length;
  document.getElementById('stat-favorites').textContent = state.recipes.filter(r => r.favorite).length;
  document.getElementById('stat-screenshots').textContent = state.screenshots.length;
}
function closeProfile(e) {
  if (e && e.target !== document.getElementById('modal-profile')) return;
  document.getElementById('modal-profile').classList.add('hidden');
}
function exportData() {
  const blob = new Blob([JSON.stringify({ recipes: state.recipes, plan: state.weeklyPlan }, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'snaprecipe-export.json' });
  a.click();
  document.getElementById('modal-profile').classList.add('hidden');
}

// ── Search & Filter ───────────────────────────────────────────
function toggleSearch() {
  const bar = document.getElementById('search-bar');
  const isHidden = bar.classList.contains('hidden');
  if (isHidden) {
    bar.classList.remove('hidden');
    bar.classList.add('visible');
    setTimeout(() => document.getElementById('search-input').focus(), 100);
  } else {
    cancelSearch();
  }
}

function cancelSearch() {
  const bar = document.getElementById('search-bar');
  bar.classList.remove('visible');
  bar.classList.add('hidden');
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear-btn')?.classList.add('hidden');
  state.filters.search = '';
  renderHome();
}

function clearSearch() {
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear-btn')?.classList.add('hidden');
  state.filters.search = '';
  renderHome();
}

function applyFilters() {
  const val = document.getElementById('search-input').value;
  state.filters.search = val.toLowerCase();
  const clearBtn = document.getElementById('search-clear-btn');
  if (clearBtn) clearBtn.classList.toggle('hidden', !val);
  renderHome();
}

function selectCategory(btn, cat) {
  document.querySelectorAll('.segment').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  state.filters.category = cat;
  state.filters.source = '';   // 카테고리 변경 시 소스 필터 해제
  updateSourceFilterBanner();
  renderHome();
}

function updateSourceFilterBanner() {
  let banner = document.getElementById('source-filter-banner');
  if (state.filters.source) {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'source-filter-banner';
      banner.className = 'source-filter-banner';
      const refNode = document.getElementById('recipe-count');
      refNode?.parentNode.insertBefore(banner, refNode);
    }
    const icon = SRC_ICON[state.recipes.find(r => r.source?.handle === state.filters.source)?.source?.type] || '🔗';
    banner.innerHTML = `
      <span class="sfb-label">${icon} ${esc(state.filters.source)}</span>
      <button class="sfb-clear" onclick="clearSourceFilter()">✕ 필터 해제</button>`;
  } else if (banner) {
    banner.remove();
  }
}

function clearSourceFilter() {
  state.filters.source = '';
  updateSourceFilterBanner();
  renderHome();
}

function toggleSortMenu() {
  document.getElementById('sort-menu').classList.toggle('hidden');
}

function applySort(val) {
  state.filters.sort = val;
  document.getElementById('sort-menu').classList.add('hidden');
  renderHome();
}

function getFilteredRecipes() {
  let list = [...state.recipes];
  const { category, search, sort, source } = state.filters;
  if (category !== 'all') list = list.filter(r => r.category === category);
  if (source) list = list.filter(r => r.source?.handle === source);
  if (search) list = list.filter(r =>
    r.title.toLowerCase().includes(search) ||
    r.tags.some(t => t.toLowerCase().includes(search)) ||
    r.ingredients.some(i => i.name.toLowerCase().includes(search))
  );
  switch (sort) {
    case 'newest':   list.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt)); break;
    case 'oldest':   list.sort((a, b) => new Date(a.savedAt) - new Date(b.savedAt)); break;
    case 'favorite': list.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0)); break;
    case 'name':     list.sort((a, b) => a.title.localeCompare(b.title, 'ko')); break;
  }
  return list;
}

// ── Source Ranking ────────────────────────────────────────────
function computeSourceRanking() {
  const map = {};
  for (const r of state.recipes) {
    const handle = r.source?.handle?.trim();
    if (!handle) continue;
    if (!map[handle]) {
      map[handle] = { handle, type: r.source.type, recipes: [], totalFav: 0 };
    }
    map[handle].recipes.push(r);
    if (r.favorite) map[handle].totalFav++;
  }
  return Object.values(map)
    .sort((a, b) => b.recipes.length - a.recipes.length || b.totalFav - a.totalFav);
}

const MEDALS = ['🥇', '🥈', '🥉'];
const SRC_ICON = { instagram: '📸', youtube: '▶️', blog: '📝', other: '🔗' };

function renderSourceRanking() {
  const scroll = document.getElementById('ranking-scroll');
  const section = document.getElementById('ranking-section');
  if (!scroll) return;
  const sources = computeSourceRanking();
  if (!sources.length) { section.style.display = 'none'; return; }
  section.style.display = '';
  const top5 = sources.slice(0, 10);
  scroll.innerHTML = top5.map((src, i) => {
    const thumb = src.recipes.find(r => r.thumbnail);
    const icon = SRC_ICON[src.type] || '🔗';
    return `
    <div class="rank-card" onclick="filterBySource('${esc(src.handle)}')">
      <div class="rank-card-thumb">
        ${thumb
          ? `<img src="${thumb.thumbnail}" alt="" loading="lazy" />`
          : `<div class="rank-card-thumb-placeholder">${src.recipes[0]?.emoji || icon}</div>`}
        <div class="rank-medal">${MEDALS[i] || `#${i + 1}`}</div>
        <div class="rank-src-icon">${icon}</div>
      </div>
      <div class="rank-card-body">
        <p class="rank-handle">${esc(src.handle)}</p>
        <p class="rank-count">${src.recipes.length}개 레시피</p>
      </div>
    </div>`;
  }).join('');
}

function renderSourcesScreen() {
  const body = document.getElementById('sources-body');
  if (!body) return;
  const sources = computeSourceRanking();
  const maxCount = sources[0]?.recipes.length || 1;

  if (!sources.length) {
    body.innerHTML = `<div class="empty-view"><div class="empty-icon-wrap">📭</div><p class="empty-heading">출처가 없어요</p><p class="empty-body">레시피를 저장하면 여기에 출처가 나타나요</p></div>`;
    return;
  }

  body.innerHTML = sources.map((src, i) => {
    const icon = SRC_ICON[src.type] || '🔗';
    const thumb = src.recipes.find(r => r.thumbnail);
    const barW = Math.round(src.recipes.length / maxCount * 100);
    const recentRecipes = [...src.recipes].sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt)).slice(0, 6);
    return `
    <div class="source-rank-row">
      <div class="source-rank-inner" onclick="filterBySource('${esc(src.handle)}')">
        <div class="source-rank-num">${MEDALS[i] || `#${i + 1}`}</div>
        <div class="source-rank-avatar">
          ${thumb
            ? `<img src="${thumb.thumbnail}" alt="" loading="lazy" />`
            : `<div class="source-rank-avatar-placeholder">${icon}</div>`}
        </div>
        <div class="source-rank-info">
          <p class="source-rank-handle">${esc(src.handle)}</p>
          <p class="source-rank-meta">${icon} ${src.type === 'instagram' ? '인스타그램' : src.type === 'youtube' ? 'YouTube' : src.type === 'blog' ? '블로그' : '기타'} · ❤️ ${src.totalFav}</p>
        </div>
        <div class="source-rank-badge">
          <span class="source-rank-count">${src.recipes.length}</span>
          <span class="source-rank-label">레시피</span>
        </div>
      </div>
      <div class="source-rank-bar-wrap">
        <div class="source-rank-bar-fill" style="width:${barW}%"></div>
      </div>
      <div class="source-preview-strip">
        ${recentRecipes.map(r => `
          <div class="source-preview-thumb" onclick="showDetail('${r.id}')">
            ${r.thumbnail
              ? `<img src="${r.thumbnail}" alt="" loading="lazy" />`
              : `<div class="source-preview-thumb-placeholder">${r.emoji || '🍽️'}</div>`}
          </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}

function filterBySource(handle) {
  state.filters.source = handle;
  switchTab('home');
  updateSourceFilterBanner();
}

// ── Home ──────────────────────────────────────────────────────
function renderHome() {
  const grid = document.getElementById('recipe-grid');
  const empty = document.getElementById('empty-state');
  if (!grid) return;
  // Ensure FAB and nav are visible on home
  document.getElementById('bottom-nav')?.classList.add('visible');
  document.getElementById('fab')?.classList.add('visible');
  const cat = state.filters.category || 'all';
  const recipes = state.recipes
    .filter(r => cat === 'all' || r.category === cat)
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  if (!recipes.length) { grid.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  grid.innerHTML = recipes.map(recipeCardHTML).join('');
}

function recipeCardHTML(r) {
  const srcIcon = r.source?.type === 'instagram' ? '📸' : r.source?.type === 'youtube' ? '▶️' : r.source?.type === 'blog' ? '📝' : '';
  const srcText = r.source?.handle ? `${srcIcon} ${r.source.handle}` : '';
  return `
  <div class="recipe-card" onclick="showDetail('${r.id}')">
    <div class="card-thumb">
      ${r.thumbnail
        ? `<img src="${r.thumbnail}" alt="${esc(r.title)}" loading="lazy" />`
        : `<div class="card-thumb-placeholder">${r.emoji || '🍽️'}</div>`}
      <button class="card-fav" onclick="toggleFavorite(event,'${r.id}')">
        <svg viewBox="0 0 24 24" fill="${r.favorite ? '#ff375f' : 'none'}" stroke="${r.favorite ? '#ff375f' : 'rgba(60,60,67,0.5)'}" stroke-width="2">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
        </svg>
      </button>
    </div>
    <div class="card-body">
      <span class="card-cat">${esc(r.category)}</span>
      <p class="card-title">${esc(r.title)}</p>
      ${srcText ? `<p class="card-source">${srcText}</p>` : ''}
      <p class="card-date">${formatDate(r.savedAt)}</p>
    </div>
  </div>`;
}

function toggleFavorite(e, id) {
  e.stopPropagation();
  const r = state.recipes.find(r => r.id === id);
  if (!r) return;
  r.favorite = !r.favorite;
  saveDB();
  renderHome();
}

function formatDate(iso) {
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60) return '방금 전';
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}일 전`;
  const d = new Date(iso); return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

// ── Detail ────────────────────────────────────────────────────
function showDetail(id) {
  state.previousScreen = document.querySelector('.screen.active')?.id?.replace('screen-', '') || 'home';
  const r = state.recipes.find(r => r.id === id);
  if (!r) return;
  state.currentRecipeId = id;
  renderDetail(r);
  showScreen('detail', 'forward');
}

function renderDetail(r) {
  // Hero with thumbnail if available
  const hero = document.getElementById('detail-hero');
  if (r.thumbnail) {
    hero.style.background = 'none';
    hero.style.position = 'relative';
    const existingImg = hero.querySelector('.hero-img');
    if (!existingImg) {
      const img = document.createElement('img');
      img.className = 'hero-img';
      img.src = r.thumbnail;
      img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0';
      hero.insertBefore(img, hero.firstChild);
    } else {
      existingImg.src = r.thumbnail;
    }
  } else {
    hero.style.background = '';
    hero.querySelector('.hero-img')?.remove();
  }

  // Fav button state
  const favSvg = document.getElementById('detail-fav-btn').querySelector('svg');
  favSvg.setAttribute('fill', r.favorite ? '#ff375f' : 'none');
  favSvg.setAttribute('stroke', r.favorite ? '#ff375f' : 'white');

  const srcUrl = r.source?.url || '';
  const srcHandle = r.source?.handle || '';
  const srcType = r.source?.type || 'other';
  const srcIcon = srcType === 'instagram' ? '📸' : srcType === 'youtube' ? '▶️' : srcType === 'blog' ? '📝' : '🔗';
  const canOpen = !!srcUrl;

  document.getElementById('detail-hero-text').innerHTML = `
    <span class="detail-cat-badge">${r.category}</span>
    <h1 class="detail-hero-title">${esc(r.title)}</h1>
    ${srcHandle ? `
    <button class="detail-src-btn ${canOpen ? 'tappable' : ''}" onclick="${canOpen ? `openSourceURL('${esc(srcUrl)}')` : ''}">
      <span>${srcIcon}</span>
      <span class="detail-src-text">${esc(srcHandle)}</span>
      ${canOpen ? '<span class="detail-src-arrow">↗</span>' : ''}
    </button>` : ''}`;

  // YouTube video card (if URL available)
  const ytVideoId = srcType === 'youtube' && srcUrl ? extractYouTubeId(srcUrl) : null;
  const ytCard = ytVideoId ? `
    <div class="detail-section">
      <div class="yt-card" onclick="openSourceURL('${esc(srcUrl)}')">
        <img class="yt-card-thumb" src="https://img.youtube.com/vi/${ytVideoId}/mqdefault.jpg" alt="" loading="lazy" />
        <div class="yt-card-overlay">
          <div class="yt-play-btn">
            <svg viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </div>
        <div class="yt-card-info">
          <p class="yt-card-label">▶ YouTube에서 영상 보기</p>
          <p class="yt-card-handle">${esc(srcHandle)}</p>
        </div>
      </div>
    </div>` : '';

  document.getElementById('detail-body').innerHTML = ytCard + `
    <div class="detail-section">
      <div class="detail-sec-header"><h2 class="detail-sec-title">🥕 재료 (${r.ingredients.length}가지)</h2></div>
      <div class="ing-list">
        ${r.ingredients.map((ing, i) => `
          <div class="ing-row-d">
            <span class="ing-name-d">${esc(ing.name)}</span>
            <div class="ing-right">
              <span class="ing-amt-d">${esc(ing.amount)}</span>
              <button class="cart-btn" onclick="toggleCart(this,${i})">+</button>
            </div>
          </div>`).join('')}
      </div>
    </div>
    <div class="detail-section">
      <div class="detail-sec-header"><h2 class="detail-sec-title">👨‍🍳 조리 순서</h2></div>
      <div class="step-list-d">
        ${r.steps.map((step, i) => `
          <div class="step-item-d">
            <div class="step-badge-d">${i + 1}</div>
            <p class="step-text-d">${esc(step)}</p>
          </div>`).join('')}
      </div>
    </div>
    ${r.tags.length ? `
    <div class="detail-section">
      <div class="detail-tags-wrap">
        ${r.tags.map(t => `<span class="detail-tag">#${esc(t)}</span>`).join('')}
      </div>
    </div>` : ''}
    <div class="detail-section">
      <div class="detail-footer-row">
        <span class="detail-conf-label">AI 신뢰도 ${Math.round((r.confidence || 0.8) * 100)}%${r.gptAnalyzed ? ' · Gemini' : ''}</span>
        <button class="detail-edit-btn" onclick="editRecipe('${r.id}')">수정하기</button>
      </div>
    </div>`;
}

function toggleFavoriteDetail() {
  const r = state.recipes.find(r => r.id === state.currentRecipeId);
  if (!r) return;
  r.favorite = !r.favorite;
  saveDB();
  renderDetail(r);
}

function toggleCart(btn, idx) {
  btn.classList.toggle('added');
  btn.textContent = btn.classList.contains('added') ? '✓' : '+';
}

function shareRecipe() {
  const r = state.recipes.find(r => r.id === state.currentRecipeId);
  if (!r) return;
  const text = `${r.title}\n\n재료: ${r.ingredients.map(i => `${i.name} ${i.amount}`).join(', ')}\n\n#SnapRecipe`;
  if (navigator.share) navigator.share({ title: r.title, text });
  else navigator.clipboard?.writeText(text).then(() => showToast('클립보드에 복사됐어요!'));
}

function openSourceURL(url) {
  if (!url) return;
  window.open(url, '_blank', 'noopener');
}

// ── Upload tab switch ─────────────────────────────────────────
function resetUploadScreen() {
  switchUploadTab('photo');
  const inp = document.getElementById('yt-url-input');
  if (inp) inp.value = '';
  const preview = document.getElementById('yt-preview');
  if (preview) { preview.classList.add('hidden'); preview.innerHTML = ''; }
  const analyzeBtn = document.getElementById('yt-analyze-btn');
  if (analyzeBtn) analyzeBtn.disabled = true;
}

function switchUploadTab(tab) {
  document.querySelectorAll('.utab').forEach(b => b.classList.remove('active'));
  document.getElementById(`utab-${tab}`).classList.add('active');
  document.getElementById('upload-photo-panel').classList.toggle('hidden', tab !== 'photo');
  document.getElementById('upload-yt-panel').classList.toggle('hidden', tab !== 'youtube');
  if (tab === 'youtube') setTimeout(() => document.getElementById('yt-url-input')?.focus(), 200);
}

async function pasteYTURL() {
  try {
    const text = await navigator.clipboard.readText();
    const inp = document.getElementById('yt-url-input');
    inp.value = text;
    onYTInputChange();
  } catch (_) { showToast('클립보드 접근이 안 됩니다 — 직접 붙여넣어 주세요'); }
}

function onYTInputChange() {
  const url = document.getElementById('yt-url-input').value.trim();
  const videoId = extractYouTubeId(url);
  const analyzeBtn = document.getElementById('yt-analyze-btn');
  const preview = document.getElementById('yt-preview');

  analyzeBtn.disabled = !videoId;

  if (videoId) {
    preview.classList.remove('hidden');
    preview.innerHTML = `
      <div class="yt-thumb-preview" onclick="openSourceURL('${esc(url)}')">
        <img src="https://img.youtube.com/vi/${videoId}/mqdefault.jpg" alt="" loading="lazy" />
        <div class="yt-play-overlay">
          <div class="yt-play-circle">
            <svg viewBox="0 0 24 24" fill="white" width="28" height="28"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </div>
      </div>`;
  } else {
    preview.classList.add('hidden');
    preview.innerHTML = '';
  }
}

async function analyzeYTURL() {
  const url = document.getElementById('yt-url-input').value.trim();
  const videoId = extractYouTubeId(url);
  if (!videoId) { showToast('올바른 YouTube URL을 입력해 주세요'); return; }

  if (!getGeminiKey()) {
    showGeminiKeyPrompt(() => analyzeYTURL());
    return;
  }

  document.getElementById('preview-img').src = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
  renderProcSteps([
    { icon: '🎬', label: '영상 정보 가져오는 중...' },
    { icon: '✨', label: 'Gemini AI 분석 중...' },
    { icon: '🥕', label: '재료 정리 중...' },
    { icon: '👨‍🍳', label: '조리 순서 정리 중...' },
    { icon: '✅', label: '완성!' },
  ]);
  setProgress(0, 'YouTube 분석 시작...');
  showScreen('processing', 'forward');

  try {
    activateStep(0); setProgress(15, '영상 제목 가져오는 중...');
    let videoTitle = '';
    try {
      const oEmbed = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
      if (oEmbed.ok) { const d = await oEmbed.json(); videoTitle = d.title || ''; }
    } catch (_) {}

    activateStep(1);
    const aiResult = await analyzeYouTubeWithGemini(url, videoTitle, (pct, label) => setProgress(pct, label));

    activateStep(2); setProgress(88, '재료 정리 중...'); await delay(300);
    activateStep(3); setProgress(95, '순서 정리 중...'); await delay(300);
    activateStep(4); setProgress(100, '완성!'); await delay(400);

    const recipe = aiResultToRecipe(aiResult, null, null);
    recipe.source.url = url;
    recipe.source.type = 'youtube';
    recipe.thumbnail = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
    recipe.youtubeId = videoId;

    state.pendingResult = recipe;
    renderResult(recipe);
    showScreen('result', 'forward');
  } catch (err) {
    console.error(err);
    showToast(`오류: ${err.message}`);
    setTimeout(() => showScreen('home', 'back'), 2500);
  }
}

function editRecipe(id) {
  const r = state.recipes.find(r => r.id === id);
  if (!r) return;
  state.pendingResult = JSON.parse(JSON.stringify(r));
  renderResult(state.pendingResult);
  showScreen('result', 'forward');
}

// ── Upload & Processing ───────────────────────────────────────
function handleDragOver(e) { e.preventDefault(); document.getElementById('upload-area').classList.add('drag-over'); }
function handleDragLeave()  { document.getElementById('upload-area').classList.remove('drag-over'); }
function handleDrop(e) {
  e.preventDefault(); document.getElementById('upload-area').classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
  if (files.length) processFiles(files);
}
function handleFileSelect(e) {
  const files = Array.from(e.target.files).filter(f => f.type.startsWith('image/'));
  if (files.length) processFiles(files);
  e.target.value = '';
}
function processFiles(files) { startProcessing(files[0]); }


// ── YouTube URL Detection ─────────────────────────────────────
function extractYouTubeId(url) {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ── Tesseract OCR Fallback ────────────────────────────────────
async function runOCR(file, onProgress) {
  const worker = await Tesseract.createWorker('kor+eng', 1, {
    logger: m => { if (m.status === 'recognizing text') onProgress(m.progress * 100); },
  });
  const { data: { text } } = await worker.recognize(file);
  await worker.terminate();
  return text;
}

function correctText(text) {
  if (!text) return text;
  let r = text;
  for (const [w, c] of Object.entries(CORRECTIONS))
    r = r.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), c);
  r = r.replace(/(\d)\s+(g|ml|kg|L|l)\b/g, '$1$2');
  r = r.replace(/[|_]{2,}/g, ' ').replace(/\s{3,}/g, '\n');
  return r.trim();
}

// ── Processing Steps ──────────────────────────────────────────
const PROC_STEPS_AI = [
  { icon: '🔍', label: '이미지 분석 중...' },
  { icon: '✨', label: 'Gemini AI 분석 중...' },
  { icon: '🥕', label: '재료 추출 중...' },
  { icon: '👨‍🍳', label: '조리 순서 정리 중...' },
  { icon: '✅', label: '완성!' },
];
const PROC_STEPS_OCR = [
  { icon: '🔍', label: '이미지 분석 중...' },
  { icon: '🔤', label: 'OCR 텍스트 인식 중...' },
  { icon: '🤖', label: 'AI 오타 교정 중...' },
  { icon: '🥕', label: '재료·순서 추출 중...' },
  { icon: '✅', label: '완성!' },
];

function renderProcSteps(steps) {
  document.getElementById('proc-steps').innerHTML = steps.map((s, i) =>
    `<div class="proc-step" id="pstep-${i}">
      <div class="step-icon">${s.icon}</div>
      <span class="step-text">${s.label}</span>
    </div>`
  ).join('');
}

function activateStep(i) {
  document.querySelectorAll('.proc-step').forEach((el, idx) => {
    el.classList.remove('active');
    if (idx < i) el.classList.add('done'), el.querySelector('.step-icon').textContent = '✓';
  });
  const el = document.getElementById(`pstep-${i}`);
  if (el) {
    el.classList.add('active');
    document.getElementById('proc-title').textContent = el.querySelector('.step-text').textContent;
  }
}

function setProgress(pct, label) {
  document.getElementById('proc-fill').style.width = `${pct}%`;
  document.getElementById('proc-pct').textContent = `${Math.round(pct)}%`;
  if (label) document.getElementById('proc-sub').textContent = label;
}

async function startProcessing(file) {
  const ssId = `ss-${Date.now()}`;
  const dataUrl = await fileToDataURL(file);
  state.screenshots.push({ id: ssId, dataUrl, fileName: file.name, status: 'pending', recipeId: null, savedAt: new Date().toISOString() });
  saveDB();

  document.getElementById('preview-img').src = dataUrl;
  showScreen('processing', 'forward');

  const hasKey = !!getGeminiKey();

  if (hasKey) {
    // ── Gemini AI path ──────────────────────────────
    renderProcSteps(PROC_STEPS_AI);
    setProgress(0, 'Gemini AI 분석 시작...');
    try {
      activateStep(0); setProgress(10, '이미지 준비 중...'); await delay(300);
      activateStep(1);
      const aiResult = await analyzeImageWithGemini(dataUrl, (pct, label) => setProgress(pct, label));
      activateStep(2); setProgress(88, '재료 정리 중...'); await delay(300);
      activateStep(3); setProgress(95, '순서 정리 중...'); await delay(300);
      activateStep(4); setProgress(100, '완성!'); await delay(400);

      const recipe = aiResultToRecipe(aiResult, dataUrl, ssId);
      state.pendingResult = recipe;
      const ss = state.screenshots.find(s => s.id === ssId);
      if (ss) ss.pendingRecipeData = recipe;
      saveDB();
      renderResult(recipe);
      showScreen('result', 'forward');
    } catch (err) {
      console.error('Gemini error:', err);
      if (err.message === 'no_key') {
        showGeminiKeyPrompt(() => startProcessing(file));
      } else {
        showToast(`Gemini 오류: ${err.message}`);
        setTimeout(() => showScreen('home', 'back'), 2500);
      }
    }
  } else {
    // ── OCR fallback path ────────────────────────────
    renderProcSteps(PROC_STEPS_OCR);
    setProgress(0, 'OCR 분석 시작...');
    try {
      activateStep(0); setProgress(8, '이미지 분석 중...'); await delay(500);
      activateStep(1);
      let ocrText = '';
      try {
        ocrText = await runOCR(file, pct => setProgress(8 + pct * 0.5, `OCR ${Math.round(pct)}%`));
      } catch (_) {}
      setProgress(58, 'OCR 완료');
      activateStep(2);
      const corrected = correctText(ocrText);
      await delay(400); setProgress(68, '교정 완료');
      activateStep(3); await delay(500); setProgress(90, '파싱 완료');
      activateStep(4); setProgress(100, '완성!'); await delay(400);

      const recipe = parseRecipeFromText(corrected, dataUrl, ssId);
      state.pendingResult = recipe;
      const ss = state.screenshots.find(s => s.id === ssId);
      if (ss) ss.pendingRecipeData = recipe;
      saveDB();
      renderResult(recipe);
      showScreen('result', 'forward');
    } catch (err) {
      console.error('OCR error:', err);
      showToast(`오류: ${err.message}`);
      setTimeout(() => showScreen('home', 'back'), 2500);
    }
  }
}

// ── AI Result → Recipe Object ─────────────────────────────────
function aiResultToRecipe(gpt, imageDataUrl, ssId) {
  const ingredients = (gpt.ingredients || []).map(i =>
    typeof i === 'string' ? { name: i, amount: '' } : { name: i.name || '', amount: i.amount || '' }
  ).filter(i => i.name);

  const steps = (gpt.steps || []).filter(Boolean);
  const tags = (gpt.tags || []).filter(Boolean).slice(0, 8);

  return {
    id: null,
    title: gpt.title || '새 레시피',
    category: gpt.category || '기타',
    tags,
    ingredients: ingredients.length ? ingredients : [{ name: '', amount: '' }],
    steps: steps.length ? steps : [''],
    source: { type: gpt.source?.type || 'other', handle: gpt.source?.handle || '', url: '' },
    thumbnail: imageDataUrl || null,
    screenshotId: ssId || null,
    favorite: false,
    confidence: 0.97,
    gptAnalyzed: true,
    aiSummary: gpt.summary || '',
    savedAt: new Date().toISOString(),
    emoji: categoryEmoji(gpt.category || '기타'),
  };
}

// ── OCR Fallback Parser ───────────────────────────────────────
const AMOUNT_RE = /(\d[\d./]*)\s*(g|ml|kg|L|개|장|대|쪽|줄|모|컵|큰술|작은술|약간|조금|적당량|한줌)\b/i;
const ING_HDR = /재료|ingredient/i;
const STEP_HDR = /만드는\s*법|조리법|순서|how\s*to/i;
const STEP_LEAD = /^(?:\d+[\.\)]|[①②③④⑤⑥⑦⑧⑨⑩])/;
const COOKING_VERB = /볶|끓|넣|섞|썰|구워|찌|굽|삶|바르|덮|올려|부어|풀어|뿌려|익히|데쳐|졸여/;

function parseRecipeFromText(text, imageDataUrl, ssId) {
  const lines = (text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const title = extractTitle(lines);
  const source = extractSource(text);
  const ingredients = extractIngredients(lines);
  const steps = extractSteps(lines);
  const { category, tags } = classifyRecipe(title, ingredients, text);
  const conf = Math.min(0.9, 0.4 + Math.min(ingredients.length / 5, 0.25) + Math.min(steps.length / 4, 0.2) + (title.length > 2 ? 0.1 : 0));
  return {
    id: null, title, category, tags,
    ingredients: ingredients.length ? ingredients : [{ name: '', amount: '' }],
    steps: steps.length ? steps : [''],
    source, thumbnail: imageDataUrl, screenshotId: ssId,
    favorite: false, confidence: conf, gptAnalyzed: false,
    savedAt: new Date().toISOString(), emoji: categoryEmoji(category),
  };
}

function extractTitle(lines) {
  const skip = [/^[@#]/, /^\d+[^\d]/, /큰술|작은술|g\b|ml\b/i, /재료|만드는법|레시피/, /^https?:\/\//];
  for (const l of lines) {
    if (l.length < 2 || l.length > 40) continue;
    if (skip.some(p => p.test(l))) continue;
    if (/[가-힣]/.test(l)) return l;
  }
  return lines.find(l => l.length > 1) || '새 레시피';
}

function extractSource(text) {
  const ig = text.match(/@([\w.]+)/);
  if (ig) return { type: 'instagram', handle: `@${ig[1]}`, url: '' };
  if (/유튜브|youtube/i.test(text)) return { type: 'youtube', handle: 'YouTube', url: '' };
  if (/블로그|tistory|brunch/i.test(text)) return { type: 'blog', handle: '블로그', url: '' };
  return { type: 'other', handle: '', url: '' };
}

function extractIngredients(lines) {
  const result = []; let inSec = false;
  for (const line of lines) {
    if (ING_HDR.test(line)) { inSec = true; continue; }
    if (STEP_HDR.test(line)) inSec = false;
    const hasAmt = AMOUNT_RE.test(line);
    const isStep = STEP_LEAD.test(line) || COOKING_VERB.test(line);
    if ((inSec || hasAmt) && !isStep) {
      const p = parseIngLine(line); if (p) result.push(p);
    }
  }
  if (!result.length) for (const l of lines) { if (AMOUNT_RE.test(l) && !COOKING_VERB.test(l)) { const p = parseIngLine(l); if (p) result.push(p); } }
  return result.slice(0, 20);
}

function parseIngLine(line) {
  const ci = line.indexOf(':');
  if (ci > 0 && ci < 12) { const n = line.slice(0, ci).trim(), a = line.slice(ci + 1).trim(); if (n && a) return { name: n, amount: a }; }
  const m = line.match(AMOUNT_RE);
  if (m) {
    const ai = line.indexOf(m[0]); const name = line.slice(0, ai).replace(/[\s,\-]+$/, '').trim();
    if (name.length >= 1) return { name, amount: m[0].trim() };
    const rest = line.slice(ai + m[0].length).trim(); if (rest.length >= 1) return { name: rest, amount: m[0].trim() };
  }
  if (line.length >= 2 && line.length <= 20 && /[가-힣]/.test(line)) return { name: line, amount: '적당량' };
  return null;
}

function extractSteps(lines) {
  const result = []; let inSec = false;
  for (const line of lines) {
    if (STEP_HDR.test(line)) { inSec = true; continue; }
    const isNum = STEP_LEAD.test(line), hasVerb = COOKING_VERB.test(line);
    if (inSec || isNum) { const c = line.replace(STEP_LEAD, '').trim(); if (c.length >= 4) result.push(c); }
    else if (!inSec && hasVerb && line.length >= 8) result.push(line);
  }
  return result.slice(0, 20);
}

const CATEGORY_MAP = [
  { cat: '한식', keys: ['김치', '된장', '고추장', '간장', '제육', '삼겹', '불고기', '갈비', '찌개', '국밥', '비빔', '잡채', '순두부', '냉면', '볶음밥', '떡볶이'] },
  { cat: '일식', keys: ['라멘', '우동', '소바', '스시', '회', '돈까스', '규동', '카레', '미소'] },
  { cat: '중식', keys: ['짜장', '짬뽕', '탕수육', '마파두부', '볶음면', '딤섬', '만두'] },
  { cat: '양식', keys: ['파스타', '스파게티', '피자', '리조또', '스테이크', '햄버거', '크림', '카르보나라', '봉골레'] },
  { cat: '디저트', keys: ['케이크', '쿠키', '마카롱', '타르트', '푸딩', '아이스크림', '빵', '머핀'] },
  { cat: '음료', keys: ['커피', '라떼', '스무디', '주스', '버블티', '말차'] },
  { cat: '간식', keys: ['튀김', '전', '부침', '강정', '호떡'] },
  { cat: '채식', keys: ['두부', '버섯', '브로콜리', '아보카도', '비건', '채식'] },
];
function classifyRecipe(title, ings, text) {
  const combined = `${title} ${ings.map(i => i.name).join(' ')} ${text}`.toLowerCase();
  let bestCat = '기타', best = 0;
  for (const { cat, keys } of CATEGORY_MAP) { const s = keys.filter(k => combined.includes(k)).length; if (s > best) { best = s; bestCat = cat; } }
  const hashTags = (text.match(/#([가-힣\w]+)/g) || []).map(t => t.replace('#', '')).filter(t => t.length <= 10).slice(0, 5);
  return { category: bestCat, tags: [...new Set([...(bestCat !== '기타' ? [bestCat] : []), ...hashTags])] };
}
function categoryEmoji(cat) {
  return { '한식': '🍚', '일식': '🍣', '중식': '🥟', '양식': '🍝', '디저트': '🧁', '음료': '🧋', '간식': '🍿', '채식': '🥗', '기타': '🍽️' }[cat] || '🍽️';
}

// ── Result Screen ─────────────────────────────────────────────
function renderResult(r) {
  const conf = r.confidence || 0.8;
  const pct = Math.round(conf * 100);
  const cls = conf >= 0.9 ? 'high' : conf >= 0.6 ? 'mid' : 'low';
  const lbl = conf >= 0.9 ? '✅ 높은 신뢰도' : conf >= 0.6 ? '⚠️ 확인 권장' : '❗ 직접 수정 필요';

  document.getElementById('result-body').innerHTML = `
    ${r.thumbnail ? `<div class="result-thumb-wrap"><img class="result-thumb-img" src="${r.thumbnail}" alt="" /></div>` : ''}
    <div class="result-confidence ${cls}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span>${lbl} (${pct}%)</span>
        ${r.gptAnalyzed ? '<span class="ai-chip">✨ Gemini</span>' : '<span class="ai-chip">🔤 OCR</span>'}
      </div>
      <div class="conf-bar-track"><div class="conf-bar-fill" style="width:${pct}%"></div></div>
      ${r.aiSummary ? `<p style="font-size:13px;font-weight:400;opacity:0.85;margin-top:2px">${esc(r.aiSummary)}</p>` : ''}
    </div>

    <div class="result-card">
      <div class="result-card-header"><span class="result-card-title">📌 기본 정보</span></div>
      <div class="result-card-body">
        <div class="field-group">
          <span class="field-label">제목</span>
          <input class="field-input" id="res-title" value="${esc(r.title)}" placeholder="레시피 제목" />
        </div>
        <div style="display:flex;gap:16px">
          <div class="field-group" style="flex:1">
            <span class="field-label">카테고리</span>
            <select class="field-select" id="res-category">
              ${['한식','일식','중식','양식','디저트','음료','간식','채식','기타'].map(c =>
                `<option value="${c}" ${r.category === c ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="field-group">
          <span class="field-label">출처</span>
          <div class="source-row">
            <span class="source-emoji" id="res-source-emoji">${r.source?.type === 'instagram' ? '📸' : r.source?.type === 'youtube' ? '▶️' : '🔗'}</span>
            <input class="source-input" id="res-source-handle" value="${esc(r.source?.handle || '')}" placeholder="@계정 또는 채널명" />
          </div>
        </div>
        <div class="field-group">
          <span class="field-label">링크 URL</span>
          <div class="source-row">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px;flex-shrink:0;stroke:var(--label-3)"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            <input class="source-input" id="res-source-url" value="${esc(r.source?.url || '')}" placeholder="https://instagram.com/p/... 또는 youtube.com/..." oninput="onSourceURLChange(this.value)" />
          </div>
        </div>
      </div>
    </div>

    <div class="result-card">
      <div class="result-card-header">
        <span class="result-card-title">🥕 재료 (${r.ingredients.length}가지)</span>
        <button class="result-card-add" onclick="addIngRow()">+ 추가</button>
      </div>
      <div class="result-card-body" id="res-ings">
        ${r.ingredients.map((ing, i) => ingRowHTML(ing, i)).join('')}
      </div>
    </div>

    <div class="result-card">
      <div class="result-card-header">
        <span class="result-card-title">👨‍🍳 조리 순서 (${r.steps.length}단계)</span>
        <button class="result-card-add" onclick="addStepRow()">+ 추가</button>
      </div>
      <div class="result-card-body" id="res-steps">
        ${r.steps.map((s, i) => stepRowHTML(s, i)).join('')}
      </div>
    </div>

    <div class="result-card">
      <div class="result-card-header"><span class="result-card-title">🏷️ 태그</span></div>
      <div class="tags-wrap" id="res-tags">
        ${r.tags.map(tagHTML).join('')}
        <input class="tag-in" id="tag-input" placeholder="+ 태그 추가" onkeydown="addTag(event)" />
      </div>
    </div>`;
}

function ingRowHTML(ing, i) {
  return `<div class="ing-row" id="ing-row-${i}">
    <input class="ing-name-in" placeholder="재료명" value="${esc(ing.name)}" data-i="${i}" data-f="name" oninput="updateIng(this)" />
    <input class="ing-amt-in" placeholder="수량" value="${esc(ing.amount)}" data-i="${i}" data-f="amount" oninput="updateIng(this)" />
    <button class="row-del" onclick="delIng(${i})">−</button>
  </div>`;
}

function stepRowHTML(step, i) {
  return `<div class="step-row-r" id="step-row-${i}">
    <div class="step-num-badge">${i + 1}</div>
    <textarea class="step-textarea-r" rows="2" data-s="${i}" oninput="updateStep(this)">${esc(step)}</textarea>
    <button class="row-del" onclick="delStep(${i})">−</button>
  </div>`;
}

function tagHTML(t) {
  return `<span class="res-tag">#${esc(t)}<button class="res-tag-del" onclick="delTag('${esc(t)}')">×</button></span>`;
}

function updateIng(input) {
  const i = +input.dataset.i;
  if (state.pendingResult) state.pendingResult.ingredients[i][input.dataset.f] = input.value;
}
function updateStep(ta) {
  const i = +ta.dataset.s;
  if (state.pendingResult) state.pendingResult.steps[i] = ta.value;
}

function updateResultCounts() {
  const ingTitle = document.getElementById('res-ings')?.closest('.result-card')?.querySelector('.result-card-title');
  if (ingTitle) ingTitle.textContent = `🥕 재료 (${state.pendingResult.ingredients.length}가지)`;
  const stepTitle = document.getElementById('res-steps')?.closest('.result-card')?.querySelector('.result-card-title');
  if (stepTitle) stepTitle.textContent = `👨‍🍳 조리 순서 (${state.pendingResult.steps.length}단계)`;
}

function addIngRow() {
  if (!state.pendingResult) return;
  const i = state.pendingResult.ingredients.length;
  state.pendingResult.ingredients.push({ name: '', amount: '' });
  document.getElementById('res-ings').insertAdjacentHTML('beforeend', ingRowHTML({ name: '', amount: '' }, i));
  document.querySelectorAll('.ing-name-in')[i]?.focus();
  updateResultCounts();
}
function delIng(i) {
  if (!state.pendingResult) return;
  state.pendingResult.ingredients.splice(i, 1);
  document.getElementById('res-ings').innerHTML = state.pendingResult.ingredients.map(ingRowHTML).join('');
  updateResultCounts();
}
function addStepRow() {
  if (!state.pendingResult) return;
  const i = state.pendingResult.steps.length;
  state.pendingResult.steps.push('');
  document.getElementById('res-steps').insertAdjacentHTML('beforeend', stepRowHTML('', i));
  document.querySelectorAll('.step-textarea-r')[i]?.focus();
  updateResultCounts();
}
function delStep(i) {
  if (!state.pendingResult) return;
  state.pendingResult.steps.splice(i, 1);
  document.getElementById('res-steps').innerHTML = state.pendingResult.steps.map(stepRowHTML).join('');
  updateResultCounts();
}
function addTag(e) {
  if (e.key !== 'Enter') return;
  const inp = document.getElementById('tag-input');
  const tag = inp.value.replace(/^#/, '').trim();
  if (!tag || !state.pendingResult) return;
  if (!state.pendingResult.tags.includes(tag)) { state.pendingResult.tags.push(tag); rerenderTags(); }
  inp.value = '';
}
function delTag(tag) {
  if (!state.pendingResult) return;
  state.pendingResult.tags = state.pendingResult.tags.filter(t => t !== tag);
  rerenderTags();
}
function rerenderTags() {
  document.getElementById('res-tags').innerHTML =
    state.pendingResult.tags.map(tagHTML).join('') +
    `<input class="tag-in" id="tag-input" placeholder="+ 태그 추가" onkeydown="addTag(event)" />`;
}

// ── Save ──────────────────────────────────────────────────────
function onSourceURLChange(url) {
  url = url.trim();
  const emoji = document.getElementById('res-source-emoji');
  if (!emoji) return;
  if (/instagram\.com|instagr\.am/.test(url)) emoji.textContent = '📸';
  else if (/youtube\.com|youtu\.be/.test(url)) emoji.textContent = '▶️';
  else if (url) emoji.textContent = '🔗';
  else emoji.textContent = '🔗';
}

function saveRecipe() {
  if (!state.pendingResult) return;
  const r = state.pendingResult;
  r.title = document.getElementById('res-title')?.value || r.title;
  r.category = document.getElementById('res-category')?.value || r.category;
  r.source.handle = document.getElementById('res-source-handle')?.value || r.source.handle;
  const sourceUrl = document.getElementById('res-source-url')?.value?.trim() || '';
  r.source.url = sourceUrl;
  if (/instagram\.com|instagr\.am/.test(sourceUrl)) r.source.type = 'instagram';
  else if (/youtube\.com|youtu\.be/.test(sourceUrl)) {
    r.source.type = 'youtube';
    const ytId = extractYouTubeId(sourceUrl);
    if (ytId) { r.youtubeId = ytId; r.thumbnail = r.thumbnail || `https://img.youtube.com/vi/${ytId}/mqdefault.jpg`; }
  } else if (sourceUrl) r.source.type = 'other';
  r.ingredients = Array.from(document.querySelectorAll('#res-ings .ing-row')).map(row => ({
    name: row.querySelector('.ing-name-in')?.value || '',
    amount: row.querySelector('.ing-amt-in')?.value || '',
  })).filter(i => i.name);
  r.steps = Array.from(document.querySelectorAll('#res-steps .step-textarea-r')).map(t => t.value).filter(Boolean);
  r.confidence = 1.0;
  r.emoji = categoryEmoji(r.category);

  if (r.id && state.recipes.find(x => x.id === r.id)) {
    state.recipes[state.recipes.findIndex(x => x.id === r.id)] = r;
  } else {
    r.id = `recipe-${Date.now()}`;
    r.savedAt = new Date().toISOString();
    state.recipes.unshift(r);
    const ss = state.screenshots.find(s => s.id === r.screenshotId);
    if (ss) { ss.status = 'done'; ss.recipeId = r.id; }
  }
  saveDB();
  state.pendingResult = null;
  showToast('저장됐어요! 🎉');
  showScreen('home', 'back');
}

// ── Screenshots ───────────────────────────────────────────────
function renderScreenshots() {
  const grid = document.getElementById('screenshot-grid');
  const empty = document.getElementById('gallery-empty');
  const f = document.querySelector('.fpill.active')?.dataset?.f || 'all';
  if (!grid) return;
  let list = [...state.screenshots].reverse();
  if (f === 'pending') list = list.filter(s => s.status !== 'done');
  if (f === 'done')    list = list.filter(s => s.status === 'done');
  if (!list.length) { grid.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  grid.innerHTML = list.map(ss => `
    <div class="ss-thumb" onclick="openScreenshotModal('${ss.id}')">
      <img src="${ss.dataUrl}" alt="" loading="lazy" />
      <div class="ss-overlay">
        <span class="ss-badge ${ss.status === 'done' ? 'done' : ''}">${ss.status === 'done' ? '완료' : '미처리'}</span>
      </div>
    </div>`).join('');
}

function filterGallery(btn, f) {
  document.querySelectorAll('.fpill').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  renderScreenshots();
}

function openScreenshotModal(id) {
  state.currentScreenshotId = id;
  const ss = state.screenshots.find(s => s.id === id);
  if (!ss) return;
  document.getElementById('modal-ss-img').src = ss.dataUrl;
  document.getElementById('modal-screenshot').classList.remove('hidden');
}
function closeScreenshotModal(e) {
  if (e && e.target !== document.getElementById('modal-screenshot')) return;
  document.getElementById('modal-screenshot').classList.add('hidden');
  state.currentScreenshotId = null;
}
function reprocessScreenshot() {
  const ss = state.screenshots.find(s => s.id === state.currentScreenshotId);
  if (!ss) return;
  document.getElementById('modal-screenshot').classList.add('hidden');
  fetch(ss.dataUrl).then(r => r.blob()).then(blob => {
    startProcessing(new File([blob], ss.fileName || 'ss.jpg', { type: 'image/jpeg' }));
  });
}
function goToRecipeFromModal() {
  const ss = state.screenshots.find(s => s.id === state.currentScreenshotId);
  document.getElementById('modal-screenshot').classList.add('hidden');
  if (ss?.recipeId) showDetail(ss.recipeId);
}
function deleteScreenshot() {
  state.screenshots = state.screenshots.filter(s => s.id !== state.currentScreenshotId);
  document.getElementById('modal-screenshot').classList.add('hidden');
  state.currentScreenshotId = null;
  saveDB(); renderScreenshots();
}

// ── Fridge ────────────────────────────────────────────────────
function renderFridgeTags() {
  document.getElementById('fridge-tags').innerHTML =
    state.fridgeItems.map(item =>
      `<span class="fridge-chip">${esc(item)}<button class="fridge-chip-del" onclick="rmFridge('${esc(item)}')">×</button></span>`
    ).join('');
}
function addFridgeItem(e) { if (e.key === 'Enter') addFridgeItemBtn(); }
function addFridgeItemBtn() {
  const inp = document.getElementById('fridge-input');
  inp.value.split(/[,，、]/).map(s => s.trim()).filter(Boolean).forEach(item => {
    if (!state.fridgeItems.includes(item)) state.fridgeItems.push(item);
  });
  inp.value = ''; saveDB(); renderFridgeTags();
}
function rmFridge(item) { state.fridgeItems = state.fridgeItems.filter(i => i !== item); saveDB(); renderFridgeTags(); }

function searchFridge() {
  if (!state.fridgeItems.length) { showToast('재료를 먼저 입력하세요'); return; }
  const results = state.recipes.map(r => {
    const matches = r.ingredients.filter(ing => state.fridgeItems.some(fi => ing.name.includes(fi) || fi.includes(ing.name)));
    return { r, cnt: matches.length, pct: Math.round(matches.length / Math.max(r.ingredients.length, 1) * 100) };
  }).filter(x => x.cnt > 0).sort((a, b) => b.pct - a.pct);

  const el = document.getElementById('fridge-results');
  if (!results.length) { el.innerHTML = '<p style="text-align:center;color:var(--label-3);padding:24px;font-size:15px">일치하는 레시피가 없어요</p>'; return; }
  el.innerHTML = results.map(({ r, cnt, pct }) => `
    <div class="fridge-result-card" onclick="showDetail('${r.id}')">
      <div class="fridge-result-inner">
        <p class="fridge-result-title">${r.emoji || '🍽️'} ${esc(r.title)}</p>
        <p class="fridge-result-sub">${r.category} · ${cnt}/${r.ingredients.length}개 보유 (${pct}%)</p>
        <div class="match-track"><div class="match-fill" style="width:${pct}%"></div></div>
      </div>
    </div>`).join('');
}

// ── Planner ───────────────────────────────────────────────────
const DAYS = ['월', '화', '수', '목', '금', '토', '일'];
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MEALS = [{ k: 'breakfast', l: '아침' }, { k: 'lunch', l: '점심' }, { k: 'dinner', l: '저녁' }];

function renderPlanner() {
  document.getElementById('planner-body').innerHTML = DAYS.map((day, di) => `
    <div class="planner-card">
      <div class="planner-day-head">${day}요일</div>
      <div class="planner-meals">
        ${MEALS.map(m => {
          const key = `${DAY_KEYS[di]}-${m.k}`;
          const r = state.weeklyPlan[key] ? state.recipes.find(x => x.id === state.weeklyPlan[key]) : null;
          return `<div class="planner-meal-row">
            <span class="meal-tag">${m.l}</span>
            <div class="meal-slot">
              ${r
                ? `<span class="meal-recipe" onclick="showDetail('${r.id}')">${r.emoji || '🍽️'} ${esc(r.title)}</span>`
                : `<button class="meal-empty" onclick="openPlannerModal('${DAY_KEYS[di]}','${m.k}')">+ 추가</button>`}
            </div>
            ${r ? `<button class="meal-clear" onclick="clearMeal('${DAY_KEYS[di]}','${m.k}')"></button>` : ''}
          </div>`;
        }).join('')}
      </div>
    </div>`).join('');
}

function openPlannerModal(day, meal) {
  state.plannerTarget = { day, meal };
  document.getElementById('planner-recipe-list').innerHTML =
    state.recipes.map(r => `<button class="picker-item" onclick="assignMeal('${r.id}')">${r.emoji || '🍽️'} ${esc(r.title)}</button>`).join('');
  document.getElementById('modal-planner').classList.remove('hidden');
}
function closePlannerModal(e) {
  if (e && e.target !== document.getElementById('modal-planner')) return;
  document.getElementById('modal-planner').classList.add('hidden');
  state.plannerTarget = null;
}
function assignMeal(id) {
  if (!state.plannerTarget) return;
  state.weeklyPlan[`${state.plannerTarget.day}-${state.plannerTarget.meal}`] = id;
  saveDB(); closePlannerModal(); renderPlanner();
}
function clearMeal(day, meal) { delete state.weeklyPlan[`${day}-${meal}`]; saveDB(); renderPlanner(); }
function clearWeeklyPlan() {
  if (!confirm('식단 플래너를 모두 초기화할까요?')) return;
  state.weeklyPlan = {}; saveDB(); renderPlanner();
}


// ── Gemini Key Modal ──────────────────────────────────────────
function showGeminiKeyPrompt(onSave) {
  document.getElementById('gemini-key-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'gemini-key-modal';
  modal.className = 'sheet-backdrop';
  modal.innerHTML = `
    <div class="sheet" onclick="event.stopPropagation()">
      <div class="sheet-handle"></div>
      <h3 class="sheet-title">✨ Google Gemini AI 설정</h3>
      <p style="font-size:14px;color:var(--label-2);line-height:1.6;margin-bottom:16px">
        <strong>무료</strong> Gemini API 키를 입력하면 사진과 YouTube 링크를<br>
        AI가 자동으로 분석해 레시피를 만들어줘요.<br><br>
        <strong>키 발급:</strong> <span style="color:var(--accent)">aistudio.google.com</span><br>
        → Get API key → Create API key (30초, 카드 불필요)
      </p>
      <div class="fridge-input-wrap" style="margin-bottom:12px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:20px;height:20px;flex-shrink:0;stroke:var(--accent)"><path d="M21 2H3v16h5v4l4-4h5l4-4V2zM11 11V7M16 11V7"/></svg>
        <input id="gemini-key-input" type="password" placeholder="AIza... 또는 AQ...."
          value="${getGeminiKey()}"
          style="flex:1;border:none;background:none;outline:none;font-size:15px;font-family:monospace;color:var(--label)" />
      </div>
      <div class="sheet-actions">
        <button class="sheet-action-btn primary" onclick="saveGeminiKeyAndContinue()">저장하고 분석 시작</button>
        <button class="sheet-action-btn" onclick="document.getElementById('gemini-key-modal')?.remove()">나중에</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  window._geminiKeyCb = onSave;
  setTimeout(() => document.getElementById('gemini-key-input')?.focus(), 300);
}

function saveGeminiKeyAndContinue() {
  const key = document.getElementById('gemini-key-input')?.value.trim() || '';
  if (!key) { showToast('API 키를 입력해주세요'); return; }
  saveGeminiKey(key);
  document.getElementById('gemini-key-modal')?.remove();
  if (window._geminiKeyCb) { window._geminiKeyCb(); window._geminiKeyCb = null; }
}

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg, ms = 2400) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ── Helpers ───────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fileToDataURL(f) {
  return new Promise((res, rej) => {
    const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej; r.readAsDataURL(f);
  });
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Intercept upload to check API key first ───────────────────
const _origShowScreen = showScreen;
const _showScreen = showScreen;
// Wrap fab click to ask for key if never set
document.addEventListener('DOMContentLoaded', () => {
  loadDB();

  // Splash → login or home; show Gemini key prompt if not set
  setTimeout(() => {
    if (state.user) {
      updateProfileUI();
      showScreen('home', 'forward');
      if (!getGeminiKey()) {
        setTimeout(() => showGeminiKeyPrompt(() => {}), 700);
      }
    } else {
      showScreen('login', 'forward');
    }
  }, 2200);

  // Animate splash dots
  const dots = document.querySelectorAll('.splash-dots .dot');
  if (dots.length) {
    let i = 0;
    const dt = setInterval(() => {
      dots.forEach(d => d.classList.remove('active'));
      dots[i % dots.length].classList.add('active');
      i++;
      if (i >= dots.length * 2) clearInterval(dt);
    }, 600);
  }

  // Close sort menu on outside tap
  document.addEventListener('click', e => {
    const menu = document.getElementById('sort-menu');
    if (!menu?.classList.contains('hidden') &&
        !document.getElementById('sort-menu')?.contains(e.target) &&
        !e.target.closest('[onclick*="toggleSortMenu"]')) {
      menu?.classList.add('hidden');
    }
  });

});
