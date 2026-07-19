/* GymNet frontend — vanilla JS single-page app */
'use strict';

const $ = sel => document.querySelector(sel);
const root = $('#root');
let ME = null;            // current user (publicUser shape)
let STATUS = { notif: 0, dm: 0 };
let GYMS_CACHE = null;

// ------------------------------------------------------------- utils
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 604800) return Math.floor(s / 86400) + 'd';
  return new Date(ts).toLocaleDateString();
}

function toast(msg, cls = '') {
  const t = el(`<div class="toast ${cls}">${esc(msg)}</div>`);
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
const xpToast = n => n && toast(`+${n} XP ⚡`, 'xp');

function avatarEl(u, size = '') {
  const cls = `avatar ${size}`;
  if (u && u.avatar) return `<div class="${cls}" style="background-image:url('${esc(u.avatar)}')"></div>`;
  const initial = u && (u.name || u.username) ? (u.name || u.username)[0].toUpperCase() : '?';
  return `<div class="${cls}">${esc(initial)}</div>`;
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function uploadFile(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error('File too large (20 MB max)');
  const data = await readFileAsDataURL(file);
  return api('/upload', { body: { data } });
}

function modal(innerHTML) {
  const back = el(`<div class="modalback"><div class="modal">${innerHTML}</div></div>`);
  back.addEventListener('click', e => { if (e.target === back) back.remove(); });
  document.body.appendChild(back);
  return back;
}

// ------------------------------------------------------------- router
function nav(hash) { location.hash = hash; }
window.addEventListener('hashchange', route);

async function route() {
  if (!ME) {
    try { const d = await api('/me'); ME = d.user; }
    catch { renderAuth('login'); return; }
  }
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const view = parts[0] || 'feed';
  const arg = parts[1] ? decodeURIComponent(parts[1]) : null;
  renderShell(view);
  const target = $('#view');
  try {
    if (view === 'feed') await renderFeed(target);
    else if (view === 'profile') await renderProfile(target, arg || ME.username);
    else if (view === 'workouts') await renderWorkouts(target);
    else if (view === 'leaderboard') await renderLeaderboard(target);
    else if (view === 'map') await renderMap(target);
    else if (view === 'chat') await renderChat(target, arg);
    else if (view === 'notifications') await renderNotifications(target);
    else if (view === 'settings') await renderSettings(target);
    else await renderFeed(target);
  } catch (e) {
    target.innerHTML = `<div class="empty"><div class="big">😵</div>${esc(e.message)}</div>`;
  }
  refreshStatus();
}

// ------------------------------------------------------------- shell
const NAV = [
  ['feed', '🏠', 'Feed'], ['workouts', '💪', 'Workouts'], ['leaderboard', '🏆', 'Leaderboard'],
  ['map', '🗺️', 'Map'], ['chat', '💬', 'Chat', 'dm'], ['notifications', '🔔', 'Alerts', 'notif'],
  ['profile', '👤', 'Profile'],
];

function renderShell(active) {
  if ($('#app') && root.dataset.shell === '1') {
    document.querySelectorAll('.navbtn').forEach(b => b.classList.toggle('active', b.dataset.v === active));
    return;
  }
  root.dataset.shell = '1';
  const navBtns = where => NAV.map(([v, icon, label, badge]) => `
    <button class="navbtn ${v === active ? 'active' : ''}" data-v="${v}" onclick="nav('#/${v}')">
      <span class="navicon">${icon}</span>${where === 'side' ? label : `<span>${label}</span>`}
      ${badge ? `<span class="navbadge hidden" data-badge="${badge}"></span>` : ''}
    </button>`).join('');
  root.innerHTML = `
    <div id="app">
      <nav class="sidebar">
        <div class="logo">Gym<span>Net</span></div>
        ${navBtns('side')}
        <div class="spacer"></div>
        <div class="sidebar-me" onclick="nav('#/profile')">
          ${avatarEl(ME)}
          <div class="who"><b>${esc(ME.name)}</b><span>@${esc(ME.username)} · Lv ${ME.level}</span></div>
        </div>
        <button class="navbtn" onclick="nav('#/settings')"><span class="navicon">⚙️</span>Settings</button>
        <button class="navbtn" id="logoutbtn"><span class="navicon">🚪</span>Log out</button>
      </nav>
      <main class="main"><div class="content" id="viewwrap">
        <div class="topbar">
          <h1 id="viewtitle"></h1>
          <div class="searchwrap">
            <span class="sicon">🔍</span>
            <input id="searchbox" placeholder="Search lifters..." autocomplete="off">
            <div class="searchresults hidden" id="searchresults"></div>
          </div>
        </div>
        <div id="view"></div>
      </div></main>
      <div class="mobilebar">${navBtns('mob')}</div>
    </div>`;
  $('#logoutbtn').onclick = async () => { await api('/logout', { body: {} }); ME = null; root.dataset.shell = ''; location.hash = ''; renderAuth('login'); };

  const box = $('#searchbox'), results = $('#searchresults');
  let timer;
  box.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const term = box.value.trim();
      if (!term) { results.classList.add('hidden'); return; }
      const d = await api('/search?q=' + encodeURIComponent(term));
      results.innerHTML = d.users.length
        ? d.users.map(u => `<div class="urow" onclick="nav('#/profile/${esc(u.username)}')">${avatarEl(u, 'sm')}<div class="uinfo"><b>${esc(u.name)}</b><span>@${esc(u.username)} · Lv ${u.level}</span></div></div>`).join('')
        : '<div class="urow"><span class="muted" style="padding:4px 2px">No lifters found</span></div>';
      results.classList.remove('hidden');
    }, 250);
  });
  document.addEventListener('click', e => { if (!e.target.closest('.searchwrap')) results.classList.add('hidden'); });
}

function setTitle(t) { const h = $('#viewtitle'); if (h) h.textContent = t; }

async function refreshStatus() {
  try {
    const d = await api('/status');
    STATUS = d; ME = d.user;
    document.querySelectorAll('[data-badge]').forEach(b => {
      const n = d[b.dataset.badge] || 0;
      b.textContent = n; b.classList.toggle('hidden', !n);
    });
  } catch { /* logged out */ }
}
setInterval(() => { if (ME) refreshStatus(); }, 12000);

