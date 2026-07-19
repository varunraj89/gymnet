// GymNet — fitness social network. Zero-dependency Node.js server (Node 22+ / built-in SQLite).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR || ROOT;   // point at a persistent disk in production
const UPLOADS = path.join(DATA, 'uploads');
const PORT = process.env.PORT || 3000;
const MAX_BODY = 30 * 1024 * 1024;

fs.mkdirSync(UPLOADS, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'gymnet.db'));
db.exec('PRAGMA journal_mode = WAL');

// ---------------------------------------------------------------- schema
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL, salt TEXT NOT NULL,
  name TEXT NOT NULL, bio TEXT DEFAULT '',
  gym_id INTEGER, city TEXT DEFAULT '', country TEXT DEFAULT '',
  weight REAL DEFAULT 0, bench REAL DEFAULT 0, squat REAL DEFAULT 0, deadlift REAL DEFAULT 0,
  avatar TEXT DEFAULT '', cover TEXT DEFAULT '',
  lat REAL, lng REAL, open_to_partners INTEGER DEFAULT 0,
  xp INTEGER DEFAULT 0, streak INTEGER DEFAULT 0, last_workout_date TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reset_codes (user_id INTEGER PRIMARY KEY, code TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS follows (follower_id INTEGER NOT NULL, followee_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (follower_id, followee_id));
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL, content TEXT DEFAULT '', media TEXT DEFAULT '[]',
  repost_of INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS likes (user_id INTEGER NOT NULL, post_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, post_id));
