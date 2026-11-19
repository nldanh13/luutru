// Kết nối API hệ thống khai báo tạm trú / thông báo lưu trú (KBTT) của Bộ Công An.
// Tài khoản CSLT lấy từ secret KBTT_USER / KBTT_PASS; KBTT_BASE để đổi sang môi trường demo.
const PROD = "https://api-tbltkbtt.bocongan.gov.vn";
const CLIENT_BASIC = "QVBJX0NTTFQ6aTJuVnhCZEdGcjdqMTNkT3FJ"; // "API_CSLT:..." theo tài liệu tích hợp

export function kbttConfigured(env) { return !!(env.KBTT_USER && env.KBTT_PASS); }
const base = (env) => (env.KBTT_BASE || PROD).replace(/\/+$/, "");

async function kvGet(env, k) { const r = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(k).first(); return r ? JSON.parse(r.v) : null; }
async function kvSet(env, k, v) { await env.DB.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, JSON.stringify(v)).run(); }

async function readJson(res) { const t = await res.text(); try { return JSON.parse(t); } catch { return { code: String(res.status), message: t.slice(0, 300) || ("HTTP " + res.status) }; } }
const isOk = (res, j) => res.ok && String(j && j.code) === "200";

export async function getToken(env, force) {
  const b = base(env);
  const cached = force ? null : await kvGet(env, "kbtt_token");
  if (cached && cached.base === b && cached.user === env.KBTT_USER && cached.exp - 90 > Date.now() / 1000) return cached;
  const form = new URLSearchParams({ username: env.KBTT_USER, password: env.KBTT_PASS, "grant-type": "api_cslt" });
  const res = await fetch(b + "/authorization-service/oauth/token", {
    method: "POST", headers: { Authorization: "Basic " + (env.KBTT_CLIENT_BASIC || CLIENT_BASIC), "Content-Type": "application/x-www-form-urlencoded" }, body: form,
  });
  const j = await readJson(res);
  if (!isOk(res, j) || !j.data || !j.data.AccessToken) throw new Error("Đăng nhập hệ thống lưu trú thất bại: " + (j.message || res.status));
  const d = j.data;
  const tok = { base: b, user: env.KBTT_USER, token: d.AccessToken, exp: +d.Exp || (Date.now() / 1000 + 1800),
    info: { CsltId: d.CsltId, MaTTCuaCslt: d.MaTTCuaCslt, MaPxCuaCslt: d.MaPxCuaCslt, IsCsltChinh: d.IsCsltChinh, Authorities: d.Authorities } };
  await kvSet(env, "kbtt_token", tok);
  return tok;
}

async function call(env, path, body) {
  let tok = await getToken(env);
  const go = (t) => fetch(base(env) + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t.token }, body: JSON.stringify(body) });
  let res = await go(tok);
  if (res.status === 401 || res.status === 403) { tok = await getToken(env, true); res = await go(tok); }
  const j = await readJson(res);
  return { ok: isOk(res, j), message: j.message || ("HTTP " + res.status) };
}

export async function nationalities(env) {
  const c = await kvGet(env, "kbtt_qt");
  if (c && c.base === base(env) && Date.now() - c.at < 864e5 && c.list.length) return c.list;
  const res = await fetch(base(env) + "/cms-backend/public/dm-qt/3th/get-all");
  const j = await readJson(res);
  if (!isOk(res, j) || !Array.isArray(j.data)) throw new Error("Không tải được danh mục quốc tịch: " + (j.message || res.status));
  const list = j.data.map(q => ({ ma: q.maQT, vi: q.tenQT, en: q.tenQTEn }));
  await kvSet(env, "kbtt_qt", { base: base(env), at: Date.now(), list });
  return list;
}