// ------------------------------------------------------------- auth
function renderAuth(mode) {
  root.dataset.shell = '';
  const forms = {
    login: `
      <div class="field"><label>Username or email</label><input id="a_user" autocomplete="username"></div>
      <div class="field"><label>Password</label><input id="a_pass" type="password" autocomplete="current-password"></div>
      <div class="formerror" id="a_err"></div>
      <button class="btn full" id="a_go">Log in</button>
      <div class="authswitch">New here? <a data-m="signup">Create account</a> · <a data-m="forgot">Forgot password?</a></div>
      <div class="demobox">Try the demo — username <b>demo</b> / password <b>demo123</b></div>`,
    signup: `
      <div class="field"><label>Name</label><input id="a_name" placeholder="Alex Carter"></div>
      <div class="field"><label>Username</label><input id="a_user" placeholder="alex_lifts" autocomplete="username"></div>
      <div class="field"><label>Email</label><input id="a_email" type="email" placeholder="you@example.com"></div>
      <div class="field"><label>Password</label><input id="a_pass" type="password" autocomplete="new-password" placeholder="6+ characters"></div>
      <div class="formerror" id="a_err"></div>
      <button class="btn full" id="a_go">Sign up</button>
      <div class="authswitch">Already lifting with us? <a data-m="login">Log in</a></div>`,
    forgot: `
      <p class="muted small" style="margin-bottom:14px">Enter your username or email and we'll issue a reset code. (Demo mode: the code is shown on screen.)</p>
      <div class="field"><label>Username or email</label><input id="a_user"></div>
      <div class="formerror" id="a_err"></div>
      <button class="btn full" id="a_go">Get reset code</button>
      <div class="authswitch"><a data-m="login">Back to login</a></div>`,
    reset: `
      <p class="muted small" style="margin-bottom:14px">Reset code for <b id="a_whoLabel"></b>: <b style="color:var(--green)" id="a_codeShow"></b></p>
      <div class="field"><label>Reset code</label><input id="a_code" inputmode="numeric"></div>
      <div class="field"><label>New password</label><input id="a_pass" type="password" autocomplete="new-password"></div>
      <div class="formerror" id="a_err"></div>
      <button class="btn full" id="a_go">Reset password</button>
      <div class="authswitch"><a data-m="login">Back to login</a></div>`,
  };
  const titles = { login: 'Welcome back, lifter', signup: 'Join the strongest community', forgot: 'Reset your password', reset: 'Set a new password' };
  root.innerHTML = `
    <div class="authwrap"><div class="authcard">
      <div class="logo">Gym<span>Net</span></div>
      <div class="authtag">${titles[mode]}</div>
      ${forms[mode]}
    </div></div>`;
  root.querySelectorAll('[data-m]').forEach(a => a.onclick = () => renderAuth(a.dataset.m));
  const errBox = $('#a_err');
  const go = $('#a_go');
  root.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') go.click(); }));

  go.onclick = async () => {
    errBox.textContent = '';
    go.disabled = true;
    try {
      if (mode === 'login') {
        await api('/login', { body: { username: $('#a_user').value, password: $('#a_pass').value } });
        ME = null; location.hash = '#/feed'; await route();
      } else if (mode === 'signup') {
        await api('/signup', { body: { name: $('#a_name').value, username: $('#a_user').value, email: $('#a_email').value, password: $('#a_pass').value } });
        ME = null; location.hash = '#/feed'; await route();
        toast('Welcome to GymNet! 💪');
      } else if (mode === 'forgot') {
        const who = $('#a_user').value;
        const d = await api('/forgot', { body: { username: who } });
        renderAuth('reset');
        $('#a_whoLabel').textContent = who;
        $('#a_codeShow').textContent = d.demo_code;
        window._resetWho = who;
      } else if (mode === 'reset') {
        await api('/reset', { body: { username: window._resetWho, code: $('#a_code').value, password: $('#a_pass').value } });
        toast('Password updated — log in with it now');
        renderAuth('login');
      }
    } catch (e) { errBox.textContent = e.message; }
    go.disabled = false;
  };
}

// ------------------------------------------------------------- feed
async function renderFeed(target) {
  setTitle('Feed');
  target.innerHTML = `
    <div class="card composer">
      <textarea id="postText" placeholder="What did you lift today, ${esc(ME.name.split(' ')[0])}?"></textarea>
      <div class="mediapreview" id="mediaPreview"></div>
      <div class="crow">
        <button class="mediabtn" id="pickImg">📷 Photo</button>
        <button class="mediabtn" id="pickVid">🎥 Video</button>
        <input type="file" id="fileImg" accept="image/*" multiple class="hidden">
        <input type="file" id="fileVid" accept="video/mp4,video/webm" class="hidden">
        <div class="grow"></div>
        <button class="btn small" id="postGo">Post</button>
      </div>
    </div>
    <div class="tabs">
      <button class="tab active" data-f="all">🌍 Everyone</button>
      <button class="tab" data-f="following">👥 Following</button>
      <button class="tab" data-f="saved">🔖 Saved</button>
    </div>
    <div id="feedList"></div>`;

  let pendingMedia = [];
  const preview = $('#mediaPreview');
  const drawPreview = () => {
    preview.innerHTML = pendingMedia.map((m, i) => `
      <div class="mitem">${m.type === 'video' ? `<video src="${esc(m.url)}" muted></video>` : `<img src="${esc(m.url)}">`}
      <button class="mx" data-i="${i}">✕</button></div>`).join('');
    preview.querySelectorAll('.mx').forEach(b => b.onclick = () => { pendingMedia.splice(+b.dataset.i, 1); drawPreview(); });
  };
  const handleFiles = async files => {
    for (const f of [...files].slice(0, 4 - pendingMedia.length)) {
      try { toast('Uploading…'); const d = await uploadFile(f); pendingMedia.push(d); drawPreview(); }
      catch (e) { toast(e.message); }
    }
  };
  $('#pickImg').onclick = () => $('#fileImg').click();
  $('#pickVid').onclick = () => $('#fileVid').click();
  $('#fileImg').onchange = e => handleFiles(e.target.files);
  $('#fileVid').onchange = e => handleFiles(e.target.files);

  $('#postGo').onclick = async () => {
    try {
      const d = await api('/posts', { body: { content: $('#postText').value, media: pendingMedia } });
      $('#postText').value = ''; pendingMedia = []; drawPreview();
      $('#feedList').prepend(postEl(d.post));
      xpToast(d.xp);
    } catch (e) { toast(e.message); }
  };

  const list = $('#feedList');
  async function load(filter) {
    const d = await api('/posts?filter=' + filter);
    list.innerHTML = '';
    if (!d.posts.length) { list.innerHTML = `<div class="empty"><div class="big">🦗</div>Nothing here yet${filter === 'following' ? ' — follow some lifters!' : filter === 'saved' ? ' — save posts with 🔖' : ''}</div>`; return; }
    d.posts.forEach(p => list.appendChild(postEl(p)));
  }
  target.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    target.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    load(t.dataset.f);
  });
  await load('all');
}

function mediaHtml(media) {
  if (!media || !media.length) return '';
  const items = media.map(m => m.type === 'video'
    ? `<video src="${esc(m.url)}" controls preload="metadata"></video>`
    : `<img src="${esc(m.url)}" loading="lazy">`).join('');
  return `<div class="pmedia ${media.length > 1 ? 'g2' : ''}">${items}</div>`;
}

