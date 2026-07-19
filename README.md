# GymNet 🏋️

A fitness social network — dark, bold, and built for lifters. Follow friends, post your PRs, log workouts, keep streaks, earn XP and badges, climb leaderboards, find nearby gyms and workout partners on the map, chat, and challenge each other.

## Run it

```bash
node server.js
```

Then open **http://localhost:3000**. That's it — no npm install, no build step, no API keys. Requires Node.js 22+ (uses the built-in `node:sqlite` module).

**Demo login:** username `demo`, password `demo123` (all seeded accounts use `demo123`: `sara_lifts`, `mike_bench`, `emma_squat`, `deadlift_dan`, …).

## Features

- **Auth** — signup, login, logout, forgot/reset password (demo mode shows the reset code on screen since there's no email service)
- **Profiles** — cover + profile photo, name, username, bio, home gym, city, bodyweight, bench/squat/deadlift PRs, followers/following
- **Social** — create posts with image/video uploads (up to 4 per post), like, comment, share (repost with a note), save
- **Fitness** — workout log with exercises/sets/reps/weight, daily streaks, XP, levels, badges (auto-awarded), automatic PR detection from logged lifts
- **Leaderboards** — global, country, city, gym, and friends, ranked by XP
- **Map** — pan/zoom canvas map with nearby gyms, nearby friends, workout partners, and gym events (create/join)
- **Chat** — direct messages with image sharing and unread counts (polls every few seconds)
- **Notifications** — likes, comments, follows, shares, event joins, and challenges (send a lift challenge, accept for +25 XP each)

## XP system

| Action | XP |
|---|---|
| Log a workout | +50 |
| Create a post | +10 |
| Share a post | +5 (original author +3) |
| Comment | +5 |
| Receive a like | +2 |
| Accept a challenge | +25 for both lifters |

Level = `floor(sqrt(XP / 50)) + 1`, with titles from Rookie up to Legend.

## Tech

- **Backend:** plain Node.js `http` server + built-in SQLite (`server.js`, zero dependencies)
- **Frontend:** vanilla JS single-page app (`public/app.js`), hash routing, no framework
- **Storage:** `gymnet.db` (SQLite, created on first run and seeded with demo data), uploaded media in `uploads/`

To reset everything: stop the server, delete `gymnet.db` and the `uploads/` folder, and start again.

> Demo-grade auth (session cookies, scrypt-hashed passwords). Fine for local use and prototyping; add HTTPS, rate limiting, and CSRF protection before exposing it to the internet.