/* ---------- chuyển dữ liệu app -> trường API ---------- */
const code = (s) => String(s || "").split(" - ")[0].trim();
const intCode = (s) => { const n = parseInt(code(s), 10); return Number.isFinite(n) ? n : null; };
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[đĐ]/g, "d").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
function vnNow() { return new Date(Date.now() + 7 * 3600e3); }
function vnDate(ms) { return new Date(ms + 7 * 3600e3).toISOString().slice(0, 10); }
function vnTime(ms) { return new Date(ms + 7 * 3600e3).toISOString().slice(11, 19); }
function dobIso(dob, type) {
  const s = String(dob || "").trim(); let m;
  if ((m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s))) return `${m[3]}-${m[2]}-${m[1]}`;
  if ((m = /^(\d{2})\/(\d{4})$/.exec(s))) return `${m[2]}-${m[1]}-01`;
  if ((m = /^(\d{4})$/.exec(s))) return `${m[1]}-01-01`;
  return "";
}
function arriveStr(x) {
  if (!x.arrive) return "";
  if (x.ct && vnDate(x.ct) === x.arrive) return x.arrive + " " + vnTime(x.ct);
  return x.arrive + " " + (x.arrive === vnNow().toISOString().slice(0, 10) ? vnTime(Date.now() - 60e3) : "08:00:00");
}
export function noteFor(x, p) {
  const ba = p && p.ba ? " - BA " + p.ba : "";
  if (x.role === "BN") return "Bệnh nhân" + ba + (x.note ? " - " + x.note : "");
  return "Người nhà BN " + String((p && p.name) || "").toUpperCase() + ba + (x.note ? " - " + x.note : "");
}
const roomFor = (x, p) => String(x.room || (p && p.dept) || "").trim();

function validateVN(x, p) {
  const e = [];
  if (!x.name) e.push("họ tên");
  if (!dobIso(x.dob)) e.push("ngày sinh");
  if (!/^[MF]/.test(x.gender || "")) e.push("giới tính");
  const lg = intCode(x.docType), so = String(x.docNo || "").trim();
  if (!lg) e.push("loại giấy tờ");
  if ((lg === 1 || lg === 8) && !/^\d{12}$/.test(so)) e.push("số CCCD phải đủ 12 chữ số");
  else if (lg === 2 && !/^(\d{9}|\d{12})$/.test(so)) e.push("số CMND phải 9 hoặc 12 chữ số");
  else if (!so || /[^A-Za-z0-9]/.test(so)) e.push("số giấy tờ");
  if (!intCode(x.reason)) e.push("lý do cư trú");
  if (intCode(x.reason) === 20 && !String(x.reasonText || "").trim()) e.push("lý do chi tiết");
  if (!roomFor(x, p)) e.push("số phòng/khoa");
  if (!x.arrive || !x.leave) e.push("ngày đến/đi");
  return e;
}
function payloadVN(x, p) {
  const o = {
    hoTen: String(x.name).trim(), gioiTinh: x.gender[0], ngayThangNamSinhStr: dobIso(x.dob),
    ghiChu: noteFor(x, p).slice(0, 500), ngayDenCsltStr: arriveStr(x), ngayDiDuKienStr: x.leave + " 23:59:59",
    soPhong: roomFor(x, p), lyDoCuTru: intCode(x.reason), loaiGiayTo: intCode(x.docType), soGiayTo: String(x.docNo).trim(),
  };
  if (x.phone) o.soDienThoai = String(x.phone).replace(/\s+/g, "");
  if (intCode(x.residence)) o.noiCuTru = intCode(x.residence);
  if (code(x.prov)) o.maTT = code(x.prov);
  if (code(x.ward)) o.maPX = code(x.ward);
  if (x.detail) o.diaChi = String(x.detail).trim();
  if (o.lyDoCuTru === 20) o.lyDoChiTiet = String(x.reasonText || "").trim();
  return o;
}
function findQT(list, nat) {
  const c3 = code(nat), name = norm(String(nat || "").split(" - ").slice(1).join(" - "));
  return (list.find(q => q.ma === c3) || list.find(q => norm(q.en) === name) || list.find(q => name && norm(q.en) && (norm(q.en).includes(name) || name.includes(norm(q.en)))) || {}).ma || null;
}
function validateNNN(x, p) {
  const e = [];
  if (!x.name) e.push("họ tên");
  if (!dobIso(x.dob)) e.push("ngày sinh");
  if (!/^[MF]/.test(x.gender || "")) e.push("giới tính");
  if (!/^[A-Za-z0-9]{1,10}$/.test(String(x.passport || "").trim())) e.push("số hộ chiếu (chữ và số, tối đa 10 ký tự)");
  if (!x.nat) e.push("quốc tịch");
  if (!x.visaUntil) e.push("thời hạn tạm trú tại VN");
  if (!roomFor(x, p)) e.push("số phòng/khoa");
  if (!x.arrive || !x.leave) e.push("ngày đến/đi");
  return e;
}
function payloadNNN(x, p, qt) {
  return {
    hoTen: String(x.name).trim(), quocTich: qt, soHoChieu: String(x.passport).trim().toUpperCase(), gioiTinh: x.gender[0],
    loaiNgayThangNamSinh: (x.dobType || "D")[0] === "D" ? "D" : "Y", ngayThangNamSinhStr: dobIso(x.dob),
    ngayDenCsltStr: arriveStr(x), ngayDiDuKienStr: x.leave + " 23:59:59", soPhong: roomFor(x, p), thoiHanTamTruStr: x.visaUntil + " 23:59:59",
  };
}