function postEl(p, isEmbedded = false) {
  const u = p.user || { username: '?', name: 'Deleted user' };
  const inner = `
    <div class="phead">
      ${avatarEl(u)}
      <div class="grow">
        <span class="pname" onclick="nav('#/profile/${esc(u.username)}')">${esc(u.name)}</span>
        <span class="pill lvl" style="margin-left:6px">Lv ${u.level ?? '?'}</span>
        <div class="psub">@${esc(u.username)} · ${timeAgo(p.created_at)}</div>
      </div>
    </div>
    ${p.content ? `<div class="pbody">${esc(p.content)}</div>` : ''}
    ${mediaHtml(p.media)}`;
  if (isEmbedded) return el(`<div class="repost-orig">${inner}</div>`);

  const node = el(`<article class="card post" data-id="${p.id}">
    ${p.original ? `<div class="repostlabel">🔁 ${esc(u.name)} shared</div>` : ''}
    ${p.original ? `<div class="phead">${avatarEl(u)}<div class="grow"><span class="pname" onclick="nav('#/profile/${esc(u.username)}')">${esc(u.name)}</span><div class="psub">@${esc(u.username)} · ${timeAgo(p.created_at)}</div></div></div>${p.content ? `<div class="pbody">${esc(p.content)}</div>` : ''}` : inner}
    <div class="pactions">
      <button class="pact ${p.liked ? 'on' : ''}" data-a="like">${p.liked ? '❤️' : '🤍'} <span>${p.like_count}</span></button>
      <button class="pact" data-a="comment">💬 <span>${p.comment_count}</span></button>
      <button class="pact" data-a="share">🔁 <span>${p.share_count}</span></button>
      <button class="pact ${p.saved ? 'on saved' : ''}" data-a="save">${p.saved ? '🔖' : '📑'} Save</button>
    </div>
    <div class="comments hidden"></div>
  </article>`);
  if (p.original) node.querySelector('.pactions').before(postEl(p.original, true));

  node.querySelector('[data-a=like]').onclick = async e => {
    const d = await api(`/posts/${p.id}/like`, { body: {} });
    const btn = e.currentTarget;
    btn.classList.toggle('on', d.post.liked);
    btn.innerHTML = `${d.post.liked ? '❤️' : '🤍'} <span>${d.post.like_count}</span>`;
  };
  node.querySelector('[data-a=save]').onclick = async e => {
    const d = await api(`/posts/${p.id}/save`, { body: {} });
    const btn = e.currentTarget;
    btn.classList.toggle('on', d.saved); btn.classList.toggle('saved', d.saved);
    btn.innerHTML = d.saved ? '🔖 Saved' : '📑 Save';
    toast(d.saved ? 'Saved to your collection 🔖' : 'Removed from saved');
  };
  node.querySelector('[data-a=share]').onclick = () => {
    const m = modal(`<h2>🔁 Share post</h2>
      <div class="field"><label>Add a comment (optional)</label><textarea id="shareText" placeholder="Check this out..."></textarea></div>
      <button class="btn full" id="shareGo">Share to your feed</button>`);
    m.querySelector('#shareGo').onclick = async () => {
      try {
        const d = await api(`/posts/${p.id}/share`, { body: { content: m.querySelector('#shareText').value } });
        m.remove(); xpToast(d.xp); toast('Shared! 🔁');
        const list = $('#feedList'); if (list) list.prepend(postEl(d.post));
      } catch (e2) { toast(e2.message); }
    };
  };
  node.querySelector('[data-a=comment]').onclick = () => toggleComments(node, p);
  return node;
}

async function toggleComments(node, p) {
  const box = node.querySelector('.comments');
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '<div class="muted small">Loading…</div>';
  const d = await api(`/posts/${p.id}/comments`);
  const cEl = c => el(`<div class="comment">${avatarEl(c.user, 'sm')}<div class="cbubble"><b onclick="nav('#/profile/${esc(c.user.username)}')">${esc(c.user.name)}</b> <span class="muted small">${timeAgo(c.created_at)}</span><p>${esc(c.content)}</p></div></div>`);
  box.innerHTML = '';
  d.comments.forEach(c => box.appendChild(cEl(c)));
  const form = el(`<div class="commentbox">${avatarEl(ME, 'sm')}<input placeholder="Add a comment…"><button class="btn small">Send</button></div>`);
  box.appendChild(form);
  const input = form.querySelector('input');
  const submit = async () => {
    if (!input.value.trim()) return;
    try {
      const d2 = await api(`/posts/${p.id}/comments`, { body: { content: input.value } });
      form.before(cEl(d2.comment));
      input.value = ''; xpToast(d2.xp);
      const cnt = node.querySelector('[data-a=comment] span');
      cnt.textContent = +cnt.textContent + 1;
    } catch (e) { toast(e.message); }
  };
  form.querySelector('button').onclick = submit;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  input.focus();
}

