// Máy chủ "Lưu trú bệnh viện": đăng nhập theo nhân viên + đồng bộ hồ sơ giữa các máy + gửi khai báo lên hệ thống KBTT.
import { kbttConfigured, getToken, nationalities, run } from "./kbtt.js";
const SESSION_DAYS = 30;
const enc = new TextEncoder();

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const err = (msg, status = 400) => json({ error: msg }, status);

function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join(""); }
function randHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a); }
async function hashPw(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return hex(bits);
}
function safeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
function cookieToken(req) { const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.get("cookie") || ""); return m ? m[1] : null; }
const sidCookie = (t, maxAge) => `sid=${t}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

async function currentUser(req, env) {
  const t = cookieToken(req); if (!t) return null;
  const row = await env.DB.prepare("SELECT u.id, u.username, u.name, u.role, u.active, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?").bind(t).first();
  if (!row || !row.active || row.expires_at < Date.now()) return null;
  return row;
}
async function newSession(env, userId) {
  const t = randHex(32);
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").bind(t, userId, Date.now() + SESSION_DAYS * 864e5).run();
  return t;
}
async function body(req) { try { return await req.json(); } catch { return {}; } }
function cleanUsername(u) { return String(u || "").trim().toLowerCase(); }

// chống dò mật khẩu: tối đa 10 lần sai / 15 phút cho mỗi tên đăng nhập
const fails = new Map();
function tooMany(key) { const f = fails.get(key); return f && f.n >= 10 && Date.now() - f.t < 15 * 60e3; }
function noteFail(key) { const f = fails.get(key); if (!f || Date.now() - f.t > 15 * 60e3) fails.set(key, { n: 1, t: Date.now() }); else f.n++; }

async function api(req, env, url) {
  const p = url.pathname, m = req.method;

  if (p === "/api/status" && m === "GET") {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
    const u = await currentUser(req, env);
    return json({ needsSetup: n.n === 0, user: u ? { id: u.id, username: u.username, name: u.name, role: u.role } : null, now: Date.now() });
  }
  if (p === "/api/setup" && m === "POST") {
    const b = await body(req);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
    if (n.n > 0) return err("Đã có tài khoản quản trị", 403);
    const code = await env.DB.prepare("SELECT code FROM setup WHERE code = ?").bind(String(b.code || "").trim()).first();
    if (!code) return err("Mã thiết lập không đúng", 403);
    const username = cleanUsername(b.username);
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) return err("Tên đăng nhập 3–32 ký tự: chữ không dấu, số, . _ -");
    if (String(b.password || "").length < 8) return err("Mật khẩu tối thiểu 8 ký tự");
    const salt = randHex(16), hash = await hashPw(b.password, salt);
    const r = await env.DB.prepare("INSERT INTO users (username, name, pass_hash, salt, role, active, created_at) VALUES (?, ?, ?, ?, 'admin', 1, ?)").bind(username, String(b.name || "").slice(0, 80), hash, salt, Date.now()).run();
    await env.DB.prepare("DELETE FROM setup").run();
    const t = await newSession(env, r.meta.last_row_id);
    return json({ ok: true }, 200, { "set-cookie": sidCookie(t, SESSION_DAYS * 86400) });
  }
  if (p === "/api/login" && m === "POST") {
    const b = await body(req); const username = cleanUsername(b.username);
    if (tooMany(username)) return err("Sai quá nhiều lần, thử lại sau 15 phút", 429);
    const u = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
    const ok = u && u.active && safeEq(await hashPw(String(b.password || ""), u.salt), u.pass_hash);
    if (!ok) { noteFail(username); return err("Sai tên đăng nhập hoặc mật khẩu", 401); }
    fails.delete(username);
    await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()).run();
    const t = await newSession(env, u.id);
    return json({ ok: true, user: { id: u.id, username: u.username, name: u.name, role: u.role } }, 200, { "set-cookie": sidCookie(t, SESSION_DAYS * 86400) });
  }
  if (p === "/api/logout" && m === "POST") {
    const t = cookieToken(req); if (t) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(t).run();
    return json({ ok: true }, 200, { "set-cookie": sidCookie("", 0) });
  }

  const me = await currentUser(req, env);
  if (!me) return err("Chưa đăng nhập", 401);

  if (p === "/api/sync" && m === "GET") {
    const since = Math.max(0, +url.searchParams.get("since") || 0);
    const now = Date.now();
    try { await env.DB.prepare("UPDATE users SET last_seen = ? WHERE id = ? AND last_seen < ?").bind(now, me.id, now - 60000).run(); } catch {}
    const rs = await env.DB.prepare("SELECT id, type, data, deleted, updated_at FROM records WHERE updated_at > ? AND updated_at <= ? ORDER BY updated_at LIMIT 5000").bind(since, now).all();
    return json({ now, records: rs.results.map(r => ({ id: r.id, type: r.type, deleted: !!r.deleted, updated_at: r.updated_at, data: r.deleted ? null : JSON.parse(r.data) })) });
  }
  if (p === "/api/sync" && m === "POST") {
    const b = await body(req);
    const list = Array.isArray(b.records) ? b.records.slice(0, 500) : [];
    const now = Date.now();
    const stmts = [];
    for (const r of list) {
      if (typeof r.id !== "string" || !/^[A-Za-z0-9_-]{6,64}$/.test(r.id)) continue;
      if (r.type !== "patient" && r.type !== "person") continue;
      const data = r.deleted ? "{}" : JSON.stringify(r.data || {});
      if (data.length > 20000) continue;
      stmts.push(env.DB.prepare("INSERT INTO records (id, type, data, deleted, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET type = excluded.type, data = excluded.data, deleted = excluded.deleted, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
        .bind(r.id, r.type, data, r.deleted ? 1 : 0, now, me.id));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, now, saved: stmts.length });
  }

  if (p === "/api/kbtt/status" && m === "GET") {
    if (!kbttConfigured(env)) return json({ configured: false });
    const demo = !!env.KBTT_BASE && !/bocongan\.gov\.vn/.test(env.KBTT_BASE);
    if (url.searchParams.get("check") !== "1") return json({ configured: true, demo });
    try { const t = await getToken(env, true); return json({ configured: true, demo, ok: true, info: t.info }); }
    catch (e) { return json({ configured: true, demo, ok: false, error: String(e.message || e) }); }
  }
  if (p === "/api/kbtt/qt" && m === "GET") {
    try { return json({ list: await nationalities(env) }); } catch (e) { return err(String(e.message || e), 502); }
  }
  const km = /^\/api\/kbtt\/(send|checkout|extend)$/.exec(p);
  if (km && m === "POST") {
    if (!kbttConfigured(env)) return err("Chưa cấu hình tài khoản hệ thống lưu trú (KBTT_USER / KBTT_PASS)", 400);
    const b = await body(req);
    const ids = (Array.isArray(b.ids) ? b.ids : []).filter(i => typeof i === "string").slice(0, 60);
    if (!ids.length) return err("Không có ai để gửi");
    const q = (list) => env.DB.prepare(`SELECT id, type, data, deleted FROM records WHERE id IN (${list.map(() => "?").join(",")})`).bind(...list).all();
    const ppl = (await q(ids)).results.filter(r => r.type === "person" && !r.deleted).map(r => JSON.parse(r.data));
    if (!ppl.length) return err("Dữ liệu chưa đồng bộ lên máy chủ, đợi vài giây rồi thử lại");
    const pids = [...new Set(ppl.map(x => x.pid))];
    const pats = new Map((await q(pids)).results.filter(r => !r.deleted).map(r => { const d = JSON.parse(r.data); return [d.id, d]; }));
    const sts = new Map((await q(ppl.map(x => "s" + x.id))).results.map(r => [r.id.slice(1), JSON.parse(r.data)]));
    const results = await run(env, km[1], ppl, pats, sts);
    const now = Date.now();
    await env.DB.batch(results.map(r => env.DB.prepare("INSERT INTO records (id, type, data, deleted, updated_at, updated_by) VALUES (?, 'status', ?, 0, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
      .bind("s" + r.id, JSON.stringify(Object.assign(r.status, { by: me.name || me.username })), now, me.id)));
    return json({ results: results.map(r => ({ id: r.id, ok: r.ok, error: r.error || "", status: r.status })) });
  }

  if (p.startsWith("/api/users")) {
    if (me.role !== "admin") return err("Chỉ quản trị viên", 403);
    if (p === "/api/users" && m === "GET") {
      const rs = await env.DB.prepare("SELECT id, username, name, role, active, created_at, last_seen FROM users ORDER BY id").all();
      return json({ users: rs.results });
    }
    if (p === "/api/users" && m === "POST") {
      const b = await body(req); const username = cleanUsername(b.username);
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) return err("Tên đăng nhập 3–32 ký tự: chữ không dấu, số, . _ -");
      if (String(b.password || "").length < 8) return err("Mật khẩu tối thiểu 8 ký tự");
      const salt = randHex(16), hash = await hashPw(b.password, salt);
      try {
        await env.DB.prepare("INSERT INTO users (username, name, pass_hash, salt, role, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)")
          .bind(username, String(b.name || "").slice(0, 80), hash, salt, b.role === "admin" ? "admin" : "staff", Date.now()).run();
      } catch { return err("Tên đăng nhập đã tồn tại"); }
      return json({ ok: true });
    }
    const mm = /^\/api\/users\/(\d+)$/.exec(p);
    if (mm && m === "POST") {
      const id = +mm[1], b = await body(req);
      if (b.password) {
        if (String(b.password).length < 8) return err("Mật khẩu tối thiểu 8 ký tự");
        const salt = randHex(16), hash = await hashPw(b.password, salt);
        await env.DB.prepare("UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?").bind(hash, salt, id).run();
        await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
      }
      if (typeof b.name === "string" && b.name.trim()) await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(b.name.trim().slice(0, 80), id).run();
      if (b.role === "admin" || b.role === "staff") {
        if (id === me.id && b.role !== "admin") return err("Không thể tự bỏ quyền quản trị của mình");
        await env.DB.prepare("UPDATE users SET role = ? WHERE id = ?").bind(b.role, id).run();
      }
      if (typeof b.active === "boolean") {
        if (id === me.id && !b.active) return err("Không thể tự khóa tài khoản của mình");
        await env.DB.prepare("UPDATE users SET active = ? WHERE id = ?").bind(b.active ? 1 : 0, id).run();
        if (!b.active) await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
      }
      return json({ ok: true });
    }
  }
  if (p === "/api/password" && m === "POST") {
    const b = await body(req);
    const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(me.id).first();
    if (!safeEq(await hashPw(String(b.old || ""), u.salt), u.pass_hash)) return err("Mật khẩu cũ không đúng", 403);
    if (String(b.password || "").length < 8) return err("Mật khẩu tối thiểu 8 ký tự");
    const salt = randHex(16), hash = await hashPw(b.password, salt);
    await env.DB.prepare("UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?").bind(hash, salt, me.id).run();
    return json({ ok: true });
  }
  return err("Không tìm thấy", 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      // chỉ nhận yêu cầu ghi từ chính trang web này
      if (req.method !== "GET") {
        const origin = req.headers.get("origin");
        if (origin && origin !== url.origin) return err("Nguồn không hợp lệ", 403);
      }
      try { return await api(req, env, url); }
      catch (e) { return err("Lỗi máy chủ: " + (e && e.message || e), 500); }
    }
    return env.ASSETS.fetch(req);
  },
};