/* ---------- thao tác ---------- */
// action: "send" | "checkout" | "extend"
export async function run(env, action, people, patients, prevStatus) {
  const results = [];
  let qtList = null;
  for (const x of people) {
    const p = patients.get(x.pid) || {};
    const prev = prevStatus.get(x.id) || {};
    const st = Object.assign({}, prev);
    const at = Date.now();
    try {
      let r;
      if (action === "send") {
        const errs = x.kind === "NNN" ? validateNNN(x, p) : validateVN(x, p);
        if (errs.length) throw new Error("Thiếu hoặc sai: " + errs.join(", "));
        if (x.kind === "NNN") {
          qtList = qtList || await nationalities(env);
          const qt = findQT(qtList, x.nat);
          if (!qt) throw new Error("Không tìm thấy mã quốc tịch trên hệ thống cho “" + x.nat + "”");
          r = await call(env, "/client-service/kbtt/kbtt-3th", [payloadNNN(x, p, qt)]);
        } else r = await call(env, "/client-service/kbtt-vn/kbtt-3th", [payloadVN(x, p)]);
        if (r.ok) Object.assign(st, { st: "ok", at, msg: "", leave: x.leave, arrive: x.arrive, out: 0, outMsg: "" });
      } else if (action === "checkout") {
        if (prev.st !== "ok") throw new Error("Chưa gửi khai báo thành công nên không cần trả phòng");
        if (x.kind === "NNN") { qtList = qtList || await nationalities(env); r = await call(env, "/client-service/kbtt/kbtt-3th/doi-ngay-tra-phong", [{ loai: "TS", soHc: String(x.passport).trim().toUpperCase(), quocTich: findQT(qtList, x.nat) }]); }
        else r = await call(env, "/client-service/kbtt-vn/kbtt-3th/doi-ngay-tra-phong", [{ loai: "TS", soGiayTo: String(x.docNo).trim(), loaiGiayTo: intCode(x.docType) }]);
        if (r.ok) Object.assign(st, { out: at, outMsg: "" });
      } else if (action === "extend") {
        if (prev.st !== "ok") throw new Error("Chưa gửi khai báo thành công");
        if (!x.leave) throw new Error("Thiếu ngày đi mới");
        if (x.kind === "NNN") { qtList = qtList || await nationalities(env); const o = { loai: "GH", soHc: String(x.passport).trim().toUpperCase(), quocTich: findQT(qtList, x.nat), thoiGianStr: x.leave + " 23:59:59" }; if (x.visaUntil) o.thoiHanTamTruVnStr = x.visaUntil + " 23:59:59"; r = await call(env, "/client-service/kbtt/kbtt-3th/doi-ngay-tra-phong", [o]); }
        else r = await call(env, "/client-service/kbtt-vn/kbtt-3th/doi-ngay-tra-phong", [{ loai: "GH", soGiayTo: String(x.docNo).trim(), loaiGiayTo: intCode(x.docType), thoiGianStr: x.leave + " 23:59:59" }]);
        if (r.ok) Object.assign(st, { leave: x.leave, extAt: at, msg: "" });
      }
      if (!r.ok) throw new Error(r.message.replace(/Bản (khai báo|ghi) 1:\s*/g, ""));
      results.push({ id: x.id, ok: true, status: st });
    } catch (e) {
      const msg = String(e && e.message || e).slice(0, 400);
      if (action === "send") Object.assign(st, { st: prev.st === "ok" ? "ok" : "err", msg, msgAt: at });
      else if (action === "checkout") Object.assign(st, { outMsg: msg });
      else Object.assign(st, { msg, msgAt: at });
      results.push({ id: x.id, ok: false, error: msg, status: st });
    }
  }
  return results;
}