// ------------------------------------------------------------- profile
async function renderProfile(target, username) {
  setTitle('Profile');
  const d = await api('/users/' + encodeURIComponent(username));
  const u = d.user;
  const mine = u.id === ME.id;
  const lvlBase = 50 * (u.level - 1) ** 2, lvlNext = 50 * u.level ** 2;
  const pct = Math.min(100, Math.round(((u.xp - lvlBase) / (lvlNext - lvlBase)) * 100));

  target.innerHTML = `
    <div class="profilehead">
      <div class="cover" ${u.cover ? `style="background-image:url('${esc(u.cover)}')"` : ''}></div>
      <div class="profilebody">
        <div class="profiletop">
          ${avatarEl(u, 'lg')}
          <div class="grow"></div>
          ${mine
            ? `<button class="btn ghost small" onclick="nav('#/settings')">✏️ Edit profile</button>`
            : `<button class="btn small" id="followBtn">${u.is_following ? 'Following ✓' : '+ Follow'}</button>
               <button class="btn ghost small" onclick="nav('#/chat/${esc(u.username)}')">💬 Message</button>
               <button class="btn ghost small" id="challengeBtn">⚔️ Challenge</button>`}
        </div>
        <div class="profilename">${esc(u.name)} <span class="pill lvl">Lv ${u.level} · ${esc(u.level_title)}</span> ${u.streak ? `<span class="pill hot">🔥 ${u.streak} day streak</span>` : ''}</div>
        <div class="profilehandle">@${esc(u.username)}</div>
        ${u.bio ? `<div class="profilebio">${esc(u.bio)}</div>` : ''}
        <div class="profilemeta">
          ${u.gym ? `<span>🏋️ ${esc(u.gym.name)}</span>` : ''}
          ${u.city ? `<span>📍 ${esc(u.city)}${u.country ? ', ' + esc(u.country) : ''}</span>` : ''}
          <span>📅 Joined ${new Date(u.created_at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</span>
        </div>
        <div class="fstats">
          <span class="fstat" data-ft="followers"><b>${u.followers}</b> <span class="muted">Followers</span></span>
          <span class="fstat" data-ft="following"><b>${u.following}</b> <span class="muted">Following</span></span>
          <span><b class="lbxp">${u.xp}</b> <span class="muted">XP</span></span>
        </div>
        <div class="levelrow"><span>Level ${u.level} — ${esc(u.level_title)}</span><b>${u.xp} / ${lvlNext} XP</b></div>
        <div class="xpbar"><div class="fill" style="width:${pct}%"></div></div>
        <div class="statgrid">
          <div class="statbox"><div class="v">${u.weight || '—'}</div><div class="k">Bodyweight kg</div></div>
          <div class="statbox"><div class="v">${u.bench || '—'}</div><div class="k">Bench kg</div></div>
          <div class="statbox"><div class="v">${u.squat || '—'}</div><div class="k">Squat kg</div></div>
          <div class="statbox"><div class="v">${u.deadlift || '—'}</div><div class="k">Deadlift kg</div></div>
        </div>
      </div>
    </div>
    ${d.badges.length ? `<div class="card"><b style="display:block;margin-bottom:10px">🎖️ Badges</b><div class="badges">${d.badges.map(b => `<span class="badge" title="${esc(b.desc)}"><span class="bicon">${b.icon}</span>${esc(b.name)}</span>`).join('')}</div></div>` : ''}
    <div class="tabs">
      <button class="tab active" data-t="posts">📸 Posts</button>
      <button class="tab" data-t="workouts">💪 Workouts</button>
    </div>
    <div id="profTab"></div>`;

  const tabBox = $('#profTab');
  const showPosts = () => {
    tabBox.innerHTML = '';
    if (!d.posts.length) { tabBox.innerHTML = `<div class="empty"><div class="big">📭</div>No posts yet</div>`; return; }
    d.posts.forEach(p => tabBox.appendChild(postEl(p)));
  };
  const showWorkouts = () => {
    tabBox.innerHTML = d.workouts.length ? d.workouts.map(workoutCardHtml).join('') : `<div class="empty"><div class="big">🏋️</div>No workouts logged yet</div>`;
  };
  target.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    target.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    t.dataset.t === 'posts' ? showPosts() : showWorkouts();
  });
  showPosts();

  target.querySelectorAll('.fstat').forEach(f => f.onclick = async () => {
    const type = f.dataset.ft;
    const fd = await api(`/users/${encodeURIComponent(u.username)}/follows?type=${type}`);
    modal(`<h2>${type === 'followers' ? '👥 Followers' : '👥 Following'}</h2>
      ${fd.users.length ? fd.users.map(x => `<div class="urow" style="margin-bottom:12px" onclick="document.querySelector('.modalback').remove();nav('#/profile/${esc(x.username)}')">${avatarEl(x)}<div class="uinfo"><b>${esc(x.name)}</b><span>@${esc(x.username)} · Lv ${x.level}</span></div></div>`).join('') : '<div class="muted">Nobody here yet</div>'}`);
  });

  const fb = $('#followBtn');
  if (fb) fb.onclick = async () => {
    const r = await api('/follow/' + u.id, { body: {} });
    fb.textContent = r.following ? 'Following ✓' : '+ Follow';
    toast(r.following ? `Now following ${u.name} 💪` : `Unfollowed ${u.name}`);
  };
  const cb = $('#challengeBtn');
  if (cb) cb.onclick = () => {
    const m = modal(`<h2>⚔️ Challenge ${esc(u.name)}</h2>
      <div class="field"><label>Exercise</label>
        <select id="chEx"><option>Bench Press</option><option>Squat</option><option>Deadlift</option><option>Overhead Press</option><option>Pull-ups</option></select></div>
      <div class="field"><label>Target weight (kg)</label><input id="chW" type="number" min="1" placeholder="100"></div>
      <button class="btn full" id="chGo">Send challenge</button>`);
    m.querySelector('#chGo').onclick = async () => {
      try {
        await api('/challenges', { body: { username: u.username, exercise: m.querySelector('#chEx').value, target: m.querySelector('#chW').value } });
        m.remove(); toast(`Challenge sent to ${u.name} ⚔️`);
      } catch (e) { toast(e.message); }
    };
  };
}

// ------------------------------------------------------------- workouts
function workoutCardHtml(w) {
  const vol = w.entries.reduce((s, e) => s + e.sets * e.reps * e.weight, 0);
  return `<div class="card workoutcard">
    <div style="display:flex;justify-content:space-between;align-items:baseline">
      <span class="wtitle">💪 ${esc(w.title)}</span>
      <span class="muted small">${new Date(w.created_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
    </div>
    <table><tr><th>Exercise</th><th>Sets</th><th>Reps</th><th>Weight</th></tr>
      ${w.entries.map(e => `<tr><td>${esc(e.exercise)}</td><td>${e.sets}</td><td>${e.reps}</td><td>${e.weight ? e.weight + ' kg' : 'BW'}</td></tr>`).join('')}
    </table>
    <div class="muted small" style="margin-top:8px">Total volume: <b style="color:var(--accent2)">${Math.round(vol).toLocaleString()} kg</b></div>
  </div>`;
}

async function renderWorkouts(target) {
  setTitle('Workouts');
  const d = await api('/workouts');
  target.innerHTML = `
    <div class="streakbanner">
      <div class="flame">🔥</div>
      <div><div class="snum">${ME.streak} day streak</div>
      <div class="muted small">${ME.streak ? 'Log a workout today to keep it burning!' : 'Log a workout to start your streak!'}</div></div>
      <div style="flex:1"></div>
      <div style="text-align:right"><div class="snum" style="color:var(--gold)">${ME.xp} XP</div><div class="muted small">Level ${ME.level} · ${esc(ME.level_title)}</div></div>
    </div>
    <div class="card">
      <div class="field"><label>Workout name</label><input id="wTitle" placeholder="Push Day, Leg Day, Full Body…"></div>
      <div class="exhead"><span>Exercise</span><span>Sets</span><span>Reps</span><span>Weight kg</span><span></span></div>
      <div id="exList"></div>
      <div style="display:flex;gap:10px;margin-top:6px">
        <button class="btn ghost small" id="addEx">+ Add exercise</button>
        <div style="flex:1"></div>
        <button class="btn small" id="logGo">Log workout (+50 XP)</button>
      </div>
    </div>
    <h2 style="font-size:16px;margin:22px 0 12px;text-transform:uppercase;letter-spacing:.5px">📜 History</h2>
    <div id="wHistory">${d.workouts.map(workoutCardHtml).join('') || '<div class="empty"><div class="big">🏋️</div>No workouts yet — log your first one above!</div>'}</div>`;

  const exList = $('#exList');
  const addRow = (ex = '', sets = 3, reps = 8, weight = '') => {
    const row = el(`<div class="exrow">
      <input class="e_name" placeholder="Bench Press" value="${esc(ex)}" list="exsugg">
      <input class="e_sets" type="number" min="1" value="${sets}">
      <input class="e_reps" type="number" min="1" value="${reps}">
      <input class="e_w" type="number" min="0" step="2.5" value="${weight}" placeholder="0">
      <button class="exdel">✕</button></div>`);
    row.querySelector('.exdel').onclick = () => row.remove();
    exList.appendChild(row);
  };
  if (!document.getElementById('exsugg')) {
    document.body.appendChild(el(`<datalist id="exsugg">${['Bench Press', 'Squat', 'Deadlift', 'Overhead Press', 'Barbell Row', 'Pull-ups', 'Dips', 'Romanian Deadlift', 'Leg Press', 'Lunges', 'Bicep Curls', 'Lat Pulldown', 'Incline Bench Press', 'Hip Thrust'].map(x => `<option value="${x}">`).join('')}</datalist>`));
  }
  addRow();
  $('#addEx').onclick = () => addRow();
  $('#logGo').onclick = async () => {
    const entries = [...exList.querySelectorAll('.exrow')].map(r => ({
      exercise: r.querySelector('.e_name').value,
      sets: r.querySelector('.e_sets').value,
      reps: r.querySelector('.e_reps').value,
      weight: r.querySelector('.e_w').value,
    }));
    try {
      const d2 = await api('/workouts', { body: { title: $('#wTitle').value, entries } });
      ME = d2.user;
      xpToast(d2.xp);
      toast(`🔥 Streak: ${d2.streak} day${d2.streak > 1 ? 's' : ''}!`);
      const prs = Object.entries(d2.new_prs);
      if (prs.length) setTimeout(() => toast(`🏆 New PR: ${prs.map(([k, v]) => `${k} ${v} kg`).join(', ')}!`), 600);
      await renderWorkouts(target);
    } catch (e) { toast(e.message); }
  };
}