CREATE TABLE IF NOT EXISTS saves (user_id INTEGER NOT NULL, post_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, post_id));
CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL, user_id INTEGER NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS workouts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT DEFAULT '', entries TEXT DEFAULT '[]', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS gyms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, city TEXT NOT NULL, country TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, creator_id INTEGER NOT NULL, gym_id INTEGER NOT NULL,
  title TEXT NOT NULL, description TEXT DEFAULT '', date TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS event_attendees (event_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (event_id, user_id));
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL,
  content TEXT DEFAULT '', image TEXT DEFAULT '', read INTEGER DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, actor_id INTEGER,
  type TEXT NOT NULL, ref_id INTEGER, text TEXT DEFAULT '', read INTEGER DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL,
  exercise TEXT NOT NULL, target REAL NOT NULL, status TEXT DEFAULT 'pending', created_at INTEGER NOT NULL
);
`);

// ---------------------------------------------------------------- helpers
const q = sql => db.prepare(sql);
const now = () => Date.now();
const today = () => new Date().toISOString().slice(0, 10);
const rid = () => Number(crypto.randomBytes(4).readUInt32BE(0));

function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function newToken() { return crypto.randomBytes(32).toString('hex'); }

function levelFor(xp) { return Math.floor(Math.sqrt(Math.max(0, xp) / 50)) + 1; }
const LEVEL_TITLES = ['Rookie', 'Beginner', 'Intermediate', 'Solid', 'Advanced', 'Strong', 'Elite', 'Beast', 'Freak', 'Legend'];
function levelTitle(lvl) { return LEVEL_TITLES[Math.min(lvl, LEVEL_TITLES.length) - 1]; }

function effStreak(u) {
  if (!u.last_workout_date) return 0;
  const d = new Date(today());
  const yesterday = new Date(d.getTime() - 86400000).toISOString().slice(0, 10);
  return (u.last_workout_date === today() || u.last_workout_date === yesterday) ? u.streak : 0;
}

function addXp(userId, amount) {
  q('UPDATE users SET xp = MAX(0, xp + ?) WHERE id = ?').run(amount, userId);
}

function notify(userId, actorId, type, refId, text) {
  if (userId === actorId) return;
  q('INSERT INTO notifications (user_id, actor_id, type, ref_id, text, read, created_at) VALUES (?,?,?,?,?,0,?)')
    .run(userId, actorId, type, refId ?? null, text || '', now());
}

function publicUser(u, viewerId) {
  if (!u) return null;
  const gym = u.gym_id ? q('SELECT * FROM gyms WHERE id = ?').get(u.gym_id) : null;
  const followers = q('SELECT COUNT(*) c FROM follows WHERE followee_id = ?').get(u.id).c;
  const following = q('SELECT COUNT(*) c FROM follows WHERE follower_id = ?').get(u.id).c;
  const lvl = levelFor(u.xp);
  return {
    id: u.id, username: u.username, name: u.name, bio: u.bio,
    gym: gym ? { id: gym.id, name: gym.name, city: gym.city } : null,
    city: u.city, country: u.country,
    weight: u.weight, bench: u.bench, squat: u.squat, deadlift: u.deadlift,
    avatar: u.avatar, cover: u.cover, lat: u.lat, lng: u.lng,
    open_to_partners: !!u.open_to_partners,
    xp: u.xp, level: lvl, level_title: levelTitle(lvl), streak: effStreak(u),
    followers, following,
    is_following: viewerId ? !!q('SELECT 1 x FROM follows WHERE follower_id = ? AND followee_id = ?').get(viewerId, u.id) : false,
    created_at: u.created_at,
  };
}

function badgesFor(u) {
  const workouts = q('SELECT COUNT(*) c FROM workouts WHERE user_id = ?').get(u.id).c;
  const posts = q('SELECT COUNT(*) c FROM posts WHERE user_id = ?').get(u.id).c;
  const followers = q('SELECT COUNT(*) c FROM follows WHERE followee_id = ?').get(u.id).c;
  const streak = effStreak(u);
  const total = u.bench + u.squat + u.deadlift;
  const out = [];
  if (workouts >= 1) out.push({ icon: '🏋️', name: 'First Rep', desc: 'Logged your first workout' });
  if (streak >= 7) out.push({ icon: '🔥', name: 'Week Warrior', desc: '7-day workout streak' });
  if (streak >= 30) out.push({ icon: '⚡', name: 'Iron Month', desc: '30-day workout streak' });
  if (u.bench >= 100) out.push({ icon: '🏆', name: 'Century Bench', desc: 'Bench press 100 kg+' });
  if (u.squat >= 140) out.push({ icon: '🦵', name: 'Squat Beast', desc: 'Squat 140 kg+' });
  if (u.deadlift >= 180) out.push({ icon: '☠️', name: 'Deadlift Demon', desc: 'Deadlift 180 kg+' });
  if (total >= 500) out.push({ icon: '👑', name: '500 Club', desc: 'Combined total of 500 kg+' });
  if (followers >= 10) out.push({ icon: '⭐', name: 'Crowd Favorite', desc: '10+ followers' });
  if (posts >= 10) out.push({ icon: '📸', name: 'Content Machine', desc: '10+ posts' });
  if (levelFor(u.xp) >= 10) out.push({ icon: '🎖️', name: 'Level 10 Legend', desc: 'Reached level 10' });
  return out;
}

function postOut(p, viewerId, depth = 0) {
  const u = q('SELECT * FROM users WHERE id = ?').get(p.user_id);
  const out = {
    id: p.id, content: p.content, media: JSON.parse(p.media || '[]'), created_at: p.created_at,
    user: u ? { id: u.id, username: u.username, name: u.name, avatar: u.avatar, level: levelFor(u.xp) } : null,
    like_count: q('SELECT COUNT(*) c FROM likes WHERE post_id = ?').get(p.id).c,
    comment_count: q('SELECT COUNT(*) c FROM comments WHERE post_id = ?').get(p.id).c,
    share_count: q('SELECT COUNT(*) c FROM posts WHERE repost_of = ?').get(p.id).c,
    liked: viewerId ? !!q('SELECT 1 x FROM likes WHERE user_id = ? AND post_id = ?').get(viewerId, p.id) : false,
    saved: viewerId ? !!q('SELECT 1 x FROM saves WHERE user_id = ? AND post_id = ?').get(viewerId, p.id) : false,
    original: null,
  };
  if (p.repost_of && depth === 0) {
    const orig = q('SELECT * FROM posts WHERE id = ?').get(p.repost_of);
    if (orig) out.original = postOut(orig, viewerId, 1);
  }
  return out;
}

function commentOut(c) {
  const u = q('SELECT id, username, name, avatar FROM users WHERE id = ?').get(c.user_id);
  return { id: c.id, content: c.content, created_at: c.created_at, user: u };
}

// ---------------------------------------------------------------- seed data
function seed() {
  if (q('SELECT COUNT(*) c FROM users').get().c > 0) return;
  const GYMS = [
    ['Iron Temple', 'New York', 'USA', 40.7178, -74.0031],
    ['Forge Fitness', 'New York', 'USA', 40.7306, -73.9866],
    ['Venice Power House', 'Los Angeles', 'USA', 33.985, -118.4695],
    ['Golden Barbell', 'Los Angeles', 'USA', 34.0522, -118.2537],
    ['The Yard', 'London', 'UK', 51.5074, -0.1278],
    ['Deadlift District', 'London', 'UK', 51.5225, -0.1004],
    ['Berlin Strength Lab', 'Berlin', 'Germany', 52.52, 13.405],
    ['Tokyo Lifting Club', 'Tokyo', 'Japan', 35.6812, 139.7671],
  ];
  const insGym = q('INSERT INTO gyms (name, city, country, lat, lng) VALUES (?,?,?,?,?)');
  for (const g of GYMS) insGym.run(...g);

  const salt = crypto.randomBytes(16).toString('hex');
  const pw = hashPw('demo123', salt);
  // username, email, name, bio, gym, city, country, weight, bench, squat, deadlift, lat, lng, partners, xp, streak
  const USERS = [
    ['demo', 'demo@gymnet.app', 'Alex Carter', 'Chasing a 3-plate bench. NYC lifter. 🏙️', 1, 'New York', 'USA', 82, 95, 130, 170, 40.719, -74.002, 1, 780, 4],
    ['sara_lifts', 'sara@gymnet.app', 'Sara Kim', 'Powerlifting + espresso. Coach at Forge.', 2, 'New York', 'USA', 63, 72, 120, 150, 40.731, -73.985, 1, 2450, 12],
    ['mike_bench', 'mike@gymnet.app', 'Mike Torres', 'Bench specialist. Ask me about arch setup.', 1, 'New York', 'USA', 96, 142, 160, 200, 40.716, -74.005, 0, 3100, 21],
    ['emma_squat', 'emma@gymnet.app', 'Emma Wright', 'Squats before sunrise. LA girl. ☀️', 3, 'Los Angeles', 'USA', 60, 55, 125, 140, 33.986, -118.468, 1, 1900, 9],
    ['deadlift_dan', 'dan@gymnet.app', 'Dan Kowalski', 'If the bar ain\'t bendin\' you\'re just pretendin\'.', 4, 'Los Angeles', 'USA', 104, 130, 190, 260, 34.051, -118.255, 0, 4200, 35],
    ['yuki_gains', 'yuki@gymnet.app', 'Yuki Tanaka', 'Tokyo lifting club. Clean technique > ego.', 8, 'Tokyo', 'Japan', 70, 90, 135, 175, 35.682, 139.766, 1, 2800, 15],
    ['lena_strong', 'lena@gymnet.app', 'Lena Fischer', 'Strongwoman in training. Berlin. 🇩🇪', 7, 'Berlin', 'Germany', 74, 80, 145, 185, 52.521, 13.404, 1, 2100, 8],
    ['oli_ohp', 'oli@gymnet.app', 'Oliver Bennett', 'Overhead press enjoyer. London.', 5, 'London', 'UK', 85, 105, 150, 190, 51.508, -0.127, 0, 1600, 6],
    ['pri_power', 'pri@gymnet.app', 'Priya Sharma', 'First comp in September! 🎯', 6, 'London', 'UK', 58, 50, 100, 130, 51.523, -0.101, 1, 950, 3],
    ['carlos_cut', 'carlos@gymnet.app', 'Carlos Mendez', 'Cutting season. Venice beach workouts.', 3, 'Los Angeles', 'USA', 88, 110, 155, 195, 33.984, -118.47, 1, 1750, 5],
    ['coach', 'coach@gymnet.app', 'GymNet Coach', 'Official GymNet account. Tips, updates & love. 💪', null, '', '', 0, 0, 0, 0, null, null, 0, 9999, 0],
  ];
  const insUser = q(`INSERT INTO users (username, email, pw_hash, salt, name, bio, gym_id, city, country, weight, bench, squat, deadlift, lat, lng, open_to_partners, xp, streak, last_workout_date, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const dayMs = 86400000;
  const yesterday = new Date(Date.now() - dayMs).toISOString().slice(0, 10);
  for (const u of USERS) {
    insUser.run(u[0], u[1], pw, salt, u[2], u[3], u[4], u[5], u[6], u[7], u[8], u[9], u[10], u[11], u[12], u[13], u[14], u[15], u[15] > 0 ? yesterday : '', now() - 90 * dayMs);
  }
  const id = un => q('SELECT id FROM users WHERE username = ?').get(un).id;
  const [demo, sara, mike, emma, dan, yuki, lena, oli, pri, carlos, coach] =
    ['demo', 'sara_lifts', 'mike_bench', 'emma_squat', 'deadlift_dan', 'yuki_gains', 'lena_strong', 'oli_ohp', 'pri_power', 'carlos_cut', 'coach'].map(id);

  const insFollow = q('INSERT INTO follows VALUES (?,?,?)');
  const followPairs = [
    [demo, sara], [demo, mike], [demo, emma], [demo, coach],
    [sara, demo], [mike, demo], [dan, demo], [lena, demo],
    [sara, mike], [mike, sara], [emma, carlos], [carlos, emma], [dan, emma],
    [yuki, mike], [lena, yuki], [oli, pri], [pri, oli], [pri, sara], [carlos, dan],
  ];
  for (const [a, b] of followPairs) insFollow.run(a, b, now() - 30 * dayMs);

  const insPost = q('INSERT INTO posts (user_id, content, media, repost_of, created_at) VALUES (?,?,?,?,?)');
  const P = (uid, content, hoursAgo) => Number(insPost.run(uid, content, '[]', null, now() - hoursAgo * 3600000).lastInsertRowid);
  const p1 = P(mike, 'New bench PR: 142.5 kg 🎉 Six months of pause work finally paying off. Trust the process.', 3);
  const p2 = P(sara, 'Coaching tip: if your squat depth disappears when the weight gets heavy, drop 15% and film every set for two weeks. Depth is a skill, not a gift.', 6);
  const p3 = P(emma, '5 AM squat session done before the gym even got busy. Best decision I ever made was becoming a morning lifter. ☀️🦵', 10);
  const p4 = P(dan, '260 kg deadlift moved like a warmup today. 270 is going DOWN next month. Who wants to come watch? 😤', 24);
  const p5 = P(yuki, 'Technique night at Tokyo Lifting Club — we spent 90 minutes on bracing alone. Fundamentals win championships.', 30);
  const p6 = P(lena, 'First time flipping the 200 kg tire. Strongwoman comp prep is officially ON. 🇩🇪💪', 48);
  const p7 = P(pri, '12 weeks until my first competition. Nervous but SO excited. Any first-meet advice from you veterans?', 52);
  const p8 = P(carlos, 'Cutting update: down 4 kg, bench still going up. Slow cuts are undefeated. Venice beach pump session tonight.', 60);
  const p9 = P(oli, 'Overhead press is the most honest lift. No bounce, no momentum, nowhere to hide. 105 kg today. 🏋️', 72);
  const p10 = P(demo, 'Day 4 of the streak. Legs are toast but the grind continues. See everyone at Iron Temple tomorrow 🏙️', 26);

  const insLike = q('INSERT INTO likes VALUES (?,?,?)');
  const likePairs = [
    [demo, p1], [sara, p1], [emma, p1], [dan, p1], [yuki, p1], [carlos, p1],
    [demo, p2], [mike, p2], [pri, p2], [emma, p2],
    [demo, p4], [mike, p4], [carlos, p4], [lena, p4],
    [sara, p7], [oli, p7], [demo, p7],
    [mike, p10], [sara, p10], [dan, p10], [lena, p10],
    [demo, p3], [carlos, p3], [dan, p6], [yuki, p6],
  ];
  for (const [u2, p] of likePairs) insLike.run(u2, p, now() - 2 * 3600000);

  const insComment = q('INSERT INTO comments (post_id, user_id, content, created_at) VALUES (?,?,?,?)');
  insComment.run(p1, demo, 'Insane! What did your pause work look like?', now() - 2 * 3600000);
  insComment.run(p1, sara, 'Called it months ago. Congrats Mike! 🎉', now() - 2.5 * 3600000);
  insComment.run(p7, sara, 'Open light, make all nine lifts, enjoy the day. The total takes care of itself.', now() - 40 * 3600000);
  insComment.run(p7, dan, 'Bring snacks. Meets are LONG. Good luck!', now() - 38 * 3600000);
  insComment.run(p10, mike, 'Spotting you on bench tomorrow, be there at 6.', now() - 20 * 3600000);
  insComment.run(p4, demo, 'I\'ll be there for 270. Front row.', now() - 20 * 3600000);

  const insWorkout = q('INSERT INTO workouts (user_id, title, entries, created_at) VALUES (?,?,?,?)');
  const W = (uid, title, entries, daysAgo) => insWorkout.run(uid, title, JSON.stringify(entries), now() - daysAgo * dayMs);
  W(demo, 'Push Day', [{ exercise: 'Bench Press', sets: 5, reps: 5, weight: 90 }, { exercise: 'Overhead Press', sets: 3, reps: 8, weight: 55 }, { exercise: 'Dips', sets: 3, reps: 12, weight: 0 }], 1);
  W(demo, 'Pull Day', [{ exercise: 'Deadlift', sets: 3, reps: 5, weight: 160 }, { exercise: 'Barbell Row', sets: 4, reps: 8, weight: 80 }, { exercise: 'Pull-ups', sets: 4, reps: 10, weight: 0 }], 2);
  W(demo, 'Leg Day', [{ exercise: 'Squat', sets: 5, reps: 5, weight: 125 }, { exercise: 'Romanian Deadlift', sets: 3, reps: 10, weight: 100 }, { exercise: 'Leg Press', sets: 3, reps: 12, weight: 200 }], 3);
  W(demo, 'Upper Body', [{ exercise: 'Bench Press', sets: 4, reps: 6, weight: 87.5 }, { exercise: 'Barbell Row', sets: 4, reps: 8, weight: 77.5 }], 4);
  W(mike, 'Bench Priority', [{ exercise: 'Bench Press', sets: 6, reps: 3, weight: 130 }, { exercise: 'Close-Grip Bench', sets: 4, reps: 8, weight: 100 }], 1);
  W(sara, 'Squat Volume', [{ exercise: 'Squat', sets: 5, reps: 8, weight: 95 }, { exercise: 'Lunges', sets: 3, reps: 10, weight: 40 }], 1);
  W(dan, 'Deadlift Day', [{ exercise: 'Deadlift', sets: 5, reps: 3, weight: 230 }, { exercise: 'Barbell Row', sets: 4, reps: 8, weight: 110 }], 1);

  const insEvent = q('INSERT INTO events (creator_id, gym_id, title, description, date, created_at) VALUES (?,?,?,?,?,?)');
  const evDate = d => new Date(Date.now() + d * dayMs).toISOString().slice(0, 10);
  insEvent.run(mike, 1, 'Saturday Squad Session', 'Open bench + squat session at Iron Temple. All levels welcome, spotters on site.', evDate(2), now());
  insEvent.run(emma, 3, 'Venice Beach Pump & Burgers', 'Sunset workout at the outdoor gym, burgers after. Bring chalk.', evDate(5), now());
  insEvent.run(dan, 4, 'Dan\'s 270 kg Deadlift Attempt', 'Come watch (or film) the big pull. Hype crew needed.', evDate(9), now());
  const insAtt = q('INSERT INTO event_attendees VALUES (?,?)');
  insAtt.run(1, mike); insAtt.run(1, sara); insAtt.run(1, demo);
  insAtt.run(2, emma); insAtt.run(2, carlos);
  insAtt.run(3, dan); insAtt.run(3, carlos); insAtt.run(3, emma);

  const insMsg = q('INSERT INTO messages (from_id, to_id, content, image, read, created_at) VALUES (?,?,?,?,?,?)');
  insMsg.run(coach, demo, 'Welcome to GymNet, Alex! 💪 Log a workout to keep your streak alive, and check the map to find lifters near you.', '', 1, now() - 80 * dayMs);
  insMsg.run(sara, demo, 'Hey! Saw your squat video — depth looked great. Want a form check on the walkout next time?', '', 1, now() - 26 * 3600000);
  insMsg.run(demo, sara, 'That would be awesome! I\'m at Iron Temple tomorrow around 6pm.', '', 1, now() - 25 * 3600000);
  insMsg.run(sara, demo, 'Perfect, I\'ll swing by after my coaching block. 👍', '', 0, now() - 24 * 3600000);
  insMsg.run(mike, demo, 'Yo, bench day tomorrow. 6 AM. Don\'t be late 😤', '', 0, now() - 10 * 3600000);

  q('INSERT INTO challenges (from_id, to_id, exercise, target, status, created_at) VALUES (?,?,?,?,?,?)')
    .run(mike, demo, 'Bench Press', 100, 'pending', now() - 5 * 3600000);
  notify(demo, mike, 'challenge', 1, 'challenged you: Bench Press 100 kg');
  notify(demo, sara, 'follow', null, 'started following you');
  notify(demo, mike, 'like', p10, 'liked your post');
  notify(demo, dan, 'like', p10, 'liked your post');
  notify(demo, mike, 'comment', p10, 'commented: "Spotting you on bench tomorrow, be there at 6."');
  console.log('Seeded demo data (login: demo / demo123 — all seeded accounts use demo123)');
}
seed();