// ------------------------------------------------------------- leaderboard
async function renderLeaderboard(target) {
  setTitle('Leaderboard');
  target.innerHTML = `
    <div class="tabs" id="lbTabs">
      <button class="tab active" data-s="global">🌍 Global</button>
      <button class="tab" data-s="country">🏳️ Country</button>
      <button class="tab" data-s="city">🏙️ City</button>
      <button class="tab" data-s="gym">🏋️ My Gym</button>
      <button class="tab" data-s="friends">👥 Friends</button>
    </div>
    <div class="card" style="padding:0" id="lbList"></div>`;
  const list = $('#lbList');
  const load = async scope => {
    const d = await api('/leaderboard?scope=' + scope);
    if (!d.users.length) {
      const hints = { country: 'Set your country in Settings to see this board.', city: 'Set your city in Settings to see this board.', gym: 'Pick your gym in Settings to see this board.', friends: 'Follow some lifters to build this board.' };
      list.innerHTML = `<div class="empty"><div class="big">🏜️</div>${hints[scope] || 'Nobody here yet.'}</div>`;
      return;
    }
    list.innerHTML = d.users.map((u, i) => `
      <div class="lbrow ${i < 3 ? 'top' + (i + 1) : ''} ${u.id === ME.id ? 'isme' : ''}" onclick="nav('#/profile/${esc(u.username)}')">
        <span class="lbrank">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</span>
        ${avatarEl(u)}
        <div class="uinfo" style="flex:1;min-width:0"><b>${esc(u.name)}</b><span class="muted small">@${esc(u.username)} · Lv ${u.level} ${u.streak ? `· 🔥${u.streak}` : ''}</span></div>
        <span class="lbxp">${u.xp.toLocaleString()} XP</span>
      </div>`).join('');
  };
  $('#lbTabs').querySelectorAll('.tab').forEach(t => t.onclick = () => {
    $('#lbTabs').querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    load(t.dataset.s);
  });
  await load('global');
}

// ------------------------------------------------------------- map
async function renderMap(target) {
  setTitle('Map');
  const d = await api('/map');
  target.parentElement.classList.add('wide');
  target.innerHTML = `
    <div class="mapwrap">
      <canvas class="mapcanvas" id="mapCanvas"></canvas>
      <div class="mapzoom"><button id="zin">+</button><button id="zout">−</button><button id="zhome" title="Reset view">⌂</button></div>
      <div class="maplegend">
        <span><span class="dot" style="background:var(--accent)"></span>Gyms</span>
        <span><span class="dot" style="background:var(--green)"></span>Friends</span>
        <span><span class="dot" style="background:var(--blue)"></span>Partners</span>
        <span><span class="dot" style="background:var(--gold)"></span>You</span>
      </div>
    </div>
    <div class="tabs">
      <button class="tab active" data-t="events">📅 Events</button>
      <button class="tab" data-t="gyms">🏋️ Nearby Gyms</button>
      <button class="tab" data-t="friends">👥 Nearby Friends</button>
      <button class="tab" data-t="partners">🤝 Workout Partners</button>
    </div>
    <div id="mapTab"></div>`;

  // ---- canvas map (equirectangular, pan/zoom)
  const canvas = $('#mapCanvas');
  const ctx = canvas.getContext('2d');
  let view = { lon: -40, lat: 38, scale: 3.2 };   // scale = px per degree
  if (ME.lat != null) { view.lon = ME.lng; view.lat = ME.lat; view.scale = 40; }
  else if (d.gyms.length) { view.lon = d.gyms[0].lng; view.lat = d.gyms[0].lat; view.scale = 6; }
  const home = { ...view };

  const markers = [
    ...d.gyms.map(g => ({ lat: g.lat, lng: g.lng, color: '#ff4d2e', label: g.name, sub: `${g.city} · ${g.members} member${g.members === 1 ? '' : 's'}`, r: 8, kind: 'gym' })),
    ...d.friends.map(u => ({ lat: u.lat, lng: u.lng, color: '#2ee6a8', label: u.name, sub: '@' + u.username + ' · Lv ' + u.level, r: 7, kind: 'user', username: u.username })),
    ...d.partners.filter(u2 => !d.friends.some(f => f.id === u2.id)).map(u => ({ lat: u.lat, lng: u.lng, color: '#4da3ff', label: u.name, sub: '@' + u.username + ' · open to partners', r: 7, kind: 'user', username: u.username })),
  ];
  if (ME.lat != null) markers.push({ lat: ME.lat, lng: ME.lng, color: '#ffc93c', label: 'You', sub: '@' + ME.username, r: 8, kind: 'me' });

  const proj = (lat, lng) => {
    const w = canvas.width / devicePixelRatio, h = canvas.height / devicePixelRatio;
    return [w / 2 + (lng - view.lon) * view.scale, h / 2 - (lat - view.lat) * view.scale];
  };

  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * devicePixelRatio; canvas.height = h * devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.fillStyle = '#0a1420'; ctx.fillRect(0, 0, w, h);
    // graticule
    ctx.strokeStyle = 'rgba(120,140,180,0.10)'; ctx.lineWidth = 1;
    const step = view.scale > 20 ? 1 : view.scale > 6 ? 5 : 15;
    const lonSpan = w / 2 / view.scale, latSpan = h / 2 / view.scale;
    for (let lon = Math.floor((view.lon - lonSpan) / step) * step; lon <= view.lon + lonSpan; lon += step) {
      const [x] = proj(0, lon); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let lat = Math.floor((view.lat - latSpan) / step) * step; lat <= view.lat + latSpan; lat += step) {
      const [, y] = proj(lat, 0); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    // equator + prime meridian slightly brighter
    ctx.strokeStyle = 'rgba(120,140,180,0.22)';
    let [ex, ey] = proj(0, view.lon); void ex;
    ctx.beginPath(); ctx.moveTo(0, proj(0, 0)[1]); ctx.lineTo(w, ey = proj(0, 0)[1]); ctx.stroke();
    const [pmx] = proj(0, 0); ctx.beginPath(); ctx.moveTo(pmx, 0); ctx.lineTo(pmx, h); ctx.stroke();
    // markers
    for (const m of markers) {
      const [x, y] = proj(m.lat, m.lng);
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
      ctx.beginPath(); ctx.arc(x, y, m.r + 4, 0, 7); ctx.fillStyle = m.color + '33'; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, m.r, 0, 7); ctx.fillStyle = m.color; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#0a1420'; ctx.stroke();
      if (view.scale > 12) {
        ctx.fillStyle = '#eef1f7'; ctx.font = '700 12px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(m.label, x, y - m.r - 8);
      }
    }
  }

  let popup = null;
  const closePopup = () => { if (popup) { popup.remove(); popup = null; } };
  function markerAt(px, py) {
    let best = null, bestD = 18;
    for (const m of markers) {
      const [x, y] = proj(m.lat, m.lng);
      const dist = Math.hypot(x - px, y - py);
      if (dist < bestD) { best = m; bestD = dist; }
    }
    return best;
  }

  let dragging = false, moved = false, last = null;
  canvas.addEventListener('pointerdown', e => { dragging = true; moved = false; last = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - last[0], dy = e.clientY - last[1];
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    view.lon -= dx / view.scale; view.lat += dy / view.scale;
    view.lat = Math.max(-85, Math.min(85, view.lat));
    last = [e.clientX, e.clientY];
    closePopup(); draw();
  });
  canvas.addEventListener('pointerup', e => {
    dragging = false;
    if (moved) return;
    const rect = canvas.getBoundingClientRect();
    const m = markerAt(e.clientX - rect.left, e.clientY - rect.top);
    closePopup();
    if (!m) return;
    const [x, y] = proj(m.lat, m.lng);
    popup = el(`<div class="mappopup" style="left:${x}px;top:${y}px">
      <b>${esc(m.label)}</b><div class="muted small">${esc(m.sub)}</div>
      ${m.kind === 'user' ? `<button class="btn small" style="margin-top:8px" onclick="nav('#/profile/${esc(m.username)}')">View profile</button>` : ''}
    </div>`);
    canvas.parentElement.appendChild(popup);
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    view.scale = Math.max(1.2, Math.min(400, view.scale * (e.deltaY < 0 ? 1.25 : 0.8)));
    closePopup(); draw();
  }, { passive: false });
  $('#zin').onclick = () => { view.scale = Math.min(400, view.scale * 1.5); closePopup(); draw(); };
  $('#zout').onclick = () => { view.scale = Math.max(1.2, view.scale / 1.5); closePopup(); draw(); };
  $('#zhome').onclick = () => { view = { ...home }; closePopup(); draw(); };
  new ResizeObserver(draw).observe(canvas);
  draw();

  // ---- tabs under the map
  const tabBox = $('#mapTab');
  const dist = (a, b) => {
    if (a.lat == null || b.lat == null) return Infinity;
    const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLon = (b.lng - a.lng) * Math.PI / 180;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };
  const km = v => v === Infinity ? '' : v < 1 ? '· <1 km away' : `· ${Math.round(v)} km away`;
  const meLoc = { lat: ME.lat, lng: ME.lng };
  const noLocNote = ME.lat == null ? `<div class="card muted small">📍 Set your location in Settings to see distances and appear on the map.</div>` : '';

  const flyTo = (lat, lng) => { view.lon = lng; view.lat = lat; view.scale = 60; closePopup(); draw(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  window._flyTo = flyTo;

  const draws = {
    events: () => {
      const createBtn = `<button class="btn small" id="evCreate" style="margin-bottom:14px">+ Create event</button>`;
      tabBox.innerHTML = createBtn + (d.events.length ? d.events.map(ev => {
        const dt = new Date(ev.date + 'T12:00');
        return `<div class="card eventcard">
          <div class="eventdate"><div class="d">${dt.getDate()}</div><div class="m">${dt.toLocaleDateString(undefined, { month: 'short' })}</div></div>
          <div style="flex:1">
            <b>${esc(ev.title)}</b>
            <div class="muted small">🏋️ ${esc(ev.gym_name)}, ${esc(ev.gym_city)} · by @${esc(ev.creator.username)} · ${ev.attendees} going</div>
            ${ev.description ? `<div class="small" style="margin-top:4px">${esc(ev.description)}</div>` : ''}
          </div>
          <div style="display:flex;flex-direction:column;gap:6px">
            <button class="btn small ${ev.joined ? 'ghost' : ''}" data-ev="${ev.id}">${ev.joined ? 'Going ✓' : 'Join'}</button>
            <button class="btn ghost small" onclick="_flyTo(${ev.lat},${ev.lng})">📍 Map</button>
          </div>
        </div>`;
      }).join('') : '<div class="empty"><div class="big">📅</div>No upcoming events — create one!</div>');
      tabBox.querySelectorAll('[data-ev]').forEach(b => b.onclick = async () => {
        const r = await api(`/events/${b.dataset.ev}/join`, { body: {} });
        b.textContent = r.joined ? 'Going ✓' : 'Join';
        b.classList.toggle('ghost', r.joined);
        toast(r.joined ? 'See you there! 📅' : 'Removed from event');
      });
      $('#evCreate').onclick = () => {
        const m = modal(`<h2>📅 Create event</h2>
          <div class="field"><label>Title</label><input id="evT" placeholder="Saturday squad session"></div>
          <div class="field"><label>Gym</label><select id="evG">${d.gyms.map(g => `<option value="${g.id}">${esc(g.name)} — ${esc(g.city)}</option>`).join('')}</select></div>
          <div class="field"><label>Date</label><input id="evD" type="date" min="${new Date().toISOString().slice(0, 10)}"></div>
          <div class="field"><label>Description</label><textarea id="evDesc" placeholder="What's the plan?"></textarea></div>
          <button class="btn full" id="evGo">Create event</button>`);
        m.querySelector('#evGo').onclick = async () => {
          try {
            await api('/events', { body: { title: m.querySelector('#evT').value, gym_id: m.querySelector('#evG').value, date: m.querySelector('#evD').value, description: m.querySelector('#evDesc').value } });
            m.remove(); toast('Event created! 📅'); renderMap(target);
          } catch (e) { toast(e.message); }
        };
      };
    },
    gyms: () => {
      const sorted = [...d.gyms].sort((a, b) => dist(meLoc, a) - dist(meLoc, b));
      tabBox.innerHTML = noLocNote + sorted.map(g => `
        <div class="card" style="display:flex;align-items:center;gap:14px">
          <div style="font-size:28px">🏋️</div>
          <div style="flex:1"><b>${esc(g.name)}</b><div class="muted small">${esc(g.city)}, ${esc(g.country)} · ${g.members} member${g.members === 1 ? '' : 's'} ${km(dist(meLoc, g))}</div></div>
          <button class="btn ghost small" onclick="_flyTo(${g.lat},${g.lng})">📍 Map</button>
        </div>`).join('');
    },
    friends: () => {
      const rows = d.friends.sort((a, b) => dist(meLoc, a) - dist(meLoc, b));
      tabBox.innerHTML = noLocNote + (rows.length ? rows.map(u => `
        <div class="card urow" onclick="nav('#/profile/${esc(u.username)}')">${avatarEl(u)}
          <div class="uinfo"><b>${esc(u.name)}</b><span>@${esc(u.username)} · Lv ${u.level} ${km(dist(meLoc, u))}</span></div>
          ${u.open_to_partners ? '<span class="pill" style="color:var(--blue)">🤝 open to partners</span>' : ''}
        </div>`).join('') : '<div class="empty"><div class="big">👥</div>Friends you follow will appear here once they set a location.</div>');
    },
    partners: () => {
      const rows = d.partners.sort((a, b) => dist(meLoc, a) - dist(meLoc, b));
      tabBox.innerHTML = noLocNote + `<div class="card small muted">🤝 Lifters near you who flagged themselves open to training partners. Turn this on for yourself in Settings.</div>` +
        (rows.length ? rows.map(u => `
        <div class="card urow" onclick="nav('#/profile/${esc(u.username)}')">${avatarEl(u)}
          <div class="uinfo"><b>${esc(u.name)}</b><span>@${esc(u.username)} · Lv ${u.level} ${u.gym ? '· 🏋️ ' + esc(u.gym.name) : ''} ${km(dist(meLoc, u))}</span></div>
          <button class="btn small" onclick="event.stopPropagation();nav('#/chat/${esc(u.username)}')">💬 Message</button>
        </div>`).join('') : '<div class="empty"><div class="big">🤝</div>No partners available yet.</div>');
    },
  };
  target.querySelectorAll('.tabs .tab').forEach(t => t.onclick = () => {
    target.querySelectorAll('.tabs .tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    draws[t.dataset.t]();
  });
  draws.events();
}

// ------------------------------------------------------------- chat
let chatPoll = null;
async function renderChat(target, withUser) {
  setTitle('Chat');
  clearInterval(chatPoll);
  const d = await api('/conversations');
  target.innerHTML = `
    <div class="chatlayout ${withUser ? 'inchat' : ''}">
      <div class="convlist" id="convList">
        ${d.conversations.length ? d.conversations.map(c => `
          <div class="convrow ${withUser === c.user.username ? 'active' : ''}" onclick="nav('#/chat/${esc(c.user.username)}')">
            ${avatarEl(c.user)}
            <div class="cinfo"><b>${esc(c.user.name)}</b><span>${c.last.from_me ? 'You: ' : ''}${c.last.image ? '📷 Photo' : esc(c.last.content)}</span></div>
            ${c.unread ? `<span class="unreaddot">${c.unread}</span>` : `<span class="muted small">${timeAgo(c.last.created_at)}</span>`}
          </div>`).join('') : '<div class="empty" style="padding:30px 16px"><div class="big">💬</div>No conversations yet.<br>Find lifters via search or the map!</div>'}
      </div>
      <div class="chatpane" id="chatPane">
        <div class="empty" style="margin:auto"><div class="big">💬</div>Pick a conversation</div>
      </div>
    </div>`;
  if (!withUser) return;

  const pane = $('#chatPane');
  async function loadThread(scrollDown) {
    const t = await api('/messages/' + encodeURIComponent(withUser));
    const msgs = t.messages.map(m => `
      <div class="bubble ${m.from_me ? 'mine' : ''}">
        ${m.content ? esc(m.content) : ''}
        ${m.image ? `<img src="${esc(m.image)}" loading="lazy">` : ''}
        <span class="btime">${timeAgo(m.created_at)}</span>
      </div>`).join('');
    const existing = pane.querySelector('.chatmsgs');
    if (existing && existing.dataset.count === String(t.messages.length)) return;
    pane.innerHTML = `
      <div class="chathead" onclick="nav('#/profile/${esc(t.user.username)}')">
        ${avatarEl(t.user)}<div><b>${esc(t.user.name)}</b><div class="muted small">@${esc(t.user.username)}</div></div>
      </div>
      <div class="chatmsgs" data-count="${t.messages.length}">${msgs || '<div class="empty">Say hi! 👋</div>'}</div>
      <div class="chatinput">
        <button class="mediabtn" id="chatImg">📷</button>
        <input type="file" id="chatFile" accept="image/*" class="hidden">
        <input type="text" id="chatText" placeholder="Message…" autocomplete="off">
        <button class="btn small" id="chatSend">Send</button>
      </div>`;
    const box = pane.querySelector('.chatmsgs');
    box.scrollTop = box.scrollHeight;
    const input = $('#chatText');
    const send = async (image = '') => {
      const content = input.value.trim();
      if (!content && !image) return;
      input.value = '';
      try { await api('/messages/' + encodeURIComponent(withUser), { body: { content, image } }); await loadThread(true); }
      catch (e) { toast(e.message); }
    };
    $('#chatSend').onclick = () => send();
    input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
    $('#chatImg').onclick = () => $('#chatFile').click();
    $('#chatFile').onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      try { toast('Uploading…'); const up = await uploadFile(f); await send(up.url); }
      catch (e2) { toast(e2.message); }
    };
    input.focus();
  }
  await loadThread(true);
  chatPoll = setInterval(() => { if (location.hash.includes('/chat/')) loadThread(false); else clearInterval(chatPoll); }, 4000);
}

// ------------------------------------------------------------- notifications
async function renderNotifications(target) {
  setTitle('Alerts');
  const d = await api('/notifications');
  const icons = { like: '❤️', comment: '💬', follow: '➕', share: '🔁', challenge: '⚔️', challenge_accept: '🤝', event: '📅' };
  const pending = d.challenges.filter(c => c.status === 'pending' && c.to_username === ME.username);
  target.innerHTML = `
    ${pending.map(c => `
      <div class="card challengecard" data-ch="${c.id}">
        <b>⚔️ Challenge from ${esc(c.from_name)}</b>
        <div class="muted" style="margin:6px 0 12px">${esc(c.exercise)} — hit <b style="color:var(--blue)">${c.target} kg</b>. Accept for +25 XP each!</div>
        <div style="display:flex;gap:10px">
          <button class="btn small" data-r="1">Accept ⚔️</button>
          <button class="btn ghost small" data-r="0">Decline</button>
        </div>
      </div>`).join('')}
    <div class="card" style="padding:0">
      ${d.notifications.length ? d.notifications.map(n => `
        <div class="notifrow ${n.read ? '' : 'unread'}" ${n.actor ? `onclick="nav('#/profile/${esc(n.actor.username)}')"` : ''}>
          <span class="notificon">${icons[n.type] || '🔔'}</span>
          ${n.actor ? avatarEl(n.actor, 'sm') : ''}
          <div style="flex:1"><b>${n.actor ? esc(n.actor.name) : 'GymNet'}</b> <span class="muted">${esc(n.text)}</span></div>
          <span class="muted small">${timeAgo(n.created_at)}</span>
        </div>`).join('') : '<div class="empty"><div class="big">🔕</div>No notifications yet</div>'}
    </div>
    ${d.challenges.length ? `
      <h2 style="font-size:15px;margin:20px 0 10px;text-transform:uppercase;letter-spacing:.5px">⚔️ Challenge history</h2>
      <div class="card" style="padding:0">
        ${d.challenges.map(c => `
          <div class="notifrow">
            <span class="notificon">${c.status === 'accepted' ? '🤝' : c.status === 'declined' ? '🚫' : '⏳'}</span>
            <div style="flex:1"><b>@${esc(c.from_username)}</b> → <b>@${esc(c.to_username)}</b> <span class="muted">${esc(c.exercise)} ${c.target} kg</span></div>
            <span class="pill">${c.status}</span>
          </div>`).join('')}
      </div>` : ''}`;

  target.querySelectorAll('[data-ch]').forEach(card => {
    card.querySelectorAll('[data-r]').forEach(b => b.onclick = async () => {
      const accept = b.dataset.r === '1';
      await api(`/challenges/${card.dataset.ch}/respond`, { body: { accept } });
      card.remove();
      if (accept) { xpToast(25); toast('Challenge accepted — go get it! ⚔️'); }
    });
  });
  await api('/notifications/read', { body: {} });
  refreshStatus();
}

// ------------------------------------------------------------- settings
async function renderSettings(target) {
  setTitle('Settings');
  if (!GYMS_CACHE) GYMS_CACHE = (await api('/gyms')).gyms;
  const u = (await api('/me')).user;
  target.innerHTML = `
    <div class="card">
      <h2 style="font-size:16px;margin-bottom:16px">👤 Profile</h2>
      <div style="display:flex;gap:16px;align-items:center;margin-bottom:16px">
        <div id="avPrev">${avatarEl(u, 'lg')}</div>
        <div>
          <button class="btn ghost small" id="pickAv">📷 Profile photo</button>
          <button class="btn ghost small" id="pickCov">🖼️ Cover photo</button>
          <input type="file" id="fileAv" accept="image/*" class="hidden">
          <input type="file" id="fileCov" accept="image/*" class="hidden">
          <div class="muted small" id="covNote" style="margin-top:6px">${u.cover ? 'Cover photo set ✓' : 'No cover photo yet'}</div>
        </div>
      </div>
      <div class="field"><label>Name</label><input id="s_name" value="${esc(u.name)}"></div>
      <div class="field"><label>Bio</label><textarea id="s_bio">${esc(u.bio)}</textarea></div>
      <div class="fieldrow">
        <div class="field"><label>City</label><input id="s_city" value="${esc(u.city)}"></div>
        <div class="field"><label>Country</label><input id="s_country" value="${esc(u.country)}"></div>
      </div>
      <div class="field"><label>Home gym</label>
        <select id="s_gym"><option value="">— No gym —</option>
          ${GYMS_CACHE.map(g => `<option value="${g.id}" ${u.gym && u.gym.id === g.id ? 'selected' : ''}>${esc(g.name)} — ${esc(g.city)}</option>`).join('')}
        </select></div>
    </div>
    <div class="card">
      <h2 style="font-size:16px;margin-bottom:16px">🏋️ Stats (kg)</h2>
      <div class="fieldrow4">
        <div class="field"><label>Bodyweight</label><input id="s_weight" type="number" step="0.5" value="${u.weight || ''}"></div>
        <div class="field"><label>Bench</label><input id="s_bench" type="number" step="2.5" value="${u.bench || ''}"></div>
        <div class="field"><label>Squat</label><input id="s_squat" type="number" step="2.5" value="${u.squat || ''}"></div>
        <div class="field"><label>Deadlift</label><input id="s_deadlift" type="number" step="2.5" value="${u.deadlift || ''}"></div>
      </div>
    </div>
    <div class="card">
      <h2 style="font-size:16px;margin-bottom:16px">📍 Location &amp; partners</h2>
      <p class="muted small" style="margin-bottom:12px">Your location places you on the map so friends and nearby lifters can find you. Leave blank to stay hidden.</p>
      <div class="fieldrow">
        <div class="field"><label>Latitude</label><input id="s_lat" type="number" step="0.0001" value="${u.lat ?? ''}" placeholder="40.7128"></div>
        <div class="field"><label>Longitude</label><input id="s_lng" type="number" step="0.0001" value="${u.lng ?? ''}" placeholder="-74.0060"></div>
      </div>
      <button class="btn ghost small" id="useLoc" style="margin-bottom:14px">📡 Use my current location</button>
      <div class="field"><label style="display:flex;align-items:center;gap:10px;cursor:pointer;text-transform:none;font-size:14px;color:var(--text)">
        <input type="checkbox" id="s_partners" style="width:auto" ${u.open_to_partners ? 'checked' : ''}> 🤝 I'm open to workout partners
      </label></div>
    </div>
    <button class="btn full" id="saveGo">Save changes</button>`;

  let avatar = u.avatar, cover = u.cover;
  $('#pickAv').onclick = () => $('#fileAv').click();
  $('#pickCov').onclick = () => $('#fileCov').click();
  $('#fileAv').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { toast('Uploading…'); const d = await uploadFile(f); avatar = d.url; $('#avPrev').innerHTML = avatarEl({ ...u, avatar }, 'lg'); }
    catch (e2) { toast(e2.message); }
  };
  $('#fileCov').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { toast('Uploading…'); const d = await uploadFile(f); cover = d.url; $('#covNote').textContent = 'Cover photo set ✓'; }
    catch (e2) { toast(e2.message); }
  };
  $('#useLoc').onclick = () => {
    if (!navigator.geolocation) return toast('Geolocation not available');
    navigator.geolocation.getCurrentPosition(
      pos => { $('#s_lat').value = pos.coords.latitude.toFixed(4); $('#s_lng').value = pos.coords.longitude.toFixed(4); toast('Location filled in 📍'); },
      () => toast('Could not get location — enter it manually'));
  };
  $('#saveGo').onclick = async () => {
    try {
      const d = await api('/profile', { method: 'PUT', body: {
        name: $('#s_name').value, bio: $('#s_bio').value, city: $('#s_city').value, country: $('#s_country').value,
        gym_id: $('#s_gym').value || null,
        weight: $('#s_weight').value, bench: $('#s_bench').value, squat: $('#s_squat').value, deadlift: $('#s_deadlift').value,
        lat: $('#s_lat').value, lng: $('#s_lng').value,
        open_to_partners: $('#s_partners').checked, avatar, cover,
      } });
      ME = d.user;
      toast('Profile saved ✓');
      nav('#/profile');
    } catch (e) { toast(e.message); }
  };
}

// ------------------------------------------------------------- boot
route();