// ---------------------------------------------------------------- http plumbing
function send(res, code, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(body);
}
const err = (res, code, msg) => send(res, code, { error: msg });

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function auth(req) {
  const token = parseCookies(req).token;
  if (!token) return null;
  const s = q('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return null;
  return q('SELECT * FROM users WHERE id = ?').get(s.user_id) || null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.ico': 'image/x-icon',
};
const EXT_FOR = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
};

function serveFile(res, base, rel) {
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base)) return err(res, 403, 'forbidden');
  fs.readFile(file, (e, data) => {
    if (e) return err(res, 404, 'not found');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const cache = base === UPLOADS ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
    res.end(data);
  });
}

// ---------------------------------------------------------------- api
async function api(req, res, parts, query) {
  const me = auth(req);
  const need = () => { if (!me) { err(res, 401, 'login required'); return true; } return false; };
  const method = req.method;
  const route = (m, ...pattern) => {
    if (m !== method || pattern.length !== parts.length) return null;
    const params = [];
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i] === '*') params.push(parts[i]);
      else if (pattern[i] !== parts[i]) return null;
    }
    return params;
  };
  let p;

  // ---- auth
  if (route('POST', 'signup')) {
    const b = await readBody(req);
    const username = String(b.username || '').toLowerCase().trim();
    const email = String(b.email || '').toLowerCase().trim();
    const name = String(b.name || '').trim();
    const password = String(b.password || '');
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return err(res, 400, 'Username must be 3-20 chars: letters, numbers, underscores');
    if (!/^\S+@\S+\.\S+$/.test(email)) return err(res, 400, 'Enter a valid email address');
    if (!name) return err(res, 400, 'Enter your name');
    if (password.length < 6) return err(res, 400, 'Password must be at least 6 characters');
    if (q('SELECT 1 x FROM users WHERE username = ?').get(username)) return err(res, 400, 'Username is taken');
    if (q('SELECT 1 x FROM users WHERE email = ?').get(email)) return err(res, 400, 'Email already registered');
    const salt = crypto.randomBytes(16).toString('hex');
    const r = q(`INSERT INTO users (username, email, pw_hash, salt, name, created_at) VALUES (?,?,?,?,?,?)`)
      .run(username, email, hashPw(password, salt), salt, name, now());
    const uid = Number(r.lastInsertRowid);
    const coach = q('SELECT id FROM users WHERE username = ?').get('coach');
    if (coach) {
      q('INSERT INTO messages (from_id, to_id, content, image, read, created_at) VALUES (?,?,?,?,0,?)')
        .run(coach.id, uid, `Welcome to GymNet, ${name}! 💪 Set up your profile in Settings, log your first workout to start a streak, and hit the Map to find gyms and lifters near you.`, '', now());
    }
    const token = newToken();
    q('INSERT INTO sessions VALUES (?,?,?)').run(token, uid, now());
    return send(res, 200, { ok: true }, { 'Set-Cookie': `token=${token}; Path=/; Max-Age=31536000; SameSite=Lax` });
  }

  if (route('POST', 'login')) {
    const b = await readBody(req);
    const who = String(b.username || '').toLowerCase().trim();
    const u = q('SELECT * FROM users WHERE username = ? OR email = ?').get(who, who);
    if (!u || hashPw(String(b.password || ''), u.salt) !== u.pw_hash) return err(res, 400, 'Wrong username or password');
    const token = newToken();
    q('INSERT INTO sessions VALUES (?,?,?)').run(token, u.id, now());
    return send(res, 200, { ok: true }, { 'Set-Cookie': `token=${token}; Path=/; Max-Age=31536000; SameSite=Lax` });
  }

  if (route('POST', 'logout')) {
    const token = parseCookies(req).token;
    if (token) q('DELETE FROM sessions WHERE token = ?').run(token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'token=; Path=/; Max-Age=0' });
  }

  if (route('POST', 'forgot')) {
    const b = await readBody(req);
    const who = String(b.username || '').toLowerCase().trim();
    const u = q('SELECT * FROM users WHERE username = ? OR email = ?').get(who, who);
    if (!u) return err(res, 400, 'No account found with that username or email');
    const code = String(100000 + rid() % 900000);
    q('INSERT OR REPLACE INTO reset_codes VALUES (?,?,?)').run(u.id, code, now());
    // Demo mode: no email service, so the code is returned directly for display.
    return send(res, 200, { ok: true, demo_code: code });
  }

  if (route('POST', 'reset')) {
    const b = await readBody(req);
    const who = String(b.username || '').toLowerCase().trim();
    const u = q('SELECT * FROM users WHERE username = ? OR email = ?').get(who, who);
    if (!u) return err(res, 400, 'No account found');
    const rc = q('SELECT * FROM reset_codes WHERE user_id = ?').get(u.id);
    if (!rc || rc.code !== String(b.code || '') || now() - rc.created_at > 15 * 60000) return err(res, 400, 'Invalid or expired code');
    if (String(b.password || '').length < 6) return err(res, 400, 'Password must be at least 6 characters');
    const salt = crypto.randomBytes(16).toString('hex');
    q('UPDATE users SET pw_hash = ?, salt = ? WHERE id = ?').run(hashPw(String(b.password), salt), salt, u.id);
    q('DELETE FROM reset_codes WHERE user_id = ?').run(u.id);
    q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    return send(res, 200, { ok: true });
  }

  // ---- me / profile
  if (route('GET', 'me')) {
    if (need()) return;
    return send(res, 200, { user: publicUser(me, me.id), badges: badgesFor(me) });
  }

  if (route('PUT', 'profile')) {
    if (need()) return;
    const b = await readBody(req);
    const s = (v, max = 300) => String(v ?? '').slice(0, max);
    const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
    const gymId = b.gym_id ? Number(b.gym_id) : null;
    if (gymId && !q('SELECT 1 x FROM gyms WHERE id = ?').get(gymId)) return err(res, 400, 'Unknown gym');
    q(`UPDATE users SET name=?, bio=?, gym_id=?, city=?, country=?, weight=?, bench=?, squat=?, deadlift=?, avatar=?, cover=?, lat=?, lng=?, open_to_partners=? WHERE id=?`)
      .run(s(b.name, 60) || me.name, s(b.bio), gymId, s(b.city, 60), s(b.country, 60),
        n(b.weight), n(b.bench), n(b.squat), n(b.deadlift),
        s(b.avatar, 500000), s(b.cover, 500000),
        b.lat == null || b.lat === '' ? null : n(b.lat), b.lng == null || b.lng === '' ? null : n(b.lng),
        b.open_to_partners ? 1 : 0, me.id);
    const fresh = q('SELECT * FROM users WHERE id = ?').get(me.id);
    return send(res, 200, { user: publicUser(fresh, me.id) });
  }

  if (route('POST', 'upload')) {
    if (need()) return;
    const b = await readBody(req);
    const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/is.exec(String(b.data || ''));
    if (!m) return err(res, 400, 'Expected a base64 data URL');
    const ext = EXT_FOR[m[1].toLowerCase()];
    if (!ext) return err(res, 400, 'Unsupported file type (images and mp4/webm video only)');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 20 * 1024 * 1024) return err(res, 400, 'File too large (20 MB max)');
    const fname = crypto.randomBytes(12).toString('hex') + ext;
    fs.writeFileSync(path.join(UPLOADS, fname), buf);
    const type = m[1].startsWith('video') ? 'video' : 'image';
    return send(res, 200, { url: '/uploads/' + fname, type });
  }

  // ---- users / follow
  if ((p = route('GET', 'users', '*'))) {
    const u = q('SELECT * FROM users WHERE username = ?').get(p[0].toLowerCase());
    if (!u) return err(res, 404, 'User not found');
    const posts = q('SELECT * FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(u.id)
      .map(x => postOut(x, me?.id));
    const workouts = q('SELECT * FROM workouts WHERE user_id = ? ORDER BY created_at DESC LIMIT 30').all(u.id)
      .map(w => ({ id: w.id, title: w.title, entries: JSON.parse(w.entries), created_at: w.created_at }));
    return send(res, 200, { user: publicUser(u, me?.id), badges: badgesFor(u), posts, workouts });
  }

  if ((p = route('GET', 'users', '*', 'follows'))) {
    const u = q('SELECT * FROM users WHERE username = ?').get(p[0].toLowerCase());
    if (!u) return err(res, 404, 'User not found');
    const dir = query.get('type') === 'following'
      ? q('SELECT u.* FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ? ORDER BY f.created_at DESC').all(u.id)
      : q('SELECT u.* FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.followee_id = ? ORDER BY f.created_at DESC').all(u.id);
    return send(res, 200, { users: dir.map(x => publicUser(x, me?.id)) });
  }

  if ((p = route('POST', 'follow', '*'))) {
    if (need()) return;
    const target = Number(p[0]);
    if (target === me.id) return err(res, 400, 'You cannot follow yourself');
    if (!q('SELECT 1 x FROM users WHERE id = ?').get(target)) return err(res, 404, 'User not found');
    const existing = q('SELECT 1 x FROM follows WHERE follower_id = ? AND followee_id = ?').get(me.id, target);
    if (existing) {
      q('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(me.id, target);
      return send(res, 200, { following: false });
    }
    q('INSERT INTO follows VALUES (?,?,?)').run(me.id, target, now());
    notify(target, me.id, 'follow', null, 'started following you');
    return send(res, 200, { following: true });
  }

  if (route('GET', 'search')) {
    const term = String(query.get('q') || '').toLowerCase().trim();
    if (!term) return send(res, 200, { users: [] });
    const rows = q(`SELECT * FROM users WHERE (username LIKE ? OR LOWER(name) LIKE ?) AND username != 'coach' LIMIT 8`)
      .all(`%${term}%`, `%${term}%`);
    return send(res, 200, { users: rows.map(u => publicUser(u, me?.id)) });
  }

  // ---- posts
  if (route('GET', 'posts')) {
    if (need()) return;
    const filter = query.get('filter') || 'all';
    let rows;
    if (filter === 'following') {
      rows = q(`SELECT * FROM posts WHERE user_id = ? OR user_id IN (SELECT followee_id FROM follows WHERE follower_id = ?) ORDER BY created_at DESC LIMIT 60`).all(me.id, me.id);
    } else if (filter === 'saved') {
      rows = q(`SELECT p.* FROM saves s JOIN posts p ON p.id = s.post_id WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT 60`).all(me.id);
    } else {
      rows = q('SELECT * FROM posts ORDER BY created_at DESC LIMIT 60').all();
    }
    return send(res, 200, { posts: rows.map(x => postOut(x, me.id)) });
  }

  if (route('POST', 'posts')) {
    if (need()) return;
    const b = await readBody(req);
    const content = String(b.content || '').trim().slice(0, 2000);
    const media = Array.isArray(b.media) ? b.media.filter(x => x && typeof x.url === 'string' && x.url.startsWith('/uploads/') && ['image', 'video'].includes(x.type)).slice(0, 4) : [];
    if (!content && !media.length) return err(res, 400, 'Post something — text, a photo or a video');
    const r = q('INSERT INTO posts (user_id, content, media, repost_of, created_at) VALUES (?,?,?,?,?)')
      .run(me.id, content, JSON.stringify(media), null, now());
    addXp(me.id, 10);
    return send(res, 200, { post: postOut(q('SELECT * FROM posts WHERE id = ?').get(Number(r.lastInsertRowid)), me.id), xp: 10 });
  }

  if ((p = route('POST', 'posts', '*', 'like'))) {
    if (need()) return;
    const post = q('SELECT * FROM posts WHERE id = ?').get(Number(p[0]));
    if (!post) return err(res, 404, 'Post not found');
    const existing = q('SELECT 1 x FROM likes WHERE user_id = ? AND post_id = ?').get(me.id, post.id);
    if (existing) {
      q('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(me.id, post.id);
      addXp(post.user_id, -2);
    } else {
      q('INSERT INTO likes VALUES (?,?,?)').run(me.id, post.id, now());
      addXp(post.user_id, 2);
      notify(post.user_id, me.id, 'like', post.id, 'liked your post');
    }
    return send(res, 200, { post: postOut(q('SELECT * FROM posts WHERE id = ?').get(post.id), me.id) });
  }

  if ((p = route('POST', 'posts', '*', 'save'))) {
    if (need()) return;
    const post = q('SELECT * FROM posts WHERE id = ?').get(Number(p[0]));
    if (!post) return err(res, 404, 'Post not found');
    const existing = q('SELECT 1 x FROM saves WHERE user_id = ? AND post_id = ?').get(me.id, post.id);
    if (existing) q('DELETE FROM saves WHERE user_id = ? AND post_id = ?').run(me.id, post.id);
    else q('INSERT INTO saves VALUES (?,?,?)').run(me.id, post.id, now());
    return send(res, 200, { saved: !existing });
  }

  if ((p = route('POST', 'posts', '*', 'share'))) {
    if (need()) return;
    const target = q('SELECT * FROM posts WHERE id = ?').get(Number(p[0]));
    if (!target) return err(res, 404, 'Post not found');
    const origId = target.repost_of || target.id;
    const orig = q('SELECT * FROM posts WHERE id = ?').get(origId);
    const b = await readBody(req);
    const r = q('INSERT INTO posts (user_id, content, media, repost_of, created_at) VALUES (?,?,?,?,?)')
      .run(me.id, String(b.content || '').trim().slice(0, 2000), '[]', origId, now());
    addXp(me.id, 5);
    addXp(orig.user_id, 3);
    notify(orig.user_id, me.id, 'share', origId, 'shared your post');
    return send(res, 200, { post: postOut(q('SELECT * FROM posts WHERE id = ?').get(Number(r.lastInsertRowid)), me.id), xp: 5 });
  }

  if ((p = route('GET', 'posts', '*', 'comments'))) {
    const rows = q('SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC').all(Number(p[0]));
    return send(res, 200, { comments: rows.map(commentOut) });
  }

  if ((p = route('POST', 'posts', '*', 'comments'))) {
    if (need()) return;
    const post = q('SELECT * FROM posts WHERE id = ?').get(Number(p[0]));
    if (!post) return err(res, 404, 'Post not found');
    const b = await readBody(req);
    const content = String(b.content || '').trim().slice(0, 1000);
    if (!content) return err(res, 400, 'Comment cannot be empty');
    const r = q('INSERT INTO comments (post_id, user_id, content, created_at) VALUES (?,?,?,?)').run(post.id, me.id, content, now());
    addXp(me.id, 5);
    notify(post.user_id, me.id, 'comment', post.id, `commented: "${content.slice(0, 60)}"`);
    return send(res, 200, { comment: commentOut(q('SELECT * FROM comments WHERE id = ?').get(Number(r.lastInsertRowid))), xp: 5 });
  }

  // ---- workouts
  if (route('GET', 'workouts')) {
    if (need()) return;
    const rows = q('SELECT * FROM workouts WHERE user_id = ? ORDER BY created_at DESC LIMIT 60').all(me.id);
    return send(res, 200, { workouts: rows.map(w => ({ id: w.id, title: w.title, entries: JSON.parse(w.entries), created_at: w.created_at })) });
  }

  if (route('POST', 'workouts')) {
    if (need()) return;
    const b = await readBody(req);
    const entries = (Array.isArray(b.entries) ? b.entries : [])
      .map(e => ({
        exercise: String(e.exercise || '').trim().slice(0, 60),
        sets: Math.max(1, Math.min(50, parseInt(e.sets) || 1)),
        reps: Math.max(1, Math.min(200, parseInt(e.reps) || 1)),
        weight: Math.max(0, Math.min(1000, parseFloat(e.weight) || 0)),
      }))
      .filter(e => e.exercise).slice(0, 20);
    if (!entries.length) return err(res, 400, 'Add at least one exercise');
    const title = String(b.title || '').trim().slice(0, 80) || 'Workout';
    q('INSERT INTO workouts (user_id, title, entries, created_at) VALUES (?,?,?,?)').run(me.id, title, JSON.stringify(entries), now());

    // streak
    const t = today();
    const yesterday = new Date(new Date(t).getTime() - 86400000).toISOString().slice(0, 10);
    let streak = me.streak;
    if (me.last_workout_date === t) { /* already counted today */ }
    else if (me.last_workout_date === yesterday) streak = me.streak + 1;
    else streak = 1;
    q('UPDATE users SET streak = ?, last_workout_date = ? WHERE id = ?').run(streak, t, me.id);
    addXp(me.id, 50);

    // auto-update PRs from big three
    const prs = {};
    for (const e of entries) {
      const ex = e.exercise.toLowerCase();
      if (ex.includes('bench') && e.weight > me.bench) prs.bench = e.weight;
      if (ex.includes('squat') && e.weight > me.squat) prs.squat = e.weight;
      if (ex.includes('deadlift') && !ex.includes('romanian') && e.weight > me.deadlift) prs.deadlift = e.weight;
    }
    for (const [k, v] of Object.entries(prs)) q(`UPDATE users SET ${k} = ? WHERE id = ?`).run(v, me.id);

    const fresh = q('SELECT * FROM users WHERE id = ?').get(me.id);
    return send(res, 200, { ok: true, xp: 50, streak, new_prs: prs, user: publicUser(fresh, me.id), badges: badgesFor(fresh) });
  }

  // ---- leaderboard
  if (route('GET', 'leaderboard')) {
    if (need()) return;
    const scope = query.get('scope') || 'global';
    let rows;
    const base = `SELECT * FROM users WHERE username != 'coach'`;
    if (scope === 'country' && me.country) rows = q(base + ' AND country = ? ORDER BY xp DESC LIMIT 100').all(me.country);
    else if (scope === 'city' && me.city) rows = q(base + ' AND city = ? ORDER BY xp DESC LIMIT 100').all(me.city);
    else if (scope === 'gym' && me.gym_id) rows = q(base + ' AND gym_id = ? ORDER BY xp DESC LIMIT 100').all(me.gym_id);
    else if (scope === 'friends') rows = q(base + ' AND (id = ? OR id IN (SELECT followee_id FROM follows WHERE follower_id = ?)) ORDER BY xp DESC LIMIT 100').all(me.id, me.id);
    else if (scope !== 'global' ) rows = []; // scope requested but user hasn't set that profile field
    else rows = q(base + ' ORDER BY xp DESC LIMIT 100').all();
    return send(res, 200, { users: rows.map(u => publicUser(u, me.id)) });
  }

  // ---- gyms / map / events / partners
  if (route('GET', 'gyms')) {
    const rows = q('SELECT g.*, (SELECT COUNT(*) FROM users u WHERE u.gym_id = g.id) AS members FROM gyms g ORDER BY members DESC').all();
    return send(res, 200, { gyms: rows });
  }

  if (route('GET', 'map')) {
    if (need()) return;
    const gyms = q('SELECT g.*, (SELECT COUNT(*) FROM users u WHERE u.gym_id = g.id) AS members FROM gyms g').all();
    const friends = q(`SELECT u.* FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ? AND u.lat IS NOT NULL`).all(me.id)
      .map(u => publicUser(u, me.id));
    const partners = q(`SELECT * FROM users WHERE open_to_partners = 1 AND lat IS NOT NULL AND id != ? AND username != 'coach'`).all(me.id)
      .map(u => publicUser(u, me.id));
    const events = q('SELECT e.*, g.name AS gym_name, g.city AS gym_city, g.lat, g.lng, (SELECT COUNT(*) FROM event_attendees a WHERE a.event_id = e.id) AS attendees FROM events e JOIN gyms g ON g.id = e.gym_id WHERE e.date >= ? ORDER BY e.date ASC').all(today())
      .map(e => ({ ...e, joined: !!q('SELECT 1 x FROM event_attendees WHERE event_id = ? AND user_id = ?').get(e.id, me.id), creator: q('SELECT username, name FROM users WHERE id = ?').get(e.creator_id) }));
    return send(res, 200, { gyms, friends, partners, events, me: publicUser(me, me.id) });
  }

  if (route('POST', 'events')) {
    if (need()) return;
    const b = await readBody(req);
    const gymId = Number(b.gym_id);
    if (!q('SELECT 1 x FROM gyms WHERE id = ?').get(gymId)) return err(res, 400, 'Pick a gym for the event');
    const title = String(b.title || '').trim().slice(0, 100);
    const date = String(b.date || '').slice(0, 10);
    if (!title) return err(res, 400, 'Event needs a title');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today()) return err(res, 400, 'Pick a valid future date');
    const r = q('INSERT INTO events (creator_id, gym_id, title, description, date, created_at) VALUES (?,?,?,?,?,?)')
      .run(me.id, gymId, title, String(b.description || '').trim().slice(0, 500), date, now());
    q('INSERT INTO event_attendees VALUES (?,?)').run(Number(r.lastInsertRowid), me.id);
    return send(res, 200, { ok: true });
  }

  if ((p = route('POST', 'events', '*', 'join'))) {
    if (need()) return;
    const ev = q('SELECT * FROM events WHERE id = ?').get(Number(p[0]));
    if (!ev) return err(res, 404, 'Event not found');
    const existing = q('SELECT 1 x FROM event_attendees WHERE event_id = ? AND user_id = ?').get(ev.id, me.id);
    if (existing) { q('DELETE FROM event_attendees WHERE event_id = ? AND user_id = ?').run(ev.id, me.id); return send(res, 200, { joined: false }); }
    q('INSERT INTO event_attendees VALUES (?,?)').run(ev.id, me.id);
    notify(ev.creator_id, me.id, 'event', ev.id, `is going to "${ev.title}"`);
    return send(res, 200, { joined: true });
  }

  // ---- chat
  if (route('GET', 'conversations')) {
    if (need()) return;
    const msgs = q('SELECT * FROM messages WHERE from_id = ? OR to_id = ? ORDER BY created_at DESC').all(me.id, me.id);
    const seen = new Map();
    for (const m of msgs) {
      const other = m.from_id === me.id ? m.to_id : m.from_id;
      if (!seen.has(other)) seen.set(other, { last: m, unread: 0 });
      if (m.to_id === me.id && !m.read) seen.get(other).unread++;
    }
    const convos = [...seen.entries()].map(([otherId, v]) => {
      const u = q('SELECT id, username, name, avatar FROM users WHERE id = ?').get(otherId);
      return u && {
        user: u, unread: v.unread,
        last: { content: v.last.content, image: v.last.image, from_me: v.last.from_id === me.id, created_at: v.last.created_at },
      };
    }).filter(Boolean);
    return send(res, 200, { conversations: convos });
  }

  if ((p = route('GET', 'messages', '*'))) {
    if (need()) return;
    const other = q('SELECT id, username, name, avatar FROM users WHERE username = ?').get(p[0].toLowerCase());
    if (!other) return err(res, 404, 'User not found');
    q('UPDATE messages SET read = 1 WHERE from_id = ? AND to_id = ?').run(other.id, me.id);
    const rows = q('SELECT * FROM messages WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?) ORDER BY created_at ASC LIMIT 200')
      .all(me.id, other.id, other.id, me.id);
    return send(res, 200, { user: other, messages: rows.map(m => ({ id: m.id, content: m.content, image: m.image, from_me: m.from_id === me.id, created_at: m.created_at })) });
  }

  if ((p = route('POST', 'messages', '*'))) {
    if (need()) return;
    const other = q('SELECT id FROM users WHERE username = ?').get(p[0].toLowerCase());
    if (!other) return err(res, 404, 'User not found');
    const b = await readBody(req);
    const content = String(b.content || '').trim().slice(0, 2000);
    const image = typeof b.image === 'string' && b.image.startsWith('/uploads/') ? b.image : '';
    if (!content && !image) return err(res, 400, 'Message is empty');
    q('INSERT INTO messages (from_id, to_id, content, image, read, created_at) VALUES (?,?,?,?,0,?)').run(me.id, other.id, content, image, now());
    return send(res, 200, { ok: true });
  }

  // ---- notifications / challenges / status
  if (route('GET', 'notifications')) {
    if (need()) return;
    const rows = q('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(me.id)
      .map(n2 => ({ ...n2, actor: n2.actor_id ? q('SELECT username, name, avatar FROM users WHERE id = ?').get(n2.actor_id) : null }));
    const challenges = q(`SELECT c.*, uf.username AS from_username, uf.name AS from_name, uf.avatar AS from_avatar, ut.username AS to_username, ut.name AS to_name FROM challenges c JOIN users uf ON uf.id = c.from_id JOIN users ut ON ut.id = c.to_id WHERE c.from_id = ? OR c.to_id = ? ORDER BY c.created_at DESC LIMIT 20`).all(me.id, me.id);
    return send(res, 200, { notifications: rows, challenges });
  }

  if (route('POST', 'notifications', 'read')) {
    if (need()) return;
    q('UPDATE notifications SET read = 1 WHERE user_id = ?').run(me.id);
    return send(res, 200, { ok: true });
  }

  if (route('POST', 'challenges')) {
    if (need()) return;
    const b = await readBody(req);
    const to = q('SELECT * FROM users WHERE username = ?').get(String(b.username || '').toLowerCase());
    if (!to) return err(res, 404, 'User not found');
    if (to.id === me.id) return err(res, 400, 'You cannot challenge yourself');
    const exercise = String(b.exercise || '').trim().slice(0, 60);
    const target = Math.max(1, Math.min(1000, parseFloat(b.target) || 0));
    if (!exercise || !target) return err(res, 400, 'Pick an exercise and target weight');
    const r = q('INSERT INTO challenges (from_id, to_id, exercise, target, status, created_at) VALUES (?,?,?,?,?,?)')
      .run(me.id, to.id, exercise, target, 'pending', now());
    notify(to.id, me.id, 'challenge', Number(r.lastInsertRowid), `challenged you: ${exercise} ${target} kg`);
    return send(res, 200, { ok: true });
  }

  if ((p = route('POST', 'challenges', '*', 'respond'))) {
    if (need()) return;
    const c = q('SELECT * FROM challenges WHERE id = ?').get(Number(p[0]));
    if (!c || c.to_id !== me.id) return err(res, 404, 'Challenge not found');
    if (c.status !== 'pending') return err(res, 400, 'Already answered');
    const b = await readBody(req);
    const status = b.accept ? 'accepted' : 'declined';
    q('UPDATE challenges SET status = ? WHERE id = ?').run(status, c.id);
    if (b.accept) {
      addXp(me.id, 25); addXp(c.from_id, 25);
      notify(c.from_id, me.id, 'challenge_accept', c.id, `accepted your challenge: ${c.exercise} ${c.target} kg (+25 XP each)`);
    }
    return send(res, 200, { ok: true, status });
  }

  if (route('GET', 'status')) {
    if (need()) return;
    const notif = q('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read = 0').get(me.id).c;
    const dm = q('SELECT COUNT(*) c FROM messages WHERE to_id = ? AND read = 0').get(me.id).c;
    return send(res, 200, { notif, dm, user: publicUser(me, me.id) });
  }

  return err(res, 404, 'Unknown API route');
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'api') return await api(req, res, parts.slice(1), u.searchParams);
    if (parts[0] === 'uploads') return serveFile(res, UPLOADS, parts.slice(1).join('/'));
    if (parts.length === 0) return serveFile(res, PUB, 'index.html');
    return serveFile(res, PUB, parts.join('/'));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) err(res, 500, e.message || 'server error');
  }
});

server.listen(PORT, () => {
  console.log(`GymNet running → http://localhost:${PORT}`);
  console.log('Demo login: demo / demo123');
});
